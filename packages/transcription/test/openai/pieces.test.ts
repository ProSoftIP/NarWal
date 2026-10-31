// Unit tests for the OpenAI upload planning, audio slicing and user-facing information (board #16547).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENAI_MAX_UPLOAD_BYTES,
  OPENAI_WHISPER_INFO,
  UPLOAD_SAMPLE_RATE,
  UploadRefused,
  chooseCut,
  createDecodingSlicer,
  describeOpenAiUpload,
  encodeWavPcm16,
  estimateOpenAiCostUsd,
  planUploadChunks,
  toMonoPcm16,
  wavPcmSlicer,
} from '../../src/openai/index.ts';

const never = new AbortController().signal;
const word = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs });

test('plan: audio that fits is one upload with no overlap', () => {
  assert.deepEqual(planUploadChunks({ durationMs: 60_000, bytesPerSecond: 32_000, maxBytes: OPENAI_MAX_UPLOAD_BYTES, overlapMs: 4000 }), [
    { index: 0, core: { startMs: 0, endMs: 60_000 }, upload: { startMs: 0, endMs: 60_000 } },
  ]);
});

test('plan: 30 and 90 minutes of 16 kHz WAV tile the recording, overlap by 4 s and fit 25 MB', () => {
  for (const minutes of [30, 90]) {
    const durationMs = minutes * 60_000;
    const chunks = planUploadChunks({ durationMs, bytesPerSecond: 32_000, headerBytes: 44, maxBytes: OPENAI_MAX_UPLOAD_BYTES, overlapMs: 4000 });
    assert.equal(chunks.length, minutes === 30 ? 3 : 8);
    assert.equal(chunks[0].core.startMs, 0);
    assert.equal(chunks.at(-1)!.core.endMs, durationMs);
    assert.equal(chunks.at(-1)!.upload.endMs, durationMs);
    chunks.forEach((chunk, index) => {
      const bytes = 44 + ((chunk.upload.endMs - chunk.upload.startMs) / 1000) * 32_000;
      assert.ok(bytes <= OPENAI_MAX_UPLOAD_BYTES, `upload ${index} is ${bytes} bytes`);
      if (index === 0) return;
      assert.equal(chunk.core.startMs, chunks[index - 1].core.endMs);
      assert.equal(chunks[index - 1].upload.endMs - chunk.upload.startMs, 4000);
    });
    // Equal cores: the last upload is not a fragment.
    const lengths = chunks.map((chunk) => chunk.core.endMs - chunk.core.startMs);
    assert.ok(Math.max(...lengths) - Math.min(...lengths) <= chunks.length);
  }
});

test('plan: impossible inputs are refused', () => {
  const base = { durationMs: 60_000, bytesPerSecond: 32_000, maxBytes: 1_000_000, overlapMs: 4000 };
  assert.throws(() => planUploadChunks({ ...base, durationMs: 0 }), RangeError);
  assert.throws(() => planUploadChunks({ ...base, bytesPerSecond: 0 }), RangeError);
  assert.throws(() => planUploadChunks({ ...base, overlapMs: -1 }), RangeError);
  assert.throws(() => planUploadChunks({ ...base, maxBytes: 200_000 }), /too small for this overlap/);
  assert.equal(planUploadChunks({ ...base, maxChunkMs: 20_000 }).length, 4);
});

test('cut: goes to the middle of the longest silence in the shared audio', () => {
  const zone = { startMs: 4000, endMs: 8000 };
  // Silences: 4000-4200, 4900-6500, 7000-7600, 7900-8000.
  const words = [word('a', 4200, 4900), word('b', 6500, 7000), word('c', 7600, 7900)];
  assert.equal(chooseCut(zone, 6000, words), 5700);
  // A word that crosses the planned boundary is never cut in half.
  assert.equal(chooseCut(zone, 6000, [word('long', 4000, 7000)]), 7500);
  assert.equal(chooseCut(zone, 6000, []), 6000);
  assert.equal(chooseCut(zone, 6000, [word('before', 1000, 2000), word('after', 9000, 9500)]), 6000);
  assert.equal(chooseCut(zone, 6000, [word('all', 4000, 8000)]), 6000);
});

test('WAV: a slice is a complete file for exactly the requested time range', async () => {
  const samples = Int16Array.from({ length: 4000 }, (_, index) => index);
  const prepared = await wavPcmSlicer(encodeWavPcm16(samples, 1000), never);
  assert.deepEqual([prepared.durationMs, prepared.bytesPerSecond, prepared.headerBytes], [4000, 2000, 44]);

  const slice = prepared.slice(1500, 2500);
  assert.equal(slice.type, 'audio/wav');
  assert.equal(slice.size, 44 + 2000);
  const view = new DataView(await slice.arrayBuffer());
  assert.equal(view.getUint32(4, true), 36 + 2000); // RIFF size
  assert.equal(view.getUint32(24, true), 1000); // sample rate
  assert.equal(view.getUint32(40, true), 2000); // data size
  assert.equal(view.getInt16(44, true), 1500);
  assert.equal(view.getInt16(slice.size - 2, true), 2499);
  // Ranges past the end are clipped, not padded.
  assert.equal(prepared.slice(3500, 9000).size, 44 + 1000);
  // A slice is itself sliceable: the header it writes is one this reader accepts.
  assert.equal((await wavPcmSlicer(slice, never)).durationMs, 1000);
});

