/**
 * Unit check for the Project Forge mode plugin.
 *
 * The plugin's behavior is (1) the protocol and recovery prompt sections, (2) the project
 * memory digest — documents, repository state and the repository's own rule file, (3) the
 * recovery message folded into the first post-compaction step, and (4) the two guards.
 * This file drives `apply()` against a stub Cordis context that records what was
 * registered, then asserts each layer.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginPath = resolve(process.argv[2] ?? '.');
const plugin = await import(pathToFileURL(pluginPath).href);

assert.equal(plugin.name, 'project-forge', 'plugin name');
assert.deepEqual(plugin.inject, ['systemPrompt', 'tools'], 'injected services');

// ── Config contract ─────────────────────────────────────────────────────────────
// The Loader validates a row's config through the Standard Schema interface
// (`Config['~standard'].validate`). A plain object here fails the whole preset, so this
// contract is asserted before any behavior check.
assert.ok(plugin.Config, 'plugin exports Config');
const standard = plugin.Config['~standard'];
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
  assert.equal(value.stewardFilePath, '.agents/steward.md', 'stewardFilePath default');
  assert.equal(value.guardLocalGit, true, 'guardLocalGit default');
  assert.equal(value.guardCommitCheckpoint, true, 'guardCommitCheckpoint default');
  assert.deepEqual(value.digestFiles, ['plan.md', 'todo.md', 'done.md'], 'digestFiles default');
  assert.deepEqual(
    value.digestTailLimits,
    { 'plan.md': 20000, 'todo.md': 10000, 'done.md': 20000 },
    'per-document tail limits default',
  );
  assert.equal(value.digestDefaultTailLimit, 20000, 'tail limit fallback');
  assert.equal(value.digestMaxBytes, 32768, 'digestMaxBytes default');
  assert.equal(value.digestRefreshMs, 5000, 'digestRefreshMs default');
}
for (const [raw, why] of [
  [{ protocol: 'yes' }, 'string for a boolean'],
  [{ nope: 1 }, 'unknown field'],
  [{ digestFiles: [1] }, 'non-string file list'],
  [{ digestMaxBytes: 0 }, 'non-positive number'],
  [{ stewardFilePath: '   ' }, 'blank steward path'],
  [{ digestTailLimits: { 'plan.md': 'lots' } }, 'non-numeric per-document limit'],
  [{ digestTailLimits: { 'plan.md': 0 } }, 'zero per-document limit'],
  [{ digestTailLimits: { 'plan.md': -1 } }, 'negative per-document limit'],
]) {
  const result = standard.validate(raw);
  assert.ok(Array.isArray(result.issues) && result.issues.length > 0, `rejected: ${why}`);
}

// ── Stub Cordis context ─────────────────────────────────────────────────────────
/** Records sections, contexts, listeners, effects, guards and log lines. */
function makeCtx() {
  const record = { sections: [], contexts: [], listeners: [], effects: 0, logs: [], guards: [] };
  const ctx = {
    record,
    effect(factory) {
      record.effects += 1;
      return factory();
    },
    on(name, handler) {
      record.listeners.push({ name, handler });
      return () => {};
    },
    logger: {
      info: (...args) => record.logs.push(['info', ...args]),
      warn: (...args) => record.logs.push(['warn', ...args]),
    },
    tools: {
      guard(guard) {
        record.guards.push(guard);
        return () => {};
      },
    },
    systemPrompt: {
      section(section) {
        record.sections.push(section);
        return () => {};
      },
      context(context) {
        record.contexts.push(context);
        return () => {};
      },
    },
  };
  return { ctx, record };
}

