import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundleRecordingId, redactRrwebEvent, redactUrl, titleChanges, withMeasured, writeBundle } from '../../src/export/bundle.js';
import { packBundle, unpackBundle } from '../../../library/src/index.ts';
import { bundleValidator } from '../../../bundle/src/index.ts';
import { createTranscriptHistory } from '../../../transcription/src/revisions.ts';
import { checkPurpose } from '../../src/shared/purpose.js';

const T0 = 1_760_385_600_000.25;
const dec = new TextDecoder();
const lines = (bytes) => dec.decode(bytes).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const chunk = (seq, entries) => ({ seq, startAt: entries[0].t, endAt: entries[entries.length - 1].t, entries });
const producer = { name: 'narwal-extension', version: '0.1.0' };
const environment = { browser: 'Chrome', browserVersion: '155.0.0.0', platform: 'linux' };
const box = { x: 10, y: 20, w: 100, h: 30 };
const scroll = { x: 0, y: 0 };
const el = (node, tag, name) => ({ node, tag, role: tag === 'button' ? 'button' : null, name, nameSource: 'text', box });

// A recording: page open at Start (top frame + one child frame), markers,
// a masked edit, a same-document route with a query, a link to a second
// page, and one audio part with clock pairs.
function recording({ status = 'stopped', withAudio = true } = {}) {
  const attach = (t, doc, documentId, frameId, url, reason = 'boot') => ({ k: 'attach', t, doc, documentId, frameId, url, reason, boot: { inst: `i-${doc}`, isTop: frameId === 0, navType: 'navigate' } });
  const rr = (t, doc, type = 3, seq = 1) => ({ k: 'rr', t, doc, seq, sent: t - 0.5, e: { type, timestamp: t, data: {} } });
  const obs = (t, doc, o) => ({ k: 'obs', t, doc, seq: 9, sent: t - 1, o: { doc: `i-${doc}`, ...o } });
  const entries = [
    { k: 'session', type: 'start', t: T0 },
    attach(T0 + 10, 'p1', 'TOP1', 0, 'https://app.example.test/dash?user=alice#tab=2'),
    attach(T0 + 12, 'p2', 'FRAME1', 3, 'https://widgets.example.test/w'),
    { k: 'nav', type: 'committed', t: T0 + 11, frameId: 3, documentId: 'FRAME1', parentDocumentId: 'TOP1', url: 'https://widgets.example.test/w', transitionType: 'auto_subframe' },
    rr(T0 + 20, 'p1', 4),
    rr(T0 + 21, 'p1', 2),
    rr(T0 + 22, 'p2', 2),
    obs(T0 + 30, 'p1', { kind: 'viewport', basis: 'observed', atMs: 25, w: 1280, h: 720, dpr: 1 }),
    obs(T0 + 1200, 'p1', { kind: 'marker-element', basis: 'user-marked', atMs: 1200, target: el(12, 'h2', 'Revenue'), via: 'right-click', point: { x: 15, y: 25 }, scroll }),
    obs(T0 + 2600, 'p1', { kind: 'marker-region', basis: 'user-marked', atMs: 2000, endMs: 2600, rect: { x: 0, y: 0, w: 300, h: 200 }, scroll, contains: [el(12, 'h2', 'Revenue')] }),
    obs(T0 + 4000, 'p2', { kind: 'input', basis: 'observed', atMs: 3000, endMs: 3900, target: el(30, 'input', 'Email'), inputType: 'insertText', count: 5, value: { state: 'masked' }, scroll }),
    obs(T0 + 4500, 'p1', { kind: 'marker-element', basis: 'user-marked', atMs: 4500, target: el(40, 'button', 'Save'), via: 'keyboard-focus', scroll }),
    obs(T0 + 5000, 'p1', { kind: 'route', basis: 'observed', atMs: 5000, url: 'https://app.example.test/dash/2?token=abc', title: 'Two', transition: 'history-push' }),
    { k: 'nav', type: 'committed', t: T0 + 6000, frameId: 0, documentId: 'TOP2', url: 'https://app.example.test/report?id=7', transitionType: 'link', transitionQualifiers: [] },
    attach(T0 + 6010, 'p3', 'TOP2', 0, 'https://app.example.test/report?id=7'),
    rr(T0 + 6020, 'p3', 2),
    obs(T0 + 6500, 'p3', { kind: 'click', basis: 'observed', atMs: 6500, target: el(5, 'button', 'Print'), button: 'left', count: 1, point: { x: 1, y: 2 }, scroll }),
    // An observation from a port that never attached is not this recording's.
    obs(T0 + 6600, 'stray', { kind: 'click', basis: 'observed', atMs: 6600, target: el(5, 'button', 'X'), button: 'left', count: 1, scroll }),
    { k: 'audio', type: 'clock', segment: 0, frames: 48000, sampleRate: 48000, t: T0 + 1100 },
    { k: 'audio', type: 'clock', segment: 0, frames: 96000, sampleRate: 48000, t: T0 + 2100 },
    { k: 'session', type: 'stop', t: T0 + 7000 },
  ].sort((a, b) => a.t - b.t);
  const audioChunks = withAudio
    ? [0, 1].map((i) => ({ recordingId: 'r', stream: 'audio', seq: i, segment: 0, startAt: T0 + 100 + i * 1000, endAt: T0 + 1100 + i * 1000, bytes: 4, mime: 'audio/webm;codecs=opus', data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, i])]) }))
    : [];
  const meta = { id: '9b2c1e0a-1111-4222-8333-444455556666', status, startedAt: T0, stoppedAt: T0 + 7000, title: 'Dashboard review', url: 'https://app.example.test/dash?user=alice#tab=2' };
  return { meta, eventChunks: [chunk(0, entries)], audioChunks, producer, environment };
}

