import test from 'node:test';
import assert from 'node:assert/strict';
import { exportWaiting, improvingPercent, stripModel } from '../../src/strip-model.js';

const REC = { phase: 'recording', transcription: 'deepgram', elapsedMs: 134_000, micLive: true, transcript: { state: 'live' } };

test('no strip when nothing is recording', () => {
  assert.equal(stripModel({ phase: 'idle' }), null);
});

test('recording with live words: shows the words, Stop and Transcript', () => {
  const m = stripModel(REC, { tail: 'this should collapse' });
  assert.equal(m.time, '02:14');
  assert.equal(m.messageKind, 'transcript');
  assert.equal(m.message, 'this should collapse');
  assert.equal(m.showStop, true);
  assert.equal(m.showToggle, true);
  assert.equal(m.showRetry, false);
  assert.equal(m.announce, '', 'the transcript words are never announced');
});

test('recording before any word: says it is listening', () => {
  const m = stripModel(REC, { tail: '' });
  assert.equal(m.messageKind, 'status');
  assert.match(m.message, /Listening/);
});

test('connecting names the provider; offline names the speech model', () => {
  assert.match(stripModel({ ...REC, transcript: { state: 'connecting' } }).message, /Connecting to Deepgram/);
  assert.match(stripModel({ ...REC, transcription: 'offline', transcript: { state: 'connecting' } }).message, /Starting the speech model/);
});

test('disconnected provider: warns, says recording continues, offers a retry of the same provider', () => {
  const m = stripModel({ ...REC, transcript: { state: 'disconnected', detail: 'Deepgram closed the connection' } }, { tail: 'old words' });
  assert.equal(m.tone, 'warn');
  assert.equal(m.messageKind, 'status');
  assert.match(m.message, /Deepgram closed the connection/);
  assert.match(m.message, /Recording continues/);
  assert.equal(m.showRetry, true);
  assert.equal(m.showStop, true);
  assert.equal(m.announce, m.message);
});

test('disconnected with no reason still names the provider', () => {
  assert.match(stripModel({ ...REC, transcription: 'assemblyai', transcript: { state: 'disconnected' } }).message, /AssemblyAI is not connected/);
});

test('reconnecting: warns without a retry button (it is already retrying)', () => {
  const m = stripModel({ ...REC, transcript: { state: 'reconnecting' } });
  assert.equal(m.tone, 'warn');
  assert.equal(m.showRetry, false);
  assert.match(m.message, /Recording continues/);
});

test('microphone lost outranks every transcript message', () => {
  const m = stripModel({ ...REC, micLive: false, transcript: { state: 'disconnected' } }, { tail: 'words' });
  assert.equal(m.tone, 'warn');
  assert.match(m.message, /Microphone stopped/);
  assert.match(m.message, /page is still recorded/);
  assert.equal(m.showRetry, false);
});

test('transcript behind: keeps the words and adds a note', () => {
  const m = stripModel({ ...REC, transcription: 'offline', transcript: { state: 'behind' } }, { tail: 'words' });
  assert.equal(m.message, 'words');
  assert.equal(m.note, 'Transcript is behind');
  assert.equal(m.announce, 'Transcript is behind');
});

test('after-recording provider: no live transcript and no Transcript button', () => {
  const m = stripModel({ ...REC, transcription: 'openai', transcript: { state: 'after-recording' } });
  assert.match(m.message, /after you stop/);
  assert.equal(m.showToggle, false);
  assert.equal(m.showStop, true);
});

test('stopping: Stop is shown busy, nothing else to press', () => {
  const m = stripModel({ ...REC, phase: 'stopping' });
  assert.equal(m.tone, 'busy');
  assert.equal(m.stopBusy, true);
  assert.equal(m.showToggle, false);
});

test('saved: says where, offers Open and Close; no claim about uploads', () => {
  const m = stripModel({ ...REC, phase: 'saved', recordingId: 'r1' });
  assert.equal(m.tone, 'done');
  assert.equal(m.message, 'Saved on this computer.');
  assert.equal(m.showOpen, true);
  assert.equal(m.showClose, true);
  assert.equal(m.showStop, false);
});

