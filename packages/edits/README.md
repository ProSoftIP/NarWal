# @narwal/edits

Board #16550. Transcript corrections, written notes and retranscription after
corrections, as append-only layers on a NarWal bundle. Captured files are
never changed. See [`docs/editing.md`](../../docs/editing.md).

```ts
import { addNote, correctSegment, editRecording } from '@narwal/edits';

await editRecording(library, id, (layer, at) => correctSegment(layer, { segmentId: 's4', text: 'The export button does not work' }, at));
await editRecording(library, id, (layer, at) => addNote(layer, { atMs: 62000, text: 'Broken in Firefox too' }, at));
```

Scripts: `test` (node --test) and `typecheck` (tsc), as in the other packages.
