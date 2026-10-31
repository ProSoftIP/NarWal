// Right-button markers, the keyboard alternative and the native menu (board #16543).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { center, near, observations, pageLog, rectOf, start, startFixture, waitFor } from './harness.ts';
import type { Fixture } from './harness.ts';

let fx: Fixture;
before(async () => {
  fx = await startFixture();
});
after(() => fx.close());

test('right-click marks the element without activating it or opening the page menu', async () => {
  const page = await fx.open();
  await start(page);
  const at = await center(page, '#buy');
  await page.mouse.move(at.x, at.y);
  await page.evaluate(() => ((window as any).pageLog.length = 0));
  await page.mouse.click(at.x, at.y, { button: 'right' });
  const [marker] = await waitFor(page, 'marker-element');
  assert.equal(marker.basis, 'user-marked');
  assert.equal(marker.via, 'right-click');
  assert.equal(marker.target.name, 'Buy now');
  assert.equal(marker.target.role, 'button');
  near(marker.point, at);
  const r = await rectOf(page, '#buy');
  near(marker.target.box, { x: r.x, y: r.y, w: r.w, h: r.h });
  assert.deepEqual(await pageLog(page), [], 'the page saw none of the gesture');
  const all = await observations(page);
  assert.equal(all.filter((o) => o.kind === 'click').length, 0, 'a marker is not a click');
});

test('right-button drag marks a box with the elements inside it', async () => {
  const page = await fx.open();
  await start(page);
  const r = await rectOf(page, '#top');
  await page.mouse.move(r.x + 2, r.y + 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(r.x + 200, r.y + 30, { steps: 5 });
  await page.mouse.move(r.x + r.w - 2, r.y + r.h - 2, { steps: 5 });
  await page.mouse.up({ button: 'right' });
  const [region] = await waitFor(page, 'marker-region');
  assert.equal(region.basis, 'user-marked');
  assert.ok(region.endMs >= region.atMs);
  near(region.rect, { x: r.x + 2, y: r.y + 2, w: r.w - 4, h: r.h - 4 });
  const names = region.contains.map((t) => t.name);
  assert.ok(names.includes('Buy now') && names.includes('Open help') && names.includes('Read the docs'), names.join());
  for (let i = 1; i < region.contains.length; i++) {
    const a = region.contains[i - 1].box;
    const b = region.contains[i].box;
    assert.ok(a.w * a.h >= b.w * b.h - 1, 'largest overlap first');
  }
  const all = await observations(page);
  assert.equal(all.filter((o) => o.kind === 'marker-element' || o.kind === 'click').length, 0);
  assert.deepEqual(await pageLog(page), []);
});

test('a box narrower than a paragraph records the paragraph and the text inside the box (#16604)', async () => {
  const page = await fx.open();
  // Monospace columns of three-letter words: the box covers columns 2-3 of lines 1-2.
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'afterbegin',
      `<p id="long" style="margin:0;padding:8px;width:700px;font:20px/30px monospace">aaa bbb ccc ddd eee<br>fff ggg <b>hhh</b> iii jjj<br>kkk lll mmm nnn ooo</p>`,
    );
  });
  await start(page);
  const words = await page.evaluate(() => {
    const p = document.getElementById('long')!;
    const range = document.createRange();
    const rectOfWord = (word: string) => {
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const at = n.nodeValue!.indexOf(word);
        if (at < 0) continue;
        range.setStart(n, at);
        range.setEnd(n, at + word.length);
        const r = range.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }
      throw new Error(word);
    };
    return { bbb: rectOfWord('bbb'), ccc: rectOfWord('ccc'), hhh: rectOfWord('hhh') };
  });
  const p = await rectOf(page, '#long');
  const from = { x: words.bbb.x - 3, y: words.bbb.y + 2 };
  const to = { x: words.ccc.x + words.ccc.w + 3, y: words.hhh.y + words.hhh.h - 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up({ button: 'right' });
  const [region] = await waitFor(page, 'marker-region');
  assert.ok(region.rect.w * region.rect.h < (p.w * p.h) / 4, 'the box covers far less than half the paragraph');
  assert.equal(region.text, 'bbb ccc ggg hhh');
  assert.equal(region.contains.length, 1, JSON.stringify(region.contains));
  assert.equal(region.contains[0].tag, 'p');
  assert.equal(region.contains[0].name, 'aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll mmm nnn ooo');
});

