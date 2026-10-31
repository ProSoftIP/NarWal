// Interaction evidence resolves against the right document and time,
// including after scroll and layout change (board #16543).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { center, everything, near, observations, pageLog, rectOf, start, startFixture, stop, waitFor } from './harness.ts';
import type { Fixture } from './harness.ts';

let fx: Fixture;
before(async () => {
  fx = await startFixture();
});
after(() => fx.close());

test('dwell is derived, keeps the geometry from arrival, and short passes are not dwells', async () => {
  const page = await fx.open();
  await start(page);
  const help = await center(page, '#help');
  await page.mouse.move(help.x, help.y);
  await page.waitForTimeout(50);
  const buy = await rectOf(page, '#buy');
  await page.mouse.move(buy.x + buy.w / 2, buy.y + buy.h / 2);
  await page.waitForTimeout(450);
  // Layout changes under the still pointer: the button moves away.
  await page.evaluate(() => (document.getElementById('spacer')!.style.height = '200px'));
  await page.waitForTimeout(400);
  const [dwell] = await waitFor(page, 'pointer-dwell');
  assert.equal(dwell.basis, 'derived');
  assert.equal(dwell.doc, 'd0');
  assert.equal(dwell.target.name, 'Buy now');
  near(dwell.target.box, buy);
  assert.ok(dwell.endMs - dwell.atMs >= 300);
  const all = await observations(page);
  assert.ok(!all.some((o) => o.kind === 'pointer-dwell' && o.target.name === 'Open help'), 'a 50 ms pass is not a dwell');
  assert.ok(!all.some((o) => o.kind === 'click' || o.kind.startsWith('marker')));
});

test('geometry after scroll and layout change is measured when each event happens', async () => {
  const page = await fx.open();
  await start(page);
  const before = await rectOf(page, '#buy');
  await page.mouse.click(before.x + before.w / 2, before.y + before.h / 2);
  await page.evaluate(() => (document.getElementById('spacer')!.style.height = '150px'));
  await page.mouse.wheel(0, 100);
  const [scroll] = await waitFor(page, 'scroll');
  assert.equal(scroll.target, null);
  assert.deepEqual(scroll.from, { x: 0, y: 0 });
  const moved = await rectOf(page, '#buy');
  assert.ok(moved.scrollY > 0);
  assert.deepEqual(scroll.to, { x: 0, y: moved.scrollY });
  await page.mouse.click(moved.x + moved.w / 2, moved.y + moved.h / 2);
  const clicks = await waitFor(page, 'click', 2);
  near(clicks[0].target.box, before);
  near(clicks[1].target.box, moved);
  assert.deepEqual(clicks[0].scroll, { x: 0, y: 0 });
  assert.deepEqual(clicks[1].scroll, { x: 0, y: moved.scrollY });
  // Document position = box + scroll, and it moved by exactly the inserted 150px.
  const doc = (c: (typeof clicks)[number]) => c.target.box.y + c.scroll.y;
  assert.ok(Math.abs(doc(clicks[1]) - doc(clicks[0]) - 150) <= 1);
  assert.ok(clicks[0].atMs <= scroll.atMs && scroll.endMs <= clicks[1].atMs, 'observations are in time order');
});

test('clicks: count, middle button, keyboard activation; element scroll runs', async () => {
  const page = await fx.open();
  await start(page);
  await page.dblclick('#buy');
  const docs = await center(page, '#docs');
  await page.mouse.click(docs.x, docs.y, { button: 'middle' });
  await page.focus('#help');
  await page.keyboard.press('Enter');
  await page.$eval('#list', (el) => el.scrollTo(0, 90));
  const clicks = await waitFor(page, 'click', 4);
  assert.deepEqual(
    clicks.map((c) => [c.target.name, c.button, c.count, c.point === undefined]),
    [
      ['Buy now', 'left', 1, false],
      ['Buy now', 'left', 2, false],
      ['Read the docs', 'middle', 1, false],
      ['Open help', 'left', 1, true],
    ],
  );
  const [scroll] = await waitFor(page, 'scroll');
  assert.equal(scroll.target?.tag, 'ul');
  assert.deepEqual([scroll.from, scroll.to], [{ x: 0, y: 0 }, { x: 0, y: 90 }]);
});

