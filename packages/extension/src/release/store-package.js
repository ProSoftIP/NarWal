// The rules for the store zip (board #16955): what the Chrome Web Store and
// Edge Add-ons get from the built app/ folder. release.mjs reads the files;
// this module decides, so the unit tests can check every refusal without a
// build.
//
// The store zip differs from the load-unpacked zip (package.mjs) in three
// ways: manifest.json is at the root of the zip, not in a narwal/ folder;
// the manifest has no `key` (the stores refuse one and give the item their
// own ID); and only the allowed paths below may be in it.

/** Paths the extension needs at run time. Anything else in app/ is refused. */
const ALLOWED = [
  /^manifest\.json$/,
  /^[a-z-]+\.html$/,
  /^[a-z-]+\.css$/,
  /^icons\/icon-(16|32|48|128)\.png$/,
  /^logo\/narwal\.svg$/,
  /^dist\/[a-z-]+\.(js|css)$/,
  /^dist\/(LICENSE\.md|THIRD-PARTY-NOTICES\.txt)$/,
  /^dist\/build\.json$/,
  /^dist\/runtime\/[A-Za-z0-9.-]+\.(js|mjs|wasm|txt)$/,
];

/** Files that must be in every store zip. */
const REQUIRED = ['manifest.json', 'dist/LICENSE.md', 'dist/THIRD-PARTY-NOTICES.txt', 'dist/runtime/THIRD-PARTY-NOTICES.txt', 'icons/icon-128.png'];

const STORED = /\.(png|zip|gz|jpg|webm)$/;

/**
 * @param {{ path: string, bytes: Uint8Array }[]} files paths relative to app/, with `/`
 * @param {{ version: string, changelog: string }} release the package.json version and CHANGELOG.md text
 * @returns {{ inputs: { path: string, bytes: Uint8Array, compress: boolean }[], manifest: object }}
 */
export function storeEntries(files, { version, changelog }) {
  const problems = [];
  const paths = new Set(files.map((f) => f.path));
  for (const path of paths) {
    if (!ALLOWED.some((re) => re.test(path))) problems.push(`${path} is not an extension file the store zip may hold`);
  }
  for (const path of REQUIRED) if (!paths.has(path)) problems.push(`${path} is missing`);

  const decoder = new TextDecoder();
  for (const { path, bytes } of files) {
    if (!/\.(m?js|css)$/.test(path)) continue;
    const text = decoder.decode(bytes);
    // A build with test hooks answers `test:` commands; one must never ship.
    if (path.endsWith('.js') && text.includes("'test:model-install'")) problems.push(`${path} was built with test hooks`);
    if (/^\/[/*][#@] sourceMappingURL=/m.test(text)) problems.push(`${path} links a source map`);
  }

  const manifestFile = files.find((f) => f.path === 'manifest.json');
  let manifest = null;
  if (manifestFile) {
    manifest = JSON.parse(decoder.decode(manifestFile.bytes));
    if (manifest.version !== version) problems.push(`manifest.json version ${manifest.version} is not package.json version ${version}`);
    delete manifest.key;
  }
  if (!new RegExp(`^## ${version.replace(/\./g, '\\.')}( |$)`, 'm').test(changelog)) problems.push(`CHANGELOG.md has no "## ${version}" section`);

  if (problems.length) throw new Error(`the store zip is refused:\n  ${problems.join('\n  ')}`);

  const encoded = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const inputs = files
    .map(({ path, bytes }) => ({ path, bytes: path === 'manifest.json' ? encoded : bytes, compress: !STORED.test(path) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { inputs, manifest };
}
