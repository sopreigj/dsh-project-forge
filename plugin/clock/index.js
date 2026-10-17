/**
 * The clock slice — the time footnote on tool results (D30).
 *
 * Why it is not in the system prompt or the digest: the prompt must stay byte-stable and the
 * digest is cached by prefix, while the time is the one fact that changes every minute. It rides
 * on tool output instead, throttled to `clockFooterThrottleMs`, and only on successful results
 * whose last block is text — a failure or a structured value must read exactly as produced.
 */

/** Register the footer. No-ops when `clockFooter` is off or the tool service is absent. */
export function applyClock(ctx, config) {
  if (config.clockFooter !== false && ctx.tools !== undefined) {
    const lastStamp = new Map();
    ctx.on('tools/post-execute', async (execution, result, next) => {
      const decision = await next();
      if (decision.kind !== 'accept' || decision.value !== undefined) return decision;
      if (result.isError === true) return decision;
      const now = Date.now();
      const owner = execution.agent?.id ?? '';
      if (now - (lastStamp.get(owner) ?? 0) < config.clockFooterThrottleMs) return decision;
      const blocks = decision.content ?? result.content;
      const tail = Array.isArray(blocks) ? blocks[blocks.length - 1] : undefined;
      if (tail === undefined || tail.type !== 'text') return decision;
      lastStamp.set(owner, now);
      const local = new Date(now).toLocaleString('zh-CN', { hour12: false });
      return {
        ...decision,
        content: [
          ...blocks.slice(0, -1),
          { type: 'text', text: `${tail.text}\n\n---\n⏱ ${new Date(now).toISOString()}（本机 ${local}）` },
        ],
      };
    });
  }
}
