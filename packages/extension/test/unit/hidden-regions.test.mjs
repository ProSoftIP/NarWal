import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HIDDEN_CLASS,
  MAX_AREAS,
  areasForDocument,
  cleanAreas,
  fingerprintOf,
  lostText,
  markHiddenAreas,
  pageKey,
  resolveAreas,
  sameFingerprint,
  textHash,
} from '../../src/shared/hidden-regions.js';

test('a page is its origin and path: the query and fragment do not count', () => {
  assert.equal(pageKey('https://a.example/pay/run?week=3#top'), 'https://a.example/pay/run');
  assert.equal(pageKey('not a url'), null);
  assert.equal(pageKey(undefined), null);
});

const fp = (over = {}) => ({ tag: 'section', w: 300, h: 80, text: textHash('Salary 1,234'), ...over });

test('the text hash ignores white space and never carries the text', () => {
  assert.equal(textHash('Salary  1,234\n'), textHash(' Salary 1,234'));
  assert.notEqual(textHash('Salary 1,234'), textHash('Salary 1,235'));
  assert.match(textHash('Salary 1,234'), /^[0-9a-f]{8}$/);
  assert.equal(textHash(undefined), textHash(''));
});

test('areas from a message have a selector and a fingerprint, without repeats, bounded', () => {
  assert.equal(cleanAreas('div'), null);
  const good = { selector: 'main > div', fp: fp() };
  assert.deepEqual(
    cleanAreas([
      good,
      good,
      { selector: 'aside', fp: fp({ extra: 'x' }) },
      { selector: 'nav' },
      { selector: 'nav', fp: fp({ text: 'Salary 1,234' }) },
      { selector: 'nav', fp: fp({ tag: 'IMG onerror' }) },
      { selector: 'nav', fp: fp({ w: 'wide' }) },
      { selector: 'nav', fp: fp({ key: 'account' }) },
      { selector: 'main', fp: fp({ key: textHash('id=account') }) },
      { selector: '', fp: fp() },
      { selector: 'x'.repeat(2001), fp: fp() },
      3,
      null,
    ]),
    [good, { selector: 'aside', fp: fp() }, { selector: 'main', fp: fp({ key: textHash('id=account') }) }],
  );
  const many = Array.from({ length: 80 }, (_, i) => ({ selector: `div:nth-of-type(${i + 1})`, fp: fp() }));
  assert.equal(cleanAreas(many).length, MAX_AREAS);
});

test('a fingerprint matches the same element after a small resize only', () => {
  assert.ok(sameFingerprint(fp(), fp({ w: 310, h: 90 })));
  assert.ok(sameFingerprint(fp({ w: 1000 }), fp({ w: 1200 })));
  assert.ok(!sameFingerprint(fp(), fp({ w: 600 })));
  assert.ok(!sameFingerprint(fp(), fp({ tag: 'div' })));
  assert.ok(!sameFingerprint(fp(), fp({ text: textHash('Other') })));
  assert.ok(!sameFingerprint(fp(), null));
});

test('an element with the same identity attributes is the same element when its text changes', () => {
  const key = textHash('id=live');
  const live = fp({ key });
  assert.ok(sameFingerprint(live, fp({ key, text: textHash('Salary 1,999') })));
  assert.ok(!sameFingerprint(live, fp({ key: textHash('id=banner'), text: textHash('Cookies') })));
  assert.ok(!sameFingerprint(live, fp({ text: textHash('Cookies') })), 'no key: the text decides');
  assert.ok(!sameFingerprint(fp(), fp({ text: textHash('Cookies') })), 'two elements without keys never match by key');
  assert.ok(!sameFingerprint(live, fp({ key, w: 900 })), 'the size still counts');
});

// A document stub: querySelectorAll by exact selector, elements with a box and text.
function stubDocument(bySelector) {
  return {
    querySelectorAll(selector) {
      if (selector === 'bad[') throw new SyntaxError('not a selector');
      return bySelector[selector] || [];
    },
  };
}
const element = (tag, w, h, text, attrs = {}) => ({
  tagName: tag.toUpperCase(),
  textContent: text,
  getAttribute: (name) => attrs[name] ?? null,
  getBoundingClientRect: () => ({ width: w, height: h }),
});

