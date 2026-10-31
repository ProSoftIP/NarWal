// The popup's build line (board #16864): the version edge://extensions shows,
// then the commit and date `node build.mjs` wrote into NARWAL_BUILD, so two
// copies of the same version can be told apart.

/** `NarWal 1.0.1 · build 71d3c62 · 2026-10-18`; parts that are missing are left out. */
export function buildLine(version, build) {
  const parts = [`NarWal ${version}`];
  if (build && build.commit) parts.push(`build ${build.commit}`);
  if (build && build.date) parts.push(build.date);
  return parts.join(' · ');
}
