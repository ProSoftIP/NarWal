// Keeps NarWal's own controls out of the recording.
//
// Every NarWal element placed in a recorded page is a host made by
// markNarwalUi(): it carries UI_ATTR and UI_CLASS and has a closed shadow
// root. Three layers use that mark:
//   1. rrweb never reads inside the closed root, and RRWEB_RECORD_OPTIONS
//      makes it record the host as an empty block.
//   2. createCaptureFilter() removes that block, and every event that
//      points at it, before events are stored. Nothing about the controls
//      reaches the bundle or the replay.
//   3. isNarwalUiEvent() lets interaction capture (hover, clicks, marks)
//      ignore pointer and key events on the controls.
//
// Why both an attribute and a class: rrweb 2 keeps only `class` (and the
// size) of a blocked element, so the class is what layer 2 can see. The
// attribute is what layers 1 and 3 select on.

export const UI_ATTR = 'data-narwal-ui';
export const UI_CLASS = 'narwal-ui';
export const UI_SELECTOR = `[${UI_ATTR}]`;

/** Marks `host` as a NarWal element. `name` says which one ("strip", "marks"). */
export function markNarwalUi(host, name) {
  host.setAttribute(UI_ATTR, name);
  host.classList.add(UI_CLASS);
  return host;
}

/** Spread into rrweb's record() options. */
export const RRWEB_RECORD_OPTIONS = Object.freeze({ blockSelector: UI_SELECTOR });

/** True when the node is, or is inside, a NarWal host in the same tree. */
export function isNarwalUiNode(node) {
  const el = node && node.nodeType === 1 ? node : node && node.parentElement;
  return Boolean(el && typeof el.closest === 'function' && el.closest(UI_SELECTOR));
}

/**
 * True when the event happened on NarWal's controls. A closed shadow root
 * retargets the event to its host, so the host is in the path.
 */
export function isNarwalUiEvent(event) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  for (const target of path.length ? path : [event.target]) {
    if (target && target.nodeType === 1 && target.hasAttribute(UI_ATTR)) return true;
  }
  return path.length === 0 && isNarwalUiNode(event.target);
}

// rrweb 2 event numbers (EventType, IncrementalSource).
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const MUTATION = 0;
const POSITION_SOURCES = new Set([1, 6, 12]); // MouseMove, TouchMove, Drag
const SELECTION = 14;
const ELEMENT = 2;

function isUiElement(node) {
  if (!node || node.type !== ELEMENT || !node.attributes) return false;
  if (UI_ATTR in node.attributes) return true;
  const cls = node.attributes.class;
  return typeof cls === 'string' && cls.split(/\s+/).includes(UI_CLASS);
}

/**
 * A filter for one document's rrweb event stream. Call it with each event
 * in order; it returns the event to store (the same object, or a copy with
 * the controls removed) or null when the whole event is about the controls.
 * Make one filter per recorded document: rrweb node ids are per document.
 */
export function createCaptureFilter() {
  // id of a removed node -> id of the node that came after it (or null).
  // A page node inserted "before the controls" is really inserted before
  // whatever follows them.
  const dropped = new Map();

  const resolveNext = (id) => {
    let next = id;
    const seen = new Set();
    while (next != null && dropped.has(next) && !seen.has(next)) {
      seen.add(next);
      next = dropped.get(next);
    }
    return next == null || dropped.has(next) ? null : next;
  };

  const dropSubtree = (node, nextId) => {
    dropped.set(node.id, nextId);
    for (const child of node.childNodes || []) dropSubtree(child, null);
  };

  const pruneTree = (node) => {
    if (!node.childNodes || node.childNodes.length === 0) return node;
    let changed = false;
    const kept = [];
    node.childNodes.forEach((child, index) => {
      if (isUiElement(child)) {
        const after = node.childNodes[index + 1];
        dropSubtree(child, after ? after.id : null);
        changed = true;
        return;
      }
      const pruned = pruneTree(child);
      if (pruned !== child) changed = true;
      kept.push(pruned);
    });
    return changed ? { ...node, childNodes: kept } : node;
  };

  const filterMutation = (event) => {
    const data = event.data;
    let changed = false;
    const adds = [];
    for (const add of data.adds || []) {
      if (isUiElement(add.node) || dropped.has(add.parentId)) {
        dropSubtree(add.node, add.nextId ?? null);
        changed = true;
      } else {
        adds.push(add);
      }
    }
    // A second pass: an add listed before the controls can name them as its
    // next sibling. An added subtree can hold controls too: a same-origin
    // iframe's document arrives as one add (isAttachIframe) with that
    // frame's NarWal hosts inside it.
    const fixedAdds = adds.map((add) => {
      const node = pruneTree(add.node);
      const nextId = add.nextId != null && dropped.has(add.nextId) ? resolveNext(add.nextId) : add.nextId;
      if (node === add.node && nextId === add.nextId) return add;
      changed = true;
      return { ...add, node, nextId };
    });
    const keep = (list) => {
      const out = (list || []).filter((item) => !dropped.has(item.id));
      if (out.length !== (list || []).length) changed = true;
      return out;
    };
    const removes = (data.removes || []).filter((r) => {
      if (dropped.has(r.id)) {
        changed = true;
        return false;
      }
      // The node after the controls is gone: "before the controls" now means
      // "at the end".
      for (const [id, next] of dropped) if (next === r.id) dropped.set(id, null);
      return true;
    });
    const texts = keep(data.texts);
    const attributes = keep(data.attributes);
    if (!changed) return event;
    if (!fixedAdds.length && !removes.length && !texts.length && !attributes.length) return null;
    return { ...event, data: { ...data, adds: fixedAdds, removes, texts, attributes } };
  };

  return function filter(event) {
    if (!event || typeof event !== 'object') return event;
    if (event.type === FULL_SNAPSHOT && event.data && event.data.node) {
      dropped.clear();
      const node = pruneTree(event.data.node);
      return node === event.data.node ? event : { ...event, data: { ...event.data, node } };
    }
    if (event.type !== INCREMENTAL || !event.data) return event;
    const data = event.data;
    if (data.source === MUTATION) return filterMutation(event);
    if (dropped.size === 0) return event;
    if (POSITION_SOURCES.has(data.source)) {
      const positions = (data.positions || []).filter((p) => !dropped.has(p.id));
      if (positions.length === (data.positions || []).length) return event;
      return positions.length ? { ...event, data: { ...data, positions } } : null;
    }
    if (data.source === SELECTION) {
      const ranges = (data.ranges || []).filter((r) => !dropped.has(r.start) && !dropped.has(r.end));
      if (ranges.length === (data.ranges || []).length) return event;
      return { ...event, data: { ...data, ranges } };
    }
    // Mouse interaction, scroll, input, media and the rest carry one node id.
    return typeof data.id === 'number' && dropped.has(data.id) ? null : event;
  };
}
