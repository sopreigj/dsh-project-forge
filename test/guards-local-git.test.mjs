/**
 * the local-only git guard, its one-shot grants, and the guard switches.
 *
 * privacy-guard: allow — a fixture set: it writes home paths, boundary paths and secret literals
 * into throwaway repositories to prove what the guards refuse.
 */
import { guardAgent, guardRecord } from './checkpoint-and-recovery.test.mjs';


  // ── Guard A: local-only git, with no false positives ─────────────────────────
  const localGitGuard = guardRecord.guards.find(
    (guard) => typeof guard(shell('git push origin main', guardAgent)) === 'string',
  );
  assert.ok(localGitGuard, 'the local-git guard is registered');
  for (const command of [
    'git push',
    'git remote add origin https://example.com/x.git',
    'git remote set-url origin https://example.com/x.git',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git branch -D feature',
  ]) {
    assert.ok(
      String(localGitGuard(shell(command, guardAgent))).includes('仅本地'),
      `refuses ${command}`,
    );
  }
  for (const command of [
    'git status --short',
    'git log --oneline',
    'git add -A && git commit -m "docs: note that we never git push"',
    "git commit -m 'remote add is forbidden here'",
    'echo "git push"',
    'git fetch --all',
    'git remote -v',
  ]) {
    assert.equal(localGitGuard(shell(command, guardAgent)), undefined, `allows ${command}`);
  }
  // The bypass surfaces found by probing (T43): a git global option used to sit between `git` and
  // its subcommand, or a shell wrapper hiding the real command inside quotes, or the plumbing push.
  for (const command of [
    'git -c credential.helper=store push origin main',
    'git -c push.default=current push',
    'git -C . push origin main',
    'git --no-pager push origin main',
    'git -c core.pager=cat push origin main',
    'bash -c "git push origin main"',
    'sh -c \'git push origin main\'',
    'pwsh -NoProfile -Command "git push origin main"',
    'git send-pack origin main',
    'git -c credential.helper=store send-pack origin main',
    'git config --global alias.p push',
    'gh api -X POST /repos/o/r/git/refs',
    'gh api --method=PATCH /repos/o/r',
    'gh release create v1',
  ]) {
    assert.ok(
      String(localGitGuard(shell(command, guardAgent))).includes('仅本地'),
      `refuses the bypass shape ${command}`,
    );
  }
  // Still allowed: read-only or unrelated uses, including the plumbing that does not publish.
  for (const command of [
    'git fetch --all --prune',
    'git remote update',
    'git --no-pager log --oneline',
    'bash -c "git status --short"',
    'gh api /repos/o/r',
    'gh pr list',
  ]) {
    assert.equal(localGitGuard(shell(command, guardAgent)), undefined, `still allows ${command}`);
  }
  console.log('local-git guard: OK');

  // ── Guard A: one-shot push grants — consume on use, never standing permission ──
  {
    const { readFileSync: rfs2 } = await import('node:fs');
    const repo = mkdtempSync(join(tmpdir(), 'forge-grant-'));
    writeFileSync(join(repo, 'app.py'), 'print(1)\n');
    mkdirSync(join(repo, '.agents'), { recursive: true });
    initRepo(repo);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/sopreigj/nhentai-downloader.git'], { cwd: repo, stdio: 'pipe' });

    const { ctx: gCtx, record: gRecord } = makeCtx();
    plugin.apply(gCtx, standard.validate({ injectOnCompaction: false }).value);
    const { agent: gAgent } = createdAgent(gRecord, repo, `session-grant-${Date.now().toString(36)}`);
    const pushGuard = gRecord.guards.find(
      (guard) => typeof guard(shell('git push origin main', gAgent)) === 'string',
    );
    assert.ok(pushGuard, 'the push guard is registered');

    // No grant: refused, and the refusal teaches the one-shot grant syntax.
    const noGrant = pushGuard(shell('git push origin main', gAgent));
    assert.ok(String(noGrant).includes('仅本地') && String(noGrant).includes('push allowed:'), 'refused without a grant, with grant syntax in the refusal');

    // Write a ×1 grant: one push passes, the grant line is consumed, the next push is refused.
    writeFileSync(join(repo, '.agents', 'steward.md'), '# rules\n\npush allowed: github.com/sopreigj/nhentai-downloader ×1\n');
    assert.equal(pushGuard(shell('git push origin main', gAgent)), undefined, 'first push consumes the ×1 grant');
    const stewardAfter1 = rfs2(join(repo, '.agents', 'steward.md'), 'utf8');
    assert.ok(!stewardAfter1.includes('push allowed'), 'the ×1 grant line is gone after use');
    assert.ok(String(pushGuard(shell('git push origin main', gAgent))).includes('仅本地'), 'second push refused — the grant was one-shot');

    // ×2 grant: counts down, then runs out.
    writeFileSync(join(repo, '.agents', 'steward.md'), 'push allowed: github.com/sopreigj/* ×2\n');
    assert.equal(pushGuard(shell('git push origin main', gAgent)), undefined, 'first of ×2');
    assert.ok(rfs2(join(repo, '.agents', 'steward.md'), 'utf8').includes('×1'), 'counted down to ×1');
    assert.equal(pushGuard(shell('git push origin main', gAgent)), undefined, 'second of ×2');
    assert.ok(!rfs2(join(repo, '.agents', 'steward.md'), 'utf8').includes('push allowed'), '×2 exhausted, line removed');
    assert.equal(typeof pushGuard(shell('git push origin main', gAgent)), 'string', 'third push refused');

    // A grant for a different remote does not cover this one.
    writeFileSync(join(repo, '.agents', 'steward.md'), 'push allowed: github.com/someone-else/*\n');
    assert.ok(String(pushGuard(shell('git push origin main', gAgent))).includes('仅本地'), 'mismatched grant refused');

    // An explicit-URL push matches the URL form directly.
    writeFileSync(join(repo, '.agents', 'steward.md'), 'push allowed: github.com/sopreigj/* ×1\n');
    assert.equal(pushGuard(shell('git push https://github.com/sopreigj/nhentai-downloader.git main', gAgent)), undefined, 'explicit-URL push covered by glob grant');

    // Force pushes are never covered by a grant, even with grants in stock.
    writeFileSync(join(repo, '.agents', 'steward.md'), 'push allowed: *\n');
    assert.ok(String(pushGuard(shell('git push -f origin main', gAgent))).includes('强推'), 'force push refused despite wildcard grant');
    assert.ok(String(pushGuard(shell('git push --force-with-lease origin main', gAgent))).includes('强推'), 'force-with-lease refused');
    assert.ok(String(pushGuard(shell('git remote add upstream https://github.com/x/y.git', gAgent))).includes('仅本地'), 'remote add never covered');

    // The predicate is about the *command*, not the tool that carries it: a command inside another
    // tool's arguments (an MCP tool, say) is inspected too. Anything outside command/cmd stays out
    // of reach, and that boundary is asserted here rather than described in prose.
    const wrapped = (command) => ({ name: 'mcp__example__tool_invoke', arguments: { tool: 'run', command }, agent: gAgent });
    assert.ok(String(pushGuard(wrapped('git remote add upstream https://github.com/x/y.git'))).includes('仅本地'), 'a command carried by another tool is inspected');
    assert.equal(pushGuard(wrapped('kicad-cli pcb export step')), undefined, 'an unrelated command carried by another tool is allowed');
    assert.equal(
      pushGuard({ name: 'mcp__example__tool_invoke', arguments: { note: 'git remote add upstream https://github.com/x/y.git' }, agent: gAgent }),
      undefined,
      'a command outside command/cmd stays out of reach (documented boundary)',
    );

    rmSync(repo, { recursive: true, force: true });
    console.log('one-shot push grants: OK');
  }

  // ── All six guards are switchable ────────────────────────────────────────────
  const { ctx: offCtx, record: offRecord } = makeCtx();
  plugin.apply(offCtx, standard.validate({
    digest: false,
    injectOnCompaction: false,
    guardLocalGit: false,
    guardCommitCheckpoint: false,
    guardLayoutCheckpoint: false,
    guardSecrets: false,
    guardPrivacyBoundary: false,
    guardConcurrentWrite: false,
    guardAppendOnly: false,
  }).value);
  assert.equal(offRecord.guards.length, 0, 'no guards when every guard is off');
  console.log('guard switches: OK');