test('a recording becomes a valid bundle that carries markers and masked interactions', async () => {
  const { files, manifest, warnings } = await writeBundle(recording());
  assert.deepEqual(warnings, []);
  assert.equal(manifest.recordingId, 'rec_9b2c1e0a-1111-4222-8333-444455556666');
  assert.equal(manifest.state, 'complete');
  assert.equal(manifest.durationMs, 7000);
  assert.equal(manifest.clock.originEpochMs, T0);

  const docs = JSON.parse(dec.decode(files.get('documents.json'))).documents;
  assert.deepEqual(docs.map((d) => [d.key, d.frameId, d.parentKey, d.url]), [
    ['d1', 0, null, 'https://app.example.test/dash?user=_#tab=_'],
    ['d2', 3, 'd1', 'https://widgets.example.test/w'],
    ['d3', 0, null, 'https://app.example.test/report?id=_'],
  ]);
  assert.equal(docs[0].title, 'Dashboard review');

  const obs = lines(files.get('observations.jsonl'));
  const kinds = obs.map((o) => `${o.kind}:${o.doc ?? '-'}`);
  assert.deepEqual(kinds, ['route:d1', 'viewport:d1', 'marker-element:d1', 'marker-region:d1', 'input:d2', 'marker-element:d1', 'route:d1', 'route:d3', 'click:d3']);
  assert.deepEqual(obs.map((o) => o.id), obs.map((_, i) => `o${i + 1}`));
  const input = obs.find((o) => o.kind === 'input');
  assert.deepEqual(input.value, { state: 'masked' });
  assert.equal(obs.find((o) => o.kind === 'route' && o.transition === 'history-push').url, 'https://app.example.test/dash/2?token=_');
  assert.equal(obs.find((o) => o.doc === 'd3' && o.kind === 'route').transition, 'link');
  assert.equal(obs[0].transition, 'load');

  const rr1 = lines(files.get('rrweb/d1.jsonl'));
  assert.deepEqual(rr1.map((l) => [l.seq, l.sentMs, l.receivedMs]), [[0, 19.5, 20], [1, 20.5, 21]]);
  assert.ok(files.has('rrweb/d2.jsonl') && files.has('rrweb/d3.jsonl'));

  assert.equal(manifest.audio.file, 'audio/narration.webm');
  assert.equal(files.get('audio/narration.webm').length, 8);
  assert.deepEqual(lines(files.get('audio/clock.jsonl')).map((c) => c.atMs), [1100, 2100]);

  const md = dec.decode(files.get('agent/walkthrough.md'));
  assert.match(md, /marked element "Revenue" h2/);
  assert.match(md, /marked box 300x200 at \(0,0\)/);
  assert.match(md, /edited "Email" input value=masked/);
  assert.ok(!/alice|abc/.test(dec.decode(files.get('observations.jsonl')) + dec.decode(files.get('documents.json')) + md));
});