test('same-document route changes carry the transition', async () => {
  const page = await fx.open('/app/home');
  await start(page);
  await page.evaluate(() => {
    history.pushState({}, '', '/app/two');
    document.title = 'Second';
  });
  await waitFor(page, 'route');
  await page.evaluate(() => history.replaceState({}, '', '/app/two?tab=b'));
  await waitFor(page, 'route', 2);
  await page.evaluate(() => (location.hash = 'details'));
  await waitFor(page, 'route', 3);
  await page.goBack();
  const routes = await waitFor(page, 'route', 4);
  assert.deepEqual(
    routes.map((r) => [new URL(r.url).pathname + new URL(r.url).search + new URL(r.url).hash, r.transition]),
    [
      ['/app/two', 'history-push'],
      ['/app/two?tab=b', 'history-replace'],
      ['/app/two?tab=b#details', 'hash'],
      ['/app/two?tab=b', 'hash'],
    ],
  );
  await page.goBack();
  const [, , , , back] = await waitFor(page, 'route', 5);
  assert.equal(new URL(back.url).pathname, '/app/home');
  assert.equal(back.transition, 'popstate');
});

test('viewport and exclusion changes are recorded', async () => {
  const page = await fx.open();
  await start(page, ['#secret']);
  const [first] = await waitFor(page, 'viewport');
  assert.deepEqual([first.w, first.h], [1000, 700]);
  await page.setViewportSize({ width: 800, height: 600 });
  const [, second] = await waitFor(page, 'viewport', 2);
  assert.deepEqual([second.w, second.h], [800, 600]);
  await page.evaluate(() => {
    document.getElementById('secret')!.remove();
    const added = document.createElement('div');
    added.setAttribute('data-narwal-exclude', '');
    added.textContent = 'late SECRET';
    document.body.append(added);
  });
  const exclusions = await waitFor(page, 'exclusion', 3);
  assert.deepEqual(
    exclusions.map((e) => [e.state, e.target.tag, e.target.excluded, e.target.name]),
    [
      ['added', 'div', true, undefined],
      ['added', 'div', true, undefined],
      ['removed', 'div', true, undefined],
    ],
  );
  assert.equal(exclusions[2].target.node, exclusions[0].target.node, 'removal names the region that was added');
});

test('each frame records its own document in its own coordinates', async () => {
  const page = await fx.open();
  await start(page);
  const frame = page.frame({ url: /frame\.html/ })!;
  await frame.evaluate(() => (window as any).narwal.start());
  const iframe = await rectOf(page, '#frame');
  const inner = await frame.$eval('#inner', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.click(iframe.x + 1 + inner.x + inner.w / 2, iframe.y + 1 + inner.y + inner.h / 2);
  await frame.waitForFunction(() => (window as any).narwal.observations.some((o: any) => o.kind === 'click'));
  const frameClick = (await frame.evaluate(() => (window as any).narwal.observations)).find((o: any) => o.kind === 'click');
  assert.equal(frameClick.doc, 'd1');
  assert.equal(frameClick.target.name, 'Inner button');
  near(frameClick.target.box, inner);
  const top = await observations(page);
  assert.ok(!top.some((o) => o.kind === 'click'), 'the parent does not record the frame click');
});

test('the region picker hides chosen regions before capture without activating the page', async () => {
  const page = await fx.open();
  await page.evaluate(() => (window as any).narwal.pick());
  const promoButton = await center(page, '#promo-btn');
  await page.mouse.move(promoButton.x, promoButton.y);
  await page.mouse.click(promoButton.x, promoButton.y);
  // Widen from the button to the whole promo block, then swap the selection over to it.
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  // Keyboard path: Tab to a focusable element and hide it.
  await page.focus('#help');
  await page.keyboard.press('Space');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as any).narwal.picked !== null);
  const picked: string[] = await page.evaluate(() => (window as any).narwal.picked);
  assert.equal(picked.length, 2, picked.join());
  assert.deepEqual(await page.$$eval('[data-narwal-exclude]', (els) => els.map((e) => e.id)), ['help', 'promo']);
  for (const selector of picked) assert.match(selector, /^[a-z0-9 >:()-]+$/, 'structural selectors only');
  assert.deepEqual(await pageLog(page), [], 'picking activated nothing');
  assert.equal(await page.$('[data-narwal-ui="highlights"]'), null, 'the picker overlay is gone');

  // A reload keeps the choice through the selectors alone.
  await page.reload();
  await start(page, picked);
  await page.click('#promo-btn');
  await page.waitForTimeout(100);
  await stop(page);
  const text = await everything(page);
  assert.ok(!text.includes('PROMO-TEXT') && !text.includes('Promo button') && !text.includes('Open help'));
  const click = (await observations(page)).find((o) => o.kind === 'click');
  assert.ok(click && click.kind === 'click' && click.target.excluded);
});

