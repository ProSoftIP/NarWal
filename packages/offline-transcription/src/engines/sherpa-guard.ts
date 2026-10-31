// Imported first by the sherpa-onnx worker (board #16608), before the runtime
// evaluates, so the runtime only ever sees the guarded fetch. The worker reads
// its model from the verified local store itself; the only request the
// runtime makes is for its own packaged WebAssembly file.

import { installNetworkGuard } from '../network-guard.ts';

export const guard = installNetworkGuard(self as unknown as Parameters<typeof installNetworkGuard>[0]);
