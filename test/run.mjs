/**
 * The check runner. It owns the fixture and the node builtins, installs them on globalThis, then
 * imports every slice check in the order they were originally written — they share this one process
 * and one fixture repository, and a failure names the file that failed.
 */
import { PROJECT_MARKERS, agentListeners, createdAgent, initRepo, makeCtx, plugin, pluginPath, project, sharedSlice, shell, standard } from './harness.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

Object.assign(globalThis, { PROJECT_MARKERS, agentListeners, createdAgent, initRepo, makeCtx, plugin, pluginPath, project, sharedSlice, shell, standard, assert, execFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, tmpdir, dirname, join, resolve });

const checks = [
  'config.test.mjs',
  'preset-schema.test.mjs',
  'protocol.test.mjs',
  'digest.test.mjs',
  'checkpoint-and-recovery.test.mjs',
  'guards-local-git.test.mjs',
  'guards-malformed-calls.test.mjs',
  'guards-malformed-parity.test.mjs',
  'guards-concurrent-write.test.mjs',
  'guards-hygiene.test.mjs',
  'digest-configuration.test.mjs',
  'guards-records.test.mjs',
  'clock.test.mjs',
  'repo-window.test.mjs',
];

for (const check of checks) {
  await import(new URL(`./${check}`, import.meta.url).href);
}

console.log(`\n${plugin.name}: all plugin checks passed`);
