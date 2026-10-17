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

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { Config } from './config/schema.js';
import { PROTOCOL, RECOVERY } from './protocol/index.js';
import { applyClock } from './clock/index.js';

/** Producer kind stamped on every message this plugin injects. */
import {
  SOURCE_KIND,
  loadRecoveredMarkers,
  rememberRecoveredMarker,
  markerPath,
  runGitOrNothing,
  gitDirtyPath,
  stateDirPath,
  isInsideStateDir,
  resolveStateFile,
  stewardCandidates,
  firstPresent,
  stateDirDisplayPath,
  stewardDisplayPath,
  displayPath,
  agentIdentity,
  claimPath,
  readClaim,
  writeClaim,
  claimFiles,
  claimFresh,
  checkPushGrant,
  GRANT_LINE,
  grantMatches,
  pushTargetUrl,
  CLAIM_STALE_MS,
  readIfPresent,
  stripQuoted,
  safeId,
} from './shared/index.js';

/** Extensions whose files are configuration: the one place outside the boundary that may
 * carry a private value, provided an example file ships beside it for newcomers. */
const CONFIG_EXTENSIONS = Object.freeze([
  '.cfg', '.conf', '.env', '.ini', '.json', '.jsonc', '.properties', '.toml', '.yaml', '.yml',
]);

/** Extensions scanned as source: a reach into the state boundary from one of these is a
 * runtime dependency on unshared material, while prose may legitimately describe the rule. */
const SOURCE_EXTENSIONS = Object.freeze([
  '.c', '.cc', '.cpp', '.cs', '.cjs', '.dart', '.go', '.h', '.java', '.js', '.jsx', '.kt',
  '.mjs', '.php', '.ps1', '.py', '.rb', '.rs', '.sh', '.swift', '.ts', '.tsx', '.vue',
]);

/** Binary artefacts the privacy scan skips: they carry no reviewable text. */
const BINARY_EXTENSIONS = Object.freeze([
  '.7z', '.avif', '.class', '.db', '.dll', '.dylib', '.eot', '.exe', '.gif', '.gz', '.ico',
  '.jar', '.jpeg', '.jpg', '.mov', '.mp3', '.mp4', '.otf', '.pdf', '.png', '.pyc', '.rar',
  '.so', '.sqlite', '.ttf', '.webp', '.woff', '.woff2', '.zip',
]);

/** The privacy scan reads at most this many bytes of one file, and this many files per commit. */
const PRIVACY_SCAN_BYTES = 262144;
const PRIVACY_SCAN_LIMIT = 400;