test('saved (#16602): Export the recording at once, Open recording second', () => {
  const m = stripModel({ ...REC, phase: 'saved', recordingId: 'r1' });
  assert.equal(m.showExport, true);
  assert.equal(m.exportWaiting, false);
  assert.equal(m.showOpen, true);
  assert.equal(stripModel({ ...REC, phase: 'saved' }).showExport, false, 'nothing to export without a recording id');
  assert.equal(stripModel({ ...REC }).showExport, false, 'not while recording');
  assert.equal(stripModel({ ...REC, phase: 'failed', error: 'x', recordingId: 'r1' }).showExport, false, 'a failed recording is exported from the recordings page');
});

test('saved with OpenAI (#16602, #16588): Export waits while the transcript is coming, then is ready', () => {
  const saved = { ...REC, transcription: 'openai', phase: 'saved', recordingId: 'r1' };
  const busy = stripModel({ ...saved, afterTranscript: { state: 'uploading', done: 0, total: 1 } });
  assert.equal(busy.showExport, true);
  assert.equal(busy.exportWaiting, true);
  for (const job of [{ state: 'done', activated: true }, { state: 'failed', detail: 'OpenAI is busy', next: 'retry' }, { state: 'no-key' }, undefined]) {
    assert.equal(stripModel({ ...saved, afterTranscript: job }).exportWaiting, false, JSON.stringify(job));
  }
  assert.equal(exportWaiting({ ...saved, transcription: 'offline', afterTranscript: { state: 'uploading' } }), false, 'only an OpenAI job holds Export');
});

test('saved on this computer (#16603): Export waits while the transcript is improved, never when it failed', () => {
  const saved = { ...REC, transcription: 'offline', phase: 'saved', recordingId: 'r1' };
  assert.equal(stripModel({ ...saved, afterTranscript: { state: 'improving', progress: 0.4 } }).exportWaiting, true);
  for (const job of [{ state: 'done', activated: true }, { state: 'failed', detail: 'no transcript model for after Stop is installed on this computer' }, undefined]) {
    assert.equal(stripModel({ ...saved, afterTranscript: job }).exportWaiting, false, JSON.stringify(job));
  }
});

test('saved with OpenAI: points to the recording for the transcript', () => {
  assert.match(stripModel({ ...REC, transcription: 'openai', phase: 'saved', recordingId: 'r1' }).message, /Open the recording to get the transcript/);
});

test('saved with OpenAI (#16588): progress, ready, and a failure with Try again', () => {
  const saved = { ...REC, transcription: 'openai', phase: 'saved', recordingId: 'r1' };
  const busy = stripModel({ ...saved, afterTranscript: { state: 'uploading', done: 0, total: 1 } });
  assert.equal(busy.tone, 'busy');
  assert.match(busy.message, /Getting the transcript from OpenAI…$/);
  assert.equal(busy.announce, 'Getting the transcript from OpenAI');
  assert.equal(busy.showRetry, false);
  assert.equal(busy.showOpen, true);
  assert.match(stripModel({ ...saved, afterTranscript: { state: 'uploading', done: 1, total: 3 } }).message, /\(part 2 of 3\)/);

  const ready = stripModel({ ...saved, afterTranscript: { state: 'done', activated: true } });
  assert.equal(ready.tone, 'done');
  assert.match(ready.message, /The OpenAI transcript is ready/);
  assert.equal(ready.showRetry, false);
  assert.match(stripModel({ ...saved, afterTranscript: { state: 'done', activated: false } }).message, /Open the recording to use it/);

  const failed = stripModel({ ...saved, afterTranscript: { state: 'failed', detail: 'OpenAI is busy', next: 'retry' } });
  assert.equal(failed.tone, 'error');
  assert.equal(failed.badge, 'Saved', 'the recording itself is saved');
  assert.match(failed.message, /No transcript: OpenAI is busy\./);
  assert.equal(failed.showRetry, true);
  assert.equal(failed.showOpen, true);

  // Review of NarWal#29: no Try again when the same upload cannot work (a
  // refused key, an empty account, no audio). Each upload is paid for.
  const refused = stripModel({ ...saved, afterTranscript: { state: 'failed', detail: 'OpenAI did not accept the key', next: 'after-fix' } });
  assert.match(refused.message, /No transcript: OpenAI did not accept the key\./);
  assert.equal(refused.showRetry, false);
  assert.equal(refused.showOpen, true);
  assert.equal(stripModel({ ...saved, afterTranscript: { state: 'failed', detail: 'no narration audio was saved', next: 'never' } }).showRetry, false);

  const partial = stripModel({ ...saved, afterTranscript: { state: 'partial', detail: 'OpenAI is busy', activated: true } });
  assert.equal(partial.tone, 'warn');
  assert.equal(partial.showRetry, true);

  const noKey = stripModel({ ...saved, afterTranscript: { state: 'no-key' } });
  assert.match(noKey.message, /Save your OpenAI key/);
  assert.equal(noKey.showRetry, false);

  // The offline choice never shows the OpenAI job.
  assert.doesNotMatch(stripModel({ ...saved, transcription: 'offline', afterTranscript: { state: 'failed', detail: 'x' } }).message, /OpenAI|No transcript/);
});

