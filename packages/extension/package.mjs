// Builds the extension for people (no test hooks) and zips app/ for a private
// load-unpacked install (board #16552, docs/install-unpacked.md). The zip
// holds one folder, narwal/, which is the folder to choose in Load unpacked.
//
//   node package.mjs   ->  release/narwal-<version>.zip
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { writeZip } from '../library/src/zip.ts';

execFileSync(process.execPath, ['build.mjs'], { stdio: 'inherit' });

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
})('app');

// A build with test hooks answers `test:` commands; one must never ship.
for (const path of files) {
  if (path.endsWith('.js') && readFileSync(path, 'utf8').includes("'test:model-install'")) {
    throw new Error(`${path} was built with test hooks; run node build.mjs without --test`);
  }
}
if (!files.includes(join('app', 'dist', 'THIRD-PARTY-NOTICES.txt'))) throw new Error('app/dist/THIRD-PARTY-NOTICES.txt is missing');

const { version } = JSON.parse(readFileSync('app/manifest.json', 'utf8'));
const zip = await writeZip(
  files.map((path) => ({
    path: `narwal/${relative('app', path).split('\\').join('/')}`,
    bytes: readFileSync(path),
    // Already-compressed files are stored as they are.
    compress: !/\.(zip|gz|png|jpg|webm)$/.test(path),
  })),
);
mkdirSync('release', { recursive: true });
const out = `release/narwal-${version}.zip`;
writeFileSync(out, zip);
console.log(`${out}: ${files.length} files, ${(zip.length / 1e6).toFixed(1)} MB`);
