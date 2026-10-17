/**
 * Project Forge mode — the plugin's Config schema.
 *
 * privacy-guard: allow — this file is the mode's own implementation: it defines the state
 * boundary's default (`private/`) and the steward rules' path, so it names boundary paths on
 * purpose and the privacy scan is deliberately not applied to it.
 *
 * Cordis validates a plugin row's `config` through the **Standard Schema** interface
 * (`runtime.Config['~standard'].validate(raw)`), which is why a preset row's child
 * plugin must expose either a real schemastery schema or an object implementing that
 * interface. A plain-object `Config` — or none at all — makes the Loader read
 * `undefined.validate` and fails the whole preset with
 * `Cannot read properties of undefined (reading 'validate')`.
 *
 * This file implements the interface directly instead of importing
 * `@deepseek-ai/schemastery`: a profile-installed bundle cannot resolve DSH packages
 * (the profile's `node_modules` holds only bundles the user installed), so a bare
 * import would work in a source checkout and break in Desktop. The implementation
 * below is about sixty lines and has no dependencies at all.
 *
 * `~standard` is the well-known symbol `Symbol.for('~standard')`, so no
 * `@standard-schema/spec` import is needed either.
 */

/**
 * Default values, applied when a field is absent.
 *
 * Exported because it is the single source of truth for the documented defaults:
 * `release/check-consistency.mjs` compares `docs/configuration.md` against it, so the reference
 * table cannot drift from the code the way `digestTailLimits` once did — vocabulary-guard: allow (naming the retired field is the point).
 */
export const DEFAULTS = Object.freeze({
  protocol: true,
  recoveryProcedure: true,
  digest: true,
  /**
   * The state boundary: the one directory that holds the project's own state — the four
   * documents, the steward rules and the concurrent-write claims. Everything outside it is
   * the **public surface**, written as if the project were already open source.
   * `'.'` restores the pre-boundary layout (documents at the project root).
   */
  stateDir: 'private',
  /**
   * The **contract** documents: inlined in full, in this order. The order follows the one
   * rule the mode uses everywhere — least-volatile first, most-volatile last — because a
   * change invalidates everything *after* it in the cached prefix. The steward rules are
   * rendered before these and are configured separately.
   */
  digestFiles: Object.freeze(['plan.md', 'done.md', 'todo.md']),
  /**
   * Per-document budget, in characters. A budget is a **warning threshold**, never a
   * truncation: a contract document is always inlined in full (the model must not lose the
   * part it needs), and going over budget is reported in the digest itself so the agent
   * moves detail out instead of quietly losing it.
   */
  documentBudgets: Object.freeze({ 'steward.md': 6000, 'plan.md': 15000, 'done.md': 2000, 'todo.md': 5000 }),
  /** Budget for a contract document the map does not name. */
  documentBudgetDefault: 20000,
  /** The **record** file: append-only JSONL, never inlined; only a few entries ride recovery. */
  journalFile: 'journal.jsonl',
  /** How many recent journal entries the compaction-recovery message carries. */
  journalRecoveryEntries: 5,
  /** The **negative-knowledge** file: append-only JSONL, never inlined; only an index is. */
  tortuousFile: 'tortuous.jsonl',
  /** Character ceiling for the negative-knowledge index rendered into the digest. */
  tortuousIndexBytes: 2500,
  repoStateInDigest: true,
  /**
   * How many recent commits the digest's repository block lists. `guardCommitCheckpoint`
   * reads that same list to spot commits no document mentions, so this is also its window.
   */
  repoCommitWindow: 8,
  stewardFile: true,
  stewardFilePath: 'private/steward.md',
  /**
   * Ceiling for the whole digest. With every contract document on its own budget this is a
   * pure fuse: crossing it adds a warning line and never truncates or reallocates.
   */
  digestMaxBytes: 28000,
  digestRefreshMs: 5000,
  injectOnCompaction: true,
  /**
   * Earliest step of a turn allowed to carry the recovery message. `1` bounds the message
   * to at most one per turn, however many surface replacements happened inside that turn.
   */
  recoveryMinTurnStep: 1,
  guardLocalGit: true,
  guardCommitCheckpoint: true,
  guardLayoutCheckpoint: true,
  guardSecrets: true,
  guardPrivacyBoundary: true,
  guardConcurrentWrite: true,
  /**
   * The append-only records (`journalFile`, `tortuousFile`) may only grow: a write whose new
   * text does not start with the text already on disk is refused, because a rewrite loses
   * records silently — the digest index is derived from those lines.
   */
  guardAppendOnly: true,
  /**
   * What the size budgets do at commit time. `'warn'` (default) only prints the digest warning
   * line — nothing is blocked. `'ratchet'` additionally refuses a commit that makes an
   * **already-over-cap** contract document bigger; shrinking, splitting and moving always pass,
   * so the first slimming commit can never be blocked by its own over-budget file.
   */
  sizeLimitMode: 'warn',
  /** Hard cap, as a multiple of the document's budget, for `sizeLimitMode: 'ratchet'`. */
  sizeHardRatio: 1.5,
  /**
   * The clock rides on tool results (D30): after a successful tool call — at most once per
   * `clockFooterThrottleMs` — one line carrying the current time is appended to the result, so the
   * system prompt stays static and the digest stays cache-friendly. Failures are left untouched.
   */
  clockFooter: true,
  /** Minimum interval between two clock footnotes, in milliseconds, per session. */
  clockFooterThrottleMs: 600000,
  /** Which shared files the concurrent-write guard protects. */
  concurrentWriteMode: 'both',
  /**
   * How long a file claim survives without its owner touching it. A claim is refreshed on
   * every write by its owner, so an active session never loses one; a session that was killed
   * (machine off, quota gone, user interrupted) stops refreshing and its claims expire — that
   * expiry is the only cleanup this design relies on, because nothing waits for a turn to end.
   */
  claimStaleMs: 10 * 60 * 1000,
  guardMalformedToolCall: true,
})

