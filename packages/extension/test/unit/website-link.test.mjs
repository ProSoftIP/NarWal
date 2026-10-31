import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Board #16601, #16960: the popup footer and the recordings page link to the
// public ProSoft IP site in a new tab. The GitHub repository is private, so a
// store user who followed a link to it would get a 404.
for (const page of ['popup.html', 'recordings.html']) {
  test(`${page} links to prosoftip.com in a new tab`, async () => {
    const html = await readFile(new URL(`../../app/${page}`, import.meta.url), 'utf8');
    const links = [...html.matchAll(/<a ([^>]*)id="website"([^>]*)>([^<]*)<\/a>/g)];
    assert.equal(links.length, 1);
    const attrs = links[0][1] + links[0][2];
    assert.match(attrs, /href="https:\/\/prosoftip\.com\/"/);
    assert.match(attrs, /target="_blank"/);
    assert.match(attrs, /rel="noopener"/);
    assert.equal(links[0][3], 'ProSoft IP');
  });

  test(`${page} does not link to the private GitHub repository`, async () => {
    const html = await readFile(new URL(`../../app/${page}`, import.meta.url), 'utf8');
    assert.doesNotMatch(html, /github\.com\/ProSoftIP/i);
  });
}
