/**
 * Project Forge · Review Mode — placeholder plugin + malformed tool-call repair.
 *
 * The review preset does NOT load the project-forge plugin: a standalone review session is
 * read-mostly and carries no steward state, and a forked child inherits the real plugin from
 * its project-forge parent (agent-preset-registry `composeFrom`). Joining a preset twice
 * throws, so this preset must not declare the plugin.
 *
 * The one thing this placeholder must do itself: standalone review sessions (and spawned
 * review children) write their own session logs, and a model-emitted tool call with an empty
 * id wedges the V4 writer the same way as in steward sessions (seven deaths, 2026-10-08..12).
 * The `llm/stream` repair below rewrites the empty id to a synthetic one before the loop ever
 * sees it. When the fork-inherited project-forge plugin is present, its repair runs first and
 * this one passes the already-repaired chunks through untouched (empty id is gone), so the two
 * never fight.
 */
import { randomUUID } from 'node:crypto';

export const name = 'project-forge-review-placeholder'
export const inject = []

/**
 * Rewrite empty tool-call ids in one LLM chunk stream to a synthetic non-empty id.
 * Same logic as the steward plugin's guardMalformedToolCall — kept as a separate copy
 * because this bundle must stay dependency-free (profile installs resolve no DSH packages).
 * @param stream - the downstream chunk stream.
 * @param warn - logger for each repaired call.
 */
async function* repairMalformedToolCallIds(stream, warn) {
  /** Synthetic ids already assigned, keyed by block index, so the delta chain and the
   * block-end of one malformed call agree on the same id. */
  const repaired = new Map();
  const syntheticIdFor = (index) => {
    let id = repaired.get(index);
    if (id === undefined) {
      id = `malformed-${randomUUID()}`;
      repaired.set(index, id);
    }
    return id;
  };
  for await (const chunk of stream) {
    if (chunk?.type === 'tool-call-delta' && chunk.id === '') {
      yield { ...chunk, id: syntheticIdFor(chunk.index) };
      continue;
    }
    if (chunk?.type === 'block-end' && chunk.block?.type === 'tool-call' && chunk.block.id === '') {
      const id = syntheticIdFor(chunk.index);
      warn?.(
        `project-forge-review: repaired a malformed tool call (empty id, name ${JSON.stringify(chunk.block.name)}) as ${id}`,
      );
      yield { ...chunk, block: { ...chunk.block, id } };
      continue;
    }
    yield chunk;
  }
}

export function apply(ctx) {
  /** Session ids of agents created in this composition — the repair must not reach
   * streams of sessions owned by other presets sharing this process. */
  const ownedSessions = new Set();
  ctx.on('agent/created', ({ agent }) => {
    const sessionId = agent?.session?.header?.id;
    if (typeof sessionId === 'string') ownedSessions.add(sessionId);
  });
  ctx.on('llm/stream', (options, next) => {
    const sessionId = options?.sessionId;
    if (typeof sessionId !== 'string' || !ownedSessions.has(sessionId)) return next();
    return repairMalformedToolCallIds(next(), (message) => ctx.logger?.warn?.(message));
  });
}