test('WAV: metadata chunks before the audio are skipped; other encodings are refused', async () => {
  const plain = new Uint8Array(await encodeWavPcm16(new Int16Array(1000), 1000).arrayBuffer());
  const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0, 1, 2, 3, 0]); // "LIST", 3 bytes, pad
  const withList = new Blob([plain.slice(0, 36), list, plain.slice(36)], { type: 'audio/wav' });
  assert.equal((await wavPcmSlicer(withList, never)).durationMs, 1000);

  const float = plain.slice();
  new DataView(float.buffer).setUint16(20, 3, true); // IEEE float
  const refused = (blob: Blob) =>
    assert.rejects(wavPcmSlicer(blob, never), (error: unknown) => error instanceof UploadRefused && error.reason === 'unsupported-type');
  await refused(new Blob([float]));
  await refused(new Blob([new Uint8Array(100)]));
  await refused(new Blob([plain.slice(0, 36)]));
});

test('decoding slicer: compressed audio becomes 16 kHz mono WAV', async () => {
  const left = Float32Array.from([1, -1, 0.5, 2]);
  const right = Float32Array.from([1, -1, -0.5, 2]);
  assert.deepEqual([...toMonoPcm16([left, right])], [32_767, -32_768, 0, 32_767]);

  const seconds = 3;
  const channel = new Float32Array(seconds * UPLOAD_SAMPLE_RATE);
  let decodedBytes = 0;
  const slicer = createDecodingSlicer(() => ({
    decodeAudioData: async (data) => {
      decodedBytes = data.byteLength;
      return { numberOfChannels: 1, getChannelData: () => channel };
    },
  }));
  const prepared = await slicer(new Blob([new Uint8Array(777)], { type: 'audio/webm' }), never);
  assert.equal(decodedBytes, 777);
  assert.deepEqual([prepared.durationMs, prepared.bytesPerSecond], [3000, 32_000]);
  assert.equal(prepared.slice(0, 1000).size, 44 + 32_000);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(slicer(new Blob(['x']), controller.signal), { name: 'AbortError' });
});

test('information: after-recording only, with cost and limits, and no live promise', () => {
  assert.equal(OPENAI_WHISPER_INFO.timing, 'after-recording');
  assert.equal(OPENAI_WHISPER_INFO.liveTranscript, false);
  assert.equal(OPENAI_WHISPER_INFO.wordTimestamps, true);
  assert.equal(estimateOpenAiCostUsd(30 * 60_000), 0.18);

  const first = describeOpenAiUpload({ durationMs: 30 * 60_000, uploadedAudioMs: 30 * 60_000, uploads: 1, retranscription: false });
  assert.equal(first.title, 'Transcribe with OpenAI');
  assert.match(first.timing, /after you stop recording/);
  assert.match(first.timing, /no live transcript/);
  assert.match(first.cost, /about \$0\.18 for 30 minutes of narration \(\$0\.006 per minute of audio\)/);
  assert.match(first.upload, /one file.*25 MB/);
  assert.match(first.limits, /3 uploads per minute/);
  assert.match(first.scope, /Only the narration audio/);

  const again = describeOpenAiUpload({ durationMs: 90 * 60_000, uploadedAudioMs: 90 * 60_000 + 28_000, uploads: 8, retranscription: true });
  assert.equal(again.title, 'Transcribe again with OpenAI');
  assert.match(again.upload, /8 parts/);
  assert.match(again.cost, /about \$0\.54/);
  assert.match(again.cost, /charged again each time/);
  assert.match(again.revision, /earlier transcripts and your corrections are kept/);

  const unknown = describeOpenAiUpload({ durationMs: null, uploadedAudioMs: null, uploads: 1, retranscription: false });
  assert.equal(unknown.cost, 'OpenAI charges your key $0.006 per minute of audio.');
  assert.match(describeOpenAiUpload({ durationMs: 20_000, uploadedAudioMs: 20_000, uploads: 1, retranscription: false }).cost, /less than \$0\.01 for under 1 minute/);

  // Nothing shown to the user offers a live or real-time result.
  for (const summary of [first, again, unknown]) {
    const text = Object.values(summary).join(' ').replace('There is no live transcript with this option.', '');
    assert.doesNotMatch(text, /\blive\b|real[- ]time|as you speak|while you record/i);
  }
});