/** Field → the JSON type the Loader must supply. */
const TYPES = Object.freeze({
  protocol: 'boolean',
  recoveryProcedure: 'boolean',
  digest: 'boolean',
  stateDir: 'string',
  digestFiles: 'array',
  documentBudgets: 'object',
  documentBudgetDefault: 'number',
  journalFile: 'string',
  journalRecoveryEntries: 'number',
  tortuousFile: 'string',
  tortuousIndexBytes: 'number',
  repoStateInDigest: 'boolean',
  repoCommitWindow: 'number',
  stewardFile: 'boolean',
  stewardFilePath: 'string',
  digestMaxBytes: 'number',
  digestRefreshMs: 'number',
  injectOnCompaction: 'boolean',
  recoveryMinTurnStep: 'number',
  guardLocalGit: 'boolean',
  guardCommitCheckpoint: 'boolean',
  guardLayoutCheckpoint: 'boolean',
  guardSecrets: 'boolean',
  guardPrivacyBoundary: 'boolean',
  guardConcurrentWrite: 'boolean',
  guardAppendOnly: 'boolean',
  sizeLimitMode: 'string',
  sizeHardRatio: 'number',
  clockFooter: 'boolean',
  clockFooterThrottleMs: 'number',
  concurrentWriteMode: 'string',
  claimStaleMs: 'number',
  guardMalformedToolCall: 'boolean',
})

