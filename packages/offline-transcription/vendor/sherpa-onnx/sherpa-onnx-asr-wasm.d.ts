// The parts of the ASR-only sherpa-onnx WebAssembly module the Parakeet worker
// uses (board #16608). See README.md in this directory.

declare function createSherpaOnnxAsrModule(options: {
  locateFile?: (path: string) => string;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}): Promise<createSherpaOnnxAsrModule.SherpaModule>;

declare namespace createSherpaOnnxAsrModule {
  interface SherpaModule {
    FS: {
      mkdir(path: string): void;
      writeFile(path: string, data: Uint8Array, options?: { canOwn?: boolean }): void;
      unlink(path: string): void;
    };
    HEAPF32: Float32Array;
  }
}

export = createSherpaOnnxAsrModule;
