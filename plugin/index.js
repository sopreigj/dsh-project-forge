/**
 * Project Forge mode — the mode-defining plugin.
 *
 * privacy-guard: allow — this file is the mode's own implementation: its protocol text and
 * its scanner constants name the state boundary and show the patterns the guard refuses, so
 * the privacy scan is deliberately not applied to it.
 *
 * **What this mode is.** Not a rule list but a repository state management protocol:
 * the agent's job is to keep a project *recoverable, traceable and continuable*, and
 * the protocol defines the state that has to exist for that to be true. The state has
 * five layers:
 *
 * | layer | question it answers | carrier |
 * |---|---|---|
 * | persistence | what happened to this project? | git history |
 * | current state | what is true right now? | `private/done.md` |
 * | next state | what remains? | `private/todo.md` |
 * | strategy | why are we going this way, and how did it change? | `private/plan.md` |
 * | negative knowledge | which routes are already disproved? | `private/tortuous.jsonl` (index inlined) |
 * | work record | what just happened? | `private/journal.jsonl` (never inlined) |
 *
 * **The state boundary.** All of that state lives in one directory — `private/` by default —
 * together with the project's own rules. Everything outside it is the **public surface**,
 * written as if the project were already open source (§1.7 of the protocol): portable, no
 * private fact except in a configuration file, no reference into the boundary. Publishing is
 * then mechanical: delete the boundary, copy the tree, `git init`.
 *
 * **How the mode is delivered**, weakest to strongest:
 *
 * 1. `project-forge:protocol` — the protocol itself, a system-prompt section present
 *    in every request, so it survives whatever the conversation does.
 * 2. `project-forge:recovery` — the post-compaction procedure, a second section.
 * 3. `project-forge:digest` — the maintained documents, the repository state and the
 *    project's own rule file, re-read from disk on every request and rendered into the
 *    runtime context. The rules stop being the only memory: the facts are there too.
 * 4. `injectOnCompaction` — the first step after a compression carries a recovery
 *    message with that same digest appended, so recovery does not depend on the model
 *    choosing to read anything.
 * 5. The guards — `guardLocalGit` (publishing/history-destroying commands never run),
 *    `guardCommitCheckpoint` (a commit is refused while the state documents are stale),
 *    `guardLayoutCheckpoint`, `guardSecrets`, `guardPrivacyBoundary` (the public surface
 *    stays open-source-ready) and `guardConcurrentWrite`.
 *
 * **What is deliberately not inlined:** `journal.jsonl` (a record, not a constraint: only
 * the compaction recovery message carries its last few entries), `tortuous.jsonl` (only its
 * one-line-per-record index is, so the model can decide whether to open the file), and
 * `rationale/` + `docs/` (that is what they are for — they answer "how do I maintain this",
 * not "what do I do next").
 *
 * Design notes that cost real debugging time (see ../private/tortuous.jsonl):
 * - The digest reads files **synchronously**: the runtime context is rendered inside
 *   prompt assembly, and an async read is not finished when the first request is
 *   assembled.
 * - Compaction is detected by comparing `session.surface.replaceGeneration` across
 *   steps, with no session-log accessor in the path.
 * - A profile-installed bundle resolves no DSH packages, so this file imports only Node
 *   builtins and ./config/schema.js.
 */

import {
  join,
  relative,
} from 'node:path';

import { Config } from './config/schema.js';
import { PROTOCOL, RECOVERY } from './protocol/index.js';
import {
  DIGEST_HEADING,
  REPO_HEADING,
  IN_FLIGHT_HEADING,
  BUDGET_HEADING,
  REPAIR_HEADING,
  DRIFT_HEADING,
  NO_MEMORY_HEADING,
  renderNoMemory,
  renderInFlight,
  renderRepairs,
  renderDrift,
  renderTortuousIndex,
  renderJournalTail,
  renderReadOnDemand,
  readRepoState,
} from './digest/index.js';

import { applyClock } from './clock/index.js';
import { registerGuards } from './guards/register.js';

/** Producer kind stamped on every message this plugin injects. */
import {
  SOURCE_KIND,
  loadRecoveredMarkers,
  rememberRecoveredMarker,
  resolveStateFile,
  stewardCandidates,
  firstPresent,
  displayPath,
  readIfPresent,
  safeId,
  commitsSinceDocumentWrite,
} from './shared/index.js';

/** Cordis plugin name. */
export const name = 'project-forge';

/** The registries this row contributes to: prompts and the tool pipeline. */
export const inject = ['systemPrompt', 'tools'];

export { Config };

/**
 * Read one file synchronously; undefined when it is absent or unreadable.
 * @param absolute - resolved path.
 * @returns the file text, or undefined.
 */