/** Field type for one raw configuration value. */
function describe(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Build the ValidationIssue list for one raw configuration value.
 * @param raw - the row's `config` as the Loader parsed it.
 * @returns every issue, empty when `raw` is acceptable.
 */
function collectIssues(raw) {
  if (raw === undefined || raw === null) return []
  if (describe(raw) !== 'object') {
    return [{ message: `config must be an object, got ${describe(raw)}` }]
  }
  const issues = []
  for (const [key, expected] of Object.entries(TYPES)) {
    const value = raw[key]
    if (value === undefined) continue
    if (describe(value) !== expected) {
      issues.push({ message: `${key} must be a ${expected}, got ${describe(value)}`, path: [key] })
      continue
    }
    if (expected === 'array' && value.some((item) => typeof item !== 'string')) {
      issues.push({ message: `${key} must contain only file-name strings`, path: [key] })
    }
    if (expected === 'number' && (!Number.isFinite(value) || value <= 0)) {
      issues.push({ message: `${key} must be a positive number`, path: [key] })
    }
    if (key === 'stewardFilePath' && value.trim().length === 0) {
      issues.push({ message: 'stewardFilePath must not be blank', path: [key] })
    }
    if ((key === 'journalFile' || key === 'tortuousFile') && value.trim().length === 0) {
      issues.push({ message: `${key} must not be blank`, path: [key] })
    }
    if (key === 'stateDir' && value.trim().length === 0) {
      issues.push({ message: 'stateDir must not be blank (use "." for the project root)', path: [key] })
    }
    if (key === 'sizeLimitMode' && value !== 'warn' && value !== 'ratchet') {
      issues.push({ message: 'sizeLimitMode must be "warn" or "ratchet"', path: [key] })
    }
    if (key === 'clockFooterThrottleMs' && !(value > 0)) {
      issues.push({ message: 'clockFooterThrottleMs must be a positive number of milliseconds', path: [key] })
    }
    if (expected === 'object') {
      for (const [document, limit] of Object.entries(value)) {
        if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
          issues.push({
            message: `documentBudgets["${document}"] must be a positive number`,
            path: [key, document],
          })
        }
      }
    }
  }
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(TYPES, key)) {
      issues.push({ message: `unknown config field ${JSON.stringify(key)}`, path: [key] })
    }
  }
  return issues
}

/**
 * Apply defaults and copy only known fields, so downstream code sees a fully
 * populated, frozen configuration.
 * @param raw - the validated row configuration.
 * @returns the normalized configuration.
 */
function normalize(raw) {
  if (raw === undefined || raw === null) return DEFAULTS
  const normalized = {}
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    normalized[key] = raw[key] === undefined ? fallback : raw[key]
  }
  normalized.digestFiles = Object.freeze([...normalized.digestFiles])
  normalized.documentBudgets = Object.freeze({ ...normalized.documentBudgets })
  return Object.freeze(normalized)
}

