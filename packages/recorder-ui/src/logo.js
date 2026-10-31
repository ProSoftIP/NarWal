// The NarWal logo (Matt's pack, option 23 white eye, board #16597), drawn
// node by node like the rest of the UI: the strip runs in recorded pages that
// may enforce Trusted Types, and an inline drawing needs no
// web_accessible_resources entry a page could probe for.
// The master is packages/extension/branding/narwal.svg; a unit test keeps
// these paths equal to it.

const SVG_NS = 'http://www.w3.org/2000/svg';

export const LOGO_VIEWBOX = '0 0 1254 1254';

export const LOGO_PATHS = [
  ['#C90723', 'M 668,540 C 600,567 531,607 464,663 L 594,692 Z'],
  ['#D30F29', 'M 974,672 L 1036,760 L 1037,831 Q 1027,888 1006,930 Q 937,844 899,778 Z'],
  ['#C90723', 'M 401,908 L 524,806 L 679,513 L 834,367 L 952,339 L 1049,412 C 1095,455 1081,510 1054,553 C 1016,624 963,705 899,778 C 815,878 713,940 617,949 C 529,960 451,944 401,908 Z'],
  ['#FC4722', 'M 401,908 L 524,806 L 679,513 L 834,367 L 952,339 L 1049,412 L 909,492 L 810,689 L 593,860 Z'],
  ['#C90723', 'M 952,339 L 1161,134 L 1049,412 Z'],
  ['#FC4722', 'M 952,339 L 1161,134 L 1003,364 Z'],
  ['#D10F29', 'M 401,908 L 283,788 Q 180,793 96,817 L 188,927 L 275,952 Z'],
  ['#C80722', 'M 401,908 Q 381,996 350,1055 Q 273,1122 189,1149 L 210,1022 L 275,952 Z'],
];

export const LOGO_EYE = { cx: 973, cy: 494, r: 21.5 };

/** The eye radius for a drawing `size` px wide: small sizes enlarge it, as the toolbar icons do. */
export function eyeRadius(size) {
  if (size <= 16) return 45;
  if (size <= 32) return 28;
  if (size <= 48) return 24;
  return LOGO_EYE.r;
}

/**
 * The logo as an <svg>, `size` px square. Decorative: the word "NarWal" is
 * always next to it.
 * @param {Document} doc
 * @param {number} size
 * @param {string} [cls]
 */
export function narwalLogo(doc, size, cls = 'nw-logo') {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', LOGO_VIEWBOX);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', cls);
  for (const [fill, d] of LOGO_PATHS) {
    const path = doc.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', fill);
    path.setAttribute('d', d);
    svg.append(path);
  }
  const eye = doc.createElementNS(SVG_NS, 'circle');
  eye.setAttribute('cx', String(LOGO_EYE.cx));
  eye.setAttribute('cy', String(LOGO_EYE.cy));
  eye.setAttribute('r', String(eyeRadius(size)));
  eye.setAttribute('fill', '#FFFFFF');
  svg.append(eye);
  return svg;
}
