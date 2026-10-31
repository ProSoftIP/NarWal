#!/usr/bin/env node
// narwal-bundle validate <dir> [--json]   exit 0 valid, 1 invalid, 2 usage
// narwal-bundle export <dir> [--json]     print the agent view (Markdown, or JSON) of a valid bundle

import { buildAgentView, renderMarkdown, stableJson } from '../src/agent-view.ts';
import { dirSource } from '../src/node-dir.ts';
import { validateBundle } from '../src/validate.ts';
import type { Issue } from '../src/types.ts';

const [command, dir, ...flags] = process.argv.slice(2);
const json = flags.includes('--json');
if ((command !== 'validate' && command !== 'export') || !dir || flags.some((f) => f !== '--json')) {
  process.stderr.write('usage: narwal-bundle validate|export <bundle-dir> [--json]\n');
  process.exit(2);
}

const result = await validateBundle(dirSource(dir));
const show = (issue: Issue): string => `${issue.code} ${issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ''} ` : ''}${issue.message}`;

if (command === 'validate') {
  if (json) process.stdout.write(`${JSON.stringify({ ok: result.ok, errors: result.errors, warnings: result.warnings }, null, 2)}\n`);
  else {
    for (const e of result.errors) process.stdout.write(`error ${show(e)}\n`);
    for (const w of result.warnings) process.stdout.write(`warning ${show(w)}\n`);
    process.stdout.write(`${result.ok ? 'VALID' : 'INVALID'} errors=${result.errors.length} warnings=${result.warnings.length}\n`);
  }
  process.exit(result.ok ? 0 : 1);
}

if (!result.bundle) {
  for (const e of result.errors) process.stderr.write(`error ${show(e)}\n`);
  process.stderr.write('INVALID: no export\n');
  process.exit(1);
}
const view = buildAgentView(result.bundle);
process.stdout.write(json ? stableJson(view) : renderMarkdown(view));
