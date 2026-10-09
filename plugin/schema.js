/**
 * Project Forge mode — the plugin's Config schema.
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

/** Default values, applied when a field is absent. */
const DEFAULTS = Object.freeze({
  protocol: true,
  recoveryProcedure: true,
  digest: true,
  digestFiles: Object.freeze(['plan.md', 'todo.md', 'done.md']),
  /**
   * Per-document tail budget, in characters. Each document is read from its **end**: these
   * documents are maintained newest-last, so the tail is the current state, while the head
   * is history that `git log` and the shortest-path section already cover.
   */
  digestTailLimits: Object.freeze({ 'plan.md': 20000, 'todo.md': 10000, 'done.md': 20000 }),
  /** Tail budget for a document the map does not name. */
  digestDefaultTailLimit: 20000,
  repoStateInDigest: true,
  stewardFile: true,
  stewardFilePath: '.agents/steward.md',
  digestMaxBytes: 32768,
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
  guardConcurrentWrite: true,
  /** Which shared files the concurrent-write guard protects. */
  concurrentWriteMode: 'both',
})

/** Field → the JSON type the Loader must supply. */
const TYPES = Object.freeze({
  protocol: 'boolean',
  recoveryProcedure: 'boolean',
  digest: 'boolean',
  digestFiles: 'array',
  digestTailLimits: 'object',
  digestDefaultTailLimit: 'number',
  repoStateInDigest: 'boolean',
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
  guardConcurrentWrite: 'boolean',
  concurrentWriteMode: 'string',
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
    if (expected === 'object') {
      for (const [document, limit] of Object.entries(value)) {
        if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
          issues.push({
            message: `digestTailLimits["${document}"] must be a positive number`,
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
  normalized.digestTailLimits = Object.freeze({ ...normalized.digestTailLimits })
  return Object.freeze(normalized)
}

/**
 * The mode plugin's Config: a Standard Schema over the protocol's fields.
 *
 * Fields:
 * - `protocol` (boolean, default true) — register the steward protocol.
 * - `recoveryProcedure` (boolean, default true) — register the post-compaction procedure.
 * - `digest` (boolean, default true) — inline the living documents into every request.
 * - `digestFiles` (string[], default `['plan.md','todo.md','done.md']`) — inlined in order.
 *   `tortuous.md` is deliberately absent: it is the longest document and the least
 *   frequently needed, so it stays a read-on-demand file.
 * - `digestTailLimits` (object, default `{ 'plan.md': 20000, 'todo.md': 10000,
 *   'done.md': 20000 }`) — **per-document character budget, taken from the document's
 *   end**. A document longer than its budget is inlined as its tail, preceded by a note
 *   saying how much was omitted; the head is history that `git log` already holds.
 * - `digestDefaultTailLimit` (number, default 20000) — tail budget for a document the map
 *   does not name.
 * - `repoStateInDigest` (boolean, default true) — append branch, HEAD and the recent
 *   commit subjects to the digest, so drift between the documents and the repository
 *   is visible without spending a tool call.
 * - `stewardFile` (boolean, default true) — also inline the repository's own rule file,
 *   making the repository self-describing.
 * - `stewardFilePath` (string, default `.agents/steward.md`) — that file's path.
 * - `digestMaxBytes` (number, default 32768) — ceiling for the per-document budgets
 *   combined; it is the backstop that keeps the whole inlined block bounded.
 * - `digestRefreshMs` (number, default 5000) — how often the digest re-reads the files.
 * - `injectOnCompaction` (boolean, default true) — fold one recovery message carrying the
 *   digest into the first step after a compaction.
 * - `recoveryMinTurnStep` (number, default 1) — earliest step of a turn that may carry the
 *   recovery message, which bounds it to one per turn.
 * - `guardLocalGit` (boolean, default true) — refuse shell commands that publish the
 *   repository or destroy local history.
 * - `guardCommitCheckpoint` (boolean, default true) — after a compaction, refuse
 *   `git commit` until a state document has been updated; when the digest can see
 *   commits the documents do not mention, refuse it too.
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
