// The icons and logo (board #16597): the manifest points at real PNGs of the
// declared size, the icons sit on a white rounded square (#16601), and every
// copy of the logo is the branding master.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { LOGO_EYE, LOGO_PATHS, LOGO_VIEWBOX, eyeRadius } from '../../../recorder-ui/src/logo.js';

const file = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const manifest = JSON.parse(readFileSync(file('app/manifest.json'), 'utf8'));
const master = readFileSync(file('branding/narwal.svg'), 'utf8');

function pngSize(path) {
  const bytes = readFileSync(file(`app/${path}`));
  assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG', `${path} is a PNG`);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

test('the manifest icons are PNGs of the declared size', () => {
  assert.deepEqual(Object.keys(manifest.icons), ['16', '32', '48', '128']);
  for (const [size, path] of Object.entries(manifest.icons)) {
    assert.deepEqual(pngSize(path), [Number(size), Number(size)], path);
  }
});

/** RGBA pixels of an 8-bit RGBA, non-interlaced PNG (what rsvg-convert writes). */
function pngPixels(path) {
  const bytes = readFileSync(file(`app/${path}`));
  const [width, height] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  assert.deepEqual([bytes[24], bytes[25], bytes[28]], [8, 6, 0], `${path} is 8-bit RGBA, not interlaced`);
  const idat = [];
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    if (bytes.subarray(at + 4, at + 8).toString('latin1') === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x];
      const a = x >= 4 ? out[y * stride + x - 4] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter];
      out[y * stride + x] = (value + predictor) & 0xff;
    }
  }
  return { pixel: (x, y) => [...out.subarray(y * stride + x * 4, y * stride + x * 4 + 4)] };
}

test('the icons sit on a white rounded square, so they show on a dark toolbar (#16601)', () => {
  for (const [size, path] of Object.entries(manifest.icons)) {
    const n = Number(size);
    const { pixel } = pngPixels(path);
    const mid = Math.floor(n / 2);
    for (const [x, y] of [[mid, 0], [0, mid], [mid, n - 1], [n - 1, mid]]) {
      assert.deepEqual(pixel(x, y), [255, 255, 255, 255], `${path}: the edge at ${x},${y} is opaque white`);
    }
    assert.equal(pixel(0, 0)[3], 0, `${path}: the corner is rounded off (transparent)`);
  }
});

test('the toolbar uses the same icons and keeps its other action fields', () => {
  assert.deepEqual(manifest.action.default_icon, manifest.icons);
  assert.equal(manifest.action.default_title, 'NarWal');
  assert.equal(manifest.action.default_popup, 'popup.html');
});

test('the logo the recordings page loads is the branding master', () => {
  assert.equal(readFileSync(file('app/logo/narwal.svg'), 'utf8'), master);
});

test('the inline logo (recorder-ui) draws the master paths', () => {
  assert.match(master, new RegExp(`viewBox="${LOGO_VIEWBOX}"`));
  const paths = [...master.matchAll(/<path [^>]*fill="(#[0-9A-F]{6})" d="([^"]+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(LOGO_PATHS, paths);
  const eye = master.match(/<circle id="eye" cx="(\d+)" cy="(\d+)" r="([\d.]+)"/);
  assert.deepEqual(LOGO_EYE, { cx: Number(eye[1]), cy: Number(eye[2]), r: Number(eye[3]) });
});

test('small drawings enlarge the eye as the small icons do (branding/build.cjs)', () => {
  const build = readFileSync(file('branding/build.cjs'), 'utf8');
  const radii = JSON.parse(build.match(/EYE_RADIUS = (\{[^}]+\})/)[1].replace(/(\d+):/g, '"$1":'));
  for (const [size, r] of Object.entries(radii)) assert.equal(eyeRadius(Number(size)), r, `${size} px`);
});
