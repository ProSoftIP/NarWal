// The Tiles B pages (board #16783): day groups, routes, marks, the transcript
// flow, the transcript word and the library search.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxSize, dayLabel, flowOf, groupByDay, hostOf, markAt, markText, marksOf, matches, mmss, routeText, routesOf, searchText, stageFit, transcriptWord } from '../../src/ui/tiles-model.js';

const noon = new Date(2026, 9, 15, 12, 0, 0).getTime();
const at = (d, h = 9) => new Date(2026, 9, d, h, 0, 0).getTime();

test('days read Today, Yesterday, then the date', () => {
  assert.equal(dayLabel(at(15, 1), noon, 'en-US'), 'Today');
  assert.equal(dayLabel(at(14, 23), noon, 'en-US'), 'Yesterday');
  assert.equal(dayLabel(at(13), noon, 'en-US'), 'Tue, Oct 13');
  assert.match(dayLabel(new Date(2025, 9, 13).getTime(), noon, 'en-US'), /2025/);
});

test('a newest-first list groups into runs of one day', () => {
  const items = [at(15, 11), at(15, 8), at(14), at(12), at(12, 7)];
  const groups = groupByDay(items, (x) => x, noon, 'en-US');
  assert.deepEqual(groups.map((g) => [g.label, g.items.length]), [['Today', 2], ['Yesterday', 1], ['Mon, Oct 12', 2]]);
});

test('routes: the page at Start, loads and in-page routes, without repeats or query values', () => {
  const meta = { startedAt: 1000 };
  const documents = [{ doc: 'p1', documentId: 'd1', isTop: true, url: 'https://app.example.com/home' }, { doc: 'p2', documentId: 'f1', isTop: false, url: 'https://ads.example.net/' }];
  const navigations = [{ type: 'committed', frameId: 0, at: 9000, url: 'https://app.example.com/report?token=abc' }, { type: 'committed', frameId: 3, at: 9500, url: 'https://ads.example.net/x' }];
  const observations = [
    { documentKey: 'd1', o: { kind: 'route', atMs: 4000, url: 'https://app.example.com/list#/orders' } },
    { documentKey: 'd1', o: { kind: 'route', atMs: 4100, url: 'https://app.example.com/list#/orders' } },
    { documentKey: 'f1', o: { kind: 'route', atMs: 5000, url: 'https://ads.example.net/y' } },
  ];
  const routes = routesOf({ meta, documents, navigations, observations });
  assert.deepEqual(routes.map((r) => [r.atMs, routeText(r.url)]), [[0, '/home'], [4000, '/list#/orders'], [8000, '/report']]);
  assert.equal(routeText('https://x.test/a#k=v'), '/a');
  assert.equal(hostOf('https://app.example.com/home'), 'app.example.com');
  assert.equal(hostOf('not a url'), '');
});

test('marks say what was marked, never more than a line', () => {
  assert.equal(markText({ kind: 'marker-element', target: { tag: 'button', role: 'button', name: 'Save  changes' } }), 'Marked “Save changes”');
  assert.equal(markText({ kind: 'marker-element', target: { tag: 'div', role: null } }), 'Marked div');
  assert.equal(markText({ kind: 'marker-element', target: { tag: 'div', excluded: true } }), 'Marked a hidden area');
  assert.equal(markText({ kind: 'marker-region', rect: {} }), 'Marked an area');
  // Board #16844: an area with no text says its size and the named elements in it.
  assert.equal(markText({ kind: 'marker-region', rect: { x: 1, y: 2, w: 326.98, h: 54.59 }, contains: [] }), 'Marked an area 327 × 55 px');
  assert.equal(
    markText({ kind: 'marker-region', rect: { x: 1, y: 2, w: 283.75, h: 65.77 }, contains: [{ tag: 'input', name: 'Search roster...' }, { tag: 'svg' }, { tag: 'span', name: 'Search  roster...' }] }),
    'Marked an area 284 × 66 px with “Search roster...”',
  );
  assert.equal(markText({ kind: 'marker-region', rect: { w: 9, h: 9 }, text: '  Total ', contains: [{ name: 'x' }] }), 'Marked an area: “Total”');
  assert.equal(boxSize({ w: 0, h: 10 }), '');
  assert.match(markText({ kind: 'marker-region', text: 'x'.repeat(300) }), /^Marked an area: “x{79}…”$/);
  const marks = marksOf([
    { documentKey: 'd1', o: { kind: 'click', atMs: 1 } },
    { documentKey: 'd1', o: { kind: 'marker-region', atMs: 3100, rect: { x: 1, y: 2, w: 3, h: 4 }, text: 'Total' } },
    { documentKey: 'd1', o: { kind: 'marker-element', atMs: 900, target: { tag: 'a', name: 'Home', box: { x: 0, y: 0, w: 5, h: 5 } } } },
  ]);
  assert.deepEqual(marks.map((m) => [m.atMs, m.text, m.box.w]), [[900, 'Marked “Home”', 5], [3100, 'Marked an area: “Total”', 3]]);
});

