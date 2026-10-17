/**
 * the clock footnote appended to tool results.
 *
 * privacy-guard: allow — a fixture set: it writes home paths, boundary paths and secret literals
 * into throwaway repositories to prove what the guards refuse.
 */


// ── The clock footnote (D30) ──────────────────────────────────────────────────
// The clock must not enter the system prompt or the digest, so it rides on tool results: one
// footer on a successful call, nothing inside the throttle window, nothing on a failure. The
// listener is driven directly here — what the harness does with the returned decision is its
// own business and is covered by the tool packages' tests.
  const { ctx: clockCtx, record: clockRecord } = makeCtx();
  plugin.apply(clockCtx, standard.validate({ digest: false, injectOnCompaction: false }).value);
  const hook = clockRecord.listeners.find((listener) => listener.name === 'tools/post-execute');
  assert.ok(hook !== undefined, 'the clock hook is registered on tools/post-execute');
  const { agent: clockAgent } = createdAgent(clockRecord, project, 'session-clock');
  const call = (result) => hook.handler(
    { name: 'read', arguments: {}, agent: clockAgent },
    result,
    async () => ({ kind: 'accept' }),
  );
  const ok = { isError: false, content: [{ type: 'text', text: 'file contents' }] };
  const first = await call(ok);
  assert.equal(first.kind, 'accept', 'the decision stays an accept');
  assert.match(first.content[0].text, /^file contents\n\n---\n⏱ \d{4}-\d\d-\d\dT/, 'the footnote carries the time and keeps the output above it');
  const second = await call(ok);
  assert.equal(second.content, undefined, 'a second call inside the throttle window is left alone');
  const failed = await call({ isError: true, content: [{ type: 'text', text: 'boom' }] });
  assert.equal(failed.content, undefined, 'a failed result is never decorated');
  console.log('clock footnote: OK');
