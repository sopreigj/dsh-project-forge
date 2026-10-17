/**
 * the digest: documents, repository state, the boundary, brace safety.
 *
 * privacy-guard: allow — a fixture set: it writes home paths, boundary paths and secret literals
 * into throwaway repositories to prove what the guards refuse.
 */

import { execFileSync } from 'node:child_process';


// ── Digest: documents, repository state, steward file ───────────────────────────

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
  assert.ok(
    text.includes(PROJECT_MARKERS.tortuousHeadline),
    'the negative-knowledge index carries the record headline',
  );
  assert.ok(!text.includes(PROJECT_MARKERS.tortuousProse), 'the record prose is never inlined');
  assert.ok(text.includes('tortuous.jsonl'), 'the digest names the read-on-demand files');
  assert.ok(text.includes('STEWARD-MARK'), 'the repository rule file is inlined');
  assert.ok(text.includes('## Repository state'), 'repository state is inlined');
  assert.ok(text.includes('branch:'), 'branch reported');
  assert.ok(text.includes('HEAD:'), 'HEAD reported');
  assert.ok(text.includes('chore: initial commit'), 'recent commit subject reported');
  console.log('digest: OK');

  // ── The state boundary: documents under `private/` ───────────────────────────
  // This fixture is the layout the protocol now asks for: everything the project keeps for
  // itself — the four documents and the steward rules — inside one directory, and the public
  // surface outside it. (The block above is the fallback case: documents still at the root
  // and rules at `.agents/steward.md` are read there, so a project forged before the
  // boundary existed keeps working.)
  const bounded = mkdtempSync(join(tmpdir(), 'steward-boundary-'));
  mkdirSync(join(bounded, 'private'), { recursive: true });
  writeFileSync(join(bounded, 'private', 'plan.md'), `# plan\n${PROJECT_MARKERS.plan}\n`);
  writeFileSync(join(bounded, 'private', 'todo.md'), `# todo\n${PROJECT_MARKERS.todo}\n`);
  writeFileSync(join(bounded, 'private', 'done.md'), `# done\n${PROJECT_MARKERS.done}\n`);
  writeFileSync(join(bounded, 'private', 'steward.md'), '# repo rules\nBOUNDARY-STEWARD-MARK\n');
  writeFileSync(join(bounded, 'README.md'), '# project\n');
  initRepo(bounded);

  const { ctx: boundaryCtx, record: boundaryRecord } = makeCtx();
  plugin.apply(boundaryCtx, standard.validate({ injectOnCompaction: false }).value);
  const { contexts: boundaryContexts } = createdAgent(
    boundaryRecord,
    bounded,
    `session-boundary-${Date.now().toString(36)}`,
  );
  const boundaryText = boundaryContexts[0].text({});
  for (const marker of [PROJECT_MARKERS.plan, PROJECT_MARKERS.todo, PROJECT_MARKERS.done]) {
    assert.ok(boundaryText.includes(marker), `the boundary digest inlines ${marker}`);
  }
  assert.ok(boundaryText.includes('### private/plan.md'), 'documents are labelled by their path inside the boundary');
  assert.ok(boundaryText.includes('BOUNDARY-STEWARD-MARK'), 'the steward rules are read from inside the boundary');
  assert.ok(boundaryText.includes('private/steward.md (this repository'), 'the rules are labelled with their path');
  // The per-document budget is keyed by the configured name, not by the resolved path.
  assert.ok(!boundaryText.includes('…omitted'), 'a small document is not truncated by the boundary label');
  rmSync(bounded, { recursive: true, force: true });
  console.log('state boundary: OK');

  // ── Digest braces: document prose reaches the model VERBATIM ────────────────
  // The digest is registered with `interpolate: false` (asserted below), and a host that honours
  // that switch for context entries renders the text exactly as written. Breaking `{{` into `{ {`
  // was the workaround for a host that honoured it on sections only; it is gone because it
  // corrupted every document quoting braces (V11 records the host floor that replaces it).
  writeFileSync(
    join(project, 'done.md'),
    `# done\n${PROJECT_MARKERS.done}\nquote: {{playCount|formatPlayCount}} and {{ok}}\n`,
  );
  const { contexts: braceContexts } = createdAgent(record, project, 'session-braces');
  const braceDigest = braceContexts[0];
  const braceText = braceDigest.text({});
  assert.equal(braceDigest.interpolate, false, 'the digest is registered as non-interpolated');
  assert.ok(
    braceText.includes('{{playCount|formatPlayCount}}'),
    'brace text survives verbatim — the document is not mangled',
  );
  assert.ok(!braceText.includes('{ {playCount'), 'the old mangling is gone');
  console.log('digest braces: OK');

  // ── An empty project says why, instead of saying nothing ──────────────────────
  // "The state lives elsewhere" and "this project has no state yet" are both an absent
  // digest, and the comfortable reading — start from a blank slate — is the wrong one.
  // The recovery message already explained this; the per-turn path used to stay silent.
  const emptyDir = mkdtempSync(join(tmpdir(), 'steward-empty-'));
  const { ctx: emptyCtx, record: emptyRecord } = makeCtx();
  plugin.apply(emptyCtx, standard.validate({ injectOnCompaction: false }).value);
  const { contexts: emptyContexts } = createdAgent(emptyRecord, emptyDir, 'session-empty-project');
  const emptyText = emptyContexts[0].text({});
  assert.ok(
    emptyText.includes('## ⚠ 还没有项目记忆') && emptyText.includes('读过的位置都是空的'),
    'an empty project gets the explanation block, not a silent digest',
  );
  for (const name of ['plan.md', 'done.md', 'todo.md', 'tortuous.jsonl', 'steward.md']) {
    assert.ok(emptyText.includes(name), `the explanation names ${name}`);
  }
  assert.ok(emptyText.includes('stateDir'), 'and it says where to check for a wrong directory');
  assert.ok(!emptyText.includes(PROJECT_MARKERS.plan), 'no document text leaks in from elsewhere');
  rmSync(emptyDir, { recursive: true, force: true });
  console.log('empty project digest: OK');

  // ── The negative-knowledge index must never print a line that says nothing ────
  // The index is the only reason a model opens the record file, so a blank line spends
  // budget and still leaves no reason to look. Records that follow the deviation shape
  // carry their one-liner in `what`; a record with no one-liner at all must say so.
  const idxDir = mkdtempSync(join(tmpdir(), 'steward-index-'));
  writeFileSync(join(idxDir, 'tortuous.jsonl'), [
    JSON.stringify({ id: 'R1', kind: 'route', conclusion: '一句结论' }),
    JSON.stringify({ id: 'D1', kind: 'deviation', what: '这条偏差只写了 what 字段' }),
    JSON.stringify({ id: 'D2', kind: 'deviation' }),
    JSON.stringify({ id: 'R2', kind: 'route', title: 'x'.repeat(400) }),
  ].join('\n') + '\n');
  const { ctx: idxCtx, record: idxRecord } = makeCtx();
  plugin.apply(idxCtx, standard.validate({ injectOnCompaction: false }).value);
  const { contexts: idxContexts } = createdAgent(idxRecord, idxDir, 'session-index');
  const idxText = idxContexts[0].text({});
  assert.ok(
    idxText.includes('- D1（偏差）这条偏差只写了 what 字段'),
    'a record with no title falls back to the one-liner its own shape carries',
  );
  assert.ok(
    idxText.includes('缺 title/conclusion'),
    'a record with nothing to summarise says so instead of printing a blank line',
  );
  const idxLines = idxText.split('\n').filter((line) => /^- [RD]\d+（/.test(line));
  assert.ok(idxLines.length >= 4, 'every record made it into the index');
  for (const line of idxLines) {
    assert.ok(line.length <= 170, `index lines are bounded (got ${line.length}): ${line.slice(0, 40)}…`);
  }
  rmSync(idxDir, { recursive: true, force: true });
  console.log('negative-knowledge index summarises every record: OK');

  // The drift signal answers §9's question — "do the documents describe the repository?" — with
  // git's own answer: commits sitting on top of the newest commit that touched a contract
  // document. It used to test whether a document *mentions a commit hash*, which encodes a
  // project convention and then nags forever in a project that deliberately keeps hashes out of
  // its prose (C4). The fixture commits for real, so both sides of the rule are exercised.
  {
    const driftDir = mkdtempSync(join(tmpdir(), 'steward-drift-'));
    mkdirSync(join(driftDir, 'private'), { recursive: true });
    writeFileSync(join(driftDir, 'private', 'plan.md'), '# plan\n');
    writeFileSync(join(driftDir, 'private', 'todo.md'), '# todo\n');
    writeFileSync(join(driftDir, 'private', 'done.md'), '# done\n');
    writeFileSync(join(driftDir, 'app.py'), 'print(1)\n');
    initRepo(driftDir);
    const git = (...args) => execFileSync('git', args, { cwd: driftDir, stdio: 'pipe' });
    const digestText = () => {
      const { ctx: driftCtx, record: driftRecord } = makeCtx();
      plugin.apply(driftCtx, standard.validate({ injectOnCompaction: false }).value);
      const { contexts: driftContexts } = createdAgent(
        driftRecord,
        driftDir,
        `session-drift-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      );
      return driftContexts[0].text({});
    };
    const DRIFT = '## ⚠ 状态文档落后于仓库';

    git('add', '-A');
    git('commit', '-q', '-m', 'chore: 文档与代码一起进来');
    assert.ok(
      !digestText().includes(DRIFT),
      'documents committed along with the change are current — no drift block',
    );

    // Code only: the documents now describe a repository one commit out of date.
    writeFileSync(join(driftDir, 'app.py'), 'print(2)\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'feat: 只改代码');
    const driftText = digestText();
    assert.ok(
      driftText.includes(DRIFT),
      `the digest warns that the documents lag the repository: ${driftText.slice(0, 200)}`,
    );
    assert.ok(
      driftText.includes('**1** 个提交在四份合同里都没有被提到'),
      'and says how many commits the documents miss',
    );

    // Writing a document and committing it brings the documents back level; no hash has to be
    // pasted anywhere for the block to clear.
    writeFileSync(join(driftDir, 'private', 'done.md'), '# done\n记下这次改动\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'chore(state): 记下这次改动');
    assert.ok(
      !digestText().includes(DRIFT),
      'committing a document update clears the drift block',
    );
    rmSync(driftDir, { recursive: true, force: true });
    console.log('drift block appears only while documents lag the repository: OK');
  }


export { digest };
