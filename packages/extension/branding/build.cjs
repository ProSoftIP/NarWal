#!/usr/bin/env node
// Regenerates the NarWal icons and logo from narwal.svg (Matt's pack, option
// 23 white eye, board #16597). Needs rsvg-convert (librsvg).
//
//   node branding/build.cjs
//
// Writes app/icons/icon-{16,32,48,128}.png (the manifest icons; 128 is also
// the Web Store icon), app/logo/narwal.svg (the recordings page header) and
// branding/narwal-512.png (the repo README). The 16, 32 and 48 px icons
// enlarge the white eye so it still reads at that size; 128 and the logo keep
// the drawing's own eye. The icons sit on a white rounded square (corner 22%,
// narwhal at 80%) so they read on a dark toolbar (Matt, board #16601); the
// logo has no plate. recorder-ui/src/logo.js draws the same paths inline.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = __dirname;
const app = path.join(root, '..', 'app');
const master = fs.readFileSync(path.join(root, 'narwal.svg'), 'utf8');
const EYE_RADIUS = { 16: 45, 32: 28, 48: 24, 128: 21.5 };

if (!master.includes('r="21.5"')) throw new Error('narwal.svg: the eye circle (r="21.5") is missing');
const art = master.match(/  <g id="narwal">[\s\S]*?\n  <\/g>/);
if (!art) throw new Error('narwal.svg: the <g id="narwal"> group is missing');

/** The icon drawing: a white plate, then the narwhal at 80% in its middle, with an eye of `radius`. */
function plated(radius) {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1254" height="1254" viewBox="0 0 1254 1254" role="img" aria-label="NarWal">',
    '  <rect id="plate" x="0" y="0" width="1254" height="1254" rx="276" ry="276" fill="#FFFFFF"/>',
    '  <g id="art" transform="translate(627 627) scale(0.8) translate(-627 -627)">',
    art[0].replace('r="21.5"', `r="${radius}"`),
    '</g>',
    '</svg>',
    '',
  ].join('\n');
}
fs.mkdirSync(path.join(app, 'icons'), { recursive: true });
fs.mkdirSync(path.join(app, 'logo'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narwal-icons-'));
try {
  for (const [size, radius] of Object.entries(EYE_RADIUS)) {
    const svgFile = path.join(tmp, `icon-${size}.svg`);
    fs.writeFileSync(svgFile, plated(radius));
    execFileSync('rsvg-convert', ['-w', size, '-h', size, svgFile, '-o', path.join(app, 'icons', `icon-${size}.png`)]);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
fs.copyFileSync(path.join(root, 'narwal.svg'), path.join(app, 'logo', 'narwal.svg'));
execFileSync('rsvg-convert', ['-w', '512', '-h', '512', path.join(root, 'narwal.svg'), '-o', path.join(root, 'narwal-512.png')]);
console.log('Rendered 4 plated icons and the 512 px logo; copied narwal.svg to app/logo.');
