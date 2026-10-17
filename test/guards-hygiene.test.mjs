/**
 * layout, secrets and the public surface, enforced at the commit.
 *
 * privacy-guard: allow — a fixture set: it writes home paths, boundary paths and secret literals
 * into throwaway repositories to prove what the guards refuse.
 */


  // ── Guard C: the layout checkpoint ───────────────────────────────────────────
  {
    // A root that has become a shelf for several kinds of artifact: code + a unit + a script.
    const messy = mkdtempSync(join(tmpdir(), 'forge-layout-messy-'));
    writeFileSync(join(messy, 'tool.py'), 'print(1)\n');
    writeFileSync(join(messy, 'daemon.service'), '[Unit]\n');
    writeFileSync(join(messy, 'deploy.sh'), 'echo deploy\n');
    writeFileSync(join(messy, 'done.md'), '# done\nnothing about the tree yet\n');
    writeFileSync(join(messy, 'todo.md'), '# todo\n');
    writeFileSync(join(messy, 'plan.md'), '# plan\n');
    initRepo(messy);

    const { ctx: layCtx, record: layRecord } = makeCtx();
    plugin.apply(layCtx, standard.validate({ injectOnCompaction: false }).value);
    const { agent: layAgent } = createdAgent(layRecord, messy, `session-layout-${Date.now().toString(36)}`);
    const layoutGuard = layRecord.guards.find(
      (guard) => typeof guard(shell('git commit -m x', layAgent)) === 'string',
    );
    assert.ok(layoutGuard, 'the layout guard is registered');
    const refusal = layoutGuard(shell('git commit -m "x"', layAgent));
    assert.equal(typeof refusal, 'string', 'a mixed-kind root is refused until acknowledged');
    assert.ok(refusal.includes('布局'), 'the refusal is about the layout');
    assert.ok(refusal.includes('tool.py'), 'the refusal names what it measured');

    // A bare file name in the documents does NOT acknowledge: state documents mention file
    // names incidentally, so accepting one would pass on a lucky string, not on a real walk.
    writeFileSync(join(messy, 'done.md'), '# done\n\ntoday we touched tool.py and daemon.service\n');
    assert.equal(
      typeof layoutGuard(shell('git commit -m x', layAgent)),
      'string',
      'a bare file name does not acknowledge the tree',
    );

    // Naming a directory does: it can only come from having looked at the tree.
    mkdirSync(join(messy, 'deploy'), { recursive: true });
    writeFileSync(join(messy, 'done.md'), '# done\n\nthe root keeps tool.py; units and scripts go under deploy/\n');
    assert.equal(layoutGuard(shell('git commit -m x', layAgent)), undefined, 'naming a directory acknowledges the tree');
    rmSync(join(messy, 'deploy'), { recursive: true, force: true });

    // So does an explicit decision to stay flat.
    writeFileSync(join(messy, 'done.md'), '# done\n\n保持扁平：这个项目只有三个文件，不值得分层\n');
    assert.equal(layoutGuard(shell('git commit -m x', layAgent)), undefined, 'a recorded flat decision acknowledges it');

    // Emptied again: the guard is about the tree, not about the document being written.
    writeFileSync(join(messy, 'done.md'), '# done\n');
    assert.equal(typeof layoutGuard(shell('git commit -m x', layAgent)), 'string', 'an empty document does not acknowledge');

    // Only commits are governed, and unrelated tools are untouched.
    assert.equal(layoutGuard(shell('git status --short', layAgent)), undefined, 'non-commit commands are untouched');
    assert.equal(layoutGuard({ name: 'read', arguments: {}, agent: layAgent }), undefined, 'other tools are untouched');

    // One kind of artifact is not a mess: a flat source-only root stays committable.
    const tidy = mkdtempSync(join(tmpdir(), 'forge-layout-tidy-'));
    writeFileSync(join(tidy, 'a.py'), 'print(1)\n');
    writeFileSync(join(tidy, 'done.md'), '# done\n');
    initRepo(tidy);
    const { ctx: tidyCtx, record: tidyRecord } = makeCtx();
    plugin.apply(tidyCtx, standard.validate({ injectOnCompaction: false }).value);
    const { agent: tidyAgent } = createdAgent(tidyRecord, tidy, `session-tidy-${Date.now().toString(36)}`);
    const tidyGuard = tidyRecord.guards.find(
      (guard) => typeof guard(shell('git commit -m x', tidyAgent)) === 'string',
    );
    assert.equal(tidyGuard, undefined, 'a single-kind root with few files is not flagged');

    rmSync(messy, { recursive: true, force: true });
    rmSync(tidy, { recursive: true, force: true });
    console.log('layout guard: OK');
  }

  // ── Guard D: no secrets into the repository ──────────────────────────────────
  {
    // A tracked credential file must refuse the commit.
    const leaky = mkdtempSync(join(tmpdir(), 'forge-secrets-'));
    writeFileSync(join(leaky, 'app.py'), 'print(1)\n');
    writeFileSync(join(leaky, '.env'), 'API_KEY=shhh\n');
    writeFileSync(join(leaky, 'done.md'), '# done\n');
    writeFileSync(join(leaky, 'todo.md'), '# todo\n');
    writeFileSync(join(leaky, 'plan.md'), '# plan\n');
    initRepo(leaky);
    execFileSync('git', ['add', '-A'], { cwd: leaky, stdio: 'pipe' });

    const { ctx: secCtx, record: secRecord } = makeCtx();
    plugin.apply(secCtx, standard.validate({
      guardLocalGit: false, guardCommitCheckpoint: false, guardLayoutCheckpoint: false,
    }).value);
    const { agent: secAgent } = createdAgent(secRecord, leaky, `session-secrets-${Date.now().toString(36)}`);
    const secretsGuard = secRecord.guards.find(
      (guard) => typeof guard(shell('git commit -m x', secAgent)) === 'string',
    );
    assert.ok(secretsGuard, 'the secrets guard is registered');
    const refusal = secretsGuard(shell('git commit -m "x"', secAgent));
    assert.equal(typeof refusal, 'string', 'a tracked .env refuses the commit');
    assert.ok(refusal.includes('凭据'), 'the refusal is about secrets');
    assert.ok(refusal.includes('.env'), 'the refusal names the offending file');

    // Untracking the credential file clears it.
    execFileSync('git', ['rm', '--cached', '.env'], { cwd: leaky, stdio: 'pipe' });
    assert.equal(secretsGuard(shell('git commit -m x', secAgent)), undefined, 'untracking the credential clears the refusal');

    // A tracked private key also refuses; a tracked ordinary source file does not.
    execFileSync('git', ['add', '-A'], { cwd: leaky, stdio: 'pipe' });
    writeFileSync(join(leaky, 'server.pem'), '-----BEGIN PRIVATE KEY-----\n');
    execFileSync('git', ['add', 'server.pem'], { cwd: leaky, stdio: 'pipe' });
    assert.equal(typeof secretsGuard(shell('git commit -m x', secAgent)), 'string', 'a tracked .pem refuses');
    execFileSync('git', ['rm', '--cached', 'server.pem'], { cwd: leaky, stdio: 'pipe' });

    // Non-commit commands and other tools are untouched.
    assert.equal(secretsGuard(shell('git status --short', secAgent)), undefined, 'non-commit commands are untouched');
    assert.equal(secretsGuard({ name: 'read', arguments: {}, agent: secAgent }), undefined, 'other tools are untouched');

    // The same file inside the state boundary is the local-only side of the project: a
    // repository that keeps its own state may keep its own credentials there (§1.7).
    execFileSync('git', ['rm', '--cached', '.env'], { cwd: leaky, stdio: 'pipe' });
    mkdirSync(join(leaky, 'private'), { recursive: true });
    writeFileSync(join(leaky, 'private', '.env'), 'API_KEY=local-only\n');
    execFileSync('git', ['add', 'private/.env'], { cwd: leaky, stdio: 'pipe' });
    assert.equal(
      secretsGuard(shell('git commit -m x', secAgent)),
      undefined,
      'a credential file inside the boundary is allowed',
    );

    rmSync(leaky, { recursive: true, force: true });
    console.log('secrets guard: OK');
  }

  // ── Guard E: the public surface stays open-source-ready ──────────────────────
  // The export motion is "delete the state boundary, copy, `git init`", so whatever sits
  // outside `private/` is published as-is. This guard refuses the commit that would publish
  // machine-private material. Every other guard is off here, so the only guard that can
  // refuse is the one under test.
  {
    const pub = mkdtempSync(join(tmpdir(), 'forge-privacy-'));
    mkdirSync(join(pub, 'private'), { recursive: true });
    writeFileSync(join(pub, 'README.md'), '# project\n');
    writeFileSync(join(pub, 'app.py'), 'print(1)\n');
    writeFileSync(join(pub, 'private', 'done.md'), '# done\n');
    writeFileSync(join(pub, 'private', 'todo.md'), '# todo\n');
    writeFileSync(join(pub, 'private', 'plan.md'), '# plan\n');
    initRepo(pub);
    execFileSync('git', ['add', '-A'], { cwd: pub, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'chore: init'], { cwd: pub, stdio: 'pipe' });

    const { ctx: pvCtx, record: pvRecord } = makeCtx();
    plugin.apply(pvCtx, standard.validate({
      guardLocalGit: false,
      guardCommitCheckpoint: false,
      guardLayoutCheckpoint: false,
      guardSecrets: false,
      injectOnCompaction: false,
    }).value);
    const { agent: pvAgent } = createdAgent(pvRecord, pub, `session-privacy-${Date.now().toString(36)}`);
    const commit = () => shell('git commit -m "x"', pvAgent);
    assert.ok(pvRecord.guards.length > 0, 'the privacy guard is registered');
    const refusalFor = () => pvRecord.guards
      .map((guard) => guard(commit()))
      .find((verdict) => typeof verdict === 'string');

    assert.equal(refusalFor(), undefined, 'a clean public surface commits');

    // 1. A home directory of the machine that wrote the file.
    writeFileSync(join(pub, 'app.py'), 'NOTES = "C:\\Users\\someone\\project\\notes.txt"\n');
    const homeRefusal = refusalFor();
    assert.equal(typeof homeRefusal, 'string', 'a home path in the public surface refuses the commit');
    assert.ok(homeRefusal.includes('app.py'), 'the refusal names the offending file');
    assert.ok(homeRefusal.includes('家目录'), 'the refusal says what leaked');
    writeFileSync(join(pub, 'app.py'), 'print(1)\n');

    // 2. Source reaching into the state boundary: after export that path does not exist.
    writeFileSync(join(pub, 'app.py'), `NOTES = "${'private'}/notes/session.md"\n`);
    const reachRefusal = refusalFor();
    assert.equal(typeof reachRefusal, 'string', 'source reaching into the boundary refuses the commit');
    assert.ok(reachRefusal.includes('状态边界'), 'the refusal names the boundary');
    writeFileSync(join(pub, 'app.py'), 'print(1)\n');

    // 3. A high-confidence secret literal outside a configuration file.
    writeFileSync(join(pub, 'app.py'), 'api_key = "AKIAIOSFODNN7EXAMPLE"\n');
    const secretRefusal = refusalFor();
    assert.equal(typeof secretRefusal, 'string', 'a secret literal in source refuses the commit');
    assert.ok(secretRefusal.includes('配置文件'), 'the refusal points at the config-file rule');

    // A configuration file is the sanctioned carrier — with an example twin for newcomers.
    writeFileSync(join(pub, 'config.yaml'), 'api_key: "AKIAIOSFODNN7EXAMPLE"\n');
    writeFileSync(join(pub, 'config.example.yaml'), 'api_key: "replace-me"\n');
    writeFileSync(join(pub, 'app.py'), 'print(1)\n');
    assert.equal(refusalFor(), undefined, 'a configuration file may carry the value');

    // The boundary itself is exempt: that directory is the local-only side of the project.
    writeFileSync(
      join(pub, 'private', 'notes.md'),
      'local note: C:\\Users\\someone\\project and api_key = "AKIAIOSFODNN7EXAMPLE"\n',
    );
    assert.equal(refusalFor(), undefined, 'files inside the boundary are not the public surface');

    // A file whose whole job is to demonstrate the boundary declares the marker.
    writeFileSync(join(pub, 'fixtures.py'), '# privacy-guard: allow — boundary fixtures\nHOME = "C:\\Users\\someone"\n');
    assert.equal(refusalFor(), undefined, 'a file carrying the allow marker is exempt');

    // Links are project content, not a privacy leak: a paper crawler's README, docs and source
    // cite URLs all day. The guard only refuses what identifies a machine or a secret.
    writeFileSync(
      join(pub, 'README.md'),
      '# paper crawler\n\nSources: https://example.org/paper/1234 and https://example.org/api/query\n',
    );
    writeFileSync(join(pub, 'crawler.py'), 'BASE = "https://example.org/api/query"\n');
    assert.equal(refusalFor(), undefined, 'URLs in the public surface are allowed');

    // Non-commit commands and other tools are untouched.
    assert.equal(pvRecord.guards.map((guard) => guard(shell('git status --short', pvAgent))).find(Boolean), undefined,
      'non-commit commands are untouched');
    assert.equal(pvRecord.guards.map((guard) => guard({ name: 'read', arguments: {}, agent: pvAgent })).find(Boolean), undefined,
      'other tools are untouched');

    rmSync(pub, { recursive: true, force: true });
    console.log('privacy boundary guard: OK');
  }

