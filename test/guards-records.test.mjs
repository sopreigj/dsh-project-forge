/**
 * append-only records and the size ratchet.
 *
 * privacy-guard: allow — a fixture set: it writes home paths, boundary paths and secret literals
 * into throwaway repositories to prove what the guards refuse.
 */


// ── Guard: append-only records ────────────────────────────────────────────────
// The two jsonl files are read as "one record per line, appended only". The guard is found by
// what it refuses rather than by index, so another guard's opinion on the same write (the
// concurrent-write guard also looks at `write`) cannot make this test vacuous.
{
  const { ctx: appendCtx, record: appendRecord } = makeCtx();
  plugin.apply(appendCtx, standard.validate({ digest: false, injectOnCompaction: false }).value);
  const { agent: appendAgent } = createdAgent(appendRecord, project, 'session-append');
  const recordDir = join(project, 'private');
  mkdirSync(recordDir, { recursive: true });
  const recordPath = join(recordDir, 'journal.jsonl');
  const existing = '{"id":"J1","kind":"checkpoint"}\n';
  writeFileSync(recordPath, existing);
  const refusalFor = (content) => appendRecord.guards
    .map((guard) => guard({ name: 'write', arguments: { file_path: recordPath, content }, agent: appendAgent }))
    .find((answer) => typeof answer === 'string' && answer.includes('只追加'));
  const refusal = refusalFor('{"id":"J2","kind":"checkpoint"}\n');
  assert.equal(typeof refusal, 'string', 'a write that drops the records already on disk is refused');
  assert.ok(refusal.includes('journal.jsonl'), 'the refusal names the file');
  // The refusal has to be actionable: it says where the draft stopped matching, and what the two
  // sides look like there. Without this the model can only guess which record it lost.
  // `{"id":"J1"…` vs `{"id":"J2"…` share `{"id":"J` — eight characters — so that is the offset.
  assert.ok(refusal.includes('从第 8 个字符（第 1 行）起不一致'), `the refusal locates the divergence: ${refusal}`);
  assert.ok(refusal.includes('「1","kind":"checkpoint"}⏎」'), 'and quotes what is on disk at that point');
  assert.ok(refusal.includes('「2","kind":"checkpoint"}⏎」'), 'and quotes what this write would have put there');
  // A divergence deeper in the file is located at its real offset, not just "somewhere".
  const tail = '{"id":"J1"}\n{"id":"J2"}\n';
  writeFileSync(recordPath, tail);
  const midRefusal = refusalFor('{"id":"J1"}\n{"id":"JX"}\n');
  assert.ok(
    midRefusal.includes('从第 20 个字符（第 2 行）起不一致'),
    `the offset and the line are the real ones: ${midRefusal}`,
  );
  writeFileSync(recordPath, existing);
  assert.equal(
    refusalFor(`${existing}{"id":"J2","kind":"checkpoint"}\n`),
    undefined,
    'the same guard allows the append — the previous text is the prefix',
  );
  console.log('append-only guard: OK');
}

// ── Guard: size ratchet (opt-in) ──────────────────────────────────────────────
// The budgets are warning lines by default: the digest prints "⚠ 超出预算 <file> a/b" and nothing
// blocks (§4.0.1). `sizeLimitMode: 'ratchet'` adds exactly one commit-time refusal, and what that
// refusal measures is two sizes: the document must already be **over** its hard cap AND this commit
// must make it **bigger**. Shrinking, splitting and moving always pass — an absolute threshold would
// refuse the very commit that starts the slimming, which is how a file freezes at its over-budget size.
{
  const { ctx: warnCtx, record: warnRecord } = makeCtx();
  plugin.apply(warnCtx, standard.validate({ digest: false, injectOnCompaction: false }).value);
  const { ctx: ratchetCtx, record: ratchetRecord } = makeCtx();
  plugin.apply(ratchetCtx, standard.validate({ digest: false, injectOnCompaction: false, sizeLimitMode: 'ratchet' }).value);
  assert.equal(
    ratchetRecord.guards.length,
    warnRecord.guards.length + 1,
    'the ratchet adds exactly one guard when it is switched on',
  );
  assert.equal(
    standard.validate({ sizeLimitMode: 'hard' }).issues.some((issue) => issue.path?.[0] === 'sizeLimitMode'),
    true,
    'an unknown sizeLimitMode is rejected by the schema',
  );

  // Drive the refusal against a throwaway repository: `before` comes from `git show HEAD:<path>`,
  // so the fixture needs one commit to compare against. done.md's budget is 2000, so the hard cap
  // is 3000. The commit below is issued directly, not through the guard, which is how a fixture
  // gets into the "already over the cap" state the ratchet is about.
  const repo = mkdtempSync(join(tmpdir(), 'forge-ratchet-'));
  const docPath = join(repo, 'private', 'done.md');
  mkdirSync(dirname(docPath), { recursive: true });
  const git = (...args) => execFileSync(
    'git',
    ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
    { encoding: 'utf8' },
  );
  const body = (n) => `# done.md\n${'x'.repeat(n)}\n`;
  writeFileSync(docPath, body(1000));
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture under the hard cap');
  const { agent: ratchetAgent } = createdAgent(ratchetRecord, repo, 'session-ratchet');
  const refusalFor = () => ratchetRecord.guards
    .map((guard) => guard({ name: 'pwsh', arguments: { command: 'git commit -m x' }, agent: ratchetAgent }))
    .find((answer) => typeof answer === 'string' && answer.includes('硬上限'));

  writeFileSync(docPath, body(2900));
  assert.equal(refusalFor(), undefined, 'growth that stays under the hard cap passes');
  writeFileSync(docPath, body(3200));
  const refusal = refusalFor();
  assert.equal(typeof refusal, 'string', 'a commit that grows an already-over-cap document is refused');
  assert.ok(refusal.includes('done.md'), 'the refusal names the document');
  assert.ok(refusal.includes('3000'), 'the refusal states the hard cap it measured against');
  // Derive the two sizes from the fixture itself: `body(n)` also carries a title line and a
  // newline, so the document is longer than `n`.
  const overCap = body(3200);
  const excess = overCap.length - 3000;
  assert.ok(refusal.includes(String(overCap.length)), 'and the size this commit would land');
  assert.ok(refusal.includes('预算 2000'), 'the budget reported is this document\'s, not the whole table');
  assert.ok(refusal.includes(`还超 ${excess}`), `the refusal states how far over the cap it is: ${refusal}`);
  assert.ok(
    refusal.includes('不要比上次大') && refusal.includes('减到硬上限以内'),
    'and the two ways to make the next commit pass',
  );
  assert.ok(
    !refusal.includes('plan.md'),
    'the refusal no longer dumps the whole budget table',
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture over the hard cap');
  writeFileSync(docPath, body(3100));
  assert.equal(refusalFor(), undefined, 'a commit that shrinks an over-cap document passes — that is the ratchet');
  rmSync(repo, { recursive: true, force: true });
  console.log('size ratchet: OK');
}

