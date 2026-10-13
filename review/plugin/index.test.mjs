/**
 * Unit check for the review-mode placeholder plugin: it registers the malformed
 * tool-call repair (empty-id rewrite) and nothing else.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginPath = resolve(process.argv[2] ?? '.');
const plugin = await import(pathToFileURL(pluginPath).href);

assert.equal(plugin.name, 'project-forge-review-placeholder', 'plugin name');
assert.deepEqual(plugin.inject, [], 'no injected services');
assert.equal(typeof plugin.apply, 'function', 'apply is a function');

/** Minimal Cordis stub: records listeners and log lines. */
function makeCtx() {
  const record = { listeners: [], logs: [] };
  const ctx = {
    record,
    on(name, handler) {
      record.listeners.push({ name, handler });
      return () => {};
    },
    logger: {
      warn: (...args) => record.logs.push(['warn', ...args]),
      info: (...args) => record.logs.push(['info', ...args]),
    },
  };
  return { ctx, record };
}

{
  const { ctx, record } = makeCtx();
  plugin.apply(ctx);
  const names = record.listeners.map((entry) => entry.name);
  assert.deepEqual(names, ['agent/created', 'llm/stream'], 'only agent tracking and the stream repair');

  // Register an agent so its session becomes owned.
  const createdListener = record.listeners.find((entry) => entry.name === 'agent/created');
  createdListener.handler({ agent: { session: { header: { id: 'session-review-test' } } } });

  const streamListener = record.listeners.find((entry) => entry.name === 'llm/stream');
  async function* malformed() {
    yield { type: 'tool-call-delta', index: 0, id: '', argumentsDelta: '{}' };
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: '', name: '', arguments: '{}' },
    };
  }
  const out = [];
  for await (const chunk of streamListener.handler({ sessionId: 'session-review-test' }, () => malformed())) {
    out.push(chunk);
  }
  assert.ok(out[1].block.id.startsWith('malformed-'), 'empty id repaired');
  assert.equal(out[0].id, out[1].block.id, 'delta and block-end share the synthetic id');
  assert.ok(record.logs.some(([level, ...rest]) => level === 'warn' && rest.join(' ').includes('malformed')), 'repair logged');

  // Unowned sessions pass through untouched.
  async function* foreignStream() {
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: '', name: '', arguments: '{}' } };
  }
  const foreignOut = [];
  for await (const chunk of streamListener.handler({ sessionId: 'session-other' }, () => foreignStream())) foreignOut.push(chunk);
  assert.equal(foreignOut[0].block.id, '', 'foreign session untouched');

  // Healthy streams pass through untouched.
  async function* healthy() {
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_ok', name: 'read', arguments: '{}' } };
  }
  const ok = [];
  for await (const chunk of streamListener.handler({ sessionId: 'session-review-test' }, () => healthy())) ok.push(chunk);
  assert.equal(ok[0].block.id, 'call_ok', 'healthy id untouched');
  console.log('review placeholder: malformed tool-call repair OK');
}