// ── Protocol and recovery sections ──────────────────────────────────────────────
{
  const { ctx, record } = makeCtx();
  plugin.apply(ctx, standard.validate({ digest: false, injectOnCompaction: false }).value);
  assert.deepEqual(
    record.sections.map((section) => section.name),
    ['project-forge:protocol', 'project-forge:recovery'],
    'both sections registered',
  );
  const protocol = record.sections[0].text({});
  const recovery = record.sections[1].text({});
  assert.equal(record.sections[0].order, 400, 'protocol order');
  assert.equal(record.sections[1].order, 410, 'recovery order');

  for (const needle of [
    'Persistence', 'Current state', 'Next state', 'Strategy', 'Negative knowledge',
    'local', 'git init', 'push', 'README.md', 'docs/',
    'checkpoint', 'feat:', 'done.md', 'todo.md', 'plan.md', 'tortuous.md',
    '### Tried', '### Observed', '### Why it failed', '### Conclusion',
    'layered modular hierarchy', 'explicit module boundaries', 'dependency direction',
    'high cohesion, low coupling, minimal duplication',
    'necessary comments only', 'explain **why**',
    'standalone `test/` project at the project root', 'More than three test files is a trigger',
    '.agents/steward.md', 'state consistency', 'Drift', 'complete when',
    // §5.5–§5.6: the layout serves human readers, and every level is checked.
    'primarily for human developers, not for the agent',
    'your convenience must never decide the structure',
    'The five-second test',
    'without opening a single file',
    'Names state meaning, not mechanism',
    'never for when it was made',
    'This applies at every level, not only the root',
    'tidy lid on a messy box',
    'Placement is part of history',
    'Every checkpoint re-examines the layout',
    // §6.1–§6.6: the whole tree, artifact kinds, and the single-test-file case.
    'every directory, not only the root',
    'A single test file is not an exemption',
    'Different kinds of artifact never share a shelf',
    // §8.5 / §9.8 / §10.1 / §10.4: layout is part of consistency, completion and takeover.
    'has a **layout** row too',
    'The layout still passes',
    'walk the whole directory tree',
    'Reorganizing is part of taking over, not a later cleanup',
    // §6: naming and vocabulary.
    'one word, one meaning, every level',
    'navigation by lexical match is a different problem from retrieval',
    'one defined term per concept',
    'controlled vocabulary',
    'One concept, one word, everywhere',
    'The high-entropy words are the ones to fix',
    'spread', 'is',
    'never for when it was made',
    'Lowercase, no spaces, no dates, no versions, no personal names',
    'utils`, `helpers`, `common`, `shared`, `temp`, `new`, `old`, `backup`, `extra`, `stuff',
    'specific enough that a second one like it cannot be created by accident',
    'Plural for collections',
    'states **what the file is**, not who wrote it',
    'One primary concept per file',
    'Test files mirror the thing they test',
    'Names are phrases about the domain, not about the code',
    'grows with the size of the scope',
    'read as assertions',
    'Function names say what they do to what',
    'No encoding of noise',
    'A recorded deviation is knowledge; an unrecorded one is rot',
    'works at every scale',
    'Scale does not change the rule, only the amount of it',
    // §12: parallel sessions.
    'Parallel sessions on one project',
    'One document owner',
    'commits a document change immediately',
    'Claim before you touch a module',
    'One vocabulary, everywhere',
    'A spawned subagent inherits nothing',
    'Leave the tree clean, or say so',
    'When in doubt, stop and report',
    // §12.8/§12.9: subagent conventions.
    'Two subagent modes',
    'subagent_fork',
    'clean room',
    'If you are the subagent',
    'Default to read-only exploration',
    'Report findings as input for the parent to review',
  ]) {
    assert.ok(protocol.includes(needle), `protocol mentions ${needle}`);
  }
  for (const needle of ['plan.md', 'todo.md', 'done.md', 'tortuous.md', 'Re-state', 'consistency check']) {
    assert.ok(recovery.includes(needle), `recovery mentions ${needle}`);
  }
  assert.ok(!protocol.includes('{{'), 'no unrendered variables');
  console.log('sections: OK');
}

{
  // Each switch disables exactly its own section.
  for (const [raw, expected] of [
    [{ protocol: false, digest: false, injectOnCompaction: false }, ['project-forge:recovery']],
    [{ recoveryProcedure: false, digest: false, injectOnCompaction: false }, ['project-forge:protocol']],
    [{ protocol: false, recoveryProcedure: false, digest: false, injectOnCompaction: false }, []],
  ]) {
    const { ctx, record } = makeCtx();
    plugin.apply(ctx, standard.validate(raw).value);
    assert.deepEqual(record.sections.map((section) => section.name), expected, `config ${JSON.stringify(raw)}`);
  }
  console.log('section switches: OK');
}

