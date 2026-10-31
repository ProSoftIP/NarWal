// Builds the packaged runtime files and the demo extension (board #16544).
//
//   dist/runtime/          what an extension ships: both engine workers, the
//                          ONNX Runtime WebAssembly files and the third-party
//                          notices (legal comments are stripped from the code)
//   dist/demo-extension/   an unpacked MV3 extension that proves the engines
//                          run under the extension content security policy
//
// An MV3 extension page may not start a worker from a blob URL or build code
// from strings. vosk-browser 0.0.8 does both, so its worker is taken out of
// the published bundle and three embind helpers are replaced by versions that
// do the same work with closures. The input file is hash-pinned: a different
// upstream build fails here instead of shipping an unreviewed patch.

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');
const RUNTIME = join(DIST, 'runtime');
const DEMO = join(DIST, 'demo-extension');
const TARGET = 'chrome120';

// sherpa-onnx (board #16608): an ASR-only WebAssembly build of v1.13.8 (no
// text-to-speech code), its emscripten glue and upstream's JS wrapper of the C
// API. vendor/sherpa-onnx/build-wasm.sh rebuilds them; README.md there says why.
const SHERPA_GLUE = 'vendor/sherpa-onnx/sherpa-onnx-asr-wasm.js';
const SHERPA_WASM = 'vendor/sherpa-onnx/sherpa-onnx-asr-wasm.wasm';
const SHERPA_ASR = 'vendor/sherpa-onnx/sherpa-onnx-asr.js';
/** Code that is not an npm package, with the version its notice names. */
const VENDORED = { 'sherpa-onnx': '1.13.8' };

const PINNED = {
  'node_modules/vosk-browser/dist/vosk.js': '29504515526e974f4cb053cf08811c4de5fb2a74007c0a5a957db50eaa8d5d0c',
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs': '0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611',
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm': '49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082',
  [SHERPA_GLUE]: '8d95bbe9dd7fc4a461eb098ffb86f8e4e47e5167721c182a1074987b70f80324',
  [SHERPA_WASM]: 'a494e2b7f659dd622304ed0dbfcc89cfdb39956139c643b2510aa53a308dae11',
  [SHERPA_ASR]: 'd51ae8e8b756ee5e53423ffada0c9702973f154f561aca7984fe0b12f4060178',
};

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function readPinned(path) {
  const data = readFileSync(join(ROOT, path));
  const actual = sha256(data);
  if (actual !== PINNED[path]) throw new Error(`${path}: sha256 ${actual} is not the pinned ${PINNED[path]}; review the new upstream file before changing the pin`);
  return data;
}

/** Index after the closing brace of the function that starts at `start`. Skips string literals. */
function functionEnd(source, start) {
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i += 1; source[i] !== ch; i += 1) if (source[i] === '\\') i += 1;
    } else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error('unbalanced function body');
}

function replaceFunction(source, name, replacement) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0 || source.indexOf(marker, start + 1) >= 0) throw new Error(`expected exactly one ${marker} in the Vosk worker`);
  return source.slice(0, start) + replacement + source.slice(functionEnd(source, start));
}

// Same behaviour as the embind originals, without `new Function`.
const EVAL_FREE = {
  createNamedFunction: `function createNamedFunction(name,body){name=makeLegalFunctionName(name);var holder={};holder[name]=function(){"use strict";return body.apply(this,arguments)};try{Object.defineProperty(holder[name],"name",{value:name})}catch(e){}return holder[name]}`,
  craftInvokerFunction: `function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){var argCount=argTypes.length;if(argCount<2){throwBindingError("argTypes array size mismatch! Must at least get return value and 'this' types!");}var isClassMethodFunc=argTypes[1]!==null&&classType!==null;var needsDestructorStack=false;for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){needsDestructorStack=true;break}}var returns=argTypes[0].name!=="void";var expectedArgCount=argCount-2;return function(){if(arguments.length!==expectedArgCount){throwBindingError("function "+humanName+" called with "+arguments.length+" arguments, expected "+expectedArgCount+" args!");}var destructors=needsDestructorStack?[]:null;var thisWired;var argsWired=new Array(expectedArgCount);var invokerArgs=[cppTargetFunc];if(isClassMethodFunc){thisWired=argTypes[1].toWireType(destructors,this);invokerArgs.push(thisWired);}for(var i=0;i<expectedArgCount;++i){argsWired[i]=argTypes[i+2].toWireType(destructors,arguments[i]);invokerArgs.push(argsWired[i]);}var rv=cppInvokerFunc.apply(null,invokerArgs);if(needsDestructorStack){runDestructors(destructors);}else{for(var j=isClassMethodFunc?1:2;j<argTypes.length;j++){var param=j===1?thisWired:argsWired[j-2];if(argTypes[j].destructorFunction!==null){argTypes[j].destructorFunction(param);}}}if(returns){return argTypes[0].fromWireType(rv)}}}`,
  __emval_get_method_caller: `function __emval_get_method_caller(argCount,argTypes){var types=__emval_lookupTypes(argCount,argTypes);var retType=types[0];var invokerFunction=function(handle,name,destructors,args){var offset=0;var argv=new Array(argCount-1);for(var i=0;i<argCount-1;++i){argv[i]=types[i+1].readValueFromPointer(args+offset);offset+=types[i+1]["argPackAdvance"];}var rv=handle[name].apply(handle,argv);for(var i=0;i<argCount-1;++i){if(types[i+1]["deleteObject"]){types[i+1].deleteObject(argv[i]);}}if(!retType.isVoid){return retType.toWireType(destructors,rv)}};return __emval_addMethodCaller(invokerFunction)}`,
};
const HELPERS = ['makeLegalFunctionName', 'throwBindingError', 'runDestructors', '__emval_lookupTypes', '__emval_addMethodCaller'];

