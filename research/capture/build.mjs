// Bundles the probe extension's scripts into extension/dist (board #16538).
import { build } from 'esbuild';

const common = { bundle: true, format: 'iife', target: 'chrome116', logLevel: 'warning', legalComments: 'none' };

await Promise.all([
  build({ ...common, entryPoints: ['extension/src/content.js'], outfile: 'extension/dist/content.js' }),
  build({ ...common, entryPoints: ['extension/src/offscreen.js'], outfile: 'extension/dist/offscreen.js' }),
  build({ ...common, entryPoints: ['extension/src/report.js'], outfile: 'extension/dist/report.js' }),
]);
console.log('built extension/dist');