test('a box over no text has no text', async () => {
  const page = await fx.open();
  await page.evaluate(() => document.body.insertAdjacentHTML('afterbegin', '<div id="blank" style="height:120px;width:300px"></div>'));
  await start(page);
  const r = await rectOf(page, '#blank');
  await page.mouse.move(r.x + 10, r.y + 10);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(r.x + 200, r.y + 100, { steps: 5 });
  await page.mouse.up({ button: 'right' });
  const [region] = await waitFor(page, 'marker-region');
  assert.equal(region.text, undefined);
  assert.deepEqual(region.contains, []);
});

test('a drag box keeps document geometry when the page scrolls during the drag', async () => {
  const page = await fx.open();
  await start(page);
  const r = await rectOf(page, '#intro');
  await page.mouse.move(r.x + 1, r.y + 1);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(r.x + 100, r.y + 40, { steps: 4 });
  await page.evaluate(() => window.scrollBy(0, 30));
  await page.mouse.move(r.x + 100, r.y + 40, { steps: 1 });
  await page.mouse.up({ button: 'right' });
  const [region] = await waitFor(page, 'marker-region');
  assert.deepEqual(region.scroll, { x: 0, y: 30 });
  // The start corner is fixed in the document: at release it sits 30px higher in the viewport.
  near(region.rect, { y: r.y + 1 - 30, h: 40 - 1 + 30 });
});

test('Escape cancels a drag', async () => {
  const page = await fx.open();
  await start(page);
  const at = await center(page, '#intro');
  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(at.x + 80, at.y + 40, { steps: 4 });
  await page.keyboard.press('Escape');
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(150);
  const all = await observations(page);
  assert.equal(all.filter((o) => o.kind.startsWith('marker')).length, 0);
  assert.deepEqual(await pageLog(page), []);
});

test('Shift + right-click and keyboard menus pass through to the page', async () => {
  const page = await fx.open();
  await start(page);
  const at = await center(page, '#buy');
  // A completed marker first: the menu suppression must not linger.
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await waitFor(page, 'marker-element');
  await page.keyboard.down('Shift');
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.keyboard.up('Shift');
  const log = await pageLog(page);
  assert.ok(log.includes('contextmenu:buy'), log.join());
  assert.ok(!log.some((l) => l.endsWith(':prevented')), log.join());
  // A keyboard-invoked menu (menu key / Shift+F10) arrives as a contextmenu without a press.
  const reached = await page.evaluate(() => {
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    document.getElementById('buy')!.dispatchEvent(e);
    return !e.defaultPrevented;
  });
  assert.ok(reached);
  assert.equal((await observations(page)).filter((o) => o.kind === 'marker-element').length, 1);
});

test('Alt+Shift+M marks the focused element; with nothing focused, the element under the pointer', async () => {
  const page = await fx.open();
  await start(page);
  await page.focus('#email');
  await page.keyboard.press('Alt+Shift+KeyM');
  const [focused] = await waitFor(page, 'marker-element');
  assert.equal(focused.via, 'keyboard-focus');
  assert.equal(focused.target.name, 'Email');
  assert.equal(focused.point, undefined);
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  const at = await center(page, '#help');
  await page.mouse.move(at.x, at.y);
  await page.evaluate(() => (window as any).narwal.capture.markFocused());
  const [, pointed] = await waitFor(page, 'marker-element', 2);
  assert.equal(pointed.via, 'keyboard-pointer');
  assert.equal(pointed.target.name, 'Open help');
  near(pointed.point, at);
});