export function extractVoskWorker(bundle) {
  const match = /createBase64WorkerFactory\('([A-Za-z0-9+/=]+)',\s*null,\s*false\)/.exec(bundle);
  if (!match) throw new Error('vosk-browser bundle: embedded worker not found');
  const decoded = Buffer.from(match[1], 'base64').toString('latin1');
  // The upstream loader drops the first line (a marker comment) before it runs the code.
  let worker = decoded.slice(decoded.indexOf('\n', 10) + 1);
  for (const helper of HELPERS) {
    if (!worker.includes(`function ${helper}(`)) throw new Error(`Vosk worker: helper ${helper} not found`);
  }
  for (const [name, replacement] of Object.entries(EVAL_FREE)) worker = replaceFunction(worker, name, replacement);
  for (const forbidden of ['new Function', 'new_(Function', 'eval(', 'importScripts(']) {
    if (worker.includes(forbidden)) throw new Error(`Vosk worker still contains "${forbidden}" after the patch`);
  }
  return worker;
}

function replaceOnce(source, from, to, what) {
  const at = source.indexOf(from);
  if (at < 0 || source.indexOf(from, at + 1) >= 0) throw new Error(`${what}: expected exactly one ${JSON.stringify(from.slice(0, 80))}`);
  return source.slice(0, at) + to + source.slice(at + from.length);
}

/** The glue ships as built; this only proves it has no code built from strings and no Node file system. */
export function checkSherpaGlue(source) {
  for (const forbidden of ['new Function', 'eval(', 'importScripts(', 'NODERAWFS', 'require(']) {
    if (source.includes(forbidden)) throw new Error(`sherpa-onnx glue contains "${forbidden}"`);
  }
  return source;
}

/** The wrapper exports its classes only under Node; the worker imports them in a browser. */
export function patchSherpaAsr(source) {
  return replaceOnce(source, "if (typeof process == 'object' && typeof process.versions == 'object' &&\n    typeof process.versions.node == 'string') {\n  module.exports = {", 'if (true) {\n  module.exports = {', 'sherpa-onnx-asr.js');
}

/** Serves the pinned sherpa-onnx files to esbuild, checked and patched. */
const sherpaPlugin = {
  name: 'sherpa-onnx',
  setup(pluginBuild) {
    const patches = { [SHERPA_GLUE]: checkSherpaGlue, [SHERPA_ASR]: patchSherpaAsr };
    pluginBuild.onLoad({ filter: /vendor[\\/]sherpa-onnx[\\/].*\.js$/ }, (args) => {
      const path = Object.keys(patches).find((pinned) => join(ROOT, pinned) === args.path);
      if (!path) throw new Error(`sherpa-onnx: ${args.path} is not a pinned file`);
      return { contents: patches[path](readPinned(path).toString('utf8')), loader: 'js' };
    });
  },
};

const NOTICES = join(ROOT, 'third-party/NOTICES.txt');
const ORT_NOTICES = join(ROOT, 'third-party/onnxruntime-ThirdPartyNotices.txt');

