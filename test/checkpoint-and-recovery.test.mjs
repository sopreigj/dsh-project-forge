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
  const commitGuard = guardRecord.guards.find(
    (guard) => typeof guard({ name: 'pwsh', arguments: { command: 'git commit -m x' }, agent: guardAgent }) === 'string',
  ) ?? guardRecord.guards.find(
    (guard) => guard({ name: 'pwsh', arguments: { command: 'git commit -m x' }, agent: guardAgent }) !== undefined,
  );
  const commit = (target) => ({ name: 'pwsh', arguments: { command: 'git commit -m "x"' }, agent: target });
  const shell = (command, target) => ({ name: 'pwsh', arguments: { command }, agent: target });

  // Before any compaction: a commit is allowed (this repository is consistent).
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

  // Writing a state document disarms it.
  const touchListener = guardRecord.listeners.find((entry) => entry.name === 'tools/result');
  touchListener.handler(
    { name: 'edit', arguments: { file_path: join(project, 'done.md') }, agent: guardAgent },
    { isError: false },
  );
  assert.equal(commitGuard(commit(guardAgent)), undefined, 'the checkpoint guard clears after a document update');

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