test('the written tree packs, and imports back with the schema validator', async () => {
  const { files } = await writeBundle(recording());
  const zip = await packBundle(files, { validate: bundleValidator });
  const back = await unpackBundle(zip, { validate: bundleValidator });
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(lines(back.files.get('observations.jsonl')), lines(files.get('observations.jsonl')));
});

test('no narration: audio is null and an audio gap says so; an interrupted recording is recovered', async () => {
  const { files, manifest } = await writeBundle(recording({ status: 'interrupted', withAudio: false }));
  assert.equal(manifest.audio, null);
  assert.equal(manifest.state, 'recovered');
  const gaps = lines(files.get('gaps.jsonl'));
  assert.ok(gaps.some((g) => g.scope === 'audio' && g.reason === 'recorder-error'));
  assert.ok(gaps.some((g) => g.reason === 'recovery-truncated'));
  assert.ok(!files.has('audio/narration.webm'));
});

test('a field the schema does not know fails the export', async () => {
  const input = recording();
  input.eventChunks[0].entries.find((e) => e.k === 'obs' && e.o.kind === 'input').o.rawValue = 'typed';
  await assert.rejects(writeBundle(input), /W_UNKNOWN_FIELD/);
});

test('a recording still running is refused', async () => {
  await assert.rejects(writeBundle(recording({ status: 'recording' })), /Stop the recording/);
});

