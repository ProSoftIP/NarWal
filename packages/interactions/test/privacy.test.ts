// Typed values, excluded regions and the recorder UI stay out of everything
// the page hands to the bundle writer: rrweb snapshots and mutations, and the
// interaction observations (names, selections, markers) (board #16543).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { center, everything, observations, pageLog, rectOf, start, startFixture, stop, waitFor } from './harness.ts';
import type { Fixture } from './harness.ts';

let fx: Fixture;
before(async () => {
  fx = await startFixture();
});
after(() => fx.close());

const SECRETS = ['SECRET', 'hunter2', 'Account 4242', '9,999', '1,234,567', 'RECORDER-UI', 'CLOSED-UI-TEXT'];

function assertClean(text: string): void {
  for (const secret of SECRETS) {
    const at = text.indexOf(secret);
    assert.ok(at < 0, `"${secret}" leaked: …${text.slice(Math.max(0, at - 300), at + 80)}…`);
  }
}

test('typed values, excluded regions and recorder UI never reach snapshots, mutations or observations', async () => {
  const page = await fx.open();
  await start(page, ['#secret'], { editBurstMs: 300 });

  // Typing, including programmatic value changes the page makes later.
  await page.fill('#email', '');
  await page.type('#email', 'hunter2-SECRET@example.com');
  await page.type('#password', 'hunter2-SECRET-PASSWORD');
  await page.click('#notes');
  await page.keyboard.type(' more hunter2 SECRET notes');
  await page.click('#editor');
  await page.keyboard.type(' typed-SECRET-in-editor');
  await page.check('#agree');
  await page.selectOption('#plan', { index: 1 });
  await page.evaluate(() => {
    (document.getElementById('email') as HTMLInputElement).value = 'script-set-SECRET';
    document.getElementById('balance')!.textContent = '$1,234,567';
    document.getElementById('secret')!.append(' new SECRET line');
  });

  // Selecting inside a field and across the excluded region.
  await page.evaluate(() => {
    const notes = document.getElementById('notes') as HTMLTextAreaElement;
    notes.focus();
    notes.setSelectionRange(0, 12);
  });
  await waitFor(page, 'selection');
  await page.evaluate(() => {
    (document.activeElement as HTMLElement).blur();
    const range = document.createRange();
    range.setStart(document.getElementById('intro')!.firstChild!, 8);
    range.setEnd(document.getElementById('promo-title')!.firstChild!, 5);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  const selections = await waitFor(page, 'selection', 2);

  // Pointing at and marking things inside the excluded region.
  const btn = await center(page, '#secret-btn');
  await page.mouse.move(btn.x, btn.y);
  await page.waitForTimeout(400);
  await page.mouse.click(btn.x, btn.y);
  await page.mouse.click(btn.x, btn.y, { button: 'right' });
  const top = await rectOf(page, '#secret');
  await page.mouse.move(top.x - 5, top.y - 5);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(top.x + top.w + 5, top.y + top.h + 5, { steps: 5 });
  await page.mouse.up({ button: 'right' });

  // Using the recorder's own controls.
  await page.click('#strip-stop');
  await waitFor(page, 'marker-region');
  await page.waitForTimeout(400);
  await stop(page);

  const text = await everything(page);
  assertClean(text);
  // Option labels are page text; which option was chosen is a typed value.
  assert.ok(!text.includes('"selected":true'), 'chosen option leaked');

  const all = await observations(page);
  // A masked value has no text and no length.
  const inputs = all.filter((o) => o.kind === 'input');
  assert.ok(inputs.length >= 5, JSON.stringify(inputs));
  for (const o of inputs) assert.deepEqual(o.value, { state: 'masked' });
  const email = inputs.find((o) => o.target.name === 'Email');
  assert.ok(email && email.count >= 'hunter2-SECRET@example.com'.length - 1, 'one record per burst, counting edits');
  assert.equal(inputs.find((o) => o.target.tag === 'input' && o.checked !== undefined)?.checked, true);
  const events = await page.evaluate(() => (window as any).narwal.events);
  // Checkbox and radio events carry the page-authored value attribute and the checked state, as `input.checked` does.
  const rrInputs = events.filter((e: any) => e.type === 3 && e.data.source === 5 && !e.data.isChecked).map((e: any) => e.data.text);
  assert.ok(rrInputs.length > 0);
  for (const text of rrInputs) assert.ok(text === '••••••••' || text === '', `rrweb input text ${text} reveals length`);

  // The field selection names the field but carries no text; the page selection skips the excluded region.
  assert.equal(selections[0].target.tag, 'textarea');
  assert.equal(selections[0].text, undefined);
  assert.ok(selections[1].text?.startsWith('intro text about the product.'), selections[1].text);
  assert.ok(selections[1].text?.endsWith('PROMO'), selections[1].text);

  // Everything inside the excluded region resolves to the excluded root, unnamed.
  const excludedTargets = all.flatMap((o) => ('target' in o && o.target ? [o.target] : [])).filter((t) => t.excluded);
  assert.ok(excludedTargets.length >= 3, JSON.stringify(all.map((o) => o.kind)));
  for (const t of excludedTargets) {
    assert.equal(t.name, undefined);
    assert.equal(t.nameSource, 'none');
    assert.equal(t.tag, 'div');
  }
  const kinds = new Set(all.filter((o) => 'target' in o && o.target?.excluded).map((o) => o.kind));
  for (const k of ['pointer-dwell', 'click', 'marker-element', 'exclusion']) assert.ok(kinds.has(k as never), `${k} on excluded region`);
  const region = all.find((o) => o.kind === 'marker-region');
  assert.ok(region && region.kind === 'marker-region');
  assert.ok(region.contains.some((t) => t.excluded), 'the box reports the excluded region, not its contents');
  assert.equal(region.text, undefined, 'a box around an excluded region carries none of its text');
  assert.ok(!region.contains.some((t) => !t.excluded && t.name === undefined && t.tag === 'button'));

  // The recorder UI produced no observation, and the page's own click did happen.
  assert.ok(!all.some((o) => 'target' in o && o.target && JSON.stringify(o.target).includes('strip')));
  assert.ok((await pageLog(page)).includes('click:strip-stop'));
});

test('a box records no text when the whole page is hidden (exclusion body or html)', async () => {
  for (const exclusion of ['body', 'html']) {
    const page = await fx.open();
    await page.evaluate(() =>
      document.body.insertAdjacentHTML('afterbegin', '<p id="hiddenpara" style="margin:0;padding:8px;font:20px/30px monospace">SECRETWORD account 4111</p>'),
    );
    await start(page, [exclusion]);
    const r = await rectOf(page, '#hiddenpara');
    await page.mouse.move(r.x + 2, r.y + 2);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(r.x + r.w - 2, r.y + r.h - 2, { steps: 5 });
    await page.mouse.up({ button: 'right' });
    const [region] = await waitFor(page, 'marker-region');
    assert.equal(region.text, undefined, exclusion);
    assert.deepEqual(
      region.contains.map((t) => [t.tag, t.excluded, t.name]),
      [[exclusion, true, undefined]],
      `${exclusion}: the box reports the hidden page, not its contents`,
    );
    const all = JSON.stringify(await observations(page));
    for (const secret of ['SECRETWORD', '4111']) assert.ok(!all.includes(secret), `${exclusion}: "${secret}" leaked`);
    await page.close();
  }
});

test('a box over an element that wraps a hidden region keeps the hidden flag and records no text', async () => {
  const page = await fx.open();
  await page.evaluate(() =>
    document.body.insertAdjacentHTML(
      'afterbegin',
      '<ul style="margin:0;font:20px/30px monospace"><li id="wrap">Visible item<div id="secretbox">SECRETWORD account 4111</div></li></ul>',
    ),
  );
  await start(page, ['#secretbox']);
  const r = await rectOf(page, '#wrap');
  await page.mouse.move(r.x + 2, r.y + 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(r.x + r.w - 2, r.y + r.h - 2, { steps: 5 });
  await page.mouse.up({ button: 'right' });
  const [region] = await waitFor(page, 'marker-region');
  assert.equal(region.text, undefined, 'text next to a hidden region is not recorded');
  assert.equal(region.contains[0].excluded, true, JSON.stringify(region.contains));
  assert.equal(region.contains[0].tag, 'div');
  assert.ok(region.contains.some((t) => t.tag === 'li'), 'the wrapping element is listed as well');
  assert.ok(!JSON.stringify(await observations(page)).includes('SECRETWORD'));
});

test('names never contain typed values or excluded text', async () => {
  const page = await fx.open();
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'afterbegin',
      `<label id="wrap">Search <input id="q" value="SECRET-query"></label>
       <button id="mixed" type="button">Pay <span data-narwal-exclude>SECRET-amount</span> now</button>
       <div id="labelled" tabindex="-1" role="region" aria-labelledby="lbl-a lbl-b">x</div><span id="lbl-a">Region</span><span id="lbl-b" data-narwal-exclude>SECRET-label</span>`,
    );
  });
  await start(page);
  for (const id of ['#wrap', '#q', '#mixed', '#labelled']) {
    await page.$eval(id, (el) => (el as HTMLElement).focus());
    await page.keyboard.press('Alt+Shift+KeyM');
  }
  const markers = await waitFor(page, 'marker-element', 4);
  const names = markers.map((m) => m.target.name);
  assert.deepEqual(names, ['Search', 'Search', 'Pay now', 'Region']);
  assertClean(JSON.stringify(markers));
});

