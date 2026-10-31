import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingResources } from '../src/resources.ts';

test('network resources in snapshots and mutations are counted; inline data and inlined styles are not', () => {
  const snapshot = {
    type: 2,
    data: {
      node: {
        type: 0,
        childNodes: [
          { type: 2, tagName: 'img', attributes: { src: 'https://cdn.example.test/a.png', srcset: 'https://cdn.example.test/a2.png 2x, /rel.png 3x' } },
          { type: 2, tagName: 'img', attributes: { src: 'data:image/png;base64,AAAA' } },
          { type: 2, tagName: 'link', attributes: { rel: 'stylesheet', href: 'https://site.example.test/inlined.css', _cssText: 'body{background:url("https://img.example.test/bg.png")}' } },
          { type: 2, tagName: 'link', attributes: { rel: 'stylesheet', href: '//other.example.test/not-inlined.css' } },
          { type: 2, tagName: 'div', attributes: { style: "background-image:url('https://img.example.test/div.png')" } },
          { type: 2, tagName: 'style', attributes: {}, childNodes: [{ type: 3, isStyle: true, textContent: '@import "https://fonts.example.test/f.css";' }] },
          { type: 3, textContent: 'url(https://text.example.test/not-a-resource)' },
          { type: 2, tagName: 'a', attributes: { href: '/relative' } },
        ],
      },
    },
  };
  const mutation = {
    type: 3,
    data: {
      source: 0,
      adds: [{ node: { type: 2, tagName: 'iframe', attributes: { src: 'https://frame.example.test/' } } }],
      attributes: [{ id: 1, attributes: { src: 'https://cdn.example.test/b.png', style: { background: 'url(https://img.example.test/c.png)' } } }],
    },
  };
  const result = missingResources([snapshot, mutation, { type: 3, data: { source: 1 } }]);
  // a.png, a2.png, bg.png (inlined CSS), not-inlined.css, div.png, f.css, frame, b.png, c.png.
  assert.equal(result.count, 9);
  assert.deepEqual(result.origins, [
    'https://cdn.example.test',
    'https://fonts.example.test',
    'https://frame.example.test',
    'https://img.example.test',
    'https://other.example.test',
  ]);
});

test('no events, no resources', () => {
  assert.deepEqual(missingResources([]), { count: 0, origins: [] });
});
