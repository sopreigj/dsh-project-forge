/**
 * per-file claims and the in-flight view other sessions read.
 *
 * privacy-guard: allow — a fixture set: it writes home paths, boundary paths and secret literals
 * into throwaway repositories to prove what the guards refuse.
 */
import { next } from './checkpoint-and-recovery.test.mjs';
import { digest } from './digest.test.mjs';


  // ── Guard E: per-file claims allow parallel work on different files ──────────
  {
    const repo = mkdtempSync(join(tmpdir(), 'forge-concurrent-'));
    writeFileSync(join(repo, 'done.md'), '# done\nbaseline\n');
    writeFileSync(join(repo, 'plan.md'), '# plan\n');
    writeFileSync(join(repo, 'todo.md'), '# todo\n');
    writeFileSync(join(repo, 'a.py'), 'print(1)\n');
    writeFileSync(join(repo, 'b.py'), 'print(2)\n');
    // A tracked file whose name says nothing about being "source": the jurisdiction used to be
    // a source-extension list, and a tracked fixture fell outside it (measured: a `.txt` probe
    // created no claim, so neither the claim branch nor the dirty branch could ever fire).
    writeFileSync(join(repo, 'fixture.txt'), 'baseline\n');
    initRepo(repo);
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'chore: init'], { cwd: repo, stdio: 'pipe' });

    const { ctx: cwCtx, record: cwRecord } = makeCtx();
    plugin.apply(cwCtx, standard.validate({ injectOnCompaction: false }).value);
    const hexA = `${Date.now().toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    const hexB = `${(Date.now() + 1).toString(16).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
    const { agent: agentA } = createdAgent(cwRecord, repo, `session-${hexA}`);
    const { agent: agentB } = createdAgent(cwRecord, repo, `session-${hexB}`);
    // Guard E is the last-registered guard.
    const cwGuard = cwRecord.guards[cwRecord.guards.length - 1];
    assert.ok(cwGuard, 'the concurrent-write guard is registered');

    // Two agents writing DIFFERENT files both proceed (parallel work on different places).
    assert.equal(cwGuard({ name: 'write', arguments: { file_path: join(repo, 'a.py') }, agent: agentA }), undefined, 'A writes a.py');
    assert.equal(cwGuard({ name: 'write', arguments: { file_path: join(repo, 'b.py') }, agent: agentB }), undefined, 'B writes b.py in parallel');
    assert.equal(cwGuard({ name: 'write', arguments: { file_path: join(repo, 'done.md') }, agent: agentA }), undefined, 'A writes done.md');

    // A second agent on the SAME file is refused while A's claim holds.
    const refused = cwGuard({ name: 'write', arguments: { file_path: join(repo, 'done.md') }, agent: agentB });
    assert.equal(typeof refused, 'string', 'B is refused on a file A has claimed');
    assert.ok(/已被会话/.test(refused), 'the refusal names the claim');
    // The refusal must show a recognisable owner id, not the "session-" prefix: owner ids all
    // start with "session-", so a naive slice(0,8) rendered an anonymous ghost (real bug,
    // PaperQuer 2026-10-08). The UUID portion must be visible.
    assert.ok(!/已被会话 session-$/.test(refused), 'the owner id is not truncated to "session-"');
    assert.ok(/已被会话 [0-9a-f]{8}/.test(refused), 'the refusal shows the owner UUID');

    // A stale claim (owner gone quiet past the staleness window) is deleted and taken over.
    const { readFileSync: rfs, writeFileSync: wfs, existsSync: exs } = await import('node:fs');
    const claimDir = join(repo, 'private', '.forge-claims');
    const doneClaim = JSON.parse(rfs(join(claimDir, 'done.md.json'), 'utf8'));
    wfs(join(claimDir, 'done.md.json'), JSON.stringify({ owner: 'session-zzz-gone-0000-000000000000', time: Date.now() - 31 * 60 * 1000 }));
    assert.equal(cwGuard({ name: 'write', arguments: { file_path: join(repo, 'done.md') }, agent: agentB }), undefined, 'B takes over a stale claim');
    assert.ok(!exs(join(claimDir, 'done.md.json')) || JSON.parse(rfs(join(claimDir, 'done.md.json'), 'utf8')).owner === agentB.session.header.id, 'the stale claim is deleted or re-owned by B, never left as residue');

    // A successful commit releases THIS session's claims whose files landed in that commit —
    // and only those. A parallel session's claim is the record that ITS work is still mid-edit;
    // clearing the whole directory (the old behaviour) re-opens the race this guard closes.
    const commitListeners = cwRecord.listeners.filter((entry) => entry.name === 'tools/result');
    assert.ok(commitListeners.length > 0, 'tools/result listeners exist');
    assert.ok(exs(join(claimDir, 'a.py.json')), 'a.py is claimed before the commit');
    for (const listener of commitListeners) {
      listener.handler({ name: 'pwsh', arguments: { command: 'git commit -m "release"' }, agent: agentA }, { isError: false });
    }
    assert.ok(!exs(join(claimDir, 'a.py.json')), "A's own claim is released by A's commit");
    assert.ok(exs(join(claimDir, 'b.py.json')), "another session's claim survives A's commit");
    assert.ok(exs(join(claimDir, 'done.md.json')), 'the claim B took over also survives');

    // A claim that cannot be written must refuse the write. "Claim failed, carry on" is the one
    // answer that cannot be right: two sessions would then write the same file believing each
    // holds it. The atomic rename in writeClaim is what makes this state detectable at all.
    {
      const { rmSync, writeFileSync: wfs2 } = await import('node:fs');
      rmSync(claimDir, { recursive: true, force: true });
      wfs2(claimDir, 'not a directory\n');
      const refusedUnwritable = cwGuard({ name: 'write', arguments: { file_path: join(repo, 'b.py') }, agent: agentA });
      assert.equal(typeof refusedUnwritable, 'string', 'a write is refused when its claim cannot be written');
      assert.ok(/认领记录写不进去/.test(refusedUnwritable), 'the refusal names the claim that could not be written');
      assert.ok(!/已被会话/.test(refusedUnwritable), 'it is not mistaken for a claim conflict');
      rmSync(claimDir, { force: true });
    }

    // Jurisdiction is "project content", not "source-looking file name": a tracked `.txt`
    // is claimed and protected, and an untracked artifact is not. Both halves matter — the
    // point is not to claim *everything*, because `gitDirtyPath` calls an untracked file
    // dirty and refusing those would refuse writes the agent legitimately repeats.
    {
      const { existsSync: exs3, readdirSync: rds3 } = await import('node:fs');
      assert.equal(
        cwGuard({ name: 'write', arguments: { file_path: join(repo, 'fixture.txt') }, agent: agentA }),
        undefined,
        'A may write a tracked .txt',
      );
      assert.ok(rds3(claimDir).includes('fixture.txt.json'), 'a tracked .txt gets a claim');
      const refusedFixture = cwGuard({ name: 'write', arguments: { file_path: join(repo, 'fixture.txt') }, agent: agentB });
      assert.equal(typeof refusedFixture, 'string', 'B is refused on the tracked .txt A claimed');
      assert.ok(/已被会话/.test(refusedFixture) && /fixture\.txt/.test(refusedFixture), 'the refusal names that file and its holder');

      writeFileSync(join(repo, 'build-output.txt'), 'generated\n');
      assert.equal(
        cwGuard({ name: 'write', arguments: { file_path: join(repo, 'build-output.txt') }, agent: agentB }),
        undefined,
        'an untracked artifact stays outside jurisdiction',
      );
      assert.ok(!rds3(claimDir).some((name) => name.startsWith('build-output')), 'no claim is created for an artifact');
      assert.ok(exs3(join(repo, 'fixture.txt')), 'the fixture is still there');
    }

    // A file outside the project is never claimed: scratch files in Temp or elsewhere must
    // not leave claims in this project's claim directory.
    const outside = join(tmpdir(), `forge-outside-${Date.now().toString(36)}.py`);
    writeFileSync(outside, 'print(0)\n');
    assert.equal(cwGuard({ name: 'write', arguments: { file_path: outside }, agent: agentA }), undefined, 'an outside file is writable');
    const claimNames = exs(claimDir) ? (await import('node:fs')).readdirSync(claimDir) : [];
    assert.ok(!claimNames.some((name) => name.includes('forge-outside')), 'no claim is created for an outside file');

    // A file on ANOTHER DRIVE is the case `path.relative` cannot express: it returns the
    // target unchanged, so the "starts with .." test alone let a scratch file under %TEMP%
    // be claimed by a project on a different drive (real defect, 2026-10-14).
    {
      const { existsSync: exs2, readdirSync: rds2 } = await import('node:fs');
      const ownDrive = tmpdir().slice(0, 1).toUpperCase();
      const otherDrive = ['C', 'D', 'E', 'F'].find((letter) => letter !== ownDrive && exs2(`${letter}:\\`));
      if (otherDrive === undefined) {
        console.log('cross-drive claim check skipped (no second drive)');
      } else {
        const crossDrive = `${otherDrive}:\\forge-crossdrive-${Date.now().toString(36)}.py`;
        try {
          writeFileSync(crossDrive, 'print(0)\n');
          assert.equal(
            cwGuard({ name: 'write', arguments: { file_path: crossDrive }, agent: agentA }),
            undefined,
            'a cross-drive file is writable',
          );
          assert.ok(
            !rds2(claimDir).some((name) => name.includes('forge-crossdrive')),
            'no claim is created for a cross-drive file',
          );
          rmSync(crossDrive, { force: true });
        } catch (error) {
          console.log(`cross-drive claim check skipped (${otherDrive}: not writable: ${error.code ?? error.message})`);
        }
      }
    }

    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { force: true });
    console.log('concurrent-write guard: OK');
  }

  // ── Parallel sessions: the in-flight view rides the digest, nothing is hand-kept ──
  // A session may be killed at any moment (machine off, quota gone, user interrupted), so no
  // rule may depend on it cleaning up after itself. What survives is: claims expire on their
  // own, and "who is editing what" is DERIVED from the claim set into the digest every turn.
  {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const repo = mkdtempSync(join(tmpdir(), 'forge-inflight-'));
    mkdirSync(join(repo, 'private'), { recursive: true });
    writeFileSync(join(repo, 'private', 'done.md'), '# done\n');
    writeFileSync(join(repo, 'a.py'), 'print(1)\n');
    initRepo(repo);
    // A clean baseline: the guard refuses to write a file with uncommitted changes, so the
    // first writer must be working on a committed tree.
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'chore: init'], { cwd: repo, stdio: 'pipe' });

    const { ctx: ifCtx, record: ifRecord } = makeCtx();
    plugin.apply(ifCtx, standard.validate({
      injectOnCompaction: false,
      digestRefreshMs: 5,
      claimStaleMs: 1000,
    }).value);
    const hexA = `${Date.now().toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    const hexB = `${(Date.now() + 1).toString(16).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
    const { agent: writer, contexts: writerContexts } = createdAgent(ifRecord, repo, `session-${hexA}`);
    const { agent: reader, contexts: readerContexts } = createdAgent(ifRecord, repo, `session-${hexB}`);
    const cwGuard = ifRecord.guards[ifRecord.guards.length - 1];
    const digestOfReader = () => {
      const context = readerContexts[0];
      return context.text({});
    };

    // Before anyone writes: no in-flight block at all.
    assert.ok(!digestOfReader().includes('在办认领'), 'nothing in flight → no block');

    // The writer claims a file simply by writing it; the other session sees it in its digest.
    assert.equal(
      cwGuard({ name: 'write', arguments: { file_path: join(repo, 'a.py') }, agent: writer }),
      undefined,
      'the writer may write its own file',
    );
    await sleep(15);
    const seen = digestOfReader();
    assert.ok(seen.includes('在办认领'), 'the digest gains an in-flight block');
    assert.ok(seen.includes('`a.py`'), 'the block names the claimed file');
    assert.ok(seen.includes(hexA.slice(0, 8)), 'the block names the owning session');
    assert.ok(seen.includes('静默 0 分钟'), 'the block reports how long the owner has been quiet');
    assert.ok(!seen.includes('（本会话）'), "another session's claim is not marked as my own");

    // The owner's own digest marks its claim as its own, so it knows it has work in flight.
    const ownerSeen = writerContexts[0].text({});
    assert.ok(ownerSeen.includes('`a.py`'), "the owner's digest lists its own claim");
    assert.ok(ownerSeen.includes('（本会话）'), "the owner's own claim is marked as such");

    // The second session is refused while the claim is live.
    assert.equal(
      typeof cwGuard({ name: 'write', arguments: { file_path: join(repo, 'a.py') }, agent: reader }),
      'string',
      'a live claim still blocks the second writer',
    );

    // The owner goes quiet past `claimStaleMs` but nobody has tried to write the file yet: the
    // digest must already say the claim is takeable. Otherwise a session sees nothing in flight
    // and only learns the claim was abandoned by tripping over it — the failure this view exists
    // to prevent.
    writeFileSync(
      join(repo, 'private', '.forge-claims', 'a.py.json'),
      JSON.stringify({ owner: writer.session.header.id, time: Date.now() - 5000, path: 'a.py' }),
    );
    await sleep(15);
    const staleSeen = digestOfReader();
    assert.ok(staleSeen.includes('`a.py`'), 'an expired claim is still listed');
    assert.ok(staleSeen.includes('已过期'), 'and is marked as expired');
    assert.ok(staleSeen.includes('可接手'), 'with the takeover instruction');
    assert.ok(staleSeen.includes(hexA.slice(0, 8)), 'naming the session that went quiet');

    // Only now does a write take it over, and the digest says who it came from and what to do —
    // a guard can only refuse or allow, never annotate.
    assert.equal(
      cwGuard({ name: 'write', arguments: { file_path: join(repo, 'a.py') }, agent: reader }),
      undefined,
      'an expired claim is taken over instead of blocking forever',
    );
    await sleep(15);
    const afterTakeover = digestOfReader();
    assert.ok(afterTakeover.includes('已接手'), 'the digest announces the takeover');
    assert.ok(afterTakeover.includes(hexA.slice(0, 8)), 'the notice names the session that died');
    assert.ok(afterTakeover.includes('先重读该文件'), 'the notice says what to do next');

    // Pinning what was observed live (2026-10-16): the claim outlives the file it names. Deleting
    // the claimed file does NOT release the claim — only a commit or the staleness window does.
    rmSync(join(repo, 'a.py'), { force: true });
    assert.ok(
      existsSync(join(repo, 'private', '.forge-claims', 'a.py.json')),
      'deleting the claimed file does not release its claim',
    );

    rmSync(repo, { recursive: true, force: true });
    console.log('in-flight digest: OK');
  }

  // ── A dead session's uncommitted work must be takeable, not a deadlock ───────
  // The claim above was taken over on a CLEAN file. The case the takeover exists for is the
  // opposite one: the session went quiet between writing the file and committing it, so the file
  // is dirty AND its claim is stale. §12.3 promises that path ("re-read the file, then write"),
  // so the guard must not refuse it — refusing forever leaves the file uneditable by anyone, and
  // the refusal's own advice ("re-read it, reconcile, then write") can never be carried out.
  {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const { appendFileSync } = await import('node:fs');
    const repo = mkdtempSync(join(tmpdir(), 'forge-takeover-dirty-'));
    writeFileSync(join(repo, 'a.py'), 'print(1)\n');
    // The digest context renders nothing for a directory that holds no contract document, so a
    // fixture that wants to read the in-flight block must look like a project (T49's sibling).
    writeFileSync(join(repo, 'done.md'), '# done\nbaseline\n');
    writeFileSync(join(repo, 'plan.md'), '# plan\nbaseline\n');
    writeFileSync(join(repo, 'todo.md'), '# todo\nbaseline\n');
    initRepo(repo);
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'chore: init'], { cwd: repo, stdio: 'pipe' });

    const { ctx: dirtyCtx, record: dirtyRecord } = makeCtx();
    plugin.apply(dirtyCtx, standard.validate({
      injectOnCompaction: false,
      digestRefreshMs: 5,
      claimStaleMs: 1000,
    }).value);
    const deadHex = `${Date.now().toString(16).padStart(8, '0')}-dddd-4ddd-8ddd-dddddddddddd`;
    const liveHex = `${(Date.now() + 1).toString(16).padStart(8, '0')}-eeee-4eee-8eee-eeeeeeeeeeee`;
    const { agent: dead } = createdAgent(dirtyRecord, repo, `session-${deadHex}`);
    const { agent: live, contexts: liveContexts } = createdAgent(dirtyRecord, repo, `session-${liveHex}`);
    const cwGuard = dirtyRecord.guards[dirtyRecord.guards.length - 1];

    // The dead session claims a.py by writing it, then really modifies it and goes quiet.
    assert.equal(cwGuard({ name: 'write', arguments: { file_path: join(repo, 'a.py') }, agent: dead }), undefined, 'the dead session may write its file');
    appendFileSync(join(repo, 'a.py'), 'print(2)\n');
    await sleep(1100);

    const taken = cwGuard({ name: 'write', arguments: { file_path: join(repo, 'a.py') }, agent: live });
    assert.equal(taken, undefined, "a dead session's uncommitted file is takeable after re-reading (§12.3)");
    const claim = JSON.parse(readFileSync(join(repo, 'private', '.forge-claims', 'a.py.json'), 'utf8'));
    assert.equal(claim.owner, live.session.header.id, 'the claim now belongs to the session that took over');
    await sleep(15);
    assert.ok(liveContexts[0].text({}).includes('已接手'), 'the digest announces the takeover so the next step re-reads the file');

    // The owner may keep writing its own dirty file (its claim is live and its own).
    appendFileSync(join(repo, 'a.py'), 'print(3)\n');
    assert.equal(cwGuard({ name: 'write', arguments: { file_path: join(repo, 'a.py') }, agent: live }), undefined, 'the new owner may keep writing its own uncommitted file');

    // The catch-all stays: a dirty file NOBODY claims has provenance the guard cannot know
    // (a hand edit, a script, a write through a tool the guard does not see), so it is refused.
    writeFileSync(join(repo, 'b.py'), 'print(9)\n');
    const orphan = cwGuard({ name: 'write', arguments: { file_path: join(repo, 'b.py') }, agent: live });
    assert.equal(typeof orphan, 'string', 'a dirty file of unknown provenance is still refused');
    assert.ok(/未提交的改动/.test(orphan), 'and the refusal says why');
    assert.ok(/认领/.test(orphan), 'and it names the way forward (a claim on that file)');

    // The advertised way forward must actually work: the refusal prints a claim path, so taking
    // that exact path is the proof. A refusal whose escape hatch does not exist is worse than no
    // advice at all — it costs the reader a round trip and teaches it to distrust the guard.
    const quoted = /`([^`]+)`/g;
    const steps = [...orphan.matchAll(quoted)].map((match) => match[1]);
    const claimForB = steps.find((step) => step.endsWith('.json'));
    assert.ok(claimForB, `the refusal prints the claim path to create (got: ${steps.join(' | ')})`);
    writeFileSync(join(repo, claimForB), JSON.stringify({ owner: live.session.header.id, path: 'b.py', time: Date.now() }));
    assert.equal(
      cwGuard({ name: 'write', arguments: { file_path: join(repo, 'b.py') }, agent: live }),
      undefined,
      'claiming the exact path the refusal printed lets the write through',
    );

    rmSync(repo, { recursive: true, force: true });
    console.log('stale-claim takeover over uncommitted work: OK');
  }


