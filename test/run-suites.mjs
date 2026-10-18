/**
 * Run every assertion suite: `npm test`.
 *
 * The suites were run by hand for most of this project's life, which meant a
 * hand-maintained skip list lived in whatever shell history the last person had.
 * A skip list that is not in the repository is a skip list that silently grows:
 * a suite that fails for a boring reason gets added to it, and nobody notices
 * that it stopped running.
 *
 * So the exclusions are declared here, once, with the reason for each — and the
 * test output ends by listing them. Everything not listed must pass.
 *
 * Children inherit stdio rather than being piped: each suite already prints its
 * own `N/M checks passed`, and piping would both duplicate that and hit the
 * sandbox's restriction on a child process capturing another's output.
 */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Files in this directory that are not assertion suites, and why. */
const NOT_SUITES = new Map([
  ['run-suites.mjs', 'this file'],
  ['session-log.mjs', 'a library the end-to-end scripts import'],
  ['mk-test-home.ps1', 'a helper that builds a throwaway DSH_HOME'],
  ['e2e-forget.mjs', 'drives a real agent against a throwaway DSH_HOME'],
  ['e2e-tools.mjs', 'drives a real agent against a throwaway DSH_HOME'],
  ['tableaudit.mjs', 'audit: prints a report, asserts nothing'],
  ['columnaudit.mjs', 'audit: prints a report, asserts nothing'],
  ['leakprobe.mjs', 'observation: needs a database path'],
  ['claritystate.mjs', 'observation: needs a database path'],
  ['dbstate.mjs', 'observation: needs a database path'],
  ['live.mjs', 'observation: needs a database path'],
  ['loops.mjs', 'observation: needs a database path'],
  ['reflections.mjs', 'observation: needs a database path'],
  ['show-prompt.mjs', 'observation: needs a database path'],
  ['inspect-affect.mjs', 'observation: needs a database path'],
  ['inspect-db.mjs', 'observation: needs a database path'],
  ['inspect-facts.mjs', 'observation: needs a database path'],
  ['diagnose-evidence.mjs', 'observation: needs a database path'],
  ['migrate.mjs', 'a procedure, not a test: it upgrades a copy of a database'],
  ['real-consolidate.mjs', 'needs a database path and a live model'],
  ['force-consolidate.mjs', 'needs a database path and a live model'],
  ['clarify-paths.mjs', 'needs a database path and a live model'],
  ['chprobe.mjs', 'observation: prints the channel of every session, asserts nothing'],
  ['groupprobe.mjs', 'observation: needs a database path'],
  ['realsubjects.mjs', 'observation: needs a database path'],
  ['sensprobe.mjs', 'observation: needs a database path'],
  ['subjectprobe.mjs', 'observation: reproduces the group-attribution bug on an in-memory store'],
  ['roomprobe.mjs', 'observation: compares what a room is told with what a private chat is told'],
  ['sceneprobe.mjs', 'observation: prints the owner, stranger and room blocks side by side'],
  ['summary-leak.mjs', 'observation: lists live summaries that still quote a room'],
  ['clean-room-leak.mjs', 'a procedure: redacts a disclosure that already happened, writes only with --apply'],
  ['privprobe.mjs', 'observation: needs a database path, prints who spoke in each session'],
  ['nameprobe.mjs', 'observation: prints every version of the name facts, live and dead'],
  ['repair-name.mjs', 'a procedure: retires the name a stranger overwrote, writes only with --apply'],
  ['real-command.mjs', 'observation: runs /memory against a real database and prints the answers'],
  ['snap.mjs', 'a procedure: writes a VACUUM INTO copy of a database'],
]);

const files = readdirSync(here)
  .filter((name) => name.endsWith('.mjs') && !NOT_SUITES.has(name))
  .sort();

let failed = 0;
for (const name of files) {
  process.stdout.write(`\n=== ${name}\n`);
  const result = spawnSync(process.execPath, [join(here, name)], { stdio: 'inherit' });
  if (result.status !== 0) {
    failed += 1;
    process.stdout.write(`FAIL ${name} (exit ${result.status})\n`);
  }
}

const skipped = readdirSync(here).filter((name) => NOT_SUITES.has(name)).sort();
process.stdout.write(`\n${files.length - failed}/${files.length} suites passed\n`);
process.stdout.write(`not run here (${skipped.length}): ${skipped.join(', ')}\n`);
if (failed > 0) process.exitCode = 1;