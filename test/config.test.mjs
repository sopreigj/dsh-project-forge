/**
 * the declared contract: Config, the preset patch row, and the plugin identity.
 *
 * privacy-guard: allow — a fixture set: it writes home paths, boundary paths and secret literals
 * into throwaway repositories to prove what the guards refuse.
 */




assert.equal(plugin.name, 'project-forge', 'plugin name');
assert.deepEqual(plugin.inject, ['systemPrompt', 'tools'], 'injected services');

// ── Config contract ─────────────────────────────────────────────────────────────
// The Loader validates a row's config through the Standard Schema interface
// (`Config['~standard'].validate`). A plain object here fails the whole preset, so this
// contract is asserted before any behavior check.
assert.ok(plugin.Config, 'plugin exports Config');
assert.ok(standard, 'Config implements the ~standard interface');
assert.equal(standard.version, 1, 'standard schema version');
assert.equal(typeof standard.validate, 'function', 'standard schema validate');

for (const [raw, expected] of [
  [undefined, { protocol: true, digest: true, injectOnCompaction: true }],
  [null, { protocol: true, digest: true, injectOnCompaction: true }],
  [{}, { protocol: true, digest: true, injectOnCompaction: true }],
  [{ protocol: false }, { protocol: false, digest: true, injectOnCompaction: true }],
  [{ digest: false }, { protocol: true, digest: false, injectOnCompaction: true }],
]) {
  const result = standard.validate(raw);
  assert.ok(!('issues' in result), `valid config accepted: ${JSON.stringify(raw)}`);
  const value = result.value;
  assert.equal(value.protocol, expected.protocol, `protocol for ${JSON.stringify(raw)}`);
  assert.equal(value.digest, expected.digest, `digest for ${JSON.stringify(raw)}`);
  assert.equal(value.injectOnCompaction, expected.injectOnCompaction, `injectOnCompaction for ${JSON.stringify(raw)}`);
  assert.equal(value.repoStateInDigest, true, 'repoStateInDigest default');
  assert.equal(value.stewardFile, true, 'stewardFile default');
  assert.equal(value.stewardFilePath, 'private/steward.md', 'stewardFilePath default');
  assert.equal(value.stateDir, 'private', 'stateDir default');
  assert.equal(value.guardLocalGit, true, 'guardLocalGit default');
  assert.equal(value.guardCommitCheckpoint, true, 'guardCommitCheckpoint default');
  assert.equal(value.guardPrivacyBoundary, true, 'guardPrivacyBoundary default');
  assert.deepEqual(value.digestFiles, ['plan.md', 'done.md', 'todo.md'], 'contract documents default (least volatile first)');
  assert.deepEqual(
    value.documentBudgets,
    { 'steward.md': 6000, 'plan.md': 15000, 'done.md': 2000, 'todo.md': 5000 },
    'per-document budgets default',
  );
  assert.equal(value.documentBudgetDefault, 20000, 'budget fallback');
  assert.equal(value.journalFile, 'journal.jsonl', 'journal file default');
  assert.equal(value.tortuousFile, 'tortuous.jsonl', 'negative-knowledge file default');
  assert.equal(value.journalRecoveryEntries, 5, 'recovery carries five journal entries');
  assert.equal(value.tortuousIndexBytes, 2500, 'negative-knowledge index ceiling');
  assert.equal(value.digestMaxBytes, 28000, 'digestMaxBytes default (fuse)');
  assert.equal(value.digestRefreshMs, 5000, 'digestRefreshMs default');
  assert.equal(value.claimStaleMs, 600000, 'claimStaleMs default (10 minutes)');
}
for (const [raw, why] of [
  [{ protocol: 'yes' }, 'string for a boolean'],
  [{ nope: 1 }, 'unknown field'],
  [{ digestFiles: [1] }, 'non-string file list'],
  [{ digestMaxBytes: 0 }, 'non-positive number'],
  [{ claimStaleMs: 0 }, 'non-positive claim window'],
  [{ stewardFilePath: '   ' }, 'blank steward path'],
  [{ stateDir: '   ' }, 'blank state directory'],
  [{ documentBudgets: { 'plan.md': 'lots' } }, 'non-numeric per-document budget'],
  [{ documentBudgets: { 'plan.md': 0 } }, 'zero per-document budget'],
  [{ documentBudgets: { 'plan.md': -1 } }, 'negative per-document budget'],
  [{ journalFile: '   ' }, 'blank journal file'],
  [{ tortuousFile: '   ' }, 'blank negative-knowledge file'],
]) {
  const result = standard.validate(raw);
  assert.ok(Array.isArray(result.issues) && result.issues.length > 0, `rejected: ${why}`);
}

