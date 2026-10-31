// Bundles the extension's scripts into app/dist. `--test` builds the same
// code with test hooks (NARWAL_TEST) for the Playwright e2e run only.
//
// app/dist/runtime/ holds the offline transcription engines (board #16570):
// packages/offline-transcription builds them from its own pinned dependencies,
// so that package needs `npm ci` first.
//
// app/dist/THIRD-PARTY-NOTICES.txt covers the packages esbuild bundles here
// (board #16552). The build fails when a bundle holds a package with no
// notice in NOTICES, including one rrweb inlines in its own dist.
// app/dist/LICENSE.md is the repository's licence (board #16955).
//
// The version (board #16864): app/manifest.json gets package.json's version,
// the scripts get NARWAL_BUILD (the short commit and the build date the popup
// shows under its links), and app/dist/build.json holds the same with the full
// commit, so a copy of the folder says what it was built from.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeManifestVersion } from './version.mjs';

const test = process.argv.includes('--test');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const commit = commitOf();
const buildInfo = { commit: commit.short, date: new Date().toISOString().slice(0, 10) };
if (writeManifestVersion(version)) console.log(`app/manifest.json version set to ${version} from package.json`);
const common = {
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  logLevel: 'warning',
  legalComments: 'none',
  define: { NARWAL_TEST: String(test), NARWAL_BUILD: JSON.stringify(buildInfo) },
  metafile: true,
};
const entries = {
  'sw.js': 'src/sw/main.js',
  'content.js': 'src/content/main.js',
  'picker.js': 'src/content/picker.js',
  'offscreen.js': 'src/offscreen/main.js',
  'worklet.js': 'src/offscreen/worklet.js',
  'popup.js': 'src/ui/popup.js',
  'permission.js': 'src/ui/permission.js',
  'options.js': 'src/ui/options.js',
  'model.js': 'src/ui/model.js',
  'recordings.js': 'src/ui/recordings.js',
  'replay.js': 'src/ui/replay.js',
};

// One entry per bundled package: its licence text. rrweb's dist inlines its
// own monorepo packages (same version, same licence) and three npm packages.
const NOTICES = {
  rrweb: { licence: 'MIT', text: 'third-party/rrweb-LICENSE.txt', inlines: ['rrweb-snapshot', 'rrdom', 'utils', 'types'] },
  mitt: { licence: 'MIT', text: 'node_modules/mitt/LICENSE' },
  'base64-arraybuffer': { licence: 'MIT', text: 'node_modules/base64-arraybuffer/LICENSE' },
  '@xstate/fsm': { licence: 'MIT', text: 'node_modules/@xstate/fsm/LICENSE' },
};

const results = await Promise.all(
  Object.entries(entries).map(([out, entry]) =>
    build({ ...common, format: out === 'sw.js' ? 'esm' : 'iife', entryPoints: [entry], outfile: `app/dist/${out}` }),
  ),
);
results.push(await build({ ...common, entryPoints: ['node_modules/rrweb/dist/style.css'], outfile: 'app/dist/rrweb.css' }));
writeNotices(results);
const OFFLINE = '../offline-transcription';
if (!existsSync(`${OFFLINE}/node_modules/vosk-browser`)) {
  throw new Error(`${OFFLINE}/node_modules is missing: run npm ci in packages/offline-transcription, then build again`);
}
execFileSync(process.execPath, ['build.mjs'], { cwd: OFFLINE, stdio: ['ignore', 'ignore', 'inherit'] });
rmSync('app/dist/runtime', { recursive: true, force: true });
cpSync(`${OFFLINE}/dist/runtime`, 'app/dist/runtime', { recursive: true });
// The licence ships with every copy of the extension (board #16955).
cpSync('../../LICENSE.md', 'app/dist/LICENSE.md');
writeFileSync('app/dist/build.json', `${JSON.stringify({ name: 'NarWal', version, commit: commit.full, short: commit.short, dirty: commit.dirty, date: buildInfo.date, test })}\n`);
console.log(`built app/dist${test ? ' (test hooks on)' : ''}: NarWal ${version}, build ${buildInfo.commit}, ${buildInfo.date}`);

/** The commit, with -dirty on the short form when tracked files have changes; `unknown` outside git. */
function commitOf() {
  try {
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
    const full = git('rev-parse', 'HEAD');
    return { full, short: full.slice(0, 7) + (dirty ? '-dirty' : ''), dirty };
  } catch {
    return { full: 'unknown', short: 'unknown', dirty: false };
  }
}