/**
 * The mode plugin's Config: a Standard Schema over the protocol's fields.
 *
 * Fields:
 * - `protocol` (boolean, default true) — register the steward protocol.
 * - `recoveryProcedure` (boolean, default true) — register the post-compaction procedure.
 * - `digest` (boolean, default true) — inline the living documents into every request.
 * - `stateDir` (string, default `private`) — the **state boundary**: the one directory that
 *   holds the project's own state (the four documents, the steward rules, the claims).
 *   Everything outside it is the public surface, written as if the project were already
 *   open source. `'.'` restores the pre-boundary layout. A project whose documents still
 *   sit at the root keeps working: the reader falls back to the bare name when the file is
 *   not inside the boundary.
 * - `digestFiles` (string[], default `['plan.md','done.md','todo.md']`) — the **contract
 *   documents**, inlined in full and in exactly this order: least-volatile first, because a
 *   change invalidates everything after it in the cached prefix. The steward rules are
 *   rendered before them (`stewardFile`). `journal.jsonl` and `tortuous.jsonl` are
 *   deliberately absent: one is a record, the other is longest and least frequently needed —
 *   both stay read-on-demand.
 * - `documentBudgets` (object, default `{ 'steward.md': 6000, 'plan.md': 15000,
 *   'done.md': 2000, 'todo.md': 5000 }`) — **per-document character budget**. A budget is a
 *   warning threshold, never a truncation: an over-budget document is still inlined whole and
 *   the digest says by how much it is over, so detail gets moved out instead of silently lost.
 * - `documentBudgetDefault` (number, default 20000) — budget for a document the map omits.
 * - `journalFile` (string, default `journal.jsonl`) — the append-only record; never inlined,
 *   except that the compaction-recovery message carries its last few entries.
 * - `journalRecoveryEntries` (number, default 5) — how many those are.
 * - `tortuousFile` (string, default `tortuous.jsonl`) — the append-only negative-knowledge
 *   file; only its index (one line per record) is inlined.
 * - `tortuousIndexBytes` (number, default 2500) — size ceiling for that index.
 * - `repoStateInDigest` (boolean, default true) — append branch, HEAD and the recent
 *   commit subjects to the digest, so drift between the documents and the repository
 *   is visible without spending a tool call.
 * - `repoCommitWindow` (number, default 8) — how many recent commits the repository block
 *   lists; the checkpoint guard's drift signal reads the same list.
 * - `stewardFile` (boolean, default true) — also inline the repository's own rule file,
 *   making the repository self-describing.
 * - `stewardFilePath` (string, default `private/steward.md`) — that file's path. A project
 *   that still keeps it at `.agents/steward.md` is read there as well, so one-shot publish
 *   grants written before the boundary existed keep working.
 * - `digestMaxBytes` (number, default 28000) — ceiling for the per-document budgets
 *   combined; it is the backstop that keeps the whole inlined block bounded. A pure fuse:
 *   crossing it adds a warning line and never truncates.
 * - `digestRefreshMs` (number, default 5000) — how often the digest re-reads the files.
 * - `injectOnCompaction` (boolean, default true) — fold one recovery message carrying the
 *   digest into the first step after a compaction.
 * - `recoveryMinTurnStep` (number, default 1) — earliest step of a turn that may carry the
 *   recovery message, which bounds it to one per turn.
 * - `guardLayoutCheckpoint` (boolean, default true) — refuse a commit whose layout check was
 *   not acknowledged.
 * - `guardAppendOnly` (boolean, default true) — the record files may only grow.
 * - `sizeLimitMode` (string, default `'warn'`) / `sizeHardRatio` (number, default 1.5) — what
 *   the budgets do at commit time: `'warn'` only reports, `'ratchet'` also refuses a commit
 *   that makes an already-over-cap document bigger.
 * - `clockFooter` (boolean, default true) / `clockFooterThrottleMs` (number, default 600000) —
 *   the current time rides on successful tool results, at most once per interval.
 * - `concurrentWriteMode` (string, default `'both'`) — which shared files the claim guard
 *   protects.
 * All defaults are listed once, in `DEFAULTS` at the top of this file, and mirrored for users in
 * `docs/configuration.md` — the two are compared by `release/check-consistency.mjs`.
 * - `guardLocalGit` (boolean, default true) — refuse shell commands that publish the
 *   repository or destroy local history.
 * - `guardCommitCheckpoint` (boolean, default true) — after a compaction, refuse
 *   `git commit` until a state document has been updated; when the digest can see
 *   commits the documents do not mention, refuse it too.
 * - `guardSecrets` (boolean, default true) — refuse a commit that would record a credential
 *   file **outside the state boundary**; inside it, a local-only repository may hold them.
 * - `guardPrivacyBoundary` (boolean, default true) — refuse a commit whose public files leak
 *   the machine's home path, reach into the state boundary from source, or carry a
 *   high-confidence secret literal outside a configuration file.
 * - `guardConcurrentWrite` (boolean, default true) — refuse to write a shared file another
 *   live session has claimed, and take over a claim whose owner went quiet.
 * - `claimStaleMs` (number, default 600000 = 10 minutes) — how long a claim survives without
 *   its owner touching it; the owner refreshes it by writing, so a killed session's claims
 *   expire by themselves and no turn-end cleanup is needed.
 * - `guardMalformedToolCall` (boolean, default true) — rewrite an empty tool-call id
 *   arriving from the model stream into a synthetic non-empty one. An empty id kills
 *   the session: the V4 writer refuses the matching tool/result, the drain wedges,
 *   and the session file freezes mid-turn forever (7 real deaths, 2026-10-08..12).
 */
export const Config = Object.freeze({
  '~standard': {
    version: 1,
    vendor: 'project-forge',
    /**
     * Validate one row's raw configuration.
     * @param value - raw config from the Loader.
     * @returns the normalized value, or the issues to report.
     */
    validate(value) {
      const issues = collectIssues(value)
      return issues.length > 0 ? { issues } : { value: normalize(value) }
    },
  },
})
