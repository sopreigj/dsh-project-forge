/**
 * Public-surface check: run the mode's own privacy guard over this repository.
 *
 * The mode refuses a commit whose public surface leaks a home path, reaches into the state
 * boundary from source, or carries a secret literal outside a configuration file. This script
 * asks exactly that question of the repository that implements the mode — the files that
 * define the rule are the ones most likely to violate it, and this is the check the release
 * flow runs before mirroring anything into the public repository.
 *
 * Usage (from anywhere):  node release/check-public-surface.mjs
 * Exit code 0 = clean; 1 = the guard refuses, with the offending files named.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const pluginPath = fileURLToPath(new URL('../plugin/index.js', import.meta.url));
const plugin = await import(pathToFileURL(pluginPath).href);

const recorded = [];
const ctx = {
  effect: (factory) => factory(),
  on: () => () => {},
  logger: { info: () => {}, warn: () => {} },
  tools: { guard: (guard) => { recorded.push(guard); return () => {}; } },
  systemPrompt: { section: () => () => {}, context: () => () => {} },
};

// Only the privacy guard is on, so any refusal observed comes from it.
const config = plugin.Config['~standard'].validate({
  digest: false,
  injectOnCompaction: false,
  guardLocalGit: false,
  guardCommitCheckpoint: false,
  guardLayoutCheckpoint: false,
  guardSecrets: false,
  guardConcurrentWrite: false,
}).value;

plugin.apply(ctx, config);
const agent = { id: 'public-surface-check', session: { header: { cwd: repositoryRoot, id: 'public-surface-check' } } };
const verdicts = recorded
  .map((guard) => guard({ name: 'pwsh', arguments: { command: 'git commit -m "public surface check"' }, agent }))
  .filter((verdict) => typeof verdict === 'string');

if (verdicts.length > 0) {
  console.error('PUBLIC SURFACE CHECK FAILED:\n' + verdicts.join('\n---\n'));
  process.exit(1);
}
console.log(`public surface: clean (${repositoryRoot})`);