/** Absolute home directories of a machine, whatever the OS: never a fact a public file needs. */
const HOME_PATH_PATTERNS = Object.freeze([
  [/(^|[^A-Za-z0-9])[A-Za-z]:\/Users\/[^/\s"'`]+/i, 'an absolute Windows user path'],
  [/(^|[^A-Za-z0-9])\/home\/[^/\s"'`]+/, 'an absolute POSIX home path'],
  [/(^|[^A-Za-z0-9])\/Users\/[^/\s"'`]+/, 'an absolute macOS home path'],
  [/(^|[^A-Za-z0-9])\/root(\/|\b)/, 'the root home directory'],
]);

/** High-confidence secret literals: an assignment or a key block, not prose about secrets. */
const SECRET_LITERAL_PATTERNS = Object.freeze([
  /\b(?:api[_-]?key|apikey|access[_-]?key|secret|token|password|passwd|passphrase|private[_-]?key)\b\s*[:=]\s*["'`][A-Za-z0-9_\-+/=]{16,}["'`]/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]);

/**
 * A file carrying this marker is exempt from the privacy scan: the mode's own sources and
 * fixtures must be able to show what the guard refuses. An exemption is visible in the file
 * and in the diff, which is the point — this guard is anti-slip, not a security boundary.
 */
const PRIVACY_ALLOW_MARKER = 'privacy-guard: allow';

/** Extensions and names that mark a root file as a kind of artifact. */
const KIND_BY_EXTENSION = Object.freeze({
  '.py': 'source', '.js': 'source', '.mjs': 'source', '.cjs': 'source', '.ts': 'source',
  '.go': 'source', '.rs': 'source', '.java': 'source', '.rb': 'source', '.php': 'source',
  '.c': 'source', '.h': 'source', '.cc': 'source', '.cpp': 'source', '.cs': 'source',
  '.sh': 'script', '.ps1': 'script', '.bash': 'script', '.zsh': 'script', '.bat': 'script', '.cmd': 'script',
  '.service': 'deploy', '.timer': 'deploy', '.socket': 'deploy', '.target': 'deploy',
  '.yaml': 'config', '.yml': 'config', '.toml': 'config', '.ini': 'config',
});

/**
 * Facts about one repository tree, deliberately mechanical: a guard may act only on what it
 * can decide, and "is this directory well named" is not decidable here.
 * @param cwd - the session's working directory.
 * @param documents - file names that count as maintained documents, not artifacts.
 * @returns the facts, or `undefined` when the directory cannot be read.
 */
function readTreeFacts(cwd, documents) {
  let entries;
  try {
    entries = readdirSync(cwd, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const documentNames = new Set([
    ...documents.map((name) => name.toLowerCase()),
    // The protocol's own state files are state whatever `digestFiles` holds; the two
    // append-only records in particular are normally not inlined, and counting them as
    // artifacts would inflate the root on every project that has them.
    'done.md',
    'todo.md',
    'plan.md',
    'journal.jsonl',
    'tortuous.jsonl',
  ]);
  const rootFiles = [];
  const kinds = new Set();
  const topLevel = [];
  const directories = [];
  for (const entry of entries) {
    const name = entry.name;
    if (name === '.git') continue;
    topLevel.push(name);
    if (entry.isDirectory()) {
      directories.push(name);
      continue;
    }
    const lower = name.toLowerCase();
    if (documentNames.has(lower) || lower === 'readme.md' || lower === '.gitignore') continue;
    rootFiles.push(name);
    const extension = lower.slice(lower.lastIndexOf('.'));
    const kind = KIND_BY_EXTENSION[extension];
    if (kind !== undefined) kinds.add(kind);
  }
  // A root that has become a shelf for several kinds of artifact is the mechanical proxy for
  // §7.6 ("different kinds of artifact never share a shelf"). One kind may be a deliberate
  // flat layout; three kinds rarely is.
  const flagged = kinds.size >= 2 || rootFiles.length > 8;
  return { rootFiles, kinds: [...kinds], topLevel: topLevel.sort(), directories: directories.sort(), flagged };
}

/**
 * Whether the maintained documents acknowledge the tree the guard measured.
 *
 * Acknowledging means one of exactly two things is written down, both of which require
 * having looked at the tree:
 * - a **directory** name from the tree — the walk named what a place holds; or
 * - an explicit statement that the flat layout is deliberate ("保持扁平", "kept flat").
 *
 * A bare file name is deliberately **not** accepted: state documents mention file names
 * incidentally all the time, so accepting one would let the guard pass on a lucky string
 * rather than on a real walk. A root with no subdirectory at all is the case that must
 * still be acknowledged — by saying the flat layout is a decision.
 * @param documents - every maintained document's text, lowercased.
 * @param facts - the tree facts the guard just measured.
 * @returns whether the layout was acknowledged.
 */
function acknowledgesLayout(documents, facts) {
  if (documents.length === 0) return false;
  if (/保持扁平|kept? flat|deliberately flat|flat by (?:choice|design)/.test(documents)) return true;
  if (facts.directories.length === 0) return false;
  return facts.directories.some((name) => name.length >= 2 && documents.includes(name.toLowerCase()));
}

/**
 * The files a commit is about to publish: what the index holds, plus what the working tree
 * has changed or added (which is what covers `git commit -am`). Files inside the state
 * boundary are not the public surface and are left out here.
 * @param cwd - the repository root.
 * @param config - the validated row config.
 * @returns repository-relative candidate paths, capped.
 */
function publicSurfaceCandidates(cwd, config) {
  const listed = new Set();
  const staged = runGitOrNothing(cwd, ['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
  for (const line of (staged ?? '').split('\n')) {
    const path = line.trim();
    if (path.length > 0) listed.add(path);
  }
  const status = runGitOrNothing(cwd, ['status', '--porcelain', '--untracked-files=all']);
  for (const line of (status ?? '').split('\n')) {
    if (line.length < 4) continue;
    let path = line.slice(3).trim();
    // `R  old -> new`: the path that will be published is the new one.
    const arrow = path.indexOf(' -> ');
    if (arrow !== -1) path = path.slice(arrow + 4);
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1).replace(/\\"/g, '"');
    if (path.length > 0) listed.add(path);
  }
  return [...listed].filter((path) => !isInsideStateDir(cwd, config, path)).slice(0, PRIVACY_SCAN_LIMIT);
}

/**
 * Decide what one public file leaks. Three things are decidable without judgement:
 * - a home directory of the machine that wrote it (never a fact a public file needs);
 * - a **source** file reaching into the state boundary, which is a dependency on material
 *   the published tree will not contain (prose may describe the rule, so only source counts);
 * - a high-confidence secret literal outside a configuration file, which is the one place
 *   the open-source rule allows a private value — with an example file beside it.
 * A file carrying `PRIVACY_ALLOW_MARKER` is exempt, so the mode's own sources and fixtures
 * can demonstrate what the guard refuses.
 * @param cwd - the repository root.
 * @param config - the validated row config.
 * @param relPath - the candidate's repository-relative path.
 * @returns the reasons this file is refused, empty when it is clean.
 */
function privacyFindings(cwd, config, relPath) {
  const lower = relPath.toLowerCase();
  const extension = lower.slice(lower.lastIndexOf('.'));
  if (BINARY_EXTENSIONS.includes(extension)) return [];
  let text;
  try {
    text = readFileSync(join(cwd, relPath), 'utf8');
  } catch {
    return [];
  }
  if (text.length > PRIVACY_SCAN_BYTES || text.includes('\u0000')) return [];
  if (text.includes(PRIVACY_ALLOW_MARKER)) return [];
  const normalised = text.replace(/\\/g, '/');
  const reasons = [];

  if (HOME_PATH_PATTERNS.some(([pattern]) => pattern.test(normalised))) {
    reasons.push('a home directory of the machine it was written on');
  }

  if (SOURCE_EXTENSIONS.includes(extension)) {
    const boundary = (config.stateDir ?? 'private').replace(/\\/g, '/').replace(/^\.\//, '');
    if (boundary !== '.' && boundary.length > 0) {
      const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const reach = new RegExp(`(^|[^A-Za-z0-9_.-])${escaped}/[A-Za-z0-9._-]`, 'i');
      if (reach.test(normalised)) reasons.push(`a path into the state boundary (\`${boundary}/\`)`);
    }
  }

  if (!CONFIG_EXTENSIONS.includes(extension)
    && SECRET_LITERAL_PATTERNS.some((pattern) => pattern.test(text))) {
    reasons.push('a secret-looking literal outside a configuration file');
  }
  return reasons;
}

/**
 * Run the privacy scan over the public surface a commit is about to publish.
 * @param cwd - the repository root.
 * @param config - the validated row config.
 * @returns one entry per offending file, `{ path, reasons }`.
 */
function scanPublicSurface(cwd, config) {
  const findings = [];
  for (const path of publicSurfaceCandidates(cwd, config)) {
    const reasons = privacyFindings(cwd, config, path);
    if (reasons.length > 0) findings.push({ path, reasons });
  }
  return findings;
}


/** Cordis plugin name. */
export const name = 'project-forge';

/** The registries this row contributes to: prompts and the tool pipeline. */
export const inject = ['systemPrompt', 'tools'];

export { Config };


/** Heading of the inlined project-memory block. */
const DIGEST_HEADING = '## Project memory (maintained documents)';

/** Heading of the inlined repository-state block. */
const REPO_HEADING = '## Repository state (read from .git)';

/**
 * Heading of the in-flight block: who is editing what right now, rendered from the claim set
 * rather than written down by hand. A hand-kept list would be stale exactly when it matters,
 * because the session that should have cleaned it up is the one that was killed.
 */
const IN_FLIGHT_HEADING = '## 在办认领（谁正在改什么）';

/** Trailing note the digest carries about the one document it omits. */
const BUDGET_HEADING = '## ⚠ 超出预算（不截断，只提示）';

/**
 * Render the in-flight block: every live claim in this project plus the takeovers this session
 * just performed. Expired claims are left out — the guard deletes them when it next touches the
 * same file, and listing them would suggest a conflict that no longer exists.
 *
 * This is a view, not a document: it is derived from the claim set on every render, so it
 * cannot go stale and nobody has to remember to clean it up.
 * @param cwd - the project root.
 * @param config - the validated row config.
 * @param selfId - the session reading this digest, so its own claims are marked as such.
 * @param takeovers - takeovers this session performed, `{ path, owner, at }`.
 * @returns the rendered lines, or undefined when nothing is in flight.
 */
function renderInFlight(cwd, config, selfId, takeovers) {
  const now = Date.now();
  const lines = [];
  for (const claimFile of claimFiles(cwd, config)) {
    let claim;
    try {
      claim = JSON.parse(readFileSync(claimFile, 'utf8'));
    } catch {
      continue;
    }
    if (!claimFresh(claim, config)) continue;
    const rel = typeof claim.path === 'string' && claim.path.length > 0
      ? claim.path
      : basename(claimFile).replace(/\.json$/, '');
    const idleMinutes = Math.max(0, Math.round((now - claim.time) / 60000));
    const mine = selfId !== undefined && String(claim.owner) === String(selfId);
    lines.push(`- \`${rel}\` ← 会话 ${shortId(claim.owner)}${mine ? '（本会话）' : ''}，静默 ${idleMinutes} 分钟`);
  }
  for (const takeover of takeovers ?? []) {
    lines.push(
      `- 已接手 \`${takeover.path}\`：原属会话 ${shortId(takeover.owner)} 的认领已过期——动手前先重读该文件`,
    );
  }
  return lines.length === 0 ? undefined : lines.join('\n');
}

/**
 * Read one file synchronously; undefined when it is absent or unreadable.
 * @param absolute - resolved path.
 * @returns the file text, or undefined.
 */

/**
 * Parse an append-only JSONL file into its records, skipping malformed lines.
 *
 * Records are one per line by construction (`\n` inside a record is escaped), so a line that
 * does not parse is a damaged record, not a multi-line value: dropping it keeps the index
 * usable instead of losing the whole file to one bad write.
 * @param absolute - resolved path.
 * @returns the parsed records, or an empty array when the file is absent or empty.
 */
function readJsonlRecords(absolute) {
  const text = readIfPresent(absolute);
  if (text === undefined) return [];
  const records = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') records.push(parsed);
    } catch {
      // A torn line at the tail of an append-only file is expected after a killed write.
    }
  }
  return records;
}

/**
 * Describe one negative-knowledge record in a single line.
 *
 * The record carries its kind at the front (there are no sections in an append-only file), so
 * the index can say what sort of thing each entry is without reading the prose.
 * @param record - one parsed record.
 * @returns the index line, or undefined when the record has no usable identity.
 */
function tortuousIndexLine(record) {
  const id = typeof record.id === 'string' ? record.id : undefined;
  if (id === undefined) return undefined;
  const kind = record.kind === 'deviation' ? '偏差' : '失败路线';
  const headline = typeof record.conclusion === 'string' && record.conclusion.length > 0
    ? record.conclusion
    : typeof record.title === 'string' ? record.title : '';
  return `- ${id}（${kind}）${headline}`;
}

/**
 * Render the negative-knowledge index: one line per record, newest last.
 *
 * Never inlined in full — the file grows without bound — but an index is what makes the
 * negative knowledge discoverable at all: without it a model has no reason to read the file.
 * @param cwd - the project root.
 * @param config - the normalized configuration.
 * @returns the index text, or undefined when there is nothing to index.
 */
function renderTortuousIndex(cwd, config) {
  const absolute = resolveStateFile(cwd, config, config.tortuousFile).absolute;
  const lines = readJsonlRecords(absolute)
    .map(tortuousIndexLine)
    .filter((line) => line !== undefined);
  if (lines.length === 0) return undefined;
  // Keep the newest entries: the budget is spent where the risk of repeating a mistake is.
  const kept = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (used + line.length + 1 > config.tortuousIndexBytes) break;
    used += line.length + 1;
    kept.unshift(line);
  }
  const omitted = lines.length - kept.length;
  if (omitted > 0) kept.unshift(`- （更早的 ${omitted} 条未内联；要查就读文件）`);
  return kept.join('\n');
}

/**
 * Render the tail of the append-only journal — used by the recovery message only.
 *
 * The journal is a record, not a constraint: it is not worth a per-request budget, but a
 * session that just lost its context does need to know what happened immediately before.
 * @param cwd - the project root.
 * @param config - the normalized configuration.
 * @returns the rendered tail, or undefined when the journal is empty or absent.
 */
function renderJournalTail(cwd, config) {
  const absolute = resolveStateFile(cwd, config, config.journalFile).absolute;
  const records = readJsonlRecords(absolute);
  if (records.length === 0) return undefined;
  const tail = records.slice(-Math.max(1, config.journalRecoveryEntries));
  const lines = tail.map((record) => {
    const when = typeof record.at === 'string' ? `${record.at} ` : '';
    const headline = typeof record.summary === 'string' ? record.summary : JSON.stringify(record);
    return `- ${when}${headline}`;
  });
  return lines.join('\n');
}

/** Name the files that stay read-on-demand, so their existence is never a surprise. */
function renderReadOnDemand(cwd, config) {
  const name = (relative) => `\`${displayPath(cwd, resolveStateFile(cwd, config, relative).absolute)}\``;
  return `按需读（不内联）：${name(config.tortuousFile)}（负知识：失败路线与偏差）、`
    + `${name(config.journalFile)}（工作记录）、\`${displayPath(cwd, resolveStateFile(cwd, config, 'rationale').absolute)}/\`（推导与取证）。`;
}



/**
 * The shell command a tool call carries, if any.
 *
 * Every guard used to open with a check on the tool NAME (pwsh/bash), so a shell command wrapped
 * in another tool — an MCP tool whose arguments carry a "command" field, say — was never
 * inspected. Any tool's command/cmd argument is inspected now; stripQuoted still removes quoted
 * spans, so prose that merely mentions a command does not deny the call.
 * @param execution - the read-only tool execution handed to a guard.
 * @returns the command string, or undefined when this call carries none.
 */
function shellCommandOf(execution) {
  const args = execution.arguments;
  if (args === null || typeof args !== "object") return undefined;
  const candidate = args.command ?? args.cmd;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}


/**
 * Decide whether one shell command escapes the local-only git contract.
 * @param command - the command line handed to a shell tool.
 * @returns the offending label and fragment, or undefined when acceptable.
 */
function localGitEscape(command) {
  if (typeof command !== 'string' || command.length === 0) return undefined;
  const bare = stripQuoted(command);
  const escapes = [
    [/\bgit\s+push\b/, 'git push'],
    [/\bgit\s+remote\s+(?:add|set-url)\b/, 'git remote add/set-url'],
    [/\bgit\s+reset\s+--hard\b/, 'git reset --hard'],
    [/\bgit\s+clean\s+-[a-z]*f/, 'git clean -f'],
    [/\bgit\s+branch\s+-D\b/, 'git branch -D'],
  ];
  for (const [pattern, label] of escapes) {
    const match = pattern.exec(bare);
    if (match !== null) return { label, fragment: match[0] };
  }
  return undefined;
}

/**
 * Decide whether one shell command is a commit that the checkpoint protocol governs.
 * @param command - the command line handed to a shell tool.
 * @returns true when the command commits.
 */
function isCommitCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return false;
  return /\bgit\s+commit\b/.test(stripQuoted(command));
}

/**
 * Resolve a git directory from a working directory, following a \`.git\` file
 * (a worktree or submodule pointer) when present.
 * @param cwd - the session's working directory.
 * @returns the git directory path, or undefined when there is none.
 */
function gitDirOf(cwd) {
  const dotGit = join(cwd, '.git');
  const asFile = readIfPresent(dotGit);
  if (asFile !== undefined) {
    const match = /^gitdir:\s*(.+)$/m.exec(asFile);
    if (match === null) return undefined;
    const target = match[1].trim();
    return isAbsolute(target) ? target : join(cwd, target);
  }
  // A directory: probe a file that only a repository has.
  return readIfPresent(join(dotGit, 'HEAD')) === undefined ? undefined : dotGit;
}

/**
 * Read the repository state that the digest renders: current branch, HEAD commit and
 * the most recent commit subjects. Read straight from \`.git\` so it is synchronous and
 * needs no subprocess.
 * @param cwd - the session's working directory.
 * @param limit - how many recent commits to report.
 * @returns rendered lines, or undefined when the directory is not a repository.
 */
function readRepoState(cwd, limit = 8) {
  const gitDir = gitDirOf(cwd);
  if (gitDir === undefined) return undefined;
  const lines = [];

  const head = readIfPresent(join(gitDir, 'HEAD'));
  let branch;
  let headHash;
  if (head !== undefined) {
    const trimmed = head.trim();
    const ref = /^ref:\s*(.+)$/.exec(trimmed);
    if (ref !== null) {
      branch = ref[1].replace(/^refs\/heads\//, '');
      const refValue = readIfPresent(join(gitDir, ref[1].trim()));
      if (refValue !== undefined) headHash = refValue.trim().slice(0, 12);
    } else {
      branch = '(detached)';
      headHash = trimmed.slice(0, 12);
    }
  }
  if (branch !== undefined) lines.push(`branch: ${branch}`);
  if (headHash !== undefined) lines.push(`HEAD: ${headHash}`);

  const log = readIfPresent(join(gitDir, 'logs', 'HEAD'));
  if (log !== undefined) {
    const entries = log.split('\n').filter((line) => line.length > 0).slice(-limit);
    if (entries.length > 0) {
      lines.push('recent commits (newest last):');
      for (const entry of entries) {
        // <old> <new> <name> <email> <ts> <tz>\t<message>
        const tab = entry.indexOf('\t');
        const meta = tab === -1 ? entry : entry.slice(0, tab);
        // Git prefixes the first amend/rebase entries: drop that bookkeeping so the
        // subject stays readable in the digest.
        const message = (tab === -1 ? '' : entry.slice(tab + 1).split('\n')[0])
          .replace(/^commit(\s+\([^)]*\))?:\s*/, '');
        const hash = meta.split(' ')[1] ?? '?';
        lines.push(`- ${hash.slice(0, 8)} ${message.slice(0, 100)}`);
      }
    }
  }
  if (lines.length === 0) return undefined;
  return lines.join('\n');
}

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
      return;
    }

    const blocks = [DIGEST_HEADING, '', parts.join('\n\n')];
    const documentText = parts.join('\n').toLowerCase();
    if (config.repoStateInDigest !== false) {
      const repo = readRepoState(cwd, config.repoCommitWindow);
      if (repo !== undefined) {
        blocks.push('', REPO_HEADING, '', repo);
        state.repoLog = repo;
        state.repoHead = /HEAD: (\S+)/.exec(repo)?.[1];
        // Drift signal, computed from what is in front of the model: newer commits that
        // none of the documents mention. A commit older than one the documents do cite
        // counts as covered, so the signal stays strict and does not nag forever.
        const hashes = [...repo.matchAll(/^- ([0-9a-f]{7,12}) /gm)].map((match) => match[1]);
        const newestCited = hashes.findIndex((hash) => documentText.includes(hash));
        state.unrecordedCommits = newestCited === -1
          ? hashes.length > 0 && state.docSinceCompaction !== true
          : hashes.slice(0, newestCited).length > 0;
      } else {
        state.repoHead = undefined;
        state.unrecordedCommits = false;
      }
    }
    // Who is editing what, derived from the live claim set. Parallel sessions read this
    // instead of maintaining a shared "in progress" list that a killed session cannot clean.
    const inFlight = renderInFlight(cwd, config, state.agent?.id, state.takeovers);
    if (inFlight !== undefined) blocks.push('', IN_FLIGHT_HEADING, '', inFlight);
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
    // `systemPrompt.context()` entries are ALWAYS run through dsh-system-prompt's
    // strict `{{variable}}` interpolator — the `interpolate: false` option is only
    // honored on sections, and a document quoting Vue/mustache braces (e.g. a
    // forensics report quoting `{{playCount|formatPlayCount}}`) otherwise throws
    // `malformed prompt variable reference` during prompt assembly and kills every
    // turn while the text stays in the digest (dc6b5fa7 10-03, 4ddb3937 10-13).
    // Breaking every `{{` into `{ {` makes the whole text uninterpolatable; the
    // model reads the file when it needs the exact spelling (the note above says so).
    state.text = blocks.join('\n').replaceAll('{{', '{ {');
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

  // ── Guard A: the local-only git contract ──────────────────────────────────────
  // A guard is monotonic — no listener ordering can turn a denial back into permission —
  // and it runs before the shell body, which is the only point at which a refused
  // command is guaranteed not to have executed.
  //
  // Publishing is local-only by default, and authorization is a CONSUMABLE grant, never a
  // standing permission (§1.2): the user writes `push allowed: <remote-glob> [×N]` into the
  // repository's steward rules (`private/steward.md`); each guarded `git push` consumes one
  // grant — ×1 deletes the line, ×N counts down — and the repository returns to local-only the
  // moment the grants run out. One user consent cannot silently become "push forever".
  if (config.guardLocalGit !== false && ctx.tools !== undefined) {
    ctx.effect(
      () =>
        ctx.tools.guard((execution) => {
          const command = shellCommandOf(execution);
          if (command === undefined) return undefined;
          const escape = localGitEscape(command);
          if (escape === undefined) return undefined;
          // A forced push rewrites published history: grants never cover it.
          if (escape.label === 'git push' && /\bgit\s+push\b[^|&]*(\s-f\b|--force\b|--force-with-lease)/.test(stripQuoted(command))) {
            return [
              '项目锻造模式拒绝这次 `git push`：强推会重写已发布的历史，',
              '任何一次性授权都不覆盖它。确需如此，由用户显式关闭 `guardLocalGit`。',
            ].join(' ');
          }
          // `git push` consumes a one-shot grant from the repository\'s own steward rules.
          if (escape.label === 'git push') {
            const cwd = execution.agent?.session?.header?.cwd;
            const granted = typeof cwd === 'string' && checkPushGrant(cwd, config, command) === true;
            if (granted) return undefined; // grant consumed — this push, and only this push, proceeds
            return [
              '项目锻造模式拒绝 `git push`：本仓库仅本地，没有任何一次性授权覆盖这次推送。',
              '要授权恰好一次推送，请在仓库自带规则里加一行（只有用户明确要求发布时才这么做）：',
              `规则文件：\`${stewardDisplayPath(config)}\`，`,
              '写法如下：',
              '`push allowed: <remote-url-or-glob> [×N]` —— 每次受守卫的推送消耗一次授权，',
              '用尽后仓库立即回到仅本地。重写历史的操作',
              '永远不在授权范围内。',
            ].join(' ');
          }
          return [
            `项目锻造模式拒绝 \`${escape.label}\`：本仓库仅本地。`,
            '用户没有授权发布，也没有授权重写历史。',
            '请改用本地检查点提交；如果用户在后续消息里明确要求发布，',
            '必须由用户自己解除这条守卫。',
          ].join(' ');
        }),
      'project-forge.localGitGuard()',
    );
  }

  // ── Guard C: the layout checkpoint (§5.5 / §7.1) ─────────────────────────────
  // The layout rules are prose, and prose cannot fail — so the one part of them that is
  // mechanically decidable is enforced at the only moment that matters: the commit. The
  // probe reports facts about the tree (a root that has become a shelf for several kinds of
  // artifact, the shape of the top level); the guard refuses the commit while those facts
  // are unacknowledged by the state documents. Whether a directory is *well named* is a
  // judgement no guard can make, and this guard does not pretend to.
  if (config.guardLayoutCheckpoint !== false && ctx.tools !== undefined) {
    ctx.effect(
      () =>
        ctx.tools.guard((execution) => {
          const command = shellCommandOf(execution);
          if (!isCommitCommand(command)) return undefined;
          const agent = execution.agent;
          if (agent === undefined) return undefined;
          const state = states.get(agent.id);
          if (state === undefined) return undefined;
          const cwd = agent.session?.header?.cwd;
          if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
          const facts = readTreeFacts(cwd, config.digestFiles);
          if (facts === undefined || facts.flagged !== true) return undefined;
          // The acknowledgement may live in any maintained document: the digest is what the
          // model sees, so requiring it in the commit itself is what makes the walk real.
          const documents = config.digestFiles
            .map((document) => readIfPresent(resolveStateFile(cwd, config, document).absolute) ?? '')
            .join('\n')
            .toLowerCase();
          if (acknowledgesLayout(documents, facts)) return undefined;
          return [
            '项目锻造模式拒绝 `git commit`：这个仓库的布局还没有被检查过。',
            `项目根现有 ${facts.rootFiles.length} 个非文档文件（${facts.kinds.length} 类`
              + `：${facts.kinds.join(', ')}）与 ${facts.directories.length} 个目录`
              + `（顶层：${facts.topLevel.slice(0, 8).join(', ')}${facts.topLevel.length > 8 ? ', …' : ''}）。`,
            '按 §5.5 走查这棵树，把结论记进 `done.md`：每个目录装什么、新文件该放哪、',
            '你的结论是什么。只写文件名不算——要点名一个目录，或者显式说明',
            '扁平布局是一个决定（「保持扁平」/ "kept flat: <why>"）——然后再提交。',
          ].join(' ');
        }),
      'project-forge.layoutCheckpointGuard()',
    );
  }

  // The clock footer (D30) lives in its own slice: ./clock/index.js.
  applyClock(ctx, config);

  // ── Guard: append-only records ───────────────────────────────────────────────
  // `journal.jsonl` and `tortuous.jsonl` are read as "one record per line, appended only"
  // (§4.0.2). A write that does not keep the previous text as a prefix breaks that promise:
  // the index derived from those lines would silently lose entries. Comparing raw strings is
  // enough — no JSON parsing, so even a half-written record cannot slip through.
  if (config.guardAppendOnly !== false && ctx.tools !== undefined) {
    const records = [config.journalFile, config.tortuousFile].map((name) => name.toLowerCase());
    ctx.effect(
      () =>
        ctx.tools.guard((execution) => {
          if (execution.name !== 'write') return undefined;
          const path = execution.arguments?.file_path;
          const content = execution.arguments?.content;
          if (typeof path !== 'string' || typeof content !== 'string') return undefined;
          const normalized = path.replace(/\\/g, '/').toLowerCase();
          if (!records.some((name) => normalized === name || normalized.endsWith(`/${name}`))) return undefined;
          const before = readIfPresent(path);
          if (before === undefined || before.length === 0) return undefined;
          if (content.startsWith(before)) return undefined;
          return [
            `项目锻造模式拒绝这次写入：\`${path}\` 是只追加的记录文件。`,
            '它的每一行都被当作一条记录读，digest 的索引也由它们派生，所以',
            '不保留磁盘上已有文本作为前缀的写入会静默丢记录。',
            '请先写回原有内容、再追加新记录（或直接追加到文件末尾），然后重试。',
          ].join(' ');
        }),
      'project-forge.appendOnlyGuard()',
    );
  }

  // ── Guard: size ratchet (opt-in) ─────────────────────────────────────────────
  // Budgets are warning lines by default: the digest prints "⚠ 超出预算 <file> a/b" and nothing
  // blocks (§4.0.1). Under `sizeLimitMode: 'ratchet'` a commit is additionally refused when it
  // makes an **already-over-hard-cap** contract document bigger. Shrinking, splitting and moving
  // always pass — an absolute threshold would refuse the very commit that starts the slimming,
  // which is how a file gets frozen at its over-budget size.
  if (config.sizeLimitMode === 'ratchet' && ctx.tools !== undefined) {
    ctx.effect(
      () =>
        ctx.tools.guard((execution) => {
          const command = shellCommandOf(execution);
          if (!isCommitCommand(command)) return undefined;
          const cwd = execution.agent?.session?.header?.cwd;
          if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
          const offenders = [];
          for (const document of config.digestFiles) {
            const resolved = resolveStateFile(cwd, config, document);
            const after = readIfPresent(resolved.absolute);
            if (after === undefined) continue;
            const budget = typeof config.documentBudgets?.[document] === 'number'
              ? config.documentBudgets[document]
              : config.documentBudgetDefault;
            const hardCap = Math.round(budget * config.sizeHardRatio);
            if (after.length <= hardCap) continue;
            const label = displayPath(cwd, resolved.absolute);
            let before;
            try {
              before = execFileSync('git', ['-C', cwd, 'show', `HEAD:${label}`], { encoding: 'utf8' }).length;
            } catch {
              continue; // Nothing committed yet: there is no previous size to compare against.
            }
            if (after.length > before) offenders.push(`${label} ${before} → ${after.length}（硬上限 ${hardCap}）`);
          }
          if (offenders.length === 0) return undefined;
          return [
            '项目锻造模式拒绝 `git commit`：有合同文档已越过硬上限，而这次提交让它更大 —— ',
            `${offenders.join('；')}。`,
            `预算是 ${JSON.stringify(config.documentBudgets)} 字符；硬上限是`
              + `预算的 ${config.sizeHardRatio} 倍。瘦身、拆分、把内容搬走永远都能通过。`,
            '把最旧或最细的内容搬进记录文件或 `rationale/`，正文只留',
            '现在还生效的东西，然后再提交。',
          ].join(' ');
        }),
      'project-forge.sizeRatchetGuard()',
    );
  }

  // ── Guard B: the checkpoint protocol ─────────────────────────────────────────
  // A checkpoint is a commit of a consistent state, so two situations refuse it: the
  // session was compacted and no state document has been touched since, or the digest
  // can see commits the documents do not mention.
  if (config.guardCommitCheckpoint !== false && ctx.tools !== undefined) {
    ctx.on('tools/result', (execution, result) => {
      if (result.isError) return;
      if (execution.name !== 'write' && execution.name !== 'edit') return;
      const path = execution.arguments?.file_path;
      const agent = execution.agent;
      if (typeof path !== 'string' || path.length === 0 || agent === undefined) return;
      const normalized = path.replace(/\\/g, '/').toLowerCase();
      const state = states.get(agent.id);
      if (state === undefined) return;
      state.touchedDocs.add(normalized);
      if (config.digestFiles.some(
        (document) => normalized === document.toLowerCase() || normalized.endsWith(`/${document.toLowerCase()}`),
      )) {
        state.docSinceCompaction = true;
        // Any document write closes the post-compaction window for the checkpoint guard.
        state.compacted = false;
        // The drift was written down; the next refresh will re-read the documents.
        state.unrecordedCommits = false;
      }
    });

    ctx.effect(
      () =>
        ctx.tools.guard((execution) => {
          const command = shellCommandOf(execution);
          if (!isCommitCommand(command)) return undefined;
          const agent = execution.agent;
          if (agent === undefined) return undefined;
          const state = states.get(agent.id);
          if (state === undefined) return undefined;
          if (state.docSinceCompaction) return undefined;
          // `compacted` is set by the real `compaction/end` event; it is not inferred from
          // the surface generation, which also changes for pruning and spill.
          const stale = state.compacted === true || state.unrecordedCommits;
          if (!stale) return undefined;
          return [
            '项目锻造模式拒绝这次 `git commit`：这不是一个一致状态的检查点。',
            state.compacted === true
              ? '本会话被压缩过，此后没有任何合同文档被更新。'
              : '仓库里有状态文档没有提到的提交。',
            '更新 `private/done.md`（以及随之变化的 `private/todo.md` / `private/plan.md`）：记下当前状态，',
            '与 `git status`、`git log` 对账，把不符之处写进 Drift 一节，然后再提交。',
            '两点容易踩：**这条拒绝作用于整条命令**——把改文件与提交写在同一条 shell 调用里时，改文件根本不会执行，',
            '请把提交单独发一条；**只有用 write/edit 工具改合同文档才算数**，用脚本改文件不算。',
          ].join(' ');
        }),
      'project-forge.commitCheckpointGuard()',
    );
  }

  // ── Guard D: no secrets into the repository ────────────────────────────────────
  // A commit that lands a secret is the one mistake `git log` cannot undo: the value is
  // in history forever, even after a later "remove" commit. The guard therefore refuses
  // the *stage-and-commit* itself when the tracked-file set includes a path that exists
  // only to hold credentials. This is the one secret class that is decidable from the
  // file name alone; a key *inside* an ordinary source file is not decidable and is
  // covered by the protocol, not this guard.
  if (config.guardSecrets !== false && ctx.tools !== undefined) {
    ctx.effect(
      () =>
        ctx.tools.guard((execution) => {
          const command = shellCommandOf(execution);
          if (!isCommitCommand(command)) return undefined;
          const agent = execution.agent;
          if (agent === undefined) return undefined;
          const cwd = agent.session?.header?.cwd;
          if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
          // A tracked file that exists only to hold credentials. `.env` is matched with a
          // boundary so legitimate names like `dev.env.sample` are not flagged. Files inside
          // the state boundary are exempt: that directory is the local-only side of the
          // project, and the open-source rule (protocol §1.7) governs what may sit outside it.
          const tracked = runGitOrNothing(cwd, ['ls-files']);
          if (tracked === undefined) return undefined;
          const trackedFiles = tracked.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
          const envPattern = /(^|\/)\.env(\.|$)/;
          const offending = trackedFiles.filter(
            (path) =>
              !isInsideStateDir(cwd, config, path)
              && (envPattern.test(path)
                || /\.(pem|key|p12|pfx)$/i.test(path)
                || /(^|\/)(credentials|secrets?)(\/|\.|$)/i.test(path)),
          );
          if (offending.length === 0) return undefined;
          return [
            '项目锻造模式拒绝 `git commit`：这次提交会把凭据文件记进公开面。',
            `状态边界之外、只为存放密钥而存在的受跟踪文件：${offending.slice(0, 5).join(', ')}${offending.length > 5 ? ` 等共 ${offending.length} 个` : ''}。`,
            '提交进历史的密钥会永远留在 `git log` 里 —— 事后删除并不能抹掉历史。',
            `把它放进 \`${stateDirDisplayPath(config)}/\`（本仓库仅本地的那一侧），或者`,
            '把值移到未跟踪、已 gitignore 的文件里。提交前先从历史里清除它',
            '（`git rm --cached` 加 filter 或 BFG）。见协议 §1.6 与 §1.7。',
          ].join(' ');
        }),
      'project-forge.secretsGuard()',
    );
  }

  // ── Guard E: the public surface stays open-source-ready (§1.7) ─────────────────
  // The boundary rule has one decidable core: a commit must not put machine-private material
  // into the files that leave with the project, because the export step is "delete the state
  // boundary, copy, `git init`" — whatever is outside it is published as-is. What is decidable
  // without judgement is a home directory of this machine, a source file reaching into the
  // boundary, and a high-confidence secret literal outside a configuration file. Whether
  // prose "reads public" is a judgement, and this guard does not pretend to make it.
  if (config.guardPrivacyBoundary !== false && ctx.tools !== undefined) {
    ctx.effect(
      () =>
        ctx.tools.guard((execution) => {
          const command = shellCommandOf(execution);
          if (!isCommitCommand(command)) return undefined;
          const cwd = execution.agent?.session?.header?.cwd;
          if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
          const findings = scanPublicSurface(cwd, config);
          if (findings.length === 0) return undefined;
          const shown = findings.slice(0, 4)
            .map((finding) => `\`${finding.path}\` (${finding.reasons.join('; ')})`)
            .join(', ');
          return [
            '项目锻造模式拒绝 `git commit`：公开面还不是开源就绪的样子。',
            `涉及的文件：${shown}${findings.length > 4 ? ` 等共 ${findings.length} 个` : ''}。`,
            `\`${stateDirDisplayPath(config)}/\` 之外的一切都按“项目已经公开”来写：`,
            '不出现本机家目录、源码不伸手进状态边界、配置文件之外',
            '不出现高置信的密钥字面量（带真实值的配置文件要随附一份示例孪生',
            '给新同事）。请把这个值搬进边界、抽象进配置文件并附上示例，',
            '或者——对于整份文件就是为了演示这条边界的——给它打上',
            `\`${PRIVACY_ALLOW_MARKER}\` 标记。见协议 §1.7。`,
          ].join(' ');
        }),
      'project-forge.privacyBoundaryGuard()',
    );
  }

  // ── Guard F: concurrent-write interception (per-file claims) ───────────────────
  // On 2026-10-07 three main agents really did work one project in parallel, and the
  // shared state documents (done/plan/todo/tortuous) were each written by two of them;
  // narrative documents cannot be merged, so the second writer silently overwrote the
  // first. This guard closes that window with a per-file claim stored on disk, so it is
  // shared across every session on the same project root.
  //
  // Semantics: writing a shared file requires claiming it. The first session to claim a
  // file may write it; the claim is released when the file is committed or the owning
  // process dies. A second session is refused while a live claim by another agent holds,
  // and takes over a stale (dead-owner) claim. §12.1's single-document-owner rule keeps
  // most parallel agents off these files entirely; this guard is the hard backstop.
  if (config.guardConcurrentWrite !== false && ctx.tools !== undefined) {
    // A successful commit releases every claim in this project: the work has landed, so no
    // file is mid-edit any more. Without this, claims from a crashed or finished session
    // sat on disk until the 30-minute staleness window — a real incident on 2026-10-08 left
    // 82 stale claims behind and blocked a parallel session five times.
    ctx.on('tools/result', (execution, result) => {
      if (result?.isError) return;
      if (execution.name !== 'pwsh' && execution.name !== 'bash') return;
      if (!isCommitCommand(execution.arguments?.command)) return;
      const cwd = execution.agent?.session?.header?.cwd;
      if (typeof cwd !== 'string' || cwd.length === 0) return;
      clearClaims(cwd, config);
      // The work landed, so the takeover notices have served their purpose.
      const state = states.get(execution.agent?.id);
      if (state !== undefined) state.takeovers = [];
    });

    ctx.effect(
      () =>
        ctx.tools.guard((execution) => {
          if (execution.name !== 'write' && execution.name !== 'edit') return undefined;
          const rawPath = execution.arguments?.file_path ?? execution.arguments?.path;
          if (typeof rawPath !== 'string' || rawPath.length === 0) return undefined;
          const base = rawPath.split(/[\\/]/).pop().toLowerCase();
          const SHARED = ['done.md', 'plan.md', 'todo.md', 'steward.md', 'journal.jsonl', 'tortuous.jsonl'];
          const isDoc = SHARED.includes(base);
          const mode = config.concurrentWriteMode ?? 'both';
          const protectSource = mode === 'sourceFiles' || mode === 'both';
          if (!isDoc && !protectSource) return undefined;
          if (!isDoc && !/\.(dart|py|js|mjs|ts|go|rs|java|kt|rb|php|c|cc|cpp|h|cs|sh|ps1)$/i.test(base)) return undefined;
          const agent = execution.agent;
          const cwd = agent?.session?.header?.cwd;
          if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
          const absolute = isAbsolute(rawPath) ? rawPath : join(cwd, rawPath);
          const rel = relative(cwd, absolute).replace(/\\/g, '/');
          // Never claim a file outside the project: a session may write scratch files in
          // Temp or elsewhere, and their claims do not belong to this project's claim set.
          // `path.relative` returns the target UNCHANGED when the two paths share no root
          // (another drive on Windows), so an absolute `rel` is the second half of the check —
          // without it a scratch file on D: was claimed by a project living on C: (real
          // defect, 2026-10-14: a claim appeared for a file under %TEMP%).
          if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
          const self = agentIdentity(agent);

          // A working-tree change we do not own is always a blocker, even with no claim.
          const dirty = gitDirtyPath(cwd, absolute);
          let claim = readClaim(cwd, config, rel);
          if (claim !== undefined && !claimFresh(claim, config)) {
            // Stale claim: its owner is gone (killed, crashed, or finished without commit).
            // Delete it and treat the file as unclaimed instead of leaving residue forever.
            // A guard can only refuse or allow — never annotate — so the takeover is recorded
            // on the session and surfaces in the next digest render, where the agent that is
            // about to overwrite the file will actually read it.
            const deadOwner = String(claim.owner ?? '');
            deleteClaim(cwd, config, rel);
            claim = undefined;
            const state = states.get(agent.id);
            if (state !== undefined && deadOwner.length > 0 && deadOwner !== self) {
              ctx.logger?.info?.(
                'project-forge: took over the stale claim on %s from session %s',
                rel,
                shortId(deadOwner),
              );
              state.takeovers = [...state.takeovers, { path: rel, owner: deadOwner, at: Date.now() }].slice(-5);
            }
          }
          // Housekeeping: drop every other stale claim in this project while we are here.
          clearStaleClaims(cwd, config);
          if (claim !== undefined && claim.owner !== self) {
            return [
              `项目锻造模式拒绝写入 \`${rel}\`：它已被会话 ${shortId(claim.owner)} 认领。`,
              '那个会话正在改它；第二个写者会静默覆盖它的成果。',
              '先协调（或请它提交 —— 一次成功提交会释放所有认领），然后重试。见 §12。',
            ].join(' ');
          }
          if (dirty === true && claim?.owner !== self) {
            return [
              `项目锻造模式拒绝写入 \`${rel}\`：它还有未提交的改动。`,
              '多半是另一个会话改过它、还没提交；请重新读一遍、对账之后再写。',
              '见协议 §12。',
            ].join(' ');
          }
          // Take or keep the claim, then allow the write.
          writeClaim(cwd, config, rel, { owner: self, time: Date.now() });
          return undefined;
        }),
      'project-forge.concurrentWriteGuard()',
    );
  }

  // ── Guard G: malformed tool-call repair (empty call id) ──────────────────────
  // A model that writes a broken function tag (`<function=psh?` — observed with
  // mimo-v2.6-flash) makes pi-ai emit a tool-call block whose id is an empty
  // string. The loop tolerates it in memory, but the V4 session codec refuses to
  // persist the tool/result with an empty callId ("requires toolCallId matching
  // its tool source"), the drain wedges on the poisoned batch, and the session
  // file freezes at the tool/call line forever — seven sessions died exactly so
  // between 2026-10-08 and 2026-10-12, all unrecoverable. Rewriting the empty id
  // to a synthetic one at the stream boundary turns the fatal poison into an
  // ordinary unknown-tool error, which the model reads and recovers from (8/8
  // survivor sessions prove that path is safe).
  if (config.guardMalformedToolCall !== false) {
    ctx.effect(
      () =>
        ctx.on('llm/stream', (options, next) => {
          // The waterfall is process-wide; repair only streams owned by agents this
          // plugin instance manages (other presets' compositions are out of scope).
          const sessionId = options?.sessionId;
          if (typeof sessionId !== 'string' || !states.has(sessionId)) return next();
          return repairMalformedToolCallIds(next(), (message) => ctx.logger?.warn?.(message));
        }),
      'project-forge.malformedToolCallRepair()',
    );
  }
}

/**
 * Rewrite empty tool-call ids in one LLM chunk stream to a synthetic non-empty id.
 * The pi-ai adapter passes a malformed function tag through as a tool-call block with
 * `id: ""` (llm-deepseek rejects the whole response instead); the loop survives that
 * in memory, but the V4 session codec refuses to persist the tool/result with an
 * empty callId and the drain wedges on the poisoned batch — the session file freezes
 * mid-turn and never recovers. A synthetic id turns the fatal poison into an ordinary
 * unknown-tool error the model can recover from.
 * @param stream - the downstream chunk stream.
 * @param warn - logger for each repaired call.
 * @returns the same chunks, with empty tool-call ids replaced.
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
        `project-forge: repaired a malformed tool call (empty id, name ${JSON.stringify(chunk.block.name)}) as ${id}; ` +
          'the model wrote a broken function tag. The call will fail as an unknown tool.',
      );
      yield { ...chunk, block: { ...chunk.block, id } };
      continue;
    }
    yield chunk;
  }
}

/**
 * A short, recognisable form of a session id for error messages. `owner.slice(0, 8)` was a
 * real bug: every session id starts with `session-`, so the slice showed `session-` and the
 * owner was invisible in the refusal (an anonymous "ghost" blocker).
 * @param owner - the claim owner's session id.
 * @returns the UUID portion, truncated to 8 characters.
 */
function shortId(owner) {
  return String(owner).replace(/^session-/, '').slice(0, 8);
}

/**
 * Delete one claim file, if present. Absent files are not an error.
 * @param cwd - the project root.
 * @param config - the validated row config.
 * @param rel - the file's repository-relative path.
 */
function deleteClaim(cwd, config, rel) {
  try {
    unlinkSync(claimPath(cwd, config, rel));
  } catch {
    /* absent or locked — fine */
  }
}

/**
 * Remove every stale claim in one project (owner quiet past the staleness window). Called
 * lazily on each guarded write, so residue cannot accumulate across sessions.
 * @param cwd - the project root.
 * @param config - the validated row config.
 */
function clearStaleClaims(cwd, config) {
  for (const path of claimFiles(cwd, config)) {
    try {
      const claim = JSON.parse(readFileSync(path, 'utf8'));
      if (!claimFresh(claim, config)) unlinkSync(path);
    } catch {
      /* unreadable entries are left alone */
    }
  }
}

/**
 * Remove every claim in one project. Called after a successful commit: the work has landed,
 * so no claim is mid-edit any more.
 * @param cwd - the project root.
 * @param config - the validated row config.
 */
function clearClaims(cwd, config) {
  for (const path of claimFiles(cwd, config)) {
    try {
      unlinkSync(path);
    } catch {
      /* best-effort */
    }
  }
}
