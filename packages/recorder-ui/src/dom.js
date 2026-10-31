// Small DOM helpers. The views build nodes one by one and never assign
// HTML strings: a recorded page can enforce Trusted Types, and the strip
// runs inside that page.

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {Record<string, unknown>} [props] `class`, `text`, `on` ({event: handler}); any other name is an attribute.
 *   An attribute with value false, null or undefined is left out.
 * @param {...(Node|string|null|undefined|false)} children
 */
export function h(doc, tag, props = {}, ...children) {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === false || value == null) continue;
    if (name === 'class') node.className = String(value);
    else if (name === 'text') node.textContent = String(value);
    else if (name === 'on') {
      for (const [type, handler] of Object.entries(/** @type {Record<string, EventListener>} */ (value))) {
        node.addEventListener(type, handler);
      }
    } else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

const ICON_PATHS = {
  ok: 'M4.5 8.2l2.3 2.3 4.7-5',
  todo: 'M8 4.2v4.4M8 11.3v.2',
  blocked: 'M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6',
  note: 'M8 7.4v4M8 4.6v.2',
  busy: 'M8 3.2a4.8 4.8 0 1 0 4.8 4.8',
};

/** A 16px state icon. Decorative: the state is also in the text next to it. */
export function stateIcon(doc, state) {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `nw-icon nw-icon-${state}`);
  const disc = doc.createElementNS(SVG_NS, 'circle');
  disc.setAttribute('cx', '8');
  disc.setAttribute('cy', '8');
  disc.setAttribute('r', '7.25');
  disc.setAttribute('class', 'nw-icon-disc');
  const mark = doc.createElementNS(SVG_NS, 'path');
  mark.setAttribute('d', ICON_PATHS[state] || ICON_PATHS.note);
  mark.setAttribute('class', 'nw-icon-mark');
  svg.append(disc, mark);
  return svg;
}

/** Adds CSS to a document or shadow root without a <style> element (works under a strict page CSP). */
export function adoptCss(root, css) {
  const view = root.defaultView || (root.ownerDocument && root.ownerDocument.defaultView);
  const sheet = new view.CSSStyleSheet();
  sheet.replaceSync(css);
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  return sheet;
}

/**
 * Replaces the children of `parent` and keeps keyboard focus: when the
 * focused node sits inside and has `data-key`, the new node with the same
 * key gets focus.
 */
export function replaceKeepingFocus(parent, children) {
  const root = parent.getRootNode();
  const active = root.activeElement;
  const key = active && parent.contains(active) ? active.getAttribute('data-key') : null;
  parent.replaceChildren(...children);
  if (key) {
    const again = [...parent.querySelectorAll('[data-key]')].find((n) => n.getAttribute('data-key') === key);
    if (again) again.focus();
  }
}

/**
 * A five-step bar for a measured rating (board #16611). Its text alternative
 * is the same words a reader would say: "Accuracy: 4 of 5".
 * @param {Document} doc
 * @param {string} label
 * @param {number} steps 1..5
 * @param {string} [title] the measured numbers, shown on hover
 */
export function ratingBar(doc, label, steps, title) {
  const bar = h(doc, 'span', { class: 'nw-rating', role: 'img', 'aria-label': `${label}: ${steps} of 5`, title: title || null, 'data-steps': String(steps) });
  for (let i = 1; i <= 5; i += 1) bar.append(h(doc, 'span', { class: i <= steps ? 'nw-rating-on' : 'nw-rating-off' }));
  return bar;
}
