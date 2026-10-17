/**
 * the checkpoint guard: compaction arms it, a document write disarms it.
 *
 * privacy-guard: allow — a fixture set: it writes home paths, boundary paths and secret literals
 * into throwaway repositories to prove what the guards refuse.
 */


  // ── Checkpoint guard: compaction arms it, a document write disarms it ─────────
  const { ctx: guardCtx, record: guardRecord } = makeCtx();
  plugin.apply(guardCtx, standard.validate({}).value);
  const { agent } = createdAgent(guardRecord, project);
  const { agent: guardAgent } = createdAgent(guardRecord, project, 'session-guard');
  const commit = (target) => ({ name: 'pwsh', arguments: { command: 'git commit -m "x"' }, agent: target });
  const shell = (command, target) => ({ name: 'pwsh', arguments: { command }, agent: target });
  // Ask every guard at once; which one refuses is the guard's own business, and the assertions
  // below pin the checkpoint refusal by its text.
  const commitGuard = (execution) => guardRecord.guards.map((guard) => guard(execution)).find(Boolean);
  const checkpointRefusal = (target) => guardRecord.guards
    .map((guard) => guard(commit(target)))
    .find((verdict) => typeof verdict === 'string' && verdict.includes('不是一个一致状态的检查点'));

  // Before any compaction a repository whose documents are in sync may commit.
  assert.equal(checkpointRefusal(guardAgent), undefined, 'no checkpoint refusal before compaction');

  const preStep = guardRecord.listeners.filter((entry) => entry.name === 'agent/pre-step');
  const next = async () => ({ kind: 'proceed', messages: [{ id: 'u1', role: 'user' }] });
  const guardEvents = agentListeners(guardAgent).find((entry) => entry.name === 'session/event');
  assert.ok(guardEvents, 'the guard agent also listens for compaction events');
  guardEvents.handler(guardAgent.session, { type: 'compaction/end', seq: 3 });
  await preStep[0].handler({ agent: guardAgent, turn: 1, step: 1 }, next);

  const refused = commitGuard(commit(guardAgent));
  assert.equal(typeof refused, 'string', 'a post-compaction commit is refused');
  assert.ok(refused.includes('不是一个一致状态的检查点'), 'refusal explains why');
  assert.ok(refused.includes('done.md'), 'refusal names the document to update');
  // The guard also says *why the writes so far did not count*: a session that has been editing
  // source files reads its own writes as progress, so the refusal names both lists.
  assert.ok(
    refused.includes('本会话还没有用 write/edit 改过任何文件'),
    `refusal reports the (empty) list of touched files: ${refused}`,
  );
  const touchListener = guardRecord.listeners.find((entry) => entry.name === 'tools/result');
  const touch = (filePath) => touchListener.handler(
    { name: 'edit', arguments: { file_path: filePath }, agent: guardAgent },
    { isError: false },
  );
  const sourceFile = join(project, 'plugin', 'guards', 'register.js');
  touch(sourceFile);
  const stillRefused = commitGuard(commit(guardAgent));
  assert.equal(typeof stillRefused, 'string', 'editing a source file does not disarm the guard');
  assert.ok(
    stillRefused.includes('guards/register.js'),
    `refusal names what was touched instead: ${stillRefused}`,
  );
  assert.ok(
    stillRefused.includes('能解开这条的只有合同文档'),
    'and contrasts it with the documents that would count',
  );

  // Writing a state document disarms it.
  touch(join(project, 'done.md'));
  assert.equal(commitGuard(commit(guardAgent)), undefined, 'the checkpoint guard clears after a document update');

  // Two sequences the checkpoint rule has to answer correctly, both about *which* document
  // writes count and *for how long*:
  //   A) a write early in a session is not a standing permit — once HEAD moves past it, the
  //      documents are behind again and the next commit is refused;
  //   B) the rule file is one of the four contracts, so updating it alone clears a lagging
  //      repository (the refusal used to name it as expected while ignoring writes to it).
  {
    const fixture = (prefix) => {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      for (const name of ['plan.md', 'todo.md', 'done.md', 'steward.md']) {
        writeFileSync(join(dir, name), `# ${name}\n`);
      }
      writeFileSync(join(dir, 'tortuous.jsonl'), '');
      initRepo(dir);
      execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'chore: initial commit'], { cwd: dir, stdio: 'pipe' });
      return dir;
    };
    const drive = (dir, sessionId) => {
      const { ctx, record } = makeCtx();
      plugin.apply(ctx, standard.validate({ stateDir: '.' }).value);
      const { agent } = createdAgent(record, dir, sessionId);
      const refusal = () => record.guards
        .map((guard) => guard(commit(agent)))
        .find((verdict) => typeof verdict === 'string' && verdict.includes('不是一个一致状态的检查点'));
      // Every observer of a successful write sees it; the checkpoint one is among them.
      const wrote = (filePath) => record.listeners
        .filter((entry) => entry.name === 'tools/result')
        .forEach((entry) => entry.handler({ name: 'edit', arguments: { file_path: filePath }, agent }, { isError: false }));
      return { refusal, wrote };
    };
    const codeCommit = (dir, name) => {
      writeFileSync(join(dir, name), 'hello\n');
      execFileSync('git', ['add', name], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'feat: code only'], { cwd: dir, stdio: 'pipe' });
    };

    const exemption = fixture('steward-exemption-');
    const ex = drive(exemption, 'session-exemption');
    assert.equal(ex.refusal(), undefined, 'in-sync documents may commit');
    ex.wrote(join(exemption, 'done.md'));
    assert.equal(ex.refusal(), undefined, 'a document write clears the very next commit');
    codeCommit(exemption, 'src.txt');
    assert.equal(
      typeof ex.refusal(),
      'string',
      'the write exemption ends when HEAD moves past the write — it is not a standing permit',
    );

    const rules = fixture('steward-rules-');
    const ru = drive(rules, 'session-rules');
    codeCommit(rules, 'other.txt');
    assert.equal(typeof ru.refusal(), 'string', 'a code-only commit alone leaves the documents behind');
    ru.wrote(join(rules, 'steward.md'));
    assert.equal(
      ru.refusal(),
      undefined,
      'the repository rule file is one of the contracts, so writing it counts',
    );
  }

  // Unrelated tools and non-commit commands are untouched.
  assert.equal(commitGuard({ name: 'read', arguments: {}, agent: guardAgent }), undefined, 'other tools untouched');
  assert.equal(commitGuard(shell('git status --short', guardAgent)), undefined, 'non-commit commands untouched');
  assert.ok(agent.id !== guardAgent.id, 'sanity');
  console.log('checkpoint guard: OK');

  // ── Recovery: the real compaction event, once per compaction, once per turn ──
  {
    // A unique id per run: recovery markers are persisted per session on disk, so a fixed
    // id would make the second run of this file start already-recovered.
    const unique = `session-recovery-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const { ctx: recCtx, record: recRecord } = makeCtx();
    plugin.apply(recCtx, standard.validate({}).value);
    const { agent: recAgent } = createdAgent(recRecord, project, unique);
    const preStepHandler = recRecord.listeners.find((entry) => entry.name === 'agent/pre-step').handler;
    const proceed = async () => ({ kind: 'proceed', messages: [{ id: 'u1', role: 'user' }] });
    const step = (turn, stepNumber) => preStepHandler({ agent: recAgent, turn, step: stepNumber }, proceed);
    const recoveryOf = (decision) =>
      decision.messages.find((message) => message.id?.startsWith('project-forge:recovery:'));

    // The listener must live on the agent's own context: `session/event` is a Scoped
    // event and a plugin-scoped registration does not receive it.
    const eventListener = agentListeners(recAgent).find((entry) => entry.name === 'session/event');
    assert.ok(eventListener, 'the compaction listener is registered on the agent context');

    // A surface generation change alone (pruning, spill) must NOT arm recovery.
    recAgent.session.surface.replaceGeneration = 7;
    let decision = await step(1, 1);
    assert.equal(recoveryOf(decision), undefined, 'a generation change alone does not inject recovery');

    // A real compaction arms it, and the next eligible step carries it.
    eventListener.handler(recAgent.session, { type: 'compaction/end', seq: 12 });
    decision = await step(1, 1);
    const message = recoveryOf(decision);
    assert.ok(message, 'a compaction/end arms one recovery message');
    assert.equal(message.role, 'user', 'recovery rides the user role for the model');
    assert.equal(message.source.kind, 'project-forge', 'recovery declares its own producer kind');
    assert.equal(message.source.form, 'snapshot', 'recovery uses the injected-context form');
    assert.equal(message.source.sections.length, 1, 'recovery carries one named section');
    assert.equal(message.source.sections[0].name, 'project-forge:recovery', 'section name');
    assert.ok(message.source.sections[0].text.includes('Project Forge recovery:'), 'section text matches the body');
    assert.ok(
      message.content[0].text.includes(PROJECT_MARKERS.done),
      'the recovery message carries the digest',
    );

    // Same compaction, later steps: nothing more.
    assert.equal(recoveryOf(await step(1, 2)), undefined, 'later steps of the same turn stay quiet');
    assert.equal(recoveryOf(await step(2, 1)), undefined, 'a later turn without compaction stays quiet');

    // Two compactions inside one turn still produce at most one message.
    eventListener.handler(recAgent.session, { type: 'compaction/end', seq: 20 });
    eventListener.handler(recAgent.session, { type: 'compaction/end', seq: 21 });
    const first = await step(3, 1);
    assert.ok(recoveryOf(first), 'the first step of the turn carries recovery');
    assert.equal(recoveryOf(await step(3, 2)), undefined, 'the second step of that turn does not repeat it');

    // A distinct compaction in a new turn is answered again, once.
    eventListener.handler(recAgent.session, { type: 'compaction/end', seq: 30 });
    const second = await step(4, 1);
    const secondMessage = recoveryOf(second);
    assert.ok(secondMessage, 'a new compaction is answered in its own turn');
    assert.notEqual(secondMessage.id, message.id, 'each compaction gets its own message id');
    console.log('recovery message: OK');
  }


export { guardAgent, guardRecord, next };
