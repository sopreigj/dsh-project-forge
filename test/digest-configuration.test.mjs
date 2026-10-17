/**
 * document budgets, whole-document inlining, the negative-knowledge index.
 *
 * privacy-guard: allow — a fixture set: it writes home paths, boundary paths and secret literals
 * into throwaway repositories to prove what the guards refuse.
 */


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

  // ── Contract documents are inlined whole, over budget or not ─────────────────
  // The failure this replaces: a long `done.md` used to be inlined as its tail, so the head
  // — where the current state lives — vanished silently. v4 never truncates a contract: an
  // over-budget document is still complete, and the digest reports the overrun instead.
  const longProject = mkdtempSync(join(tmpdir(), 'steward-long-'));
  const head = `HEAD-ONLY-MARK\n${'x'.repeat(2000)}`;
  const tail = 'TAIL-MARK';
  writeFileSync(join(longProject, 'done.md'), `${head}\n${tail}\n`);

  const { ctx: overCtx, record: overRecord } = makeCtx();
  plugin.apply(overCtx, standard.validate({
    digestFiles: ['done.md'],
    documentBudgets: { 'done.md': 300 },
    repoStateInDigest: false,
    stewardFile: false,
    injectOnCompaction: false,
  }).value);
  const { contexts: overContexts } = createdAgent(overRecord, longProject, 'session-over');
  const overText = overContexts[0].text({});
  assert.ok(overText.includes('HEAD-ONLY-MARK'), 'an over-budget document is still complete');
  assert.ok(overText.includes('TAIL-MARK'), 'and its tail is there too');
  assert.ok(!overText.includes('…omitted'), 'nothing is ever truncated');
  assert.ok(overText.includes('超出预算'), 'the overrun is reported');
  assert.ok(/done\.md \d+\/300/.test(overText), 'the report carries the size and the budget');
  assert.ok(overText.includes('journal.jsonl'), 'the report says where the detail should go');

  // A document inside its budget gets no warning.
  const { ctx: fitCtx, record: fitRecord } = makeCtx();
  plugin.apply(fitCtx, standard.validate({
    digestFiles: ['done.md'],
    documentBudgets: { 'done.md': 8000 },
    repoStateInDigest: false,
    stewardFile: false,
    injectOnCompaction: false,
  }).value);
  const { contexts: fitContexts } = createdAgent(fitRecord, longProject, 'session-fit');
  const fitText = fitContexts[0].text({});
  assert.ok(fitText.includes('HEAD-ONLY-MARK'), 'a document inside its budget comes through whole');
  assert.ok(!fitText.includes('超出预算'), 'no warning while inside the budget');

  // A document the map does not name uses the fallback budget — and is still whole.
  const { ctx: fbCtx, record: fbRecord } = makeCtx();
  plugin.apply(fbCtx, standard.validate({
    digestFiles: ['done.md'],
    documentBudgets: {},
    documentBudgetDefault: 120,
    repoStateInDigest: false,
    stewardFile: false,
    injectOnCompaction: false,
  }).value);
  const { contexts: fbContexts } = createdAgent(fbRecord, longProject, 'session-fallback');
  const fbText = fbContexts[0].text({});
  assert.ok(fbText.includes('TAIL-MARK') && fbText.includes('HEAD-ONLY-MARK'), 'the fallback budget inlines whole');
  assert.ok(fbText.includes('超出预算'), 'the fallback budget warns when exceeded');

  // ── Negative knowledge: the index is inlined, the file is not ────────────────
  // One line per record, so a model can see that a route was already disproved without
  // carrying the whole unbounded file; the `kind` marker at the head of each record is what
  // lets the index say which sort of entry it is.
  writeFileSync(join(longProject, 'tortuous.jsonl'), [
    JSON.stringify({ id: 'T1', kind: 'route', title: 'old parser', conclusion: '不要再用旧解析器' }),
    JSON.stringify({ id: 'D1', kind: 'deviation', title: 'global install', conclusion: '不要再用全局安装' }),
    '',
  ].join('\n'));
  writeFileSync(join(longProject, 'journal.jsonl'), `${JSON.stringify({ at: '2026-01-01T00:00:00Z', summary: 'JOURNAL-ONLY-MARK' })}\n`);
  const { ctx: idxCtx, record: idxRecord } = makeCtx();
  plugin.apply(idxCtx, standard.validate({
    digestFiles: ['done.md'],
    documentBudgets: { 'done.md': 8000 },
    repoStateInDigest: false,
    stewardFile: false,
    injectOnCompaction: false,
  }).value);
  const { contexts: idxContexts } = createdAgent(idxRecord, longProject, 'session-index');
  const idxText = idxContexts[0].text({});
  assert.ok(idxText.includes('T1（失败路线）'), 'the index names a failed route');
  assert.ok(idxText.includes('D1（偏差）'), 'the index names a recorded deviation');
  assert.ok(idxText.includes('不要再用旧解析器'), 'the index carries each record conclusion');
  assert.ok(!idxText.includes('JOURNAL-ONLY-MARK'), 'the journal is never inlined');
  assert.ok(idxText.includes('journal.jsonl'), 'the digest names the read-on-demand files');
  rmSync(longProject, { recursive: true, force: true });

  // ── The protocol demands concise, current documents ──────────────────────────
  const { ctx: protocolCtx, record: protocolRecord } = makeCtx();
  plugin.apply(protocolCtx, standard.validate({ digest: false, injectOnCompaction: false }).value);
  const protocolText = protocolRecord.sections
    .find((section) => section.name === 'project-forge:protocol')
    .text({});
  for (const needle of [
    '整份内联，绝不截断',
    '告警线，不是裁剪线',
    '不要靠压缩措辞消掉告警',
    '只允许在文件末尾追加',
    '永不插入、永不改写、永不分小节',
    '顺序就是牺牲顺序',
    '越预算时把最旧的工作记录搬进 `journal.jsonl`',
    '在**完成它的同一个提交**里把条目移出',
    '该条目属于 `todo.md`',
    '不要积累只增不改的计划',
  ]) {
    assert.ok(protocolText.includes(needle), `§4 states the three-class rule: ${needle}`);
  }
  console.log('digest configuration: OK');