test('URL redaction and recording IDs follow the schema rules', () => {
  assert.equal(redactUrl('https://u:p@a.test/x?q=secret&e=#k=v'), 'https://a.test/x?q=_&e=#k=_');
  assert.equal(redactUrl('https://a.test/#/route?tab=open'), 'https://a.test/#/route?tab=_');
  assert.equal(redactUrl('not a url'), null);
  assert.match(bundleRecordingId('0f-aa'), /^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
});

// Raw rrweb events as the content script saves them: every place rrweb puts
// a URL, each carrying a query or fragment value that must not be exported.
const SECRETS = ['SECRETTOKEN42', 'LINKSECRET7', 'IMGSECRET3', 'SETSECRET5', 'CSSSECRET8', 'MUTSECRET1', 'RELSECRET4', 'TEXTSECRET6', 'HASHSECRET2', 'pw-SECRET9'];
function withSecretEvents(input) {
  const entries = input.eventChunks[0].entries;
  const at = (t, e) => ({ k: 'rr', t: T0 + t, doc: 'p1', seq: 50 + t, sent: T0 + t, e: { timestamp: T0 + t, ...e } });
  const node = {
    type: 0,
    id: 1,
    childNodes: [
      { type: 2, id: 2, tagName: 'a', attributes: { href: 'https://app.example.test/next?key=LINKSECRET7&lang=en' }, childNodes: [] },
      { type: 2, id: 3, tagName: 'img', attributes: { src: '/pic.png?sig=IMGSECRET3', srcset: 'a.png?s=SETSECRET5 1x, https://u:pw-SECRET9@cdn.test/b.png?s=SETSECRET5 2x' }, childNodes: [] },
      { type: 2, id: 4, tagName: 'style', attributes: { _cssText: 'body { background: url("https://cdn.test/bg.png?k=CSSSECRET8"); }' }, childNodes: [] },
      { type: 2, id: 5, tagName: 'a', attributes: { href: '#panel=HASHSECRET2' }, childNodes: [] },
      { type: 3, id: 6, textContent: 'Open https://app.example.test/share?t=TEXTSECRET6 to continue' },
    ],
  };
  entries.push(
    at(23, { type: 4, data: { href: 'https://app.example.test/markers.html?token=SECRETTOKEN42', width: 1280, height: 720 } }),
    at(24, { type: 2, data: { node, initialOffset: { left: 0, top: 0 } } }),
    at(25, { type: 3, data: { source: 0, texts: [], removes: [], adds: [], attributes: [{ id: 2, attributes: { href: 'step.html?code=RELSECRET4', action: 'https://app.example.test/f?x=MUTSECRET1' } }] } }),
  );
  entries.sort((a, b) => a.t - b.t);
  return input;
}

test('urlPolicy redact-query-values covers every URL in the exported rrweb events', async () => {
  const { files, manifest } = await writeBundle(withSecretEvents(recording()));
  assert.equal(manifest.privacy.urlPolicy, 'redact-query-values');
  for (const [path, bytes] of files) {
    if (path.endsWith('.webm')) continue;
    const text = dec.decode(bytes);
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `${secret} is in ${path}`);
  }
  const events = lines(files.get('rrweb/d1.jsonl')).map((l) => l.event);
  assert.equal(events.find((e) => e.type === 4 && e.data.href).data.href, 'https://app.example.test/markers.html?token=_');
  const [link, img, style, anchor, textNode] = events.find((e) => e.type === 2 && e.data.node).data.node.childNodes;
  assert.equal(link.attributes.href, 'https://app.example.test/next?key=_&lang=_');
  assert.equal(img.attributes.src, '/pic.png?sig=_');
  assert.equal(img.attributes.srcset, 'a.png?s=_ 1x, https://cdn.test/b.png?s=_ 2x');
  assert.equal(style.attributes._cssText, 'body { background: url("https://cdn.test/bg.png?k=_"); }');
  assert.equal(anchor.attributes.href, '#panel=_');
  assert.equal(textNode.textContent, 'Open https://app.example.test/share?t=_ to continue');
  const mutation = events.find((e) => e.type === 3 && e.data.attributes && e.data.attributes.length).data.attributes[0].attributes;
  assert.deepEqual(mutation, { href: 'step.html?code=_', action: 'https://app.example.test/f?x=_' });
});

test('rrweb redaction leaves URLs without values, plain text and the saved event alone', () => {
  const event = { type: 3, data: { source: 0, attributes: [{ id: 1, attributes: { href: '/a/b#top', class: 'x?y=1' } }], texts: [{ id: 2, value: 'What? Why #1' }] } };
  const copy = structuredClone(event);
  const out = redactRrwebEvent(event);
  assert.deepEqual(event, copy);
  assert.deepEqual(out.data.attributes[0].attributes, { href: '/a/b#top', class: 'x?y=1' });
  assert.equal(out.data.texts[0].value, 'What? Why #1');
});

test('rrweb redaction leaves data: URLs as they are', () => {
  const svg = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><rect fill='#fff'/></svg>";
  const event = { type: 3, data: { source: 0, attributes: [{ id: 1, attributes: { src: svg, href: '/p?k=SECRET#x' } }] } };
  const out = redactRrwebEvent(event);
  assert.equal(out.data.attributes[0].attributes.src, svg);
  assert.equal(out.data.attributes[0].attributes.href, '/p?k=_#x');
});

// Page content as rrweb saves it: a document node with html > head > title.
const text = (id, textContent) => ({ type: 3, id, textContent });
const titleNode = (id, ...children) => ({ type: 2, id, tagName: 'title', attributes: {}, childNodes: children });
const pageNode = (headChildren, bodyChildren = []) => ({
  type: 0,
  id: 1,
  childNodes: [
    { type: 1, id: 2, name: 'html' },
    { type: 2, id: 3, tagName: 'html', attributes: {}, childNodes: [{ type: 2, id: 4, tagName: 'head', attributes: {}, childNodes: headChildren }, { type: 2, id: 20, tagName: 'body', attributes: {}, childNodes: bodyChildren }] },
  ],
});
const snapshot = (node) => ({ type: 2, data: { node, initialOffset: { left: 0, top: 0 } } });
const mutation = (data) => ({ type: 3, data: { source: 0, texts: [], attributes: [], removes: [], adds: [], ...data } });

