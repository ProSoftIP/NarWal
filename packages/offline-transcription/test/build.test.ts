// Board #16544: the packaging step that makes the vosk-browser worker legal
// under the MV3 content security policy. Runs the patch on the pinned
// upstream bundle and runs the three replaced embind helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext, Script } from 'node:vm';
import { bundledPackages, checkSherpaGlue, extractVoskWorker, missingNotices, patchSherpaAsr } from '../build.mjs';

const upstream = readFileSync(new URL('../node_modules/vosk-browser/dist/vosk.js', import.meta.url));

/** A stand-in bundle: the upstream wrapper around a worker that holds the three helpers in their upstream shape. */
function bundleWith(workerBody: string): string {
  const worker = `/* rollup-plugin-web-worker-loader */\n${workerBody}`;
  return `var WorkerFactory = createBase64WorkerFactory('${Buffer.from(worker, 'latin1').toString('base64')}', null, false);`;
}

const HELPERS = `
function makeLegalFunctionName(name){name=name.replace(/[^a-zA-Z0-9_]/g,"$");return name}
function throwBindingError(message){throw new Error("BindingError: "+message)}
function runDestructors(destructors){while(destructors.length){var ptr=destructors.pop();var del=destructors.pop();del(ptr)}}
function __emval_lookupTypes(argCount,argTypes){return argTypes.slice(0,argCount)}
var emval_methodCallers=[];
function __emval_addMethodCaller(caller){var id=emval_methodCallers.length;emval_methodCallers.push(caller);return id}
`;
const UPSTREAM_SHAPED = `
function createNamedFunction(name,body){name=makeLegalFunctionName(name);return new Function("body","return function "+name+'() {\\n    "use strict";    return body.apply(this, arguments);\\n};\\n')(body)}
function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){var invokerFnBody="return function "+makeLegalFunctionName(humanName)+"() { if (x) { } }";var args1=[];var invokerFunction=new_(Function,args1).apply(null,[]);return invokerFunction}
function __emval_get_method_caller(argCount,argTypes){var types=__emval_lookupTypes(argCount,argTypes);var retType=types[0];var functionBody="return function() { var s = '}'; }";var invokerFunction=new_(Function,[functionBody]).apply(null,[]);return __emval_addMethodCaller(invokerFunction)}
`;

test('the pinned upstream bundle is the one the patch was reviewed against', () => {
  assert.equal(createHash('sha256').update(upstream).digest('hex'), '29504515526e974f4cb053cf08811c4de5fb2a74007c0a5a957db50eaa8d5d0c');
});

test('the packaged worker has no string-built code, no importScripts, and still parses', () => {
  const worker = extractVoskWorker(upstream.toString('latin1'));
  for (const forbidden of ['new Function', 'new_(Function', 'eval(', 'importScripts(']) assert.equal(worker.includes(forbidden), false, forbidden);
  assert.ok(worker.startsWith('var worker_code'), worker.slice(0, 40));
  for (const name of ['createNamedFunction', 'craftInvokerFunction', '__emval_get_method_caller']) assert.equal(worker.split(`function ${name}(`).length, 2, name);
  assert.ok(worker.length > 4_000_000, 'the WebAssembly binary is still inside');
  assert.doesNotThrow(() => new Script(worker));
});