test('markers are announced for screen readers and stay out of the recording', async () => {
  const page = await fx.open();
  await start(page);
  const at = await center(page, '#buy');
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await waitFor(page, 'marker-element');
  await page.waitForTimeout(100);
  const text = await page.evaluate(() => JSON.stringify((window as any).narwal.events));
  assert.ok(!text.includes('Marked'), 'the overlay live region is not recorded');
  // The overlay host is a blocked 0x0 placeholder in the rrweb stream.
  const host = await page.evaluate(() => {
    const found: any[] = [];
    const walk = (n: any) => {
      if (n && n.attributes?.class === 'narwal-ui') found.push(n);
      for (const c of n?.childNodes ?? []) walk(c);
    };
    for (const e of (window as any).narwal.events) {
      if (e.type === 2) walk(e.data.node);
      if (e.type === 3 && e.data.source === 0) for (const a of e.data.adds) walk(a.node);
    }
    return found;
  });
  assert.ok(host.length >= 1);
  for (const h of host) {
    assert.equal(h.tagName, 'div');
    assert.deepEqual(Object.keys(h.attributes).sort(), ['class', 'rr_height', 'rr_width']);
    assert.deepEqual(h.childNodes, []);
    assert.equal(h.attributes.rr_width, '0px');
    assert.equal(h.attributes.rr_height, '0px');
  }
});

test('page-dispatched pointer events make no marker and leave no open gesture', async () => {
  const page = await fx.open();
  await start(page);
  const buy = await center(page, '#buy');
  const top = await rectOf(page, '#top');
  await page.evaluate(
    ([b, r]) => {
      const fire = (type: string, x: number, y: number, buttons: number) =>
        document.elementFromPoint(x, y)!.dispatchEvent(
          new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true, button: type === 'pointermove' ? -1 : 2, buttons, clientX: x, clientY: y }),
        );
      // A forged right-click on "Buy now".
      fire('pointerdown', b.x, b.y, 2);
      fire('pointerup', b.x, b.y, 0);
      // A forged right-button drag over #top.
      fire('pointerdown', r.x + 2, r.y + 2, 2);
      fire('pointermove', r.x + 200, r.y + 30, 2);
      fire('pointerup', r.x + 200, r.y + 30, 0);
      // A forged press with no release: it must not open a gesture.
      fire('pointerdown', b.x, b.y, 2);
    },
    [buy, top] as const,
  );
  const log = await pageLog(page);
  assert.ok(log.includes('pointerdown:buy') && !log.some((l) => l.endsWith(':prevented')), 'the page keeps its own events: ' + log.join());
  // The user's next real move would complete an open gesture.
  await page.mouse.move(buy.x + 40, buy.y + 40, { steps: 3 });
  await page.waitForTimeout(150);
  let all = await observations(page);
  assert.equal(all.filter((o) => o.kind.startsWith('marker')).length, 0);
  // A real right-click elsewhere marks its own target, not the forged press point.
  const help = await center(page, '#help');
  await page.mouse.click(help.x, help.y, { button: 'right' });
  const [marker] = await waitFor(page, 'marker-element');
  assert.equal(marker.target.name, 'Open help');
  near(marker.point, help);
  all = await observations(page);
  assert.equal(all.filter((o) => o.kind.startsWith('marker')).length, 1);
});

test('a page-dispatched Alt+Shift+M makes no marker', async () => {
  const page = await fx.open();
  await start(page);
  await page.focus('#email');
  const reached = await page.evaluate(() => {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, composed: true, key: 'M', code: 'KeyM', altKey: true, shiftKey: true });
    document.activeElement!.dispatchEvent(e);
    return !e.defaultPrevented;
  });
  assert.ok(reached, 'the page keeps its own key event');
  await page.waitForTimeout(150);
  assert.equal((await observations(page)).filter((o) => o.kind.startsWith('marker')).length, 0);
  // The real shortcut still works.
  await page.keyboard.press('Alt+Shift+KeyM');
  const [marker] = await waitFor(page, 'marker-element');
  assert.equal(marker.via, 'keyboard-focus');
});
