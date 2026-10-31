// The small drawn icon set of the Tiles B pages (board #16783): one stroke,
// one weight, 24-unit grid. Decorative: every icon is aria-hidden and the
// control it sits in carries the name.
const PATHS = {
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M7 5v14M17 5v14"/>',
  download: '<path d="M12 4v11m0 0l-4-4m4 4l4-4M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1h5"/>',
  mic: '<path d="M12 3a3 3 0 013 3v6a3 3 0 01-6 0V6a3 3 0 013-3zM6 11a6 6 0 0012 0M12 17v4M9 21h6"/>',
  page: '<path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h5M10 17h5"/>',
  replay: '<path d="M4.5 12a7.5 7.5 0 107.5-7.5H8.5M11 2l-3 2.5 3 2.5"/>',
  gap: '<path d="M12 4l9 16H3zM12 10v4M12 17.5v.5"/>',
  text: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  marker: '<path d="M12 21s-6-5.5-6-10a6 6 0 0112 0c0 4.5-6 10-6 10z"/><circle cx="12" cy="11" r="2"/>',
  folder: '<path d="M3 6a1 1 0 011-1h5l2 2h9a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1z"/>',
  route: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8 7.5c4 0 4 9 8 9"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6 7l1 12.5a1 1 0 001 .9h8a1 1 0 001-.9L18 7M10 11v5.5M14 11v5.5"/>',
};

export const ICON_NAMES = Object.keys(PATHS);

/** An aria-hidden SVG icon. The markup is the constant above, never page data. */
export function icon(name, size = 13) {
  const body = PATHS[name];
  if (!body) throw new Error(`no icon ${name}`);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ class: 'ic', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) {
    svg.setAttribute(k, String(k === 'width' || k === 'height' ? size : v));
  }
  svg.innerHTML = body;
  return svg;
}

/** Puts an icon in front of every element with data-icon="<name>" (static markup). */
export function drawIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.querySelector(':scope > svg.ic')) continue;
    el.prepend(icon(el.dataset.icon, Number(el.dataset.iconSize) || 13));
  }
}
