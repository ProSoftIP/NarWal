import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordableUrl } from '../../src/shared/protocol.js';
import { isQuotaError } from '../../src/store/db.js';

test('only web and file pages are recordable', () => {
  for (const url of ['https://example.com/', 'http://127.0.0.1:4801/x', 'file:///tmp/a.html']) assert.equal(recordableUrl(url).ok, true, url);
  for (const url of ['chrome://version', 'chrome-extension://abc/popup.html', 'about:blank', 'data:text/html,x', 'view-source:https://a.com', 'https://chromewebstore.google.com/detail/x', '', undefined]) {
    assert.equal(recordableUrl(url).ok, false, String(url));
  }
});

test('quota errors are recognised by name and by Chromium disk-full wording', () => {
  assert.equal(isQuotaError({ name: 'QuotaExceededError', message: '' }), true);
  assert.equal(isQuotaError({ name: 'UnknownError', message: 'Insufficient disk space' }), true);
  assert.equal(isQuotaError({ name: 'UnknownError', message: 'Internal error' }), false);
  assert.equal(isQuotaError({ name: 'AbortError', message: 'quota' }), false);
  assert.equal(isQuotaError(null), false);
});
