import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplayLoadError, loadReplay } from '../src/load.ts';
import { assertSandboxed, REPLAY_CSP, REPLAY_SANDBOX } from '../src/sandbox.ts';
import { knownTimingFiles } from './known-timing.ts';

test('a bundle edited after it was written is refused before anything is drawn', async () => {
  const files = knownTimingFiles();
  const bytes = files.get('rrweb/d1.jsonl')!.slice();
  bytes[bytes.length - 3] = 0x30;
  files.set('rrweb/d1.jsonl', bytes);
  await assert.rejects(loadReplay(files), (err: unknown) => {
    assert.ok(err instanceof ReplayLoadError);
    assert.ok(err.issues.length > 0);
    assert.match(err.message, /^This recording cannot be replayed: /);
    return true;
  });
});

test('a file that is not a bundle is refused', async () => {
  await assert.rejects(loadReplay(new Map([['notes.txt', new TextEncoder().encode('hello')]])), ReplayLoadError);
});

test('only an allow-same-origin sandbox is accepted for a replay frame', () => {
  const frame = (sandbox: string | null) => ({ getAttribute: (name: string) => (name === 'sandbox' ? sandbox : null) });
  assertSandboxed(frame(REPLAY_SANDBOX));
  assertSandboxed(frame(' allow-same-origin '));
  for (const bad of [null, '', 'allow-same-origin allow-scripts', 'allow-scripts', 'allow-same-origin allow-popups', 'allow-top-navigation']) {
    assert.throws(() => assertSandboxed(frame(bad)), /must be sandboxed/, String(bad));
  }
});

test('the replay page policy forbids every network load and every inline or recorded script', () => {
  const directives = new Map(REPLAY_CSP.split('; ').map((d) => [d.split(' ')[0]!, d.split(' ').slice(1)] as const));
  assert.deepEqual(directives.get('default-src'), ["'none'"]);
  assert.deepEqual(directives.get('script-src'), ["'self'"]);
  assert.deepEqual(directives.get('connect-src'), ["'none'"]);
  assert.deepEqual(directives.get('frame-src'), ["'none'"]);
  assert.deepEqual(directives.get('form-action'), ["'none'"]);
  // Images, fonts and media only from the extension itself or inline data.
  for (const name of ['img-src', 'font-src', 'media-src', 'style-src']) {
    for (const source of directives.get(name)!) assert.ok(!/^(https?:|\*|wss?:)/.test(source), `${name} ${source}`);
  }
  assert.ok(!REPLAY_CSP.includes('unsafe-eval'));
});
