/**
 * malformed tool-call repair (empty id) and its switch.
 *
 * privacy-guard: allow — a fixture set: it writes home paths, boundary paths and secret literals
 * into throwaway repositories to prove what the guards refuse.
 */


  // ── Guard F: malformed tool-call repair ─────────────────────────────────────
  // A model that writes a broken function tag (mimo-v2.6-flash does this under
  // frustration) makes pi-ai emit a tool-call block with an EMPTY id. The loop
  // survives that in memory, but the V4 session codec refuses to persist the
  // tool/result with an empty callId ("requires toolCallId matching its tool
  // source"), the drain wedges on the poisoned batch, and the session file
  // freezes mid-turn forever — seven sessions died exactly so, 2026-10-08..12.
  // The repair rewrites the empty id to a synthetic one at the stream boundary,
  // turning the fatal poison into an ordinary unknown-tool error.
  {
    const { ctx: mCtx, record: mRecord } = makeCtx();
    plugin.apply(mCtx, standard.validate({ digest: false, injectOnCompaction: false }).value);
    const streamListener = mRecord.listeners.find((entry) => entry.name === 'llm/stream');
    assert.ok(streamListener, 'the llm/stream repair listener is registered');

    const { agent: mAgent } = createdAgent(mRecord, project, 'session-malformed');
    const options = { sessionId: mAgent.session.header.id };

    async function* malformedStream() {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'let me run ' };
      yield { type: 'block-start', index: 1, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 1, id: '', argumentsDelta: '{"command":"ls' };
      yield { type: 'tool-call-delta', index: 1, id: '', argumentsDelta: '"}' };
      yield {
        type: 'block-end',
        index: 1,
        block: { type: 'tool-call', id: '', name: '', arguments: '{"command":"ls"}' },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    }

    const repaired = [];
    for await (const chunk of streamListener.handler(options, () => malformedStream())) repaired.push(chunk);
    const deltas = repaired.filter((chunk) => chunk.type === 'tool-call-delta');
    const end = repaired.find((chunk) => chunk.type === 'block-end');
    assert.ok(end.block.id.length > 0, 'the empty block id is repaired');
    assert.ok(end.block.id.startsWith('malformed-'), 'the synthetic id is recognisable');
    assert.equal(deltas.length, 2, 'both deltas pass through');
    assert.ok(deltas.every((chunk) => chunk.id === end.block.id), 'deltas and block-end agree on the synthetic id');
    assert.equal(end.block.name, '', 'the name is left alone — the call fails as unknown tool, recoverably');
    assert.ok(
      mRecord.logs.some(([level, ...rest]) => level === 'warn' && rest.join(' ').includes('malformed')),
      'the repair is logged',
    );

    // A well-formed stream passes through untouched (identity check per chunk).
    async function* healthyStream() {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: 'call_abc', name: 'pwsh', argumentsDelta: '{}' };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'call_abc', name: 'pwsh', arguments: '{}' },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    }
    const healthy = [];
    for await (const chunk of streamListener.handler(options, () => healthyStream())) healthy.push(chunk);
    assert.equal(healthy.length, 4, 'healthy stream chunk count unchanged');
    assert.equal(healthy[2].block.id, 'call_abc', 'a well-formed id is untouched');

    // Streams of other presets' sessions are not touched (the waterfall is process-wide).
    async function* foreignStream() {
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: '', name: '', arguments: '{}' },
      };
    }
    const foreign = [];
    for await (const chunk of streamListener.handler({ sessionId: 'session-not-ours' }, () => foreignStream())) {
      foreign.push(chunk);
    }
    assert.equal(foreign[0].block.id, '', 'a session this plugin does not own is left alone');
    console.log('malformed tool-call repair: OK');

    // The repair must not live only in the log. `ctx.logger` is always present (a built-in,
    // non-optional context service), so the warning is never lost — but a log line is not
    // something the model reads, and the repaired call surfaces as an *unknown tool*, which
    // looks like a missing tool rather than a broken function tag. The digest carries the
    // cause into the next prompt; `digestRefreshMs: 0` defeats the cache so the assertion
    // reads what the model would actually get next.
    const { ctx: dCtx, record: dRecord } = makeCtx();
    // `digestRefreshMs` must be positive (the schema says so), so the smallest honest value:
    // the cache window still has to elapse between the repair and the read below.
    plugin.apply(dCtx, standard.validate({ digestRefreshMs: 1, injectOnCompaction: false }).value);
    const dListener = dRecord.listeners.find((entry) => entry.name === 'llm/stream');
    const { agent: dAgent, contexts: dContexts } = createdAgent(dRecord, project, 'session-malformed-digest');
    // The heading as the model sees it — asserted literally, not via the exported constant,
    // because this is prompt text.
    const REPAIR_HEADING = '## ⚠ 本会话修复过的畸形工具调用';
    const open = () => dContexts[0].text({});
    const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
    const drain = async () => {
      for await (const _chunk of dListener.handler(
        { sessionId: dAgent.session.header.id },
        () => malformedStream(),
      )) { /* the repair happens while the stream is consumed */ }
      await settle();
    };

    assert.ok(!open().includes(REPAIR_HEADING), 'a healthy session carries no repair block');
    await drain();
    const repairedText = open();
    assert.ok(repairedText.includes(REPAIR_HEADING), 'the next digest reports the repair');
    assert.ok(repairedText.includes('**1** 个'), 'the block carries the count');
    assert.ok(
      repairedText.includes('unknown tool'),
      'and says what the model will actually see at the tool layer',
    );
    await drain();
    assert.ok(open().includes('**2** 个'), 'the count accumulates per session');
    console.log('malformed tool-call repair visible in the digest: OK');
  }

  // ── Guard G switch: repair can be disabled ───────────────────────────────────
  {
    const { ctx: noRepairCtx, record: noRepairRecord } = makeCtx();
    plugin.apply(noRepairCtx, standard.validate({
      digest: false,
      injectOnCompaction: false,
      guardMalformedToolCall: false,
    }).value);
    assert.ok(
      !noRepairRecord.listeners.some((entry) => entry.name === 'llm/stream'),
      'no llm/stream listener when the repair is off',
    );
    console.log('malformed tool-call repair switch: OK');
  }


