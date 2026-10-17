/**
 * repoCommitWindow: the recent-commit list is a configured window.
 *
 * privacy-guard: allow — a fixture set: it writes home paths, boundary paths and secret literals
 * into throwaway repositories to prove what the guards refuse.
 */


  // ── repoCommitWindow: the recent-commit list is a configured window ──────────
  // The failure this replaces: the window was hardcoded to 8 for both the digest and the
  // checkpoint guard's drift signal, so a busy history could not be widened or narrowed.
  // `.git/logs/HEAD` is written by hand — `readRepoState` reads that file, not `git log`.
  const { mkdirSync } = await import('node:fs');
  const windowProject = mkdtempSync(join(tmpdir(), 'steward-window-'));
  mkdirSync(join(windowProject, '.git', 'logs'), { recursive: true });
  mkdirSync(join(windowProject, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(windowProject, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(windowProject, '.git', 'refs', 'heads', 'main'), 'abcdef1234567890\n');
  const logLines = [];
  for (let i = 1; i <= 12; i += 1) {
    const hash = String(i).padStart(8, '0').repeat(2);
    logLines.push(`0000000 ${hash} A <a@b> 1700000000 +0000\tcommit: subject ${i}`);
  }
  writeFileSync(join(windowProject, '.git', 'logs', 'HEAD'), `${logLines.join('\n')}\n`);
  // The digest returns early when it has no document to inline, and that early return is
  // *before* the repository block — so the fixture needs one file to make the digest render.
  writeFileSync(join(windowProject, 'done.md'), 'WINDOW-FIXTURE-MARK\n');

  const commitsIn = (window) => {
    const { ctx, record } = makeCtx();
    plugin.apply(ctx, standard.validate({
      digestFiles: ['done.md'], repoCommitWindow: window, stewardFile: false, injectOnCompaction: false,
    }).value);
    const { contexts } = createdAgent(record, windowProject, `session-window-${window}`);
    return (contexts[0].text({}).match(/^- [0-9a-f]{8} subject /gm) ?? []).length;
  };
  assert.equal(commitsIn(3), 3, 'repoCommitWindow 3 lists exactly three commits');
  assert.equal(commitsIn(5), 5, 'repoCommitWindow 5 lists exactly five');
  assert.equal(commitsIn(undefined), 8, 'the default window stays 8 when the field is not set');
  rmSync(windowProject, { recursive: true, force: true });
  console.log('repoCommitWindow: OK');

rmSync(project, { recursive: true, force: true });

console.log('\nall plugin checks passed');