// The recording() pages with titles: the first page's script sets its title
// after load and again after its route change at 5000 ms; the child frame's
// title holds a URL; the second page gets its <title> from a script.
function withTitles(input, { first = 'Dashboard' } = {}) {
  const entries = input.eventChunks[0].entries;
  const at = (t, doc, e) => ({ k: 'rr', t: T0 + t, doc, seq: 100 + t, sent: T0 + t, e: { timestamp: T0 + t, ...e } });
  // A same-origin child frame's page is in the parent's stream too.
  const frameInParent = { type: 2, id: 21, tagName: 'iframe', attributes: {}, childNodes: [{ type: 0, id: 22, childNodes: [{ type: 2, id: 23, tagName: 'html', attributes: {}, childNodes: [{ type: 2, id: 24, tagName: 'head', attributes: {}, childNodes: [titleNode(25, text(26, 'Widget in parent'))] }] }] }] };
  entries.push(
    at(24, 'p1', snapshot(pageNode([titleNode(5, text(6, '  Loading\n  app '))], [frameInParent]))),
    at(900, 'p1', mutation({ removes: [{ parentId: 5, id: 6 }], adds: [{ parentId: 5, nextId: null, node: text(40, first) }] })),
    at(5200, 'p1', mutation({ texts: [{ id: 40, value: 'Dashboard two' }] })),
    at(26, 'p2', snapshot(pageNode([titleNode(5, text(6, 'Widget https://widgets.example.test/w?key=FRAMESECRET9'))]))),
    at(6030, 'p3', snapshot(pageNode([]))),
    at(6100, 'p3', mutation({ adds: [{ parentId: 4, nextId: null, node: titleNode(9) }, { parentId: 9, nextId: null, node: text(10, 'Report 7') }] })),
  );
  entries.sort((a, b) => a.t - b.t);
  return input;
}

test('every document carries its page title, in documents.json, routes and the walkthrough (board #16590)', async () => {
  const { files } = await writeBundle(withTitles(recording()));
  const docs = JSON.parse(dec.decode(files.get('documents.json'))).documents;
  assert.deepEqual(docs.map((d) => [d.key, d.title]), [
    ['d1', 'Dashboard'],
    ['d2', 'Widget https://widgets.example.test/w?key=_'],
    ['d3', 'Report 7'],
  ]);
  const routes = lines(files.get('observations.jsonl')).filter((o) => o.kind === 'route');
  assert.deepEqual(routes.map((o) => [o.doc, o.transition, o.title]), [['d1', 'load', 'Dashboard'], ['d1', 'history-push', 'Dashboard two'], ['d3', 'link', 'Report 7']]);
  const md = dec.decode(files.get('agent/walkthrough.md'));
  // The Pages line lists top-frame documents; walkthrough.json lists them all.
  for (const d of docs.filter((x) => x.frameId === 0)) assert.ok(md.includes(`${d.key} "${d.title}" ${d.url}`), `${d.key} is not in the Pages line`);
  const view = JSON.parse(dec.decode(files.get('agent/walkthrough.json')));
  assert.deepEqual(view.documents.map((d) => d.title), docs.map((d) => d.title));
  assert.ok(!dec.decode(files.get('documents.json')).includes('FRAMESECRET9'));
});