function writeNotices(builds) {
  const usedIn = new Map();
  const use = (name, file) => {
    if (!NOTICES[name]) throw new Error(`${name} is bundled into ${file} but has no entry in NOTICES (build.mjs)`);
    if (!usedIn.has(name)) usedIn.set(name, new Set());
    usedIn.get(name).add(file);
  };
  for (const { metafile } of builds) {
    for (const [out, { inputs }] of Object.entries(metafile.outputs)) {
      const file = out.replace(/^app\/dist\//, '');
      for (const [input, { bytesInOutput }] of Object.entries(inputs)) {
        const m = bytesInOutput > 0 && input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
        if (!m) continue;
        use(m[1], file);
        if (m[1] !== 'rrweb' || !file.endsWith('.js')) continue;
        // Paths in rrweb's map are monorepo paths: ../../<pkg> is an rrweb
        // package, ../../../node_modules/<pkg> an npm dependency.
        for (const src of JSON.parse(readFileSync('node_modules/rrweb/dist/rrweb.js.map', 'utf8')).sources) {
          const dep = src.match(/^\.\.\/\.\.\/\.\.\/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
          const own = src.match(/^\.\.\/\.\.\/([^./][^/]*)\//);
          if (dep) use(dep[1], file);
          else if (own && !NOTICES.rrweb.inlines.includes(own[1])) throw new Error(`rrweb inlines ${own[1]}, which NOTICES.rrweb.inlines does not list (build.mjs)`);
        }
      }
    }
  }
  const version = (name) => JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version;
  const parts = [
    'THIRD-PARTY NOTICES: NarWal extension',
    '=====================================',
    '',
    'This file covers the third-party code bundled into the extension\'s scripts',
    'in dist/. The offline transcription engines in dist/runtime/ have their own',
    'notices there (THIRD-PARTY-NOTICES.txt, onnxruntime-ThirdPartyNotices.txt),',
    'which also cover the downloaded speech models.',
    '',
    'NarWal itself is open source: Copyright (c) 2026 ProSoft IP, under the MIT',
    'licence in LICENSE.md next to this file. The components below keep their',
    'own licences; LICENSE.md does not change them.',
    '',
    'Speech model attribution (board #16955). The Parakeet model this extension',
    'downloads on request is "parakeet-tdt-0.6b-v2" by NVIDIA',
    '(https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2), licensed under',
    'Creative Commons Attribution 4.0 International (CC-BY-4.0,',
    'https://creativecommons.org/licenses/by/4.0/). Changes: exported to ONNX',
    'and quantised to 8 bits by the k2-fsa project',
    '(https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8).',
    'The other models and their licences are listed in',
    'dist/runtime/THIRD-PARTY-NOTICES.txt.',
    '',
    'MPL-2.0 source availability (board #16955). These files contain Eigen,',
    'licensed under the Mozilla Public License 2.0',
    '(https://mozilla.org/MPL/2.0/), unmodified:',
    '',
    '  dist/runtime/sherpa-onnx.wasm',
    '    Eigen 5.0.1 (sherpa-onnx 1.13.8), source:',
    '    https://gitlab.com/libeigen/eigen/-/archive/5.0.1/eigen-5.0.1.tar.gz',
    '    and Eigen commit 1d8b82b0740839c0de7f1242a3585e3390ff5f33 (ONNX Runtime',
    '    1.28.2 inside it), source:',
    '    https://github.com/eigen-mirror/eigen/archive/1d8b82b0740839c0de7f1242a3585e3390ff5f33.zip',
    '  dist/runtime/ort-wasm-simd-threaded.asyncify.wasm',
    '    Eigen commit 1d8b82b0740839c0de7f1242a3585e3390ff5f33 (ONNX Runtime',
    '    commit 8d85527a, cmake/deps.txt), source: the same archive.',
    '',
    'The Source Code Form of Eigen is available at those addresses at no',
    'charge. The full MPL-2.0 text is in',
    'dist/runtime/onnxruntime-ThirdPartyNotices.txt under "Eigen".',
    '',
    'rrweb\'s dist also carries TypeScript helper functions (tslib), 0BSD:',
    '',
    'Copyright (c) Microsoft Corporation.',
    '',
    'Permission to use, copy, modify, and/or distribute this software for any',
    'purpose with or without fee is hereby granted.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH',
    'REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY',
    'AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,',
    'INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM',
    'LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR',
    'OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR',
    'PERFORMANCE OF THIS SOFTWARE.',
  ];
  for (const [name, files] of [...usedIn].sort(([a], [b]) => a.localeCompare(b))) {
    const n = NOTICES[name];
    const with_ = n.inlines ? ` (with ${n.inlines.map((p) => (p === 'utils' || p === 'types' ? `@rrweb/${p}` : p)).join(', ')} at the same version)` : '';
    parts.push('', '', `Package: ${name}@${version(name)}${with_}`, `Licence: ${n.licence}`, `Used in: ${[...files].sort().join(', ')}`, '', readFileSync(n.text, 'utf8').trim());
  }
  writeFileSync('app/dist/THIRD-PARTY-NOTICES.txt', `${parts.join('\n')}\n`);
}