/**
 * Register the protocol, the project-memory digest, the compaction recovery and the two
 * guards on the preset scope.
 *
 * @param ctx - the preset scope context.
 * @param config - the validated row config.
 */
export function apply(ctx, config) {
  if (config.protocol !== false) {
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'project-forge:protocol',
          // 400 sits after the shared deployment persona (0) and before the plan
          // policy (500); the mode's rules belong directly after the agent's identity
          // and before tool-specific guidance (1000+).
          order: 400,
          text: () => PROTOCOL,
        }),
      'project-forge.protocol()',
    );
  }

  if (config.recoveryProcedure !== false) {
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: 'project-forge:recovery',
          order: 410,
          text: () => RECOVERY,
        }),
      'project-forge.recovery()',
    );
  }

  const wantsDigest = config.digest !== false;
  const wantsRecovery = config.injectOnCompaction !== false;

  /** Per-agent state: the rendered digest plus the detection bookkeeping. */
  const states = new Map();

  /**
   * Read the configured documents, the repository state and the project's rule file,
   * and render the digest.
   *
   * Synchronous on purpose: the runtime context is rendered inside prompt assembly, and
   * an async read is not finished when the first request is assembled.
   * @param state - the agent's state.
   */
  const refresh = (state, force) => {
    if (!force && state.text !== undefined && Date.now() - state.at < config.digestRefreshMs) return;
    const cwd = state.agent.session.header.cwd;
    if (typeof cwd !== 'string' || cwd.length === 0) return;
    const parts = [];
    const oversize = [];
    let used = 0;

    /**
     * Inline one **contract** document in full.
     *
     * Contracts are never truncated: silently losing the end of `done.md` or `plan.md` is
     * exactly the failure this mode exists to prevent, and a resuming agent cannot tell a
     * missing tail from a short document. Going over budget is *reported* instead — the
     * report is stable text, so it costs nothing once the prefix is cached.
     * @param label - the document's display name, relative to the project root.
     * @param absolute - its resolved path.
     * @param budgetKey - the key `documentBudgets` is looked up by.
     * @returns whether the document existed and was inlined.
     */
    const appendContract = (label, absolute, budgetKey) => {
      const text = readIfPresent(absolute);
      if (text === undefined) return false;
      const budget = typeof config.documentBudgets?.[budgetKey] === 'number'
        ? config.documentBudgets[budgetKey]
        : config.documentBudgetDefault;
      const body = text.trimEnd();
      if (body.length > budget) oversize.push(`${label} ${body.length}/${budget}`);
      used += body.length;
      parts.push(`### ${label}\n${body}`);
      return true;
    };

    // Rules first: they change least, and everything after them is what pays for a change.
    if (config.stewardFile !== false) {
      const absolute = firstPresent(stewardCandidates(cwd, config));
      const label = displayPath(cwd, absolute);
      state.stewardPresent = appendContract(
        `${label} (this repository's own steward rules)`, absolute, 'steward.md',
      );
    }

    // Negative knowledge: the index only. One line per record, derived from the JSONL, so the
    // model can see that a route was already disproved without carrying the whole file.
    const index = renderTortuousIndex(cwd, config);
    if (index !== undefined) {
      used += index.length;
      parts.push(`### ${displayPath(cwd, resolveStateFile(cwd, config, config.tortuousFile).absolute)}（索引）\n${index}`);
    }

    for (const relative of config.digestFiles) {
      const resolved = resolveStateFile(cwd, config, relative);
      appendContract(displayPath(cwd, resolved.absolute), resolved.absolute, relative);
    }

    if (parts.length === 0) {
      state.status = state.text === undefined ? 'missing' : 'stale';
      // Nothing was readable, so the digest would be absent — which reads as "this project
      // has no state to load" rather than "the state is somewhere else". Say what came up
      // empty; the recovery message already does this, the per-turn path did not.
      const looked = [
        ...config.digestFiles.map((name) => displayPath(cwd, resolveStateFile(cwd, config, name).absolute)),
        displayPath(cwd, resolveStateFile(cwd, config, config.tortuousFile).absolute),
        ...(config.stewardFile === false
          ? []
          : stewardCandidates(cwd, config).map((path) => displayPath(cwd, path))),
      ];
      state.text = [DIGEST_HEADING, '', NO_MEMORY_HEADING, '', renderNoMemory(looked, config.stateDir)].join('\n');
      return;
    }

    const blocks = [DIGEST_HEADING, '', parts.join('\n\n')];
    if (config.repoStateInDigest !== false) {
      const repo = readRepoState(cwd, config.repoCommitWindow);
      if (repo !== undefined) {
        blocks.push('', REPO_HEADING, '', repo);
        state.repoLog = repo;
        state.repoHead = /HEAD: (\S+)/.exec(repo)?.[1];
        // Drift signal: commits sitting on top of the newest commit that touched a contract
        // document. Git answers "do the documents describe the repository?" without requiring
        // the project to write commit hashes into its prose — the hash test this replaces
        // nagged forever in a repository that deliberately keeps hashes out of its documents.
        const unrecorded = commitsSinceDocumentWrite(cwd, config) ?? 0;
        state.unrecordedCommits = unrecorded > 0;
        state.unrecordedCount = unrecorded;
      } else {
        state.repoHead = undefined;
        state.unrecordedCommits = false;
      }
    }
    // A commit no document mentions is the one drift signal the mode already computes; until
    // now its only visible consequence was a commit refusal. §9 wants the other order: notice
    // while working. Conditional, so a current project pays nothing for it.
    const drift = renderDrift(state.unrecordedCount);
    if (drift !== undefined) blocks.push('', DRIFT_HEADING, '', drift);
    // Who is editing what, derived from the live claim set. Parallel sessions read this
    // instead of maintaining a shared "in progress" list that a killed session cannot clean.
    const inFlight = renderInFlight(cwd, config, state.agent?.id, state.takeovers);
    if (inFlight !== undefined) blocks.push('', IN_FLIGHT_HEADING, '', inFlight);
    // A repaired malformed tool call is the one event the model cannot infer from its own
    // transcript: the call fails as an unknown tool, which looks identical to a missing tool.
    // The log line explains it to a human reading logs; this block puts the cause in front of
    // the model, and it costs nothing until something was repaired.
    const repairs = renderRepairs(state.malformedRepairs);
    if (repairs !== undefined) blocks.push('', REPAIR_HEADING, '', repairs);
    // Static text, so it costs nothing once the prefix is cached, and it is what makes the
    // read-on-demand files discoverable at all.
    blocks.push('', renderReadOnDemand(cwd, config));
    // Budget warnings go last: they are derived from the sizes above, so a document growing
    // invalidates nothing that follows it.
    const warnings = [...oversize];
    if (used > config.digestMaxBytes) warnings.push(`digest 合计 ${used}/${config.digestMaxBytes}`);
    if (warnings.length > 0) {
      blocks.push('', BUDGET_HEADING, '', ...warnings.map((line) => `- ${line}`),
        `- 处置：把最旧或最细的内容移进 \`${config.journalFile}\` 或 \`private/rationale/\`，正文只留现在还生效的东西。`);
    }
    state.journalTail = renderJournalTail(cwd, config);
    // Document prose is data, not a template. `systemPrompt.context()` carries the same
    // `interpolate` switch as sections, and a host that honours it for context entries
    // (`renderPrompt`: `context.interpolate === false ? context.text : interpolate(...)`) renders
    // the digest exactly as written — which is why the context() call below declares it. Mangling
    // `{{` into `{ {` was the workaround for a host that honoured the switch on sections only; it
    // corrupted every document that quotes Vue/mustache braces, so it is gone (V11 records the host
    // floor that replaces it).
    state.text = blocks.join('\n');
    state.at = Date.now();
    state.status = 'ready';
  };

  /**
   * The recovery message folded into the first step after a compaction.
   * @param marker - identifies the compaction this message answers.
   * @param snapshot - the current digest, so the message is self-contained.
   * @param journal - the journal tail: what happened, which the digest deliberately omits.
   * @returns a UserMessage-shaped object.
   */
  const recoveryMessage = (marker, snapshot, journal) => {
    const text = [
      'Context compaction just settled. Project Forge recovery:',
      '1. The contract documents and the repository state are inlined below — read them there. The negative knowledge and the journal are **not** inlined: open them on demand, and read the negative knowledge before repeating an approach that may have failed before.',
      '2. Re-state the steward protocol in your reply before making changes.',
      '3. Run a state consistency check against `git status` / `git log`, and record every mismatch in the Drift section of `done.md`.',
      ...(journal === undefined ? [] : ['', `工作记录（\`${config.journalFile}\` 最近几条）：`, journal]),
      '',
      snapshot ?? '(the state documents could not be read; open them from the project root)',
    ].join('\n');
    return {
      // Hand-built message: a profile-installed bundle cannot import
      // `@deepseek-ai/dsh-llm`, so the UserMessage shape is produced locally.
      id: `project-forge:recovery:${safeId(marker)}`,
      role: 'user',
      content: [{ type: 'text', text }],
      // `form: 'snapshot'` is the harness's own shape for injected context (see
      // `packages/core/agent-loop/src/runtime-context.ts` and `time-context`). A bare
      // `{ kind: 'user' }` would render as if the user had typed this text.
      source: { kind: SOURCE_KIND, form: 'snapshot', sections: [{ name: 'project-forge:recovery', text }] },
    };
  };

  ctx.on('agent/created', ({ agent }) => {
    const state = {
      agent,
      text: undefined,
      at: 0,
      status: 'pending',
      /** Turn number observed at the last step, so recovery fires once per turn. */
      turnSeen: undefined,
      /** Recovery markers already folded in, loaded from disk so a reload cannot repeat one. */
      recoveredMarkers: loadRecoveredMarkers(agent.id),
      /** Recovery marker waiting for the next eligible step, set by `compaction/end`. */
      pendingRecovery: undefined,
      /** Absolute paths this session has written, for the checkpoint guard. */
      touchedDocs: new Set(),
      /** Whether any maintained document was written since the last compaction. */
      docSinceCompaction: false,
      /** Whether a `compaction/end` has happened with no document written since. */
      compacted: false,
      /** Whether the repository is known to hold commits the documents do not mention. */
      unrecordedCommits: false,
      /** The repository-state block as the digest last read it. */
      repoLog: undefined,
      /** The project's own rule file was found. */
      stewardPresent: false,
      /** HEAD as the digest last read it. */
      repoHead: undefined,
      /** Stale claims this session took over, shown in the digest until the next commit. */
      takeovers: [],
      /** Malformed tool calls this session's stream repair rewrote, counted for the digest. */
      malformedRepairs: 0,
    };
    states.set(agent.id, state);

    // The compaction signal, read where it is actually delivered. `session/event` is a
    // Scoped event: a listener registered on the plugin's own context does not receive it,
    // while one registered on the agent's context does — the same registration the
    // framework's runtime-context uses. Keying on the real `compaction/end` event removes
    // the old guess "the surface generation changed", which also fires for every other
    // surface replacement (tool-result pruning, spill).
    ctx.effect(() => {
      const dispose = agent.ctx.effect(
        () =>
          agent.ctx.on('session/event', (_session, event) => {
            if (event?.type !== 'compaction/end') return;
            // A failed compaction still closes with `compaction/end`, but the surface did not
            // shrink and there is nothing to recover from — only a successful one counts.
            if (event.data?.error !== undefined) return;
            // A compaction invalidates "the documents were updated recently": the digest in
            // front of the model may no longer match the repository, so the next eligible
            // step carries one recovery message and the checkpoint guard arms.
            state.docSinceCompaction = false;
            state.compacted = true;
            state.pendingRecovery = `compaction-${String(event.seq)}`;
          }),
        'project-forge.compactionEvents()',
      );
      return dispose;
    }, 'project-forge.compactionListener()');

    // Warm before the first assembly: the context entry renders during prompt assembly,
    // so a lazily filled cache would miss the first request.
    refresh(state, true);
    if (wantsDigest && state.status !== 'ready') {
      ctx.logger?.warn?.(
        'project-forge: no project memory for session %s (cwd %s) — are the state documents written yet?',
        agent.id,
        String(agent.session.header.cwd),
      );
    }

    ctx.effect(() => {
      const dispose = agent.ctx.effect(
        () =>
          agent.ctx.systemPrompt.context({
            name: 'project-forge:digest',
            // After the framework's own policy context (110-120), well before the
            // instruction and tool sections that follow.
            order: 130,
            // Document prose is data, not a template: never interpolate it.
            interpolate: false,
            text: () => {
              if (!wantsDigest) return '';
              refresh(state, false);
              return state.text ?? '';
            },
          }),
        'project-forge.digest()',
      );
      return () => {
        dispose();
        states.delete(agent.id);
      };
    }, 'project-forge.agentState()');
  });

  if (wantsRecovery) {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      const state = states.get(payload.agent.id);
      if (state === undefined) return decision;
      if (payload.turn !== state.turnSeen) {
        state.turnSeen = payload.turn;
      }
      // An empty first entry owns a no-step turn; folding here would turn it into a
      // standalone request instead of context waiting for the next input.
      if (decision.kind === 'reject' || decision.messages.length === 0) return decision;
      const pending = state.pendingRecovery;
      if (pending === undefined) return decision;
      // Bound it to one message per turn, and only the earliest eligible step of that
      // turn, so several surface replacements inside one turn cannot stack messages.
      if (typeof payload.step === 'number' && payload.step > config.recoveryMinTurnStep) return decision;
      state.pendingRecovery = undefined;
      if (state.recoveredMarkers.has(pending)) return decision;
      state.recoveredMarkers.add(pending);
      rememberRecoveredMarker(payload.agent.id, pending);
      refresh(state, true);
      ctx.logger?.info?.('project-forge: folding post-compaction recovery (%s)', pending);
      return { ...decision, messages: [...decision.messages, recoveryMessage(pending, state.text, state.journalTail)] };
    });
  }

  // The clock footer (D30) lives in its own slice: ./clock/index.js.
  applyClock(ctx, config);

  // The nine guard registrations live in their own slice: ./guards/register.js.
  registerGuards(ctx, config, states);
}