test('an in-page route carries the title set for it, not the title the page had when it was pushed (board #16590)', async () => {
  const input = recording();
  const entries = input.eventChunks[0].entries;
  const at = (t, doc, e) => ({ k: 'rr', t: T0 + t, doc, seq: 100 + t, sent: T0 + t, e: { timestamp: T0 + t, ...e } });
  // The page reports the title it had when the URL was pushed: the old one.
  const route = (t, title) => ({ k: 'obs', t: T0 + t, doc: 'p1', seq: 9, sent: T0 + t - 1, o: { doc: 'i-p1', kind: 'route', basis: 'observed', atMs: t, url: `https://app.example.test/dash/${t}`, title, transition: 'history-push' } });
  entries.push(
    at(24, 'p1', snapshot(pageNode([titleNode(5, text(6, 'SPA home'))]))),
    // The route at 5000 (title "Two"): the app sets its title twice after the push.
    at(5100, 'p1', mutation({ texts: [{ id: 6, value: 'SPA loading' }] })),
    at(5300, 'p1', mutation({ texts: [{ id: 6, value: 'SPA route 1' }] })),
    // The route at 5500 sets no title; the route at 5800 sets one at once.
    route(5500, 'SPA route 1'),
    route(5800, 'SPA route 1'),
    at(5800, 'p1', mutation({ texts: [{ id: 6, value: 'SPA route 3' }] })),
  );
  entries.sort((a, b) => a.t - b.t);
  const { files } = await writeBundle(input);
  const routes = lines(files.get('observations.jsonl')).filter((o) => o.kind === 'route' && o.doc === 'd1');
  assert.deepEqual(routes.map((o) => [o.transition, o.title]), [
    ['load', 'SPA home'],
    ['history-push', 'SPA route 1'],
    ['history-push', 'SPA route 1'],
    ['history-push', 'SPA route 3'],
  ]);
  assert.equal(JSON.parse(dec.decode(files.get('documents.json'))).documents[0].title, 'SPA home');
});

test('a credential-shaped page title is left out and a long one is cut; the export still validates', async () => {
  const key = `sk-${'a1B2'.repeat(6)}`;
  const leaked = await writeBundle(withTitles(recording(), { first: `Key ${key}` }));
  const docs = JSON.parse(dec.decode(leaked.files.get('documents.json'))).documents;
  assert.equal(docs[0].title, '');
  assert.ok(!dec.decode(leaked.files.get('agent/walkthrough.md')).includes(key));
  const long = await writeBundle(withTitles(recording(), { first: 'x'.repeat(300) }));
  assert.equal(JSON.parse(dec.decode(long.files.get('documents.json'))).documents[0].title, `${'x'.repeat(199)}…`);
});

test('a marked box keeps its text without credential-shaped words; the export still validates', async () => {
  const key = `sk-${'a1B2'.repeat(6)}`;
  const withRegionText = (value) => {
    const input = recording();
    const region = input.eventChunks[0].entries.find((e) => e.o?.kind === 'marker-region');
    region.o.text = value;
    return input;
  };
  const regionOf = (files) => lines(files.get('observations.jsonl')).find((o) => o.kind === 'marker-region');
  const mixed = await writeBundle(withRegionText(`Upload key ${key} failed; header Bearer abc123 refused`));
  assert.equal(regionOf(mixed.files).text, 'Upload key failed; header refused');
  assert.deepEqual(await bundleValidator(mixed.files), []);
  for (const value of [key, 'Bearer abc123']) {
    const only = await writeBundle(withRegionText(value));
    assert.equal(regionOf(only.files).text, undefined, value);
    assert.deepEqual(await bundleValidator(only.files), [], value);
  }
});