test('the box drawn at a moment is the newest mark, or the one hovered or picked (board #16844)', () => {
  const box = { x: 0, y: 0, w: 1, h: 1 };
  const a = { atMs: 7592, documentKey: 'd1', box };
  const b = { atMs: 10107, documentKey: 'd1', box };
  const c = { atMs: 11000, documentKey: 'd2', box };
  const marks = [a, b, c];
  assert.equal(markAt(marks, 8000, 'd1'), a);
  assert.equal(markAt(marks, 10107, 'd1'), b, 'a mark made 2.5 s after another replaces it');
  assert.equal(markAt(marks, 10107, 'd1', a), a, 'the hovered mark wins while it shows');
  assert.equal(markAt(marks, 14000, 'd1', a), null);
  assert.equal(markAt(marks, 11000, 'd1'), b, 'a mark on another page is not drawn');
  assert.equal(markAt([{ atMs: 0, documentKey: 'd1', box: null }], 0, 'd1'), null);
});

test('the recorded window fits the stage whole, never cropped (board #16844)', () => {
  // Matt's window in rec_e2c98460: taller than wide.
  const tall = stageFit({ width: 1458, height: 1618 }, 660, 720);
  assert.ok(Math.abs(tall.height - 720) < 1e-9 && tall.scale * 1458 <= 660 && tall.left > 0);
  const wide = stageFit({ width: 1440, height: 900 }, 720, 720);
  assert.deepEqual(wide, { scale: 0.5, left: 0, height: 450 });
});

test('the transcript flow puts routes and marks between the spoken lines', () => {
  const flow = flowOf({
    routes: [{ atMs: 0, url: 'https://a.test/' }, { atMs: 5000, url: 'https://a.test/b' }],
    marks: [{ atMs: 5000, text: 'Marked “Total”' }],
    segments: [{ startMs: 1000, text: 'First.' }, { startMs: 5000, text: 'Here.' }, { startMs: 6000, text: '  ' }],
  });
  assert.deepEqual(flow.map((r) => [r.kind, r.atMs]), [['route', 0], ['line', 1000], ['route', 5000], ['mark', 5000], ['line', 5000]]);
  assert.equal(flow[0].first, true);
});

test('the transcript word follows the active revision', () => {
  const h = (source, provider, text = 'Hello.') => ({ activeRevision: 'r2', revisions: [{ revisionId: 'r1', source: 'live', segments: [] }, { revisionId: 'r2', source, provider, segments: [{ startMs: 0, text }] }] });
  assert.equal(transcriptWord(h('after-recording', 'browser-local')), 'improved');
  assert.equal(transcriptWord(h('after-recording', 'openai')), 'OpenAI');
  assert.equal(transcriptWord(h('live', 'browser-local')), 'live');
  assert.equal(transcriptWord(h('live', 'browser-local', ' ')), null);
  assert.equal(transcriptWord({ activeRevision: null, revisions: [] }), null);
  assert.equal(transcriptWord(null), null);
});

test('search finds a recording by title, site or words said', () => {
  const text = searchText({ title: 'Quarterly Report', url: 'https://app.example.com/r', history: { activeRevision: 'r1', revisions: [{ revisionId: 'r1', segments: [{ text: 'Revenue heading.' }] }] } });
  assert.ok(matches('', text));
  assert.ok(matches('quarterly', text));
  assert.ok(matches('revenue  REPORT', text));
  assert.ok(matches('example.com', text));
  assert.ok(!matches('revenue missing', text));
  assert.equal(mmss(61_900), '1:01');
});
