import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = (file) => readFile(new URL(`../../app/${file}`, import.meta.url), 'utf8');

// Board #16785: the microphone picker and test bar live on an Options page of their own.
test('the manifest opens options.html in a tab; the page loads its bundle; the popup links to it', async () => {
  const manifest = JSON.parse(await app('manifest.json'));
  assert.deepEqual(manifest.options_ui, { page: 'options.html', open_in_tab: true });
  assert.match(await app('options.html'), /<script src="dist\/options\.js"><\/script>/);
  const build = await readFile(new URL('../../build.mjs', import.meta.url), 'utf8');
  assert.match(build, /'options\.js': 'src\/ui\/options\.js'/);
  assert.match(await app('popup.html'), /<a href="options\.html" target="_blank" id="options">Options<\/a>/);
});
