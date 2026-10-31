// The first export of a recording saves its bundle in the recording library,
// and later exports pack that copy. The transcript can come after that first
// export: an OpenAI transcript that was still being made, or one from Try
// again (board #16588). This says whether the saved copy takes the transcript
// the recording has now.
const MANIFEST_PATH = 'manifest.json';
const EDITS_PATH = 'edits.jsonl';
const REVISION_PATH = /^transcript\/[^/]+\.json$/;
const dec = new TextDecoder();

function activeRevision(files) {
  const manifest = JSON.parse(dec.decode(files.get(MANIFEST_PATH)));
  return (manifest.transcript && manifest.transcript.activeRevision) || null;
}

function startsWith(bytes, prefix) {
  if (prefix.length > bytes.length) return false;
  for (let i = 0; i < prefix.length; i += 1) if (bytes[i] !== prefix[i]) return false;
  return true;
}

/**
 * @param {Map<string, Uint8Array>} stored  the library copy's bundle tree
 * @param {Map<string, Uint8Array>} fresh  the tree written now from the recording
 * @returns {'current'|'refresh'|'edited'}
 *   'current': the copy has the transcript the recording has.
 *   'refresh': the recording has a newer transcript and the copy holds only
 *     what the recorder wrote: it takes the fresh tree.
 *   'edited': the recording has a newer transcript, but the copy has
 *     corrections, notes or a transcript of its own (replay page). It stays
 *     as the user left it.
 */
export function transcriptRefresh(stored, fresh) {
  const newer = [...fresh.keys()].some((path) => REVISION_PATH.test(path) && !stored.has(path)) || activeRevision(fresh) !== activeRevision(stored);
  if (!newer) return 'current';
  const ownRevision = [...stored.keys()].some((path) => REVISION_PATH.test(path) && !fresh.has(path));
  const edits = stored.get(EDITS_PATH);
  const ownEdits = Boolean(edits && edits.length) && !startsWith(fresh.get(EDITS_PATH) || new Uint8Array(), edits);
  return ownRevision || ownEdits ? 'edited' : 'refresh';
}