test('the picker keeps areas the site marks, ignores page scripts and cancels on Escape', async () => {
  const page = await fx.open();
  await page.evaluate(() => document.getElementById('secret')!.setAttribute('data-narwal-exclude', ''));
  await page.evaluate(() => (window as any).narwal.pick());
  const marked = () => page.$$eval('[data-narwal-exclude]', (els) => els.map((e) => e.id));
  // A click in the area the site marks does not show it.
  const balance = await center(page, '#balance');
  await page.mouse.click(balance.x, balance.y);
  assert.deepEqual(await marked(), ['secret']);
  // A click a page script dispatches picks nothing.
  await page.evaluate(() => document.getElementById('promo')!.click());
  assert.deepEqual(await marked(), ['secret']);
  const intro = await center(page, '#intro');
  await page.mouse.click(intro.x, intro.y);
  assert.deepEqual(await marked(), ['intro', 'secret']);
  // Escape goes back to what was hidden when the picker opened.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => (window as any).narwal.picked !== null);
  assert.deepEqual(await page.evaluate(() => (window as any).narwal.picked), [], 'the site-marked area is not a user selection');
  assert.deepEqual(await marked(), ['secret']);
});

test('a second picker on the same page keeps the first one\'s areas as the user\'s', async () => {
  const page = await fx.open();
  const marked = () => page.$$eval('[data-narwal-exclude]', (els) => els.map((e) => e.id));
  const pickOnce = async (id: string) => {
    await page.evaluate(() => {
      (window as any).narwal.picked = null;
      (window as any).narwal.pick();
    });
    const at = await center(page, `#${id}`);
    await page.mouse.click(at.x, at.y);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => (window as any).narwal.picked !== null);
    return (await page.evaluate(() => (window as any).narwal.picked)) as string[];
  };
  assert.equal((await pickOnce('intro')).length, 1);
  // No reload: #intro still carries the attribute, but it is the user's area, not the site's.
  const both = await pickOnce('promo-title');
  assert.equal(both.length, 2, both.join());
  assert.deepEqual(await marked(), ['intro', 'promo-title']);
  // The user can still show it again in a later picker.
  const after = await pickOnce('intro');
  assert.equal(after.length, 1, after.join());
  assert.deepEqual(await marked(), ['promo-title']);
});

test('an area the site marks while the picker is open is locked', async () => {
  const page = await fx.open();
  await page.evaluate(() => (window as any).narwal.pick());
  await page.evaluate(() => document.getElementById('secret')!.setAttribute('data-narwal-exclude', ''));
  const balance = await center(page, '#balance');
  await page.mouse.click(balance.x, balance.y);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as any).narwal.picked !== null);
  assert.deepEqual(await page.evaluate(() => (window as any).narwal.picked), [], 'the site mark is not a user selection');
  assert.deepEqual(await page.$$eval('[data-narwal-exclude]', (els) => els.map((e) => e.id)), ['secret']);
});

test('page-dispatched input and change events are not recorded as form edits', async () => {
  const page = await fx.open();
  await start(page, [], { editBurstMs: 50 });
  await page.evaluate(() => {
    const email = document.getElementById('email') as HTMLInputElement;
    email.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: 'x' }));
    email.dispatchEvent(new Event('change', { bubbles: true }));
    const agree = document.getElementById('agree') as HTMLInputElement;
    agree.checked = true;
    agree.dispatchEvent(new Event('input', { bubbles: true }));
    agree.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(150);
  assert.equal((await observations(page)).filter((o) => o.kind === 'input').length, 0);
  // A real edit is still recorded.
  await page.fill('#email', '');
  await page.type('#email', 'ab');
  const [edit] = await waitFor(page, 'input');
  assert.equal(edit.target.name, 'Email');
  await stop(page);
});