// ── Digest: documents, repository state, steward file ───────────────────────────
const project = mkdtempSync(join(tmpdir(), 'steward-'));

/** Drive one agent/created event and return the digest context. */
function createdAgent(record, cwd, sessionId = 'session-test') {
  const contexts = [];
  const agent = {
    id: sessionId,
    session: { header: { cwd, id: sessionId }, surface: { replaceGeneration: 0 } },
    ctx: {
      effect: (factory) => factory(),
      on: (name, handler) => {
        const entry = { name, handler, agent };
        record.listeners.push(entry);
        agent.ctx.registered.push(entry);
        return () => {};
      },
      systemPrompt: {
        section: () => () => {},
        context: (context) => {
          contexts.push(context);
          return () => {};
        },
      },
      registered: [],
    },
  };
  for (const listener of record.listeners.filter((entry) => entry.name === 'agent/created')) {
    listener.handler({ agent });
  }
  return { agent, contexts };
}

/** Names registered on an agent's own context, which is where `session/event` arrives. */
function agentListeners(agent) {
  return agent.ctx.registered ?? [];
}

/** Build one shell-tool execution for an agent. */
function shell(command, agent) {
  return { name: 'pwsh', arguments: { command }, agent };
}

/** Initialise a real repository, because the digest reads `.git` directly. */
function initRepo(dir) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'steward@test');
  git('config', 'user.name', 'steward');
}

const PROJECT_MARKERS = {
  plan: 'PLAN-MARK',
  todo: 'TODO-MARK',
  done: 'DONE-MARK',
  tortuous: 'TORTUOUS-MARK',
};