test('saved on this computer (#16603): improving, ready, and a failure that keeps the live transcript', () => {
  const saved = { ...REC, transcription: 'offline', phase: 'saved', recordingId: 'r1' };
  assert.equal(stripModel(saved).message, 'Saved on this computer.');

  const busy = stripModel({ ...saved, afterTranscript: { state: 'improving', progress: 0.416 } });
  assert.equal(busy.tone, 'busy');
  assert.equal(busy.message, 'Saved on this computer. Improving the transcript on this computer (41%)…');
  assert.equal(busy.showRetry, false);
  assert.equal(busy.showOpen, true);
  // Never 100% while it still runs.
  assert.equal(improvingPercent({ progress: 1 }), 99);
  assert.equal(improvingPercent({}), 0);

  assert.match(stripModel({ ...saved, afterTranscript: { state: 'done', activated: true } }).message, /The improved transcript is ready\.$/);
  assert.match(stripModel({ ...saved, afterTranscript: { state: 'done', activated: false } }).message, /Open the recording to use it/);

  const failed = stripModel({ ...saved, afterTranscript: { state: 'failed', detail: 'the transcript model stopped working', next: 'retry' } });
  assert.equal(failed.tone, 'warn', 'the live transcript is still there');
  assert.equal(failed.badge, 'Saved');
  assert.match(failed.message, /not improved: the transcript model stopped working\. The live transcript is kept\.$/);
  assert.equal(failed.showRetry, true);
  // A missing model: Try again waits for the install.
  assert.equal(stripModel({ ...saved, afterTranscript: { state: 'failed', detail: 'not installed', next: 'after-fix' } }).showRetry, false);

  const partial = stripModel({ ...saved, afterTranscript: { state: 'partial', detail: 'the browser stopped it' } });
  assert.equal(partial.tone, 'warn');
  assert.equal(partial.showRetry, true);
});

test('failed: gives the reason, and says the earlier part is saved only when it is', () => {
  const kept = stripModel({ ...REC, phase: 'failed', error: 'this browser is out of storage space', recordingId: 'r1' });
  assert.equal(kept.tone, 'error');
  assert.match(kept.message, /out of storage space/);
  assert.match(kept.message, /part before this is saved/);
  assert.equal(kept.showOpen, true);
  const lost = stripModel({ ...REC, phase: 'failed', error: 'the tab closed' });
  assert.doesNotMatch(lost.message, /is saved/);
  assert.equal(lost.showOpen, false);
});

test('the clock follows the live elapsed time when given', () => {
  assert.equal(stripModel(REC, { elapsedMs: 3_725_000 }).time, '1:02:05');
});

test('board #16785: no microphone sound in the first 10 s is said on the strip; the meter shows while the microphone records', () => {
  const quiet = stripModel({ ...REC, micSilent: true }, { tail: '' });
  assert.equal(quiet.tone, 'warn');
  assert.match(quiet.message, /No microphone sound/);
  assert.match(quiet.message, /page is still recorded/);
  assert.equal(quiet.showMeter, true, 'the meter stays: it shows when sound comes');
  assert.equal(stripModel(REC, { tail: '' }).showMeter, true);
  assert.equal(stripModel({ ...REC, micLive: false }).showMeter, false, 'no meter for a microphone that is not recorded');
  assert.match(stripModel({ ...REC, micLive: false, micSilent: true }).message, /Microphone stopped/, 'a lost microphone outranks silence');
  assert.equal(stripModel({ ...REC, phase: 'stopping' }).showMeter, false);
});

test('board #16785: a recording on the default microphone because the chosen one is gone says so', () => {
  assert.equal(stripModel({ ...REC, micFallback: true }, { tail: 'words' }).note, 'Default microphone');
  assert.equal(stripModel(REC, { tail: 'words' }).note, undefined);
});
