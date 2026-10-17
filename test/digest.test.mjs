/**
 * the digest: documents, repository state, the boundary, brace safety.
 *
 * privacy-guard: allow — a fixture set: it writes home paths, boundary paths and secret literals
 * into throwaway repositories to prove what the guards refuse.
 */


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

  // ── Digest braces: a document quoting {{…}} must not poison prompt assembly ───
  // dsh-system-prompt always interpolates context entries (the interpolate option
  // exists only for sections), and a strict {{name}} scan throws on Vue/mustache
  // syntax like {{playCount|formatPlayCount}} — which killed real sessions
  // (dc6b5fa7 10-03, 4ddb3937 10-13: every turn failed with
  // "malformed prompt variable reference" until the digest text changed).
  writeFileSync(
    join(project, 'done.md'),
    `# done\n${PROJECT_MARKERS.done}\nquote: {{playCount|formatPlayCount}} and {{ok}}\n`,
  );
  const { contexts: braceContexts } = createdAgent(record, project, 'session-braces');
  const braceDigest = braceContexts[0];
  const braceText = braceDigest.text({});
  assert.ok(!braceText.includes('{{'), 'no raw {{ survives into the digest');
  assert.ok(braceText.includes('{ {playCount|formatPlayCount}}'), 'the quoted template stays readable');
  // The strict scan that killed those sessions, replayed over the digest:
  assert.doesNotThrow(() => /\{\{[^}]*\}\}/.test(braceText) && (() => {
    for (const m of braceText.matchAll(/\{\{(.*?)\}\}/g)) {
      if (!/^[a-z][a-z0-9_]*$/.test(m[1])) throw new Error(`malformed prompt variable reference "{{${m[1]}}}"`);
    }
  })(), 'a dsh-style strict scan of the digest does not throw');
  console.log('digest braces: OK');


export { digest };
