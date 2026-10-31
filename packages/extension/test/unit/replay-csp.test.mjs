import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { REPLAY_CSP } from '../../../replay/src/sandbox.ts';

// Board #16549: pages that rebuild recorded pages carry the replay policy, so
// recorded markup can load nothing from the recorded site or anywhere else.
for (const page of ['replay.html', 'recordings.html']) {
  test(`${page} carries the replay content security policy`, async () => {
    const html = await readFile(new URL(`../../app/${page}`, import.meta.url), 'utf8');
    const metas = [...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g)];
    assert.equal(metas.length, 1);
    assert.equal(metas[0][1], REPLAY_CSP);
    assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<link'), 'policy comes before any load');
  });
}
