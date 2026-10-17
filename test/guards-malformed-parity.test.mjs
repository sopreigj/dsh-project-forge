/**
 * The two malformed tool-call repairs must agree: the steward plugin's guardMalformedToolCall
 * (plugin/guards/register.js) and the review bundle's private copy (review/plugin/index.js).
 * They are separate implementations only because the review bundle must stay dependency-free
 * (V7), so nothing but a test can keep them in step.
 *
 * privacy-guard: allow — a fixture set: it writes home paths, boundary paths and secret literals
 * into throwaway repositories to prove what the guards refuse.
 */

// The two copies must also survive each other: when a forked review child inherits the steward
// plugin, its repair runs first and the review copy sees already-repaired chunks. The last case
// below feeds rewritten chunks through both and requires identity.
const byteForByte = (chunk) => JSON.stringify(chunk);

/** One shared fixture: two malformed calls at different indices, a healthy call, and blocks the
 * repair must not touch. Both implementations see exactly this stream. */
async function* malformedFixture() {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: 'let me run ' };
  yield { type: 'block-start', index: 1, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 1, id: '', argumentsDelta: '{"command":"ls' };
  yield { type: 'tool-call-delta', index: 1, id: '', argumentsDelta: '"}' };
  yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: '', name: '', arguments: '{"command":"ls"}' } };
  yield { type: 'block-start', index: 2, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 2, id: '', argumentsDelta: '{"command":"pwd"}' };
  yield { type: 'block-end', index: 2, block: { type: 'tool-call', id: '', name: '', arguments: '{"command":"pwd"}' } };
  yield { type: 'block-end', index: 3, block: { type: 'text', text: 'done' } };
  yield { type: 'tool-call-delta', index: 4, id: 'call_ok', argumentsDelta: '{}' };
  yield { type: 'block-end', index: 4, block: { type: 'tool-call', id: 'call_ok', name: 'pwsh', arguments: '{}' } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}

/** Compare-ready shape: a synthetic id collapses to the index it was minted for, so the two
 * implementations' random uuids compare equal while any structural difference still shows. */
const shapeOf = (chunk) => {
  const id = (value) => {
    if (typeof value !== 'string') return value;
    if (value === '') return 'EMPTY';
    return /^malformed-/.test(value) ? 'SYNTHETIC' : `LITERAL:${value}`;
  };
  if (chunk.type === 'tool-call-delta') return { type: chunk.type, index: chunk.index, id: id(chunk.id) };
  if (chunk.type === 'block-end') return { type: chunk.type, index: chunk.index, blockType: chunk.block?.type, id: id(chunk.block?.id) };
  return { type: chunk.type, index: chunk.index };
};

const syntheticIdAt = (chunks, index) =>
  chunks.find((chunk) => chunk.type === 'block-end' && chunk.index === index)?.block?.id;

/** Drive one implementation: apply it to a fresh ctx, own one session, run the fixture through it. */
async function runThrough(applyFn, sessionId) {
  const { ctx, record } = makeCtx();
  applyFn(ctx);
  const listener = record.listeners.find((entry) => entry.name === 'llm/stream');
  if (!listener) throw new Error('no llm/stream listener was registered');
  createdAgent(record, project, sessionId);
  const out = [];
  for await (const chunk of listener.handler({ sessionId }, () => malformedFixture())) out.push(chunk);
  return { out, record, listener };
}

{
  const steward = await runThrough(
    (ctx) => plugin.apply(ctx, standard.validate({ digest: false, injectOnCompaction: false }).value),
    'session-parity-steward',
  );
  const review = await import('../review/plugin/index.js');
  const reviewed = await runThrough((ctx) => review.apply(ctx), 'session-parity-review');

  // 1. Same structural outcome, chunk for chunk.
  assert.deepEqual(
    steward.out.map(shapeOf),
    reviewed.out.map(shapeOf),
    'both copies repair the same chunks the same way',
  );
  assert.equal(steward.out.length, reviewed.out.length, 'neither copy adds or drops a chunk');
  assert.equal(steward.out.length, 13, 'the fixture passes through whole');

  // 2. Non-vacuity: the comparison above would notice a copy that did nothing.
  const raw = [];
  for await (const chunk of malformedFixture()) raw.push(chunk);
  assert.notDeepEqual(
    steward.out.map(shapeOf),
    raw.map(shapeOf),
    'the steward copy really did rewrite something (else the parity assertion is vacuous)',
  );

  // 3. What "repaired" must mean, asserted on both copies independently.
  for (const [label, { out, record }] of [['steward', steward], ['review', reviewed]]) {
    const idOne = syntheticIdAt(out, 1);
    const idTwo = syntheticIdAt(out, 2);
    assert.ok(/^malformed-/.test(idOne), `${label}: the empty id became a synthetic one`);
    assert.ok(/^malformed-/.test(idTwo), `${label}: the second call was repaired too`);
    assert.notEqual(idOne, idTwo, `${label}: two malformed calls get two different ids`);
    assert.ok(
      out.filter((c) => c.type === 'tool-call-delta' && c.index === 1).every((c) => c.id === idOne),
      `${label}: the delta chain and the block-end agree on one id`,
    );
    assert.equal(syntheticIdAt(out, 4), 'call_ok', `${label}: a well-formed id is untouched`);
    assert.equal(out.find((c) => c.index === 3).block.id, undefined, `${label}: non-tool blocks are untouched`);
    assert.equal(
      out.find((c) => c.type === 'block-end' && c.index === 1).block.name,
      '',
      `${label}: the name is left alone so the call fails as an unknown tool, recoverably`,
    );
    assert.ok(
      record.logs.some(([level, ...rest]) => level === 'warn' && rest.join(' ').includes('repaired a malformed tool call')),
      `${label}: the repair is logged`,
    );
  }

  // 4. The two must not fight: already-repaired chunks pass through both copies byte for byte.
  const passThrough = async function* () {
    for (const chunk of steward.out) yield chunk;
  };
  const afterReview = [];
  const { ctx: secondCtx, record: secondRecord } = makeCtx();
  review.apply(secondCtx);
  createdAgent(secondRecord, project, 'session-parity-second');
  const secondListener = secondRecord.listeners.find((entry) => entry.name === 'llm/stream');
  for await (const chunk of secondListener.handler({ sessionId: 'session-parity-second' }, () => passThrough())) {
    afterReview.push(chunk);
  }
  assert.deepEqual(
    afterReview.map(byteForByte),
    steward.out.map(byteForByte),
    'an already-repaired stream is not touched again by the review copy',
  );

  // 5. Each copy still ignores sessions it does not own (the waterfall is process-wide).
  const oneMalformedChunk = async function* () {
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: '', name: '', arguments: '{}' } };
  };
  for (const [label, listener] of [['steward', steward.listener], ['review', reviewed.listener]]) {
    const foreign = [];
    for await (const chunk of listener.handler({ sessionId: 'session-not-ours' }, () => oneMalformedChunk())) {
      foreign.push(chunk);
    }
    assert.equal(foreign[0].block.id, '', `${label}: a session it does not own is left alone`);
  }

  console.log('malformed repair parity: OK');
}