test('titleChanges reads the first <title> of the head, as document.title does', () => {
  const line = (sentMs, event) => ({ sentMs, event });
  const svgTitle = { type: 2, id: 30, tagName: 'svg', isSVG: true, attributes: {}, childNodes: [{ type: 2, id: 31, tagName: 'title', isSVG: true, attributes: {}, childNodes: [text(32, 'Icon tooltip')] }] };
  assert.deepEqual(
    titleChanges([
      // Before any snapshot nothing is known.
      line(1, mutation({ adds: [{ parentId: 4, nextId: null, node: titleNode(90, text(91, 'Too early')) }] })),
      line(10, snapshot(pageNode([titleNode(5, text(6, 'One'), text(7, ' page'))], [svgTitle]))),
      // A second <title> does not change document.title; removing the first one does.
      line(20, mutation({ adds: [{ parentId: 4, nextId: null, node: titleNode(8) }, { parentId: 8, nextId: null, node: text(9, 'Second') }] })),
      line(30, mutation({ removes: [{ parentId: 4, id: 5 }] })),
      // A child frame's page and its title arrive as mutations of this stream.
      line(40, mutation({ adds: [{ parentId: 60, nextId: null, node: titleNode(61, text(62, 'Frame title')) }] })),
      line(50, mutation({ removes: [{ parentId: 8, id: 9 }] })),
      line(60, mutation({ source: 2, type: 2, id: 20, x: 1, y: 1 })),
      // A new full snapshot (back/forward restore) starts again.
      line(70, snapshot(pageNode([titleNode(5, text(6, 'Restored'))]))),
      line(80, snapshot({ type: 0, id: 1, childNodes: [] })),
    ]),
    [{ atMs: 10, title: 'One page' }, { atMs: 30, title: 'Second' }, { atMs: 50, title: '' }, { atMs: 70, title: 'Restored' }, { atMs: 80, title: '' }],
  );
  assert.deepEqual(titleChanges([line(1, { type: 2, timestamp: 1, data: {} }), line(2, { type: 4, data: { href: 'https://a.test/' } })]), []);
});

test('the transcript history is exported: revisions, the active one and edits', async () => {
  const revision = (revisionId, text) => ({
    revisionId,
    source: 'live',
    provider: 'browser-local',
    model: 'vosk-small-en-us',
    language: 'en',
    createdAt: new Date(T0 + 7000).toISOString(),
    segments: [{ id: 's1', startMs: 1000, endMs: 2000, text, words: [], timing: 'aligned' }],
    gaps: [{ startMs: 3000, endMs: 4000, reason: 'not-transcribed', detail: 'engine-behind' }],
  });
  const history = {
    ...createTranscriptHistory('local'),
    version: 3,
    revisions: [revision('r1', 'this chart is wrong'), revision('r2', 'this chart is off')],
    activeRevision: 'r1',
    edits: [{ id: 'c1', type: 'correction', revisionId: 'r1', segmentId: 's1', text: 'this chart is right', createdAt: new Date(T0 + 8000).toISOString() }],
    pending: { jobId: 'j1', provider: 'openai', startedAtMs: T0, consentGrantedAtMs: T0 },
  };
  const { files, manifest, warnings } = await writeBundle({ ...recording(), history });
  assert.deepEqual(warnings, []);
  assert.equal(manifest.transcript.activeRevision, 'r1');
  // Each revision names its model and that model's measured quality (board #16611).
  assert.deepEqual(JSON.parse(dec.decode(files.get('transcript/r1.json'))), {
    ...history.revisions[0],
    measured: { werPct: 45.3, basis: 'word error rate on one 113 s English reading passage, in the extension, live text (docs/validation/wer-16603)' },
  });
  assert.match(dec.decode(files.get('agent/walkthrough.md')), /^- Transcript: r1, .*; measured word error rate 45\.3% \(about 1 word in 2 wrong\)$/m);
  assert.ok(files.has('transcript/r2.json'));
  assert.deepEqual(lines(files.get('edits.jsonl')), history.edits);
  const all = [...files.values()].map((b) => dec.decode(b)).join('\n');
  assert.ok(!all.includes('j1') && !all.includes('consentGrantedAtMs'), 'extension state stays local');
  assert.match(dec.decode(files.get('agent/walkthrough.md')), /this chart is right/);

  const none = await writeBundle({ ...recording(), history: createTranscriptHistory('local') });
  assert.equal(none.manifest.transcript.activeRevision, null);
  assert.ok(![...none.files.keys()].some((p) => p.startsWith('transcript/') || p === 'edits.jsonl'));
});