test('a bundle without the worker, with a helper missing, or with code the patch does not cover is refused', () => {
  assert.throws(() => extractVoskWorker('var nothing = 1;'), /embedded worker not found/);
  assert.throws(() => extractVoskWorker(bundleWith(UPSTREAM_SHAPED)), /helper makeLegalFunctionName not found/);
  assert.throws(() => extractVoskWorker(bundleWith(`${HELPERS}${UPSTREAM_SHAPED}\nfunction extra(){return eval("1")}`)), /still contains "eval\("/);
  assert.throws(() => extractVoskWorker(bundleWith(`${HELPERS}${UPSTREAM_SHAPED}\nfunction createNamedFunction(a,b){}`)), /exactly one function createNamedFunction\(/);
});

/** The three replaced helpers, loaded from a patched stand-in worker. */
function patched() {
  const worker = extractVoskWorker(bundleWith(`${HELPERS}${UPSTREAM_SHAPED}`));
  return runInNewContext(`${worker}\n({ createNamedFunction, craftInvokerFunction, __emval_get_method_caller, emval_methodCallers })`) as {
    createNamedFunction(name: string, body: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown;
    craftInvokerFunction(name: string, argTypes: unknown[], classType: unknown, invoker: (...args: unknown[]) => unknown, target: unknown): (...args: unknown[]) => unknown;
    __emval_get_method_caller(argCount: number, argTypes: unknown[]): number;
    emval_methodCallers: ((handle: unknown, name: string, destructors: unknown, args: number) => unknown)[];
  };
}

test('createNamedFunction keeps the name, the receiver and the arguments', () => {
  const { createNamedFunction } = patched();
  const named = createNamedFunction('Model.load', function (this: unknown, ...args: unknown[]) {
    return [this, ...args];
  });
  assert.equal(named.name, 'Model$load');
  const receiver = { id: 1 };
  assert.deepEqual(named.call(receiver, 2, 3), [receiver, 2, 3]);
});

test('craftInvokerFunction converts arguments, calls the C++ invoker, converts the result and runs destructors', () => {
  const { craftInvokerFunction } = patched();
  const log: string[] = [];
  const int = { name: 'int', destructorFunction: null, toWireType: (_d: unknown, value: number) => value * 2, fromWireType: (value: number) => value + 1 };
  const text = {
    name: 'string',
    destructorFunction: (pointer: unknown) => log.push(`free ${pointer}`),
    toWireType: (_d: unknown, value: string) => `ptr:${value}`,
    fromWireType: (value: unknown) => value,
  };
  const self = { name: 'Recognizer', destructorFunction: null, toWireType: (_d: unknown, value: { handle: number }) => value.handle, fromWireType: (value: unknown) => value };
  const invoker = (...args: unknown[]) => {
    log.push(`call ${JSON.stringify(args)}`);
    return 20;
  };
  const method = craftInvokerFunction('Recognizer.accept', [int, self, int, text], {}, invoker, 'target');
  assert.equal(method.call({ handle: 7 }, 5, 'abc'), 21);
  assert.deepEqual(log, ['call ["target",7,10,"ptr:abc"]', 'free ptr:abc']);
  assert.throws(() => method.call({ handle: 7 }, 5), /BindingError: function Recognizer.accept called with 1 arguments, expected 2 args!/);

  const voidType = { name: 'void', destructorFunction: null, fromWireType: () => 'never' };
  const free = craftInvokerFunction('setLogLevel', [voidType, null, int], null, invoker, 'target2');
  assert.equal(free(3), undefined, 'a void function returns nothing');
  assert.equal(log.at(-1), 'call ["target2",6]');

  // A type without a destructorFunction field uses the destructor list.
  const needsStack = {
    name: 'val',
    toWireType: (destructors: unknown[], value: unknown) => {
      destructors.push((pointer: unknown) => log.push(`stack ${pointer}`), value);
      return value;
    },
    fromWireType: (value: unknown) => value,
  };
  craftInvokerFunction('take', [voidType, null, needsStack], null, invoker, 'target3')('v');
  assert.equal(log.at(-1), 'stack v');
  assert.throws(() => craftInvokerFunction('bad', [int], null, invoker, 't'), /argTypes array size mismatch/);
});

test('__emval_get_method_caller reads the arguments, calls the method and converts the result', () => {
  const { __emval_get_method_caller, emval_methodCallers } = patched();
  const memory: Record<number, unknown> = { 100: 'a', 108: 'b' };
  const deleted: unknown[] = [];
  const ret = { isVoid: false, toWireType: (_d: unknown, value: unknown) => `wire:${value}` };
  const arg = { argPackAdvance: 8, readValueFromPointer: (pointer: number) => memory[pointer] };
  const owned = { ...arg, deleteObject: (value: unknown) => deleted.push(value) };
  const id = __emval_get_method_caller(3, [ret, arg, owned]);
  const target = {
    join(this: { sep: string }, a: string, b: string) {
      return a + this.sep + b;
    },
    sep: '-',
  };
  assert.equal(emval_methodCallers[id](target, 'join', null, 100), 'wire:a-b');
  assert.deepEqual(deleted, ['b']);
  const voidId = __emval_get_method_caller(2, [{ isVoid: true, toWireType: () => 'never' }, arg]);
  assert.equal(emval_methodCallers[voidId]({ note() {} }, 'note', null, 100), undefined);
});

// Board #16569: the build strips legal comments, so the notices file must name
// every package whose code ships, at the installed version.

const notices = readFileSync(new URL('../third-party/NOTICES.txt', import.meta.url), 'utf8');

test('bundled packages include the ones a prebundled input inlines, also through pnpm paths', () => {
  const metafile = {
    outputs: {
      'whisper-worker.js': {
        inputs: {
          'src/engines/whisper-worker.ts': { bytesInOutput: 10 },
          'node_modules/@huggingface/transformers/dist/transformers.web.js': { bytesInOutput: 10 },
          'node_modules/onnxruntime-common/dist/esm/index.js': { bytesInOutput: 10 },
          'node_modules/unused/index.js': { bytesInOutput: 0 },
        },
      },
    },
  };
  const sources: Record<string, string> = {
    'node_modules/@huggingface/transformers/dist/transformers.web.js':
      '// ../../node_modules/.pnpm/@huggingface+jinja@0.5.10/node_modules/@huggingface/jinja/dist/index.js\nvar a = 1;\n// src/models.js\n',
    'node_modules/onnxruntime-common/dist/esm/index.js': 'export {};\n',
  };
  const names = bundledPackages(metafile, (path: string) => sources[path]);
  assert.deepEqual([...names].sort(), ['@huggingface/jinja', '@huggingface/transformers', 'onnxruntime-common']);
});

test('the checked-in notices cover every package the runtime ships, at the installed version', () => {
  const shipped = ['vosk-browser', 'onnxruntime-web', 'onnxruntime-common', '@huggingface/transformers', '@huggingface/jinja', '@huggingface/tokenizers', 'sherpa-onnx'];
  assert.deepEqual(missingNotices(notices, shipped), []);
  for (const text of ['onnx-community/whisper-base.en_timestamped', 'onnx-community/moonshine-base-ONNX', 'no licence tag', 'ccoreilly.github.io', 'personal GitHub Pages site', 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8', 'CC-BY-4.0', 'KISS FFT']) {
    assert.ok(notices.includes(text), `notices mention ${text}`);
  }
});

test('a package without a notice, or at another version, is reported', () => {
  assert.deepEqual(missingNotices(notices, ['left-pad'], () => '1.3.0'), ['left-pad@1.3.0']);
  assert.deepEqual(missingNotices(notices, ['vosk-browser'], () => '0.0.9'), ['vosk-browser@0.0.9']);
});

// Board #16608: the vendored ASR-only sherpa-onnx build (vendor/sherpa-onnx/README.md).

const vendored = (name: string) => readFileSync(new URL(`../vendor/sherpa-onnx/${name}`, import.meta.url));

test('the vendored sherpa-onnx files are the reviewed ones, and the wasm has no text-to-speech code', () => {
  const pins: Record<string, string> = {
    'sherpa-onnx-asr-wasm.js': '8d95bbe9dd7fc4a461eb098ffb86f8e4e47e5167721c182a1074987b70f80324',
    'sherpa-onnx-asr-wasm.wasm': 'a494e2b7f659dd622304ed0dbfcc89cfdb39956139c643b2510aa53a308dae11',
    'sherpa-onnx-asr.js': 'd51ae8e8b756ee5e53423ffada0c9702973f154f561aca7984fe0b12f4060178',
  };
  for (const [name, sha] of Object.entries(pins)) assert.equal(createHash('sha256').update(vendored(name)).digest('hex'), sha, name);
  const wasm = vendored('sherpa-onnx-asr-wasm.wasm').toString('latin1').toLowerCase();
  for (const library of ['espeak', 'piper']) assert.equal(wasm.includes(library), false, library);
  assert.ok(wasm.includes('offlinerecognizer') || wasm.includes('sherpaonnxcreateofflinerecognizer'), 'the recognizer is inside');
});

test('the sherpa-onnx glue passes the check; glue with string-built code or the Node file system is refused', () => {
  const glue = vendored('sherpa-onnx-asr-wasm.js').toString('utf8');
  assert.equal(checkSherpaGlue(glue), glue);
  for (const forbidden of ['new Function("x")', 'eval("1")', 'importScripts("a.js")', 'var NODERAWFS = 1', 'var fs = require("fs")']) {
    assert.throws(() => checkSherpaGlue(`${glue}\n${forbidden}`), /sherpa-onnx glue contains/, forbidden);
  }
});

test('the sherpa-onnx wrapper exports its classes outside Node too; an unknown wrapper is refused', () => {
  const wrapper = vendored('sherpa-onnx-asr.js').toString('utf8');
  const patched = patchSherpaAsr(wrapper);
  assert.equal(patched.includes('typeof process.versions.node'), false);
  const module = { exports: {} as Record<string, unknown> };
  runInNewContext(patched, { module, console });
  for (const name of ['OfflineRecognizer', 'createOnlineRecognizer']) assert.equal(typeof module.exports[name], 'function', name);
  assert.throws(() => patchSherpaAsr('module.exports = {};'), /sherpa-onnx-asr.js: expected exactly one/);
  assert.throws(() => patchSherpaAsr(`${wrapper}\n${wrapper}`), /expected exactly one/);
});
