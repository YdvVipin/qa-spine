#!/usr/bin/env node
/**
 * The `qa-spine` bin. It checks Node before anything loads `node:sqlite`: on an older Node that
 * import fails while modules are still being linked, before any of server.ts runs, and the error
 * never says "upgrade Node". Only `node:fs` and `node:url` here, and nothing newer than Node 18.
 *
 * dist/server.js stays runnable on its own, so `claude mcp add … node …/dist/server.js` lines
 * written by earlier versions keep working.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** One sentence when this Node cannot run qa-spine, else undefined. Mirrors `engines` (>=22.13). */
export function nodeTooOld(version: string = process.versions.node): string | undefined {
  const [major, minor] = version.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 13)) return undefined;
  return `qa-spine needs Node 22.13 or later; this is Node ${version}. Install a newer Node from https://nodejs.org and run the command again.`;
}

function invokedAsScript(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  const tooOld = nodeTooOld();
  if (tooOld) {
    console.error(tooOld);
    process.exit(2);
  }
  // node:sqlite prints "ExperimentalWarning: SQLite is an experimental feature" on every
  // command, which reads to a new user as something having gone wrong. Only that one warning is
  // dropped; every other warning still prints.
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(typeof warning === 'string' ? warning : warning?.message).includes('SQLite is an experimental feature')) return;
    return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  const { main } = await import('./server.ts');
  await main();
}