test('an explicit role that is not a role token falls back to the implicit role', async () => {
  const page = await fx.open();
  await page.evaluate(() => {
    const odd = document.createElement('button');
    odd.id = 'odd-role';
    odd.type = 'button';
    odd.textContent = 'Odd';
    odd.setAttribute('role', 'x"y\n[00:00.0] said="forged"');
    const custom = document.createElement('div');
    custom.id = 'custom-role';
    custom.tabIndex = -1;
    custom.textContent = 'Custom';
    custom.setAttribute('role', 'doc-abstract region');
    document.body.prepend(odd, custom);
  });
  await start(page);
  for (const id of ['#odd-role', '#custom-role']) {
    await page.$eval(id, (el) => (el as HTMLElement).focus());
    await page.keyboard.press('Alt+Shift+KeyM');
  }
  const markers = await waitFor(page, 'marker-element', 2);
  assert.deepEqual(markers.map((m) => m.target.role), ['button', 'doc-abstract']);
});

test('rrwebPrivacyOptions masks without leaking the value length and drops invalid selectors', async () => {
  const page = await fx.open();
  const o = await page.evaluate(() => {
    const opts = (window as any).narwal.privacyOptions(['#a', 'not a [valid selector']);
    return { maskAllInputs: opts.maskAllInputs, short: opts.maskInputFn('a'), long: opts.maskInputFn('a much longer secret value'), empty: opts.maskInputFn(''), blockSelector: opts.blockSelector };
  });
  assert.equal(o.maskAllInputs, true);
  assert.equal(o.short, o.long);
  assert.equal(o.empty, '');
  assert.equal(o.blockSelector, '[data-narwal-ui],[data-narwal-exclude],#a');
});