{
  writeFileSync(join(project, 'plan.md'), `# plan\n${PROJECT_MARKERS.plan}\n`);
  writeFileSync(join(project, 'todo.md'), `# todo\n${PROJECT_MARKERS.todo}\n`);
  writeFileSync(join(project, 'done.md'), `# done\n${PROJECT_MARKERS.done}\n`);
  writeFileSync(join(project, 'tortuous.md'), `# tortuous\n${PROJECT_MARKERS.tortuous}\n`);
  mkdirSync(join(project, '.agents'), { recursive: true });
  writeFileSync(join(project, '.agents', 'steward.md'), '# repo rules\nSTEWARD-MARK\n');
  initRepo(project);
  writeFileSync(join(project, 'src.txt'), 'hello\n');
  execFileSync('git', ['add', '-A'], { cwd: project, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'chore: initial commit'], { cwd: project, stdio: 'pipe' });

  const { ctx, record } = makeCtx();
  plugin.apply(ctx, standard.validate({}).value);
  const { contexts } = createdAgent(record, project);
  assert.equal(contexts.length, 1, 'digest context registered');
  const digest = contexts[0];
  assert.equal(digest.name, 'project-forge:digest', 'digest name');
  assert.equal(digest.order, 130, 'digest order');
  assert.equal(digest.interpolate, false, 'document prose is not interpolated');

  const text = digest.text({});
  for (const marker of [PROJECT_MARKERS.plan, PROJECT_MARKERS.todo, PROJECT_MARKERS.done]) {
    assert.ok(text.includes(marker), `digest inlines ${marker}`);
  }
  assert.ok(!text.includes(PROJECT_MARKERS.tortuous), 'tortuous.md is never inlined');
  assert.ok(text.includes('tortuous.md'), 'the digest names the omitted document');
  assert.ok(text.includes('STEWARD-MARK'), 'the repository rule file is inlined');
  assert.ok(text.includes('## Repository state'), 'repository state is inlined');
  assert.ok(text.includes('branch:'), 'branch reported');
  assert.ok(text.includes('HEAD:'), 'HEAD reported');
  assert.ok(text.includes('chore: initial commit'), 'recent commit subject reported');
  console.log('digest: OK');

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
  assert.ok(refused.includes('not a checkpoint of a consistent state'), 'refusal explains why');
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
      String(localGitGuard(shell(command, guardAgent))).includes('local-only'),
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
    assert.ok(String(noGrant).includes('local-only') && String(noGrant).includes('push allowed:'), 'refused without a grant, with grant syntax in the refusal');

    // Write a ×1 grant: one push passes, the grant line is consumed, the next push is refused.
    writeFileSync(join(repo, '.agents', 'steward.md'), '# rules\n\npush allowed: github.com/sopreigj/nhentai-downloader ×1\n');
    assert.equal(pushGuard(shell('git push origin main', gAgent)), undefined, 'first push consumes the ×1 grant');
    const stewardAfter1 = rfs2(join(repo, '.agents', 'steward.md'), 'utf8');
    assert.ok(!stewardAfter1.includes('push allowed'), 'the ×1 grant line is gone after use');
    assert.ok(String(pushGuard(shell('git push origin main', gAgent))).includes('local-only'), 'second push refused — the grant was one-shot');

    // ×2 grant: counts down, then runs out.
    writeFileSync(join(repo, '.agents', 'steward.md'), 'push allowed: github.com/sopreigj/* ×2\n');
    assert.equal(pushGuard(shell('git push origin main', gAgent)), undefined, 'first of ×2');
    assert.ok(rfs2(join(repo, '.agents', 'steward.md'), 'utf8').includes('×1'), 'counted down to ×1');
    assert.equal(pushGuard(shell('git push origin main', gAgent)), undefined, 'second of ×2');
    assert.ok(!rfs2(join(repo, '.agents', 'steward.md'), 'utf8').includes('push allowed'), '×2 exhausted, line removed');
    assert.equal(typeof pushGuard(shell('git push origin main', gAgent)), 'string', 'third push refused');

    // A grant for a different remote does not cover this one.
    writeFileSync(join(repo, '.agents', 'steward.md'), 'push allowed: github.com/someone-else/*\n');
    assert.ok(String(pushGuard(shell('git push origin main', gAgent))).includes('local-only'), 'mismatched grant refused');

    // An explicit-URL push matches the URL form directly.
    writeFileSync(join(repo, '.agents', 'steward.md'), 'push allowed: github.com/sopreigj/* ×1\n');
    assert.equal(pushGuard(shell('git push https://github.com/sopreigj/nhentai-downloader.git main', gAgent)), undefined, 'explicit-URL push covered by glob grant');

    // Force pushes are never covered by a grant, even with grants in stock.
    writeFileSync(join(repo, '.agents', 'steward.md'), 'push allowed: *\n');
    assert.ok(String(pushGuard(shell('git push -f origin main', gAgent))).includes('force'), 'force push refused despite wildcard grant');
    assert.ok(String(pushGuard(shell('git push --force-with-lease origin main', gAgent))).includes('force'), 'force-with-lease refused');
    assert.ok(String(pushGuard(shell('git remote add upstream https://github.com/x/y.git', gAgent))).includes('local-only'), 'remote add never covered');

    rmSync(repo, { recursive: true, force: true });
    console.log('one-shot push grants: OK');
  }

  // ── All five guards are switchable ───────────────────────────────────────────
  const { ctx: offCtx, record: offRecord } = makeCtx();
  plugin.apply(offCtx, standard.validate({
    digest: false,
    injectOnCompaction: false,
    guardLocalGit: false,
    guardCommitCheckpoint: false,
    guardLayoutCheckpoint: false,
    guardSecrets: false,
    guardConcurrentWrite: false,
  }).value);
  assert.equal(offRecord.guards.length, 0, 'no guards when all five are off');
  console.log('guard switches: OK');

  // ── Guard E: per-file claims allow parallel work on different files ──────────
  {
    const repo = mkdtempSync(join(tmpdir(), 'forge-concurrent-'));
    writeFileSync(join(repo, 'done.md'), '# done\nbaseline\n');
    writeFileSync(join(repo, 'plan.md'), '# plan\n');
    writeFileSync(join(repo, 'todo.md'), '# todo\n');
    writeFileSync(join(repo, 'a.py'), 'print(1)\n');
    writeFileSync(join(repo, 'b.py'), 'print(2)\n');
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
    assert.ok(/claimed by session/.test(refused), 'the refusal names the claim');
    // The refusal must show a recognisable owner id, not the "session-" prefix: owner ids all
    // start with "session-", so a naive slice(0,8) rendered an anonymous ghost (real bug,
    // PaperQuer 2026-10-08). The UUID portion must be visible.
    assert.ok(!/claimed by session session-$/.test(refused), 'the owner id is not truncated to "session-"');
    assert.ok(/claimed by session [0-9a-f]{8}/.test(refused), 'the refusal shows the owner UUID');

    // A stale claim (owner gone quiet past the staleness window) is deleted and taken over.
    const { readFileSync: rfs, writeFileSync: wfs, existsSync: exs } = await import('node:fs');
    const claimDir = join(repo, '.agents', '.forge-claims');
    const doneClaim = JSON.parse(rfs(join(claimDir, 'done.md.json'), 'utf8'));
    wfs(join(claimDir, 'done.md.json'), JSON.stringify({ owner: 'session-zzz-gone-0000-000000000000', time: Date.now() - 31 * 60 * 1000 }));
    assert.equal(cwGuard({ name: 'write', arguments: { file_path: join(repo, 'done.md') }, agent: agentB }), undefined, 'B takes over a stale claim');
    assert.ok(!exs(join(claimDir, 'done.md.json')) || JSON.parse(rfs(join(claimDir, 'done.md.json'), 'utf8')).owner === agentB.session.header.id, 'the stale claim is deleted or re-owned by B, never left as residue');

    // A successful commit releases every claim in the project.
    const commitListeners = cwRecord.listeners.filter((entry) => entry.name === 'tools/result');
    assert.ok(commitListeners.length > 0, 'tools/result listeners exist');
    assert.ok(exs(join(claimDir, 'a.py.json')), 'a.py is claimed before the commit');
    for (const listener of commitListeners) {
      listener.handler({ name: 'pwsh', arguments: { command: 'git commit -m "release"' }, agent: agentA }, { isError: false });
    }
    assert.ok(!exs(join(claimDir, 'a.py.json')), 'a commit releases every claim');
    assert.ok(!exs(join(claimDir, 'b.py.json')), 'including claims held by other sessions');

    // A file outside the project is never claimed: scratch files in Temp or elsewhere must
    // not leave claims in this project's claim directory.
    const outside = join(tmpdir(), `forge-outside-${Date.now().toString(36)}.py`);
    writeFileSync(outside, 'print(0)\n');
    assert.equal(cwGuard({ name: 'write', arguments: { file_path: outside }, agent: agentA }), undefined, 'an outside file is writable');
    const claimNames = exs(claimDir) ? (await import('node:fs')).readdirSync(claimDir) : [];
    assert.ok(!claimNames.some((name) => name.includes('forge-outside')), 'no claim is created for an outside file');

    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { force: true });
    console.log('concurrent-write guard: OK');
  }

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
    assert.ok(refusal.includes('layout'), 'the refusal is about the layout');
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
    assert.ok(refusal.includes('credential') || refusal.includes('secret'), 'the refusal is about secrets');
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

    rmSync(leaky, { recursive: true, force: true });
    console.log('secrets guard: OK');
  }

  // ── Digest configuration ─────────────────────────────────────────────────────
  const { ctx: cfgCtx, record: cfgRecord } = makeCtx();
  plugin.apply(cfgCtx, standard.validate({
    digestFiles: ['done.md'],
    repoStateInDigest: false,
    stewardFile: false,
    injectOnCompaction: false,
  }).value);
  const { contexts: cfgContexts } = createdAgent(cfgRecord, project, 'session-config');
  const configured = cfgContexts[0].text({});
  assert.ok(configured.includes(PROJECT_MARKERS.done), 'configured document inlined');
  assert.ok(!configured.includes(PROJECT_MARKERS.plan), 'unlisted document not inlined');
  assert.ok(!configured.includes('STEWARD-MARK'), 'steward file off');
  assert.ok(!configured.includes('## Repository state'), 'repository state off');
  assert.ok(!configured.includes('…omitted'), 'no omission note while the budget suffices');

  // ── Per-document tail budget ─────────────────────────────────────────────────
  // A long document is inlined as its TAIL: the newest state must survive, and the
  // omitted head has to be announced with its size. The fixture puts a unique marker
  // only in the head, so "was the head dropped" is decidable.
  const longProject = mkdtempSync(join(tmpdir(), 'steward-long-'));
  const head = `HEAD-ONLY-MARK\n${'x'.repeat(2000)}`;
  const tail = 'TAIL-MARK';
  writeFileSync(join(longProject, 'done.md'), `${head}\n${tail}\n`);

  const { ctx: tailCtx, record: tailRecord } = makeCtx();
  plugin.apply(tailCtx, standard.validate({
    digestFiles: ['done.md'],
    digestTailLimits: { 'done.md': 300 },
    repoStateInDigest: false,
    stewardFile: false,
    injectOnCompaction: false,
  }).value);
  const { contexts: tailContexts } = createdAgent(tailRecord, longProject, 'session-tail');
  const tailText = tailContexts[0].text({});
  assert.ok(tailText.includes('TAIL-MARK'), 'the document tail is kept');
  assert.ok(!tailText.includes('HEAD-ONLY-MARK'), 'the document head is dropped');
  assert.ok(tailText.includes('…omitted'), 'the omission is announced');
  assert.ok(/omitted \d+ characters from the start/.test(tailText), 'the omitted size is reported');
  // The budget covers the body without its "### done.md" heading.
  const heading = '### done.md\n';
  const bodyStart = tailText.indexOf(heading) + heading.length;
  const bodyEnd = tailText.indexOf('\n\n`tortuous.md`', bodyStart);
  const body = tailText.slice(bodyStart, bodyEnd === -1 ? undefined : bodyEnd);
  assert.ok(body.trimEnd().length <= 300, `the rendered body stays inside its budget (${body.trimEnd().length})`);

  // The same document under a bigger per-document budget comes through whole. The budget
  // has to be at least the file's length, and the global ceiling has to allow it.
  const { ctx: wholeCtx, record: wholeRecord } = makeCtx();
  plugin.apply(wholeCtx, standard.validate({
    digestFiles: ['done.md'],
    digestTailLimits: { 'done.md': 8000 },
    repoStateInDigest: false,
    stewardFile: false,
    injectOnCompaction: false,
  }).value);
  const { contexts: wholeContexts } = createdAgent(wholeRecord, longProject, 'session-whole');
  const wholeText = wholeContexts[0].text({});
  assert.ok(wholeText.includes('HEAD-ONLY-MARK'), 'a sufficient budget keeps the head');
  assert.ok(!wholeText.includes('…omitted'), 'no omission note when nothing is omitted');

  // A document the map does not name uses the fallback limit.
  const { ctx: fbCtx, record: fbRecord } = makeCtx();
  plugin.apply(fbCtx, standard.validate({
    digestFiles: ['done.md'],
    digestTailLimits: {},
    digestDefaultTailLimit: 120,
    repoStateInDigest: false,
    stewardFile: false,
    injectOnCompaction: false,
  }).value);
  const { contexts: fbContexts } = createdAgent(fbRecord, longProject, 'session-fallback');
  const fbText = fbContexts[0].text({});
  assert.ok(fbText.includes('TAIL-MARK'), 'fallback limit keeps the tail');
  assert.ok(!fbText.includes('HEAD-MARK'), 'fallback limit drops the head');
  rmSync(longProject, { recursive: true, force: true });

  // ── The protocol demands concise, current documents ──────────────────────────
  const { ctx: protocolCtx, record: protocolRecord } = makeCtx();
  plugin.apply(protocolCtx, standard.validate({ digest: false, injectOnCompaction: false }).value);
  const protocolText = protocolRecord.sections
    .find((section) => section.name === 'project-forge:protocol')
    .text({});
  for (const needle of [
    'only the end of the document is inlined',
    'must stay concise and be updated as the project moves',
    'must stay short and current',
    'must stay bounded',
    'ever-growing `done.md` is a **defect**',
    'Do not accumulate an append-only plan',
  ]) {
    assert.ok(protocolText.includes(needle), `§4 states the conciseness rule: ${needle}`);
  }
  console.log('digest configuration: OK');
}

rmSync(project, { recursive: true, force: true });

console.log('\nall plugin checks passed');