test('an area counts as hidden only while its selector finds the same one element', () => {
  const salary = element('section', 300, 80, 'Salary 1,234');
  const picked = fingerprintOf(salary);
  assert.deepEqual(picked, fp());
  const doc = stubDocument({
    '#one': [salary],
    '#moved': [element('section', 300, 80, 'Welcome back')],
    '#two': [salary, element('section', 300, 80, 'Salary 1,234')],
  });
  const areas = (selector) => ({ selector, fp: picked });
  const { found, lost } = resolveAreas(doc, [areas('#one'), areas('#moved'), areas('#two'), areas('#gone'), areas('bad[')]);
  assert.deepEqual(found, [{ selector: '#one', element: salary }]);
  assert.equal(lost, 4);
  assert.deepEqual(resolveAreas(doc, undefined), { found: [], lost: 0 });
});

test('fingerprintOf hashes the identity attributes, never stores them', () => {
  const panel = element('section', 300, 80, 'Salary 1,234', { id: 'pay-panel', class: 'live open' });
  const picked = fingerprintOf(panel);
  assert.deepEqual(picked, fp({ key: textHash('id=pay-panel') }));
  assert.ok(!JSON.stringify(picked).includes('pay-panel'));
  const later = element('section', 300, 90, 'Salary 2,000', { id: 'pay-panel', class: 'live' });
  assert.equal(resolveAreas(stubDocument({ '#p': [later] }), [{ selector: '#p', fp: picked }]).found.length, 1);
});

test('the lost message says how many areas and what to do', () => {
  assert.equal(lostText(1), '1 hidden area could not be found. The page changed since you hid it: pick the areas to hide again.');
  assert.match(lostText(3), /^3 hidden areas could not be found\./);
});

test('hidden areas apply to the top frame of the page they were picked on only', () => {
  const list = [{ selector: 'main > section', fp: fp() }];
  const hidden = { page: 'https://a.example/pay', areas: list };
  assert.deepEqual(areasForDocument(hidden, { href: 'https://a.example/pay?x=1', isTop: true }), list);
  assert.deepEqual(areasForDocument(hidden, { href: 'https://a.example/pay', isTop: false }), []);
  assert.deepEqual(areasForDocument(hidden, { href: 'https://a.example/other', isTop: true }), []);
  assert.deepEqual(areasForDocument(hidden, { href: 'https://b.example/pay', isTop: true }), []);
  assert.deepEqual(areasForDocument(null, { href: 'https://a.example/pay', isTop: true }), []);
  // Gap regression (#16592): no hidden areas means none, never an error.
  assert.deepEqual(areasForDocument(undefined, { href: 'https://a.example/pay', isTop: true }), []);
  // A recording saved before areas had fingerprints hides nothing by selector alone.
  assert.deepEqual(areasForDocument({ page: 'https://a.example/pay', selectors: ['main'] }, { href: 'https://a.example/pay', isTop: true }), []);
});

const blocked = (id, cls) => ({ type: 2, id, tagName: 'section', attributes: { ...(cls ? { class: cls } : {}), rr_width: '300px', rr_height: '80px' }, childNodes: [] });

test('replay marks blocked elements in snapshots and added nodes, once', () => {
  const events = [
    { type: 4, data: { href: 'https://a.example/pay' } },
    {
      type: 2,
      data: {
        node: {
          type: 0,
          childNodes: [{ type: 2, id: 2, tagName: 'body', attributes: {}, childNodes: [blocked(3), { type: 3, id: 4, textContent: 'Visible' }] }],
        },
      },
    },
    { type: 3, data: { source: 0, adds: [{ parentId: 2, node: blocked(5, 'card') }], removes: [], texts: [], attributes: [] } },
    { type: 3, data: { source: 2, type: 2 } },
  ];
  markHiddenAreas(events);
  markHiddenAreas(events);
  const body = events[1].data.node.childNodes[0];
  assert.equal(body.attributes.class, undefined);
  assert.equal(body.childNodes[0].attributes.class, HIDDEN_CLASS);
  assert.equal(events[2].data.adds[0].node.attributes.class, `card ${HIDDEN_CLASS}`);
});