test('the purpose goes into the manifest, the walkthrough header and README.md / AGENTS.md (board #16594)', async () => {
  const input = recording();
  input.meta.purpose = "  Review of yesterday's dashboard changes; each thing I point at is a change request  ";
  const { files, manifest, warnings } = await writeBundle(input);
  assert.deepEqual(warnings, []);
  assert.equal(manifest.purpose, "Review of yesterday's dashboard changes; each thing I point at is a change request");
  const md = dec.decode(files.get('agent/walkthrough.md')).split('\n');
  assert.equal(md[0], '# Narrated walkthrough: "Dashboard review"');
  assert.match(md[2], /^- purpose="Review of yesterday's dashboard changes; each thing I point at is a change request"/);
  assert.equal(JSON.parse(dec.decode(files.get('agent/walkthrough.json'))).purpose, manifest.purpose);
  const readme = dec.decode(files.get('README.md'));
  assert.equal(dec.decode(files.get('AGENTS.md')), readme);
  assert.match(readme.split('\n')[0], /NarWal/);
  assert.match(readme, /^purpose="Review of yesterday's dashboard changes; each thing I point at is a change request"$/m);
  assert.match(readme, /Read `agent\/walkthrough\.md` first/);
  const listed = JSON.parse(dec.decode(files.get('manifest.json'))).files.map((f) => f.path);
  assert.ok(listed.includes('README.md') && listed.includes('AGENTS.md'));
  const back = await unpackBundle(await packBundle(files, { validate: bundleValidator }), { validate: bundleValidator });
  assert.deepEqual(back.warnings, []);
});

test('no purpose, no audio: the bundle says to ask, and says there is no narration', async () => {
  const { files, manifest } = await writeBundle(recording({ withAudio: false }));
  assert.equal('purpose' in manifest, false);
  const md = dec.decode(files.get('agent/walkthrough.md'));
  assert.match(md.split('\n')[2], /^- purpose: none given \(ask the person/);
  assert.match(md, /^- No said lines: no audio recorded \(no narration\)\.$/m);
  assert.doesNotMatch(md, /audio not redacted/);
  assert.match(dec.decode(files.get('README.md')), /No purpose was given\. Ask the person/);
});

test('a credential-shaped purpose is refused at Start and left out of an export', async () => {
  const key = `sk-${'a1B2'.repeat(6)}`;
  assert.equal(checkPurpose(`use ${key}`).ok, false);
  assert.equal(checkPurpose('Bearer abc').ok, false);
  assert.equal(checkPurpose('x'.repeat(1001)).ok, false);
  assert.deepEqual(checkPurpose('   '), { ok: true, purpose: null });
  assert.deepEqual(checkPurpose(' Each mark is a bug '), { ok: true, purpose: 'Each mark is a bug' });
  const input = recording();
  input.meta.purpose = `use ${key}`;
  const { files, manifest } = await writeBundle(input);
  assert.equal('purpose' in manifest, false);
  for (const path of ['README.md', 'agent/walkthrough.md']) assert.ok(!dec.decode(files.get(path)).includes(key), path);
});

test('a revision carries its model\'s measured word error rate; the worst of several; none when not measured (#16611)', () => {
  const r = (model) => ({ revisionId: 'r', model });
  assert.equal(withMeasured(r('whisper-small.en-q8')).measured.werPct, 9.0);
  assert.equal(withMeasured(r('whisper-small.en-q8+whisper-base.en-q8')).measured.werPct, 20.1);
  assert.match(withMeasured(r('whisper-large-v3-turbo')).measured.basis, /^word error rate on one English reading passage, a different take: Matt's separate 120-second recording/, "turbo's basis names its other take (#16621)");
  assert.equal('measured' in withMeasured(r('whisper-1')), false);
  assert.equal('measured' in withMeasured(r('whisper-small.en-q8+whisper-1')), false);
  const kept = { ...r('whisper-small.en-q8'), measured: { werPct: 1, basis: 'x' } };
  assert.equal(withMeasured(kept), kept);
});