/** The package a path belongs to: the part after its last `node_modules/` (pnpm paths have two). */
function packageOf(path) {
  const all = [...path.matchAll(/(?:^|[/ ])node_modules\/((?:@[^/]+\/)?[^/.][^/]*)\//g)];
  return all.length ? all[all.length - 1][1] : null;
}

/**
 * Packages whose code is in a bundle: every node_modules input of the
 * metafile, plus the packages a prebundled input inlines (esbuild marks them
 * with a `// node_modules/<package>/...` line).
 */
export function bundledPackages(metafile, readInput = (path) => readFileSync(join(ROOT, path), 'utf8')) {
  const names = new Set();
  for (const output of Object.values(metafile.outputs)) {
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
      const name = packageOf(input);
      if (!name || !bytesInOutput) continue;
      names.add(name);
      for (const marker of readInput(input).matchAll(/^\/\/ (?:\.\.\/)*node_modules\/\S+$/gm)) {
        const inlined = packageOf(marker[0]);
        if (inlined) names.add(inlined);
      }
    }
  }
  return names;
}

const installedVersion = (name) => VENDORED[name] ?? JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;

/** `name@version` of every package without a `Package: name@version` line in the notices. */
export function missingNotices(noticesText, names, versionOf = installedVersion) {
  const listed = new Set([...noticesText.matchAll(/^Package: (\S+)$/gm)].map((match) => match[1]));
  return [...names].map((name) => `${name}@${versionOf(name)}`).filter((entry) => !listed.has(entry)).sort();
}

async function bundleText(entry, format, packages) {
  const result = await build({ entryPoints: [join(ROOT, entry)], absWorkingDir: ROOT, bundle: true, format, target: TARGET, platform: 'browser', write: false, metafile: true, legalComments: 'none' });
  for (const name of bundledPackages(result.metafile)) packages.add(name);
  return result.outputFiles[0].text;
}

async function main() {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(RUNTIME, { recursive: true });

  // Every package whose code ships. The two below are copied, not bundled.
  const packages = new Set(['vosk-browser', 'onnxruntime-web']);

  // Vosk: network guard and local model source first, then the patched upstream worker.
  const prelude = await bundleText('src/engines/vosk-prelude.ts', 'iife', packages);
  const voskWorker = extractVoskWorker(readPinned('node_modules/vosk-browser/dist/vosk.js').toString('latin1'));
  writeFileSync(
    join(RUNTIME, 'vosk-worker.js'),
    Buffer.from(`// NarWal: vosk-browser 0.0.8 worker (Apache-2.0), packaged for MV3. See build.mjs.\n${prelude}\n${voskWorker}`, 'latin1'),
  );

  // Whisper: transformers.js with ONNX Runtime Web; the WebAssembly runtime stays a packaged file.
  const whisper = await build({
    entryPoints: [join(ROOT, 'src/engines/whisper-worker.ts')],
    absWorkingDir: ROOT,
    bundle: true,
    format: 'esm',
    target: TARGET,
    platform: 'browser',
    outfile: join(RUNTIME, 'whisper-worker.js'),
    metafile: true,
    legalComments: 'none',
    logLevel: 'error',
  });
  for (const name of bundledPackages(whisper.metafile)) packages.add(name);
  for (const file of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
    writeFileSync(join(RUNTIME, file), readPinned(`node_modules/onnxruntime-web/dist/${file}`));
  }

  // Parakeet: the vendored sherpa-onnx WebAssembly, one thread, model files in MEMFS.
  const sherpa = await build({
    entryPoints: [join(ROOT, 'src/engines/sherpa-worker.ts')],
    absWorkingDir: ROOT,
    bundle: true,
    format: 'esm',
    target: TARGET,
    platform: 'browser',
    plugins: [sherpaPlugin],
    outfile: join(RUNTIME, 'sherpa-worker.js'),
    metafile: true,
    legalComments: 'none',
    logLevel: 'error',
  });
  for (const name of bundledPackages(sherpa.metafile)) packages.add(name);
  packages.add('sherpa-onnx');
  writeFileSync(join(RUNTIME, 'sherpa-onnx.wasm'), readPinned(SHERPA_WASM));

  // The code ships without its legal comments, so the notices ship beside it.
  const missing = missingNotices(readFileSync(NOTICES, 'utf8'), packages);
  if (missing.length) throw new Error(`third-party/NOTICES.txt has no "Package:" entry for ${missing.join(', ')}; add its licence before shipping it`);
  cpSync(NOTICES, join(RUNTIME, 'THIRD-PARTY-NOTICES.txt'));
  cpSync(ORT_NOTICES, join(RUNTIME, 'onnxruntime-ThirdPartyNotices.txt'));

  // Demo extension.
  mkdirSync(DEMO, { recursive: true });
  for (const file of ['manifest.json', 'setup.html', 'offscreen.html', 'sw.js']) cpSync(join(ROOT, 'demo-extension', file), join(DEMO, file));
  const demo = await build({
    entryPoints: [join(ROOT, 'demo-extension/setup.ts'), join(ROOT, 'demo-extension/offscreen.ts')],
    absWorkingDir: ROOT,
    bundle: true,
    format: 'esm',
    target: TARGET,
    platform: 'browser',
    outdir: DEMO,
    metafile: true,
    legalComments: 'none',
    logLevel: 'error',
  });
  const demoMissing = missingNotices(readFileSync(NOTICES, 'utf8'), bundledPackages(demo.metafile));
  if (demoMissing.length) throw new Error(`third-party/NOTICES.txt has no "Package:" entry for ${demoMissing.join(', ')} (demo extension)`);
  cpSync(RUNTIME, join(DEMO, 'runtime'), { recursive: true });
  cpSync(join(ROOT, 'fixtures'), join(DEMO, 'fixtures'), { recursive: true });

  const sizes = {};
  for (const file of ['vosk-worker.js', 'whisper-worker.js', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm', 'sherpa-worker.js', 'sherpa-onnx.wasm']) {
    sizes[file] = readFileSync(join(RUNTIME, file)).length;
  }
  console.log(JSON.stringify({ runtime: sizes, totalBytes: Object.values(sizes).reduce((a, b) => a + b, 0) }));
  console.log('BUILD=OK');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
