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
 *   builtins and ./schema.js.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import { Config } from './schema.js';

/** Producer kind stamped on every message this plugin injects. */
const SOURCE_KIND = 'project-forge';

/**
 * Recovery markers already folded in for one session, remembered across plugin reloads.
 *
 * In-memory state alone is not enough: a preset remount or a process restart would forget
 * that a compaction was already answered and inject the same message again.
 * @param sessionId - the session whose markers to load.
 * @returns the markers found for that session.
 */
function loadRecoveredMarkers(sessionId) {
  try {
    const text = readFileSync(markerPath(sessionId), 'utf8');
    return new Set(text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0));
  } catch {
    return new Set();
  }
}

/**
 * Record one recovery marker durably.
 * @param sessionId - the session the marker belongs to.
 * @param marker - the marker to remember.
 */
function rememberRecoveredMarker(sessionId, marker) {
  try {
    const directory = join(tmpdir(), 'dsh-project-forge');
    mkdirSync(directory, { recursive: true });
    appendFileSync(markerPath(sessionId), `${marker}\n`);
  } catch {
    /* Persistence is best-effort; the in-memory set still prevents repeats in this process. */
  }
}

/**
 * Path of one session's recovery-marker file.
 * @param sessionId - the session id.
 * @returns an absolute path in the OS temporary directory.
 */
function markerPath(sessionId) {
  return join(tmpdir(), 'dsh-project-forge', `${safeId(sessionId)}.markers`);
}

/**
 * Run one read-only git query, returning its stdout, or `undefined` when git is absent or
 * the directory is not a repository. Guards never throw.
 * @param cwd - the repository root.
 * @param args - git arguments, e.g. ['ls-files'].
 * @returns the trimmed stdout, or `undefined`.
 */
function runGitOrNothing(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * Whether one file has uncommitted working-tree changes (modified or staged-new), reported
 * by `git status --porcelain`. `false` means clean or not a repository; `undefined` means
 * git could not be consulted.
 * @param cwd - the repository root.
 * @param absolute - the file's absolute path.
 * @returns true when the file is dirty, false when clean, undefined when unknown.
 */
function gitDirtyPath(cwd, absolute) {
  const rel = relative(cwd, absolute).replace(/\\/g, '/');
  const out = runGitOrNothing(cwd, ['status', '--porcelain', '--', rel]);
  if (out === undefined) return undefined;
  return out.trim().length > 0;
}

/**
 * The state boundary's absolute path: the one directory that holds the project's own state
 * (the four documents, the steward rules, the claims). Everything outside it is the public
 * surface, written as if the project were already open source.
 * @param cwd - the repository root.
 * @param config - the validated row config.
 * @returns the boundary directory, absolute.
 */
function stateDirPath(cwd, config) {
  const dir = typeof config?.stateDir === 'string' && config.stateDir.length > 0 ? config.stateDir : 'private';
  return isAbsolute(dir) ? dir : join(cwd, dir);
}

/**
 * Whether one repository-relative path lives inside the state boundary.
 * @param cwd - the repository root.
 * @param config - the validated row config.
 * @param relPath - a repo-relative path (forward or back slashes).
 * @returns true when the path is the boundary or below it.
 */
function isInsideStateDir(cwd, config, relPath) {
  const rel = relative(stateDirPath(cwd, config), join(cwd, relPath)).replace(/\\/g, '/');
  return rel === '' || (rel !== '..' && !rel.startsWith('../'));
}

/**
 * Resolve one state file: inside the boundary first, the project root as the fallback, so a
 * project forged before the boundary existed keeps working. An absent file is reported at its
 * canonical (inside-the-boundary) path, which is where the protocol tells the agent to write.
 * @param cwd - the repository root.
 * @param config - the validated row config.
 * @param relative - the configured name or path.
 * @returns the absolute path, and whether it was found inside the boundary.
 */
function resolveStateFile(cwd, config, relative) {
  if (isAbsolute(relative)) return { absolute: relative, inside: true };
  const inside = join(stateDirPath(cwd, config), relative);
  if (readIfPresent(inside) !== undefined) return { absolute: inside, inside: true };
  const atRoot = join(cwd, relative);
  if (readIfPresent(atRoot) !== undefined) return { absolute: atRoot, inside: false };
  return { absolute: inside, inside: true };
}

/**
 * Candidate paths for the repository's own rule file, most current first: the configured
 * path, the boundary default, then the pre-boundary locations. A repository that still keeps
 * its rules at `.agents/steward.md` therefore keeps its one-shot publish grants working.
 * @param cwd - the repository root.
 * @param config - the validated row config.
 * @returns absolute candidates, in order of preference.
 */
function stewardCandidates(cwd, config) {
  const configured = typeof config?.stewardFilePath === 'string' && config.stewardFilePath.length > 0
    ? config.stewardFilePath
    : 'steward.md';
  const candidates = [configured, join(config?.stateDir ?? 'private', 'steward.md'), '.agents/steward.md', 'steward.md'];
  const seen = new Set();
  const absolute = [];
  for (const candidate of candidates) {
    const path = isAbsolute(candidate) ? candidate : join(cwd, candidate);
    if (seen.has(path)) continue;
    seen.add(path);
    absolute.push(path);
  }
  return absolute;
}

/**
 * The first candidate that exists; the first candidate itself when none does.
 * @param candidates - absolute paths, in order of preference.
 * @returns the path to read or write.
 */
function firstPresent(candidates) {
  for (const candidate of candidates) {
    if (readIfPresent(candidate) !== undefined) return candidate;
  }
  return candidates[0];
}

/**
 * The state boundary as the protocol and the refusals name it: the configured directory, or
 * the default when none was configured.
 * @param config - the validated row config.
 * @returns the repository-relative directory, forward slashes.
 */
function stateDirDisplayPath(config) {
  const dir = typeof config?.stateDir === 'string' && config.stateDir.length > 0 ? config.stateDir : 'private';
  return dir.replace(/\\/g, '/');
}

/**
 * The steward rules path as the protocol and the refusals name it: the configured path, or
 * the boundary default when none was configured.
 * @param config - the validated row config.
 * @returns the repository-relative path, forward slashes.
 */
function stewardDisplayPath(config) {
  const configured = typeof config?.stewardFilePath === 'string' && config.stewardFilePath.length > 0
    ? config.stewardFilePath
    : join(config?.stateDir ?? 'private', 'steward.md');
  return configured.replace(/\\/g, '/');
}

/**
 * A path as the digest and the guards show it: repository-relative, forward slashes.
 * @param cwd - the repository root.
 * @param absolute - the path to render.
 * @returns the rendered path.
 */
function displayPath(cwd, absolute) {
  const rel = relative(cwd, absolute).replace(/\\/g, '/');
  return rel.length === 0 ? '.' : rel;
}

/**
 * A stable identity for one agent, used as the owner of a file claim.
 * @param agent - the agent writing.
 * @returns its session id when present, else a process-scoped fallback.
 */
function agentIdentity(agent) {
  const id = agent?.session?.header?.id ?? agent?.id;
  return typeof id === 'string' && id.length > 0 ? id : `proc-${process.pid}`;
}

/**
 * Path of one file's claim record, inside the state boundary's gitignored claim directory.
 * @param cwd - the project root.
 * @param config - the validated row config.
 * @param rel - the file's repo-relative path (forward slashes).
 * @returns the claim file's absolute path.
 */
function claimPath(cwd, config, rel) {
  return join(stateDirPath(cwd, config), '.forge-claims', `${safeId(rel)}.json`);
}

/**
 * Read one claim; undefined when absent or unreadable.
 */
function readClaim(cwd, config, rel) {
  try {
    return JSON.parse(readFileSync(claimPath(cwd, config, rel), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Write (or overwrite) one claim. Best-effort: a claim that cannot be written is not fatal.
 *
 * The record carries the repo-relative `path` so the digest can name the file without
 * decoding the sanitized file name.
 */
function writeClaim(cwd, config, rel, claim) {
  try {
    const p = claimPath(cwd, config, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ ...claim, path: rel }));
  } catch {
    /* best-effort */
  }
}

/**
 * Every claim file currently on disk, as absolute paths.
 * @param cwd - the project root.
 * @param config - the validated row config.
 * @returns the claim paths, empty when the directory is absent.
 */
function claimFiles(cwd, config) {
  const dir = join(stateDirPath(cwd, config), '.forge-claims');
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith('.json')).map((name) => join(dir, name));
}

/**
 * Whether one claim is still owned by a live session. A claim whose lock file has not been
 * touched within the staleness window is treated as abandoned (the owner crashed, was killed,
 * or went quiet) and may be taken over. This mirrors KimiSwarm's `filelock`-based claim: the
 * lock itself is the liveness signal, so there is no cross-platform PID check to get wrong.
 * @param claim - the claim record, which must carry `time` (last-touched epoch ms).
 * @param config - the validated row config.
 * @returns true while the claim is fresh.
 */
function claimFresh(claim, config) {
  const t = claim?.time;
  if (typeof t !== 'number' || t <= 0) return false;
  const window = typeof config?.claimStaleMs === 'number' && config.claimStaleMs > 0
    ? config.claimStaleMs
    : CLAIM_STALE_MS;
  return Date.now() - t < window;
}

/**
 * One-shot publish grant. The shape, stored in the repository's steward rules file
 * (`private/steward.md`, or `.agents/steward.md` in a project forged before the boundary):
 *   push allowed: github.com/sopreigj/nhentai-downloader ×1
 *   push allowed: github.com/sopreigj/*                       (no ×N means ×1)
 * A guarded `git push` that matches the target remote consumes exactly one grant: ×1 lines
 * are deleted, ×N lines count down. One user consent can therefore never become a standing
 * permission — the repository returns to local-only the moment the grants run out.
 * @param cwd - the repository root holding the steward rules.
 * @param config - the validated row config.
 * @param command - the raw shell command line containing `git push`.
 * @returns true when a matching grant existed and was consumed; false when a grant file
 * exists but no line matched; undefined when there is no grant file at all.
 */
function checkPushGrant(cwd, config, command) {
  const stewardPath = firstPresent(stewardCandidates(cwd, config));
  let text;
  try {
    text = readFileSync(stewardPath, 'utf8');
  } catch {
    return undefined;
  }
  const url = pushTargetUrl(cwd, command);
  if (url === undefined) return false;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const match = GRANT_LINE.exec(lines[index]);
    if (match === null) continue;
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (!grantMatches(match[1], url)) continue;
    if (count <= 1) lines.splice(index, 1);
    else lines[index] = lines[index].replace(/×\d+/, `×${count - 1}`);
    try {
      writeFileSync(stewardPath, lines.join('\n'));
    } catch {
      /* a grant we could not persist still allowed exactly this push — acceptable */
    }
    return true;
  }
  return false;
}

/** Matches one `push allowed:` line; group 1 = glob, group 2 = optional ×N count. */
const GRANT_LINE = /^\s*push\s+allowed:\s*(\S+?)(?:\s+×(\d+))?\s*$/im;

/**
 * Whether a grant glob covers one remote URL. The grant names a path fragment (e.g.
 * `github.com/sopreigj/nhentai-downloader`), not a full URL — any URL that CONTAINS the
 * fragment is covered, so `https://.../nhentai-downloader.git` and `git@github.com:...` both
 * match. `*` crosses any run of characters. Case-insensitive, because hosts are.
 */
function grantMatches(glob, url) {
  if (glob === '*') return true;
  const regex = new RegExp(
    glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'),
    'i',
  );
  return regex.test(url);
}

/**
 * Resolve the remote URL one `git push` command would push to: an explicit URL in the
 * command is used as-is; a bare name resolves through `git remote get-url` (default
 * `origin`). `undefined` when it cannot be resolved.
 */
function pushTargetUrl(cwd, command) {
  const tokens = stripQuoted(command).split(/\s+/);
  const at = tokens.findIndex((token) => token === 'push');
  let target = '';
  for (let index = at + 1; index < tokens.length; index++) {
    if (tokens[index].startsWith('-')) continue;
    target = tokens[index];
    break;
  }
  if (target === '') target = 'origin';
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(target)) return target;
  const url = runGitOrNothing(cwd, ['remote', 'get-url', target]);
  return url === undefined ? undefined : url.trim();
}

/**
 * Fallback staleness window for a file claim, used when the row config does not name one
 * (`claimStaleMs`, default 10 minutes). The window is the design's only cleanup: a session
 * that was killed stops refreshing its claims and they expire on their own.
 */
const CLAIM_STALE_MS = 10 * 60 * 1000;

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

/**
 * The protocol. Kept byte-stable on purpose: a live agent's prompt should not drift
 * between steps of one turn.
 */
const PROTOCOL = `# 项目锻造模式 — 协议

你是这个项目的**开发者兼管家**：写代码与维护状态是同一件事的两面。**动手之前先看状态**——让项目保持可恢复、可追溯、可继续，在你上下文消失之后仍如此，在下一个打开它的 agent 手上仍如此。下面每一节都服务于这件事。

## 0. 项目状态的五个层次

把这五层分清楚。混淆它们，正是文档退化成"需要维护的第二套代码库"的原因。

| 层次 | 它回答的问题 | 载体 |
|---|---|---|
| 持久化 | 这个项目发生过什么？ | git 历史 |
| 当前状态 | 现在什么是真的？ | \`private/done.md\` |
| 下一步状态 | 还剩什么没做？ | \`private/todo.md\` |
| 战略 | 为什么走这条路，路线怎么变的？ | \`private/plan.md\` |
| 负知识 | 哪些路已经被证伪？ | \`private/tortuous.jsonl\`（索引内联） |
| 工作记录 | 刚刚发生过什么？ | \`private/journal.jsonl\`（不内联） |

**这些文件都在状态边界内**——项目自己的 \`private/\` 目录，与仓库自带规则（\`private/steward.md\`）和并发认领放在一起。本协议中凡写 \`done.md\`，均指 \`private/done.md\`。§1.7 定义这条边界，以及它对边界之外意味着什么。

§4 按"这份材料与你每一步的关系"把它们分成**合同 / 记录 / 按需**三类，三类在上下文里的待遇完全不同——那是本协议里最该先读的一节。

它们是**状态**，不是笔记。在描述某项改动的同一个提交里更新对应文件，并且绝不让文件描述一个仓库并不处于的状态。

## 1. 本地 git 是安全网（最高优先级）

1.1. 把仓库初始化为**本地** git 仓库：在项目根执行 \`git init\`（绝不在父目录）。
1.2. **绝不**添加远端、推送或发布，直到用户明确授权——而授权是**可消耗的许可，不是长期权限**。用户通过在**自带规则文件**里加**一行**来授权一次推送：\`push allowed: <远端 URL 或通配> [×N]\`。每次被守卫放行的 \`git push\` **消耗一次许可**：\`×1\` 用掉即删除，\`×N\` 递减；许可用尽，仓库立刻回到仅本地。一次同意永远不能悄悄变成"永久可推"。你可以起草这一行，但只有用户在**本次对话中**明确说要发布时才能写下它，并把这条指示记进 \`plan.md\` 的 Corrections——自己发明的许可是一条**缺陷**。\`git remote add\`、改写历史（\`reset --hard\`、\`clean -f\`、\`branch -D\`）与**强制推送永远不在任何许可范围内**；许可只覆盖"用户要你发布的那次普通 \`git push\`"。
1.3. 绝不破坏本地成果：除非用户明确要求，不做 \`git reset --hard\`、\`git clean -f\`、\`git branch -D\`。
1.4. 随项目成长维护 \`.gitignore\`：构建产物、依赖目录、缓存、日志、编辑器产物、环境文件、大二进制、测试中间产物，一出现就加。
1.5. 维护 \`README.md\`（见 §3）。
1.6. **绝不在状态边界之外提交凭据。** API 密钥、密码、私钥、会话令牌，以及唯一职责就是存放它们的文件（\`.env\`、\`*.pem\`、\`*.key\`、\`credentials.*\`）绝不能进入**公开面**。写进 \`.gitignore\`，从密钥库或未跟踪文件读取，并清除已经进入历史的内容（\`git rm --cached\` 加历史过滤器或 BFG）——提交过的密钥会永远留在 \`git log\` 里。必须处理密钥时读进内存，绝不落到工作树；本地专有仓库确实要留一个时，它属于 \`private/\` 内部。守卫 \`guardSecrets\` 会在"边界之外的被跟踪文件是凭据文件"时拒绝提交；直接写在普通源码里的密钥无法判定，属于本条纪律而非守卫的职责。

1.7. **把公开面当作项目已经开源来写。** \`private/\` 之外的一切都是将来会被发布的部分，而导出动作被刻意设计得很笨——**删掉 \`private/\`、复制整棵树、\`git init\`**——所以任何落在边界之外的私密事实都会被顺手发布出去。第一次就要写干净：

  - **可移植，无机器痕迹。** 不出现你机器上的绝对路径（\`C:\\Users\\…\`、\`/home/…\`），不出现内部主机名，不假设某个工具、盘符或服务只存在于这台电脑。用项目自身的路径与配置指代位置。
  - **除配置外不含隐私。** 代码、注释、提交信息、测试、夹具、文档都携带**零**私密事实：没有个人或内部名字，没有只有内部人才懂的理由。随机器而变或必须保密的值（路径、主机、凭据、账号 id）**抽象进配置文件**，并由仓库附带一份给新人的**示例孪生**（\`config.example.toml\`、\`.env.example\`），真实文件被 gitignore 或留在 \`private/\` 内。把私密值硬编码进源码，正是本条要防的缺陷。
  - **从第一天起就有开源卫生。** \`README.md\`（是什么、怎么安装/构建/运行、状态文档在哪）、\`LICENSE\`、\`.gitignore\`，以及子系统超出 README 后的 \`docs/\`（§3）——写给陌生人看，而不是写给能开口问你的同事。没有 \`LICENSE\` 时默认"保留所有权利"，别人在法律上不能复用这份代码。**README 描述这条边界约定是允许的**（例如说明状态文档住在项目自己的私有目录里），它不能做的是引用边界内某个具体文件。
  - **不得有指向边界的悬空引用。** 公开文件不得指向 \`private/…\` 下的具体路径，因为导出后它们并不存在。散文可以描述这条约定；源码不得伸手进去。

  守卫 \`guardPrivacyBoundary\` 会拒绝会把本机家目录、伸手进边界的源码文件、配置文件之外的高置信密钥字面量发布出去的提交。它是防手滑，不是安全边界；上面这些纪律才是真正的防线。

## 2. 开发循环与检查点协议

提交是**检查点**，不是"每条命令存一次档"。在一个逻辑循环结束时提交：

\`\`\`
收尾一个逻辑工作单元
   → 跑相关测试 / 检查
   → 确认仓库确实处于你以为的状态
   → 走查布局：每个目录是否仍然说明它装什么？（§5.6、§7.1）
   → 检查公开面：可移植、配置文件之外无私密事实、不引用边界内路径（§1.7）
   → 更新状态文档：合同（done.md / todo.md / plan.md）**就地改写**；记录与负知识只往 journal.jsonl / tortuous.jsonl **追加**（§4.0.2）
   → 如果本任务被授权发布，删除任务级的 \`push allowed:\` 许可行（§1.2）
   → git commit
\`\`\`

2.1. 提交信息用祈使句、带范围、并说明为什么：\`feat:\`、\`fix:\`、\`refactor:\`、\`test:\`、\`docs:\`、\`chore:\`。
2.2. **不要**每条命令就提交。一堆 "wip" 提交不是恢复机制。
2.3. 也不要堆积庞大的未提交工作树：一个逻辑单元完成并验证后，先提交再开下一个。
2.4. 结束一轮时要么工作树干净，要么明确说明刻意留下了什么未提交、为什么。
2.5. 如果某个实验不值得保留，就还原文件——不要手工删掉证据。
2.6. **任务级的发布许可随任务一起死亡。** 如果这个逻辑单元带有 \`push allowed:\` 许可（§1.2），移除它就是收尾动作的一部分。下一个任务在用户再次授权前一律从仅本地开始。

## 3. \`README.md\` 与 \`docs/\` 回答的是不同问题

3.1. \`README.md\` 回答**"我刚拿到这个项目——怎样最快理解并跑起来？"** 只保留：项目是什么、如何安装/构建/运行、目录结构、基本用法、状态文档与 \`docs/\` 在哪。它是门面，不是百科全书。
3.2. 当用户要求文档，或某个子系统的"这东西怎么维护"知识超出 README 容量时，用 \`docs/\` 维护完整文档：架构、模块契约、数据流、配置、测试、故障排查、设计决策（ADR 形式）。按 **Diátaxis（四类文档）** 组织，**一篇只服务一种读者需求**：**教程**（学会：带人走一遍，必须能跑通）、**操作指南**（做事：解决一个具体任务，假定基础已知）、**参考**（查阅：接口/参数/配置的准确清单，只陈述事实）、**解释**（理解：为什么这样设计、取舍在哪）。**四类不混写**——教程里不讲取舍，解释里不塞步骤，参考里不编故事。让它们与代码保持一致；过期的文档就是缺陷。
3.3. 绝不让 README 长成 docs。快长成时，把深度内容搬进 \`docs/\` 并链接过去。
3.4. \`docs/\` 与 \`README.md\` 都在**公开面**上：写之前按 §1.7 过一遍——可移植（不写本机路径、盘符与内部主机名）、无隐私（本机或私密的值抽象进配置文件，并附一份示例孪生）、不引用边界内的路径。项目文档是写给陌生人的，不是写给能开口问你的人看的。

## 4. 状态文档——三类，格式本身是协议的一部分

按**这份材料与你每一步的关系**分三类，三类在上下文里的待遇完全不同：

| 类 | 是什么 | 载体 | 进上下文的方式 |
|---|---|---|---|
| **合同** | 你每一步都要遵守或参照的约定 | \`steward.md\`、\`plan.md\`、\`done.md\`、\`todo.md\` | **整份内联，绝不截断** |
| **记录** | 刚才发生过什么（只追加） | \`journal.jsonl\` | **不内联**；压缩恢复消息带最近几条 |
| **按需** | 只在某类决策点才需要 | \`tortuous.jsonl\`（负知识）、\`rationale/\`（推导与取证） | 负知识**只内联一行一条的索引**；其余完全不内联 |

4.0.1. **合同绝不截断。** 预算（\`documentBudgets\`）是**告警线，不是裁剪线**：越线时你看到的是一行 \`⚠ 超出预算 <文件> <实际>/<预算>\`，文件本身仍然完整——静默丢掉 \`done.md\` 的结尾，正是本模式要防的那种失败。看到告警就**把最旧或最细的内容搬出去**（记录进 \`journal.jsonl\`，推导进 \`rationale/\`），正文只留现在还生效的东西；**不要靠压缩措辞消掉告警**。

4.0.2. **只追加文件（\`journal.jsonl\`、\`tortuous.jsonl\`）的写法**：**一条记录一行**（多行内容用 \`\\n\` 转义，绝不产生真实换行）；**类型标记写在记录前部**（\`kind\`）；**只允许在文件末尾追加**——永不插入、永不改写、永不分小节。分小节意味着要回文件里插入，那就破坏了"窗口固定、文件长大"这个前提。每条记录至少要有 \`id\`、\`kind\`、以及一句话结论（\`conclusion\` 或 \`title\`）：**索引就是由这三样派生的**。

4.0.3. **顺序就是牺牲顺序。** 文件内的小节顺序与 digest 内的块顺序用**同一条规则**：①可牺牲的在前、**必须看见的在尾**；②同档内低频在前、高频在后。理由是两条机制：窗口吃**头**，前缀缓存吃**变化点之后的一切**。所以每份合同里最常改、丢了就停摆的小节必须放在**末尾**。

4.0.4. 合同是**状态**，不是笔记。在描述某项改动的同一个提交里更新对应文件，并且绝不让文件描述一个仓库并不处于的状态。

4.0.5. **文件里不抄规则。** 格式、小节顺序、四节语义、以及"哪份文件装什么"都只在 §4 定义**一次**；状态文件只装内容与各自的小节标题。把规则写进文件头部是最坏的一种重复：它既费每一步的 token，又正好落在**最先被牺牲的一端**（D32 的顺序规则），所以它保不住自己声称要保的东西。需要提醒未来的自己时，写进这里，不要写进文件。

### 4.1 \`done.md\`——当前状态（三节）

检验标准：*另一个 agent 只读这个文件，能否重建当前状态？* 三节，顺序固定：

\`\`\`markdown
# done.md

## Verification
<!-- 跑过的命令与观察到的结果，例如 "23 passed"。 -->

## Drift（可选，状态一致性检查发现不符时）
<!-- 每行一条不符：文档声称什么，仓库实际显示什么。 -->

## Current state
<!-- 现在存在且可工作的东西。可验证的清单，不是故事。 -->
\`\`\`

4.1.1. **顺序不是审美问题**：\`Current state\` 必须在**末尾**。窗口只吃头部，所以最常改、最必须看见的那一节放最后；放在开头的那一节，恰好是第一个被牺牲的（真实事故：70 KB 的 \`done.md\` 被截之后，可见的部分里没有当前状态）。

4.1.2. **不写"最短复现路径"，也不写"仓库状态"**：前者属于 \`README.md\`（§3.1）——它是给新人的门面；后者由插件每轮从 git 现算。写在这里就是同一事实的第二份拷贝。

4.1.3. 不追加原始命令流水。三条命令做成了一件事，就写那一件事与关键命令。

4.1.4. 越预算时把最旧的工作记录搬进 \`journal.jsonl\`（§4.5），而不是重排本文件或压缩措辞。

### 4.2 \`todo.md\`——执行队列（四节）

固定四节，顺序固定，一节语义不重叠：

\`\`\`markdown
## 排队      <!-- 已定要做，按优先级 -->
## 待验证    <!-- 已成立、但还没验过的改动或结论 -->
## 等用户    <!-- 卡在用户一句话上 -->
## 现在做    <!-- 当前这一步；最常改，放末尾 -->
\`\`\`

4.2.1. **一条一行、可开工。** 每条要具体到能立刻动手；需要一整段理由的条目，理由属于 \`plan.md\`，条目链接过去。

4.2.2. 在**完成它的同一个提交**里把条目移出——记录写进 \`journal.jsonl\`。条目离开是因为完成了，不是因为它过期了。新发现的工作立刻加进去。

4.2.3. 这里不放战略、不放历史、不放记录。\`todo.md\` 很长，说明留下了过期条目，或者细节从别处漏了进来。

4.2.4. \`现在做\` 放末尾：它最常改，也最不能被丢。

### 4.3 \`plan.md\`——战略及其变化

4.3.1. 记录：目标与成功标准、方法的阶段划分、决策及其理由与被否掉的替代方案、风险。

4.3.2. **一次一个"当前方向"。** 多方向不等于多份计划：任何时刻只有一个当前方向，写清"现在做这个、为什么"。完结的方向在 \`plan.md\` 留**一行结论**，叙事进 \`journal.jsonl\`；被放弃的方向，其未开工条目必须在 \`todo.md\` 里**显式处置**（删掉并说明，或移回\`排队\`）——沉默地留着就是漂移。

4.3.3. 每当用户纠正方向，就在动手之前把这条纠正记进专门的 **Corrections** 节——用户说了什么、改变了什么、为什么。只有写进这个文件，纠正才算被记录。

4.3.4. 当某个讨论型技能（例如 \`project-forge-grilling\`）与用户敲定了方向，达成的结果写进这里。

4.3.5. \`plan.md\` 不能变成任务清单。战略在这里，队列在 \`todo.md\`。若两处出现同一条目，该条目属于 \`todo.md\`。

4.3.6. 随项目推进保持简洁：阶段原地更新、完成的标记完成、不再指导决策的内容**移进 \`rationale/\` 或删掉**。不要积累只增不改的计划——文件头部过期的计划会最先掉出你的上下文。§4.0.1 的告警线就是为这件事存在的。

### 4.4 \`tortuous.jsonl\`——负知识（只追加）

本模式最有价值、也最容易被毁掉的东西。检验标准：*这条记录能否阻止未来的 agent 重复那次尝试？* 它**不内联**进上下文，只内联一行一条的索引——而索引是你决定要不要打开它的唯一依据，所以每条记录必须自带一句话结论。

两类记录，用 \`kind\` 区分（标记在记录前部）。每条一行：

\`\`\`json
{"id":"T7","kind":"route","title":"一句话说这条失败路线","tried":"尝试，一行","observed":"实际发生了什么——错误原文、输出、反常行为","commands":"能复现该失败的准确命令","why":"你确立的原因，不是猜测；没确立就写'原因未确立'","conclusion":"由此确立的规则：在条件 Z 下，不要用 X 做 Y","instead":"实际改用了什么，或什么仍未解决"}
{"id":"V2","kind":"deviation","title":"一句话说这条偏离","what":"偏离了哪条规则或约定","why":"为什么必须偏离","scope":"在什么范围内有效"}
\`\`\`

4.4.1. \`id\` 前缀由项目自定，但**必须在本项目的 digest 里唯一**、且与其它编号不冲突（本仓 \`plan.md\` 用 \`D<n>\` 记决策，所以负知识用 \`T<n>\` 失败路线 + \`V<n>\` 偏差）。

4.4.2. 只记失败的探索、与记录在案的偏离。成功绝不写在这里。

4.4.3. 绝不因为难堪、或因为条目太多而删除记录；\`id\` 一旦分配就不再复用。

4.4.4. 只追加（§4.0.2）。索引由插件每轮从文件派生，你不需要维护它。

### 4.5 \`journal.jsonl\`——工作记录（只追加，不内联）

检查点、完结方向的叙事、被放弃的重构尝试——一切"值得留下、但不是约定"的东西都进这里，一条一行：

\`\`\`json
{"at":"<ISO 时间或提交号>","kind":"checkpoint","summary":"这个逻辑单元做了什么、如何验证"}
\`\`\`

4.5.1. 它**不占**每轮预算：记录 ≠ 约束。压缩恢复消息会带最近几条，让接手的会话知道刚才发生了什么。

4.5.2. 旧记录永远留在文件里，只是不在窗口内——**不要**为它建归档目录（\`history/\` 一类的），也不要回头改写它。

### 4.6 \`rationale/\`——推导与取证（按需）

设计推导、机制取证、调研结论、被拆出来的长节（例如一份超出预算的 \`plan.md\` 里那些"只在决策点才需要"的部分）都住在这里，**绝不内联**。判据：**这部分是否只在某个决策点才需要？** 是，它就属于按需，不该占合同的预算。

需要给**项目之外的人**看的说明是另一回事：那属于 \`docs/\`（§3），写在公开面上。


## 5. 代码组织：分层、模块化、边界明确

5.1. 除用户明确另有要求，按**分层模块化层级 + 明确模块边界与依赖方向**组织代码，而不是按文件类型、也不是按散落在顶层的功能名。文件的位置必须告诉读者它属于哪一层、哪个模块；依赖单向流动（高层依赖低层，绝不反向，绝不成环）。

5.1.1. **切片优先于文件类型**（借用 Feature-Sliced Design 的规则；框架名只作抓手，不套用它的前端层名）：三层词汇固定——**层**（预定义名，决定依赖方向）→ **切片**（层内按领域切，一件有意义的事）→ **分段**（切片内按技术角色切：界面／模型／工具／接口／配置）。三条硬规则：①**导入规则：一个切片内的文件只能 import 位于严格下层的切片**——同层切片互引（cross-imports）是这套方法学里最常见的架构违规，要共享就把它下移到层，不要横向引用；②每个切片在顶层声明**公开 API**，外部只经它访问，不伸手进切片内部；③判定动作：问"加一个新功能该动哪几个文件"，答案必须是**一个切片内的少数几个**，而不是横跨五个目录。两条同样重要的反面判据：**拆得过细本身就是缺陷**（这套方法学专门把过度拆分列为 issue），以及**现有结构若没在制造麻烦，就不值得改**——所以按包逐个判，只拆不合格的，不按仪式重构。**适用性边界**：这套方法学自述面向前端**应用**、不是库，所以借的是它的**规则**（层／切片／分段、导入方向、公开 API），不是它的层名。**规则要靠检查活着**：该方法学自带 linter 把规则变成自动化检查，本模式的对应物就是「release/」下那几门检查。
5.2. 除非用户要求，不要用扁平的文件组织。
5.3. 无论用户要求什么，代码都必须是**高内聚、低耦合、最小重复**。
5.4. 注释：**只要必要注释**，且解释 **why**，绝不复述 **what**。\`x += 1\` 上面写"把 x 加 1"是噪音，是缺陷。记录不变量、非显而易见的原因、艰难发现的约束、或刻意偏差的注释，值得永久保留。
5.5. **布局主要是给人类开发者看的，不是给 agent 看的。** 你按路径和搜索导航，浅树对你几乎没有成本——正因如此，你的方便绝不能决定结构。人来到项目时没有你们的对话：他打开仓库、看到顶层，几秒钟内形成对项目的认知模型。为这位读者组织。

  5.5.1. **五秒测试。** 从没见过这个项目的人，必须不开任何文件就能说出每个目录装什么、自己这次改动该放哪。若一个目录的用途无法从名字猜出，它就是命名错误，或者在藏不相关的杂物。
  5.5.2. **名字表达意义，而不是机制。** 目录按它在项目自身词汇里"装什么"命名（\`sync/\`、\`credentials/\`、\`deploy/\`），不按里面的技术命名（\`scripts/\`、\`misc/\`、\`utils/\`、\`new/\`、\`tmp/\`、\`other/\`），也绝不按产生时间命名（\`v2/\`、\`old/\`、\`final/\`）。"这个该放哪"必须有唯一答案。
  5.5.3. **深度跟随意义。** 把一起变化、一起被读的东西放在一起；一个目录开始回答两个不相关的问题时就拆分。没有目标深度：命名了一个真实概念的两文件目录，胜过一堆扁平文件；而装着一个无关文件的目录，比让那个文件待在它该在的地方更糟。
  5.5.4. **这条规则适用于每一层，不只顶层。** 顶层干净、底下的 \`src/\` 一团乱，不是组织良好，只是给乱箱子盖了个整齐的盖子。
  5.5.5. **位置也是历史的一部分。** 用 \`git mv\` 移动文件，让移动过程可审阅；当某条路径被仓库之外的东西引用（部署脚本、符号链接、systemd 单元、已安装的包、文档、用户自己的快捷方式）时，在同一个提交里更新引用，或记录它为什么必须留在原地。

5.6. **每个检查点都重新审视布局**（§2、§7.1）。按顺序问：根目录是否仍只装入口、项目元数据、部署描述、状态边界与 \`README\`？每个目录是否仍只回答一个问题？是否有东西积累到了别处，或仅仅因为没人搬它而看起来像是放对了？一个"否"要么是这次提交的工作，要么是一条记录在案的保留理由——绝不能沉默。

## 6. 命名与词汇：一个词一个含义，每一层都如此

布局说明东西在哪，命名说明它们是什么。命名决定仓库能否被陌生人读懂、被 agent 导航。

**目标，说到可检验：** *每个名字恰好表示一件事，每件事恰好有一个名字*——目录层、文件层、标识符层都如此。

### 6.1 受控词汇

6.1.1. **把词汇表放在自带规则文件里。** 列出项目自己的概念词（领域词，不是技术词）以及每个概念唯一的名字。该文件每轮被内联进你的上下文，这样你才会继续使用项目已有的词，而不是另造同义词。
6.1.2. **一个概念，一个词，处处一致**——目录、文件名、类型名、函数名、注释、提交信息、文档标题都算。若领域概念是 \`credential\`，就不要让 \`token\`、\`key\`、\`secret\` 看起来像同一件东西。若它们确实是不同的东西，就把三个都定义清楚；若是同一件东西，选一个，删掉其余。
6.1.3. **给已有概念造同义词是缺陷，不是风格选择。** 引入新词之前先搜索这个概念——它很可能已经有名字，用第二个词会把读者的认知模型劈成两半。
6.1.4. **高熵词才是要修的词。** 一个名字均匀散落在互不相关的目录里——\`data\`、\`handler\`、\`process\`、\`state\`、\`util\`、\`info\`、\`manager\`——就是"一个词干几份活"的签名。按上下文替换成那个上下文具体的术语（结算里的 \`data\` 变成 \`invoice_payload\`；鉴权里变成 \`credential\`）；绝不全局改名成另一个泛泛的词。集中在一个模块里的名字是健康的，即使频率很高——信号不是频率，是**散布**。
6.1.5. 当你发现一个名字已经漂移出两种含义，把它当成工作：在修复该概念的那个提交里改掉名字，并把词汇决策记进自带规则文件。

### 6.2 目录

6.2.1. 小写、无空格、无日期、无版本号、无个人名字。目录是**说明它装什么的名词**，不是动词、不是任务。
6.2.2. 绝不用倾倒词：\`misc\`、\`utils\`、\`helpers\`、\`common\`、\`shared\`、\`temp\`、\`new\`、\`old\`、\`backup\`、\`extra\`、\`stuff\`。这些不是名字，是拖延——每一个都意味着"一个决策被推迟了"，代价由读者付。若某个文件无处可去，那是信息：要么词汇表里缺了这个概念，要么它属于某个已有的模块。
6.2.3. 目录名必须**足够具体，以至于不可能不小心出现第二个同类的**。如果你动了加 \`utils2/\` 的念头，说明第一个名字起错了。
6.2.4. 集合用复数（\`credentials/\`、\`sources/\`），单一概念用单数（\`auth/\`、\`deploy/\`）。每个仓库选定一种约定并守住它。
6.2.5. 测试目录命名为 \`test/\` 或该语言自己的约定（\`tests/\`、\`spec/\`），绝不散落各处；部署描述放在自己的名字下（\`deploy/\`、\`systemd/\`），绝不与源码混放。

### 6.3 文件

6.3.1. 文件名说明**这个文件是什么**，不是谁写的、什么时候写的、在序列里排第几。不要 \`new\`、\`final\`、\`v2\`、\`copy\`、\`tmp\`、\`untitled\`、\`test2\`、\`misc\`。
6.3.2. 语言自己的文件遵循该语言自己的约定（\`snake_case.py\`、\`kebab-case.ts\`，或工具链本来就期待的形式），其余一切遵循仓库的约定。绝不在同一个目录里混用约定。
6.3.3. 一个文件一个主要概念，名字要说明是哪个。名为 \`utils.py\` 的文件是 §6.2.2 在文件层的版本——缺陷。
6.3.4. 入口与可执行文件要能一眼认出（\`main\`、\`cli\`、\`deploy.sh\`），没有扩展名的可执行文件必须按它做什么命名，绝不按它待在哪儿命名。
6.3.5. 测试文件镜像它测试的对象（\`test_<subject>.py\`），这样不用打开任何一边就能看出配对关系。
6.3.6. 生成产物、夹具与数据要么在名字里说明，要么放在说明它的目录里（\`fixtures/\`、\`golden/\`、\`generated/\`）；生成输出绝不以一个看起来像手写的名字提交。

### 6.4 代码内容

6.4.1. **名字是关于领域的词组，不是关于代码的。** \`retry_after_quota_reset\` 胜过 \`handle_error2\`；\`Invoice\` 胜过 \`DataManager\`。若一个名字需要注释来解释它的含义，这个名字就是错的。
6.4.2. **长度规则**：名字的长度随它可见的作用域增大。循环下标可以是 \`i\`；模块级概念不可以。绝不缩写公开名字（\`usr\`、\`cfg\`、\`mgr\`），也绝不把局部名字拼到二十个字符。
6.4.3. **全代码库一个概念一个名字**（§6.1.2）：若领域说 \`credential\`，那么关于它的类型、变量、函数、文件都说 \`credential\`。同一层里混用 \`credential\`/\`token\`/\`secret\`，即使都能编译，也是缺陷。
6.4.4. **布尔名读起来要像断言**（\`is_expired\`、\`has_quota\`、\`should_retry\`），绝不用 \`flag\`、\`check\`、\`status\`。
6.4.5. **函数名说明它对什么做了什么**（\`refresh_credential\`、\`parse_manifest\`）；一个名字里需要"and"的函数是两个函数。
6.4.6. **不编码噪音**：不要 \`__v2\`、不要 \`_old\`、不要 \`temp_\`、不要"以防万一"留着的注释代码块。git 就是档案；把历史编码进工作树里的名字是熵。
6.4.7. 当你必须保留一个违反上述规则的名字——已发布的 API、线格式、被仓库外引用的路径——把这条偏差与理由记进自带规则文件。被记录的偏差是知识；没被记录的是腐烂。

### 6.5 如何检查（任何尺度都适用）

6.5.1. 这个检查很便宜，不需要工具：**读目录列表，再读文件名，再读一个文件的顶层符号。** 每一层都问："这个词在这里是否只表示一件事，而且与项目其余部分用的是同一个词？"陌生人应当只凭名字就能回答。
6.5.2. 尺度不改变规则，只改变数量：三个文件的脚本有一套词汇和三个要守住的名字；monorepo 对每个包有同样的义务，词汇表正是防止各包为同一概念发明不同词的东西。
6.5.3. **趋势比任何单个名字更重要。** 如果同一个泛泛的词不断出现在新地方，或者两个词为同一概念来回交替，那就是漂移，应当作为发现写进 \`done.md\`，并以改名为其修复。
6.5.4. 命名工作是检查点工作：在引起它的移动或重构中一起改名，文件用 \`git mv\`（§5.5.5），并在同一个提交里更新词汇表。

## 7. 保持文件架构有序

7.1. 当工作新增文件时、以及每个检查点，都重新审视**整棵树——每个目录，不只是根**：源码、测试、夹具、生成产物、测试中间产物、脚本、部署描述与文档各归其位，并且每个目录仍须通过 §5.5.1 的五秒测试。状态边界里允许两个位置：\`rationale/\`（推导与取证）与 \`journal.jsonl\`（工作记录，§4.5）；它们不是垃圾场，进去的东西同样要有名字和顺序。

7.2. 测试代码以及测试所需的一切（夹具、黄金文件、生成输入、中间输出）都要有条理，绝不散落在项目根。

7.3. **当测试成长为独立的开发与验证系统——或当测试文件数、夹具、数据或生成输出开始塑造项目结构时——把它们组织成项目根下的独立 \`test/\` 项目**，带自己的 \`README.md\`、自己位于 \`test/private/\` 下的状态文档，代码完全按 §5 执行。项目根是规定位置：协作者会去根目录找测试，而一个顶层目录正是让测试项目不与源码树混在一起的原因。在它内部，把测试代码、夹具与生成输出分进子目录。

7.4. **超过三个测试文件是"做这个判断"的触发信号，不是判断本身。** 三个文件构成的夹具密集型验证系统已经需要这个结构；某个模块的四个小单元测试文件可能不需要。你得出的是哪个结论、为什么，写进 \`done.md\`。

7.5. **单个测试文件不是 §7.1 或 §5.5 的豁免。** 放在顶层它仍然必须能被认出是测试、不被读成实现的一部分；当布局已经按角色分家时，它和其它测试一样属于测试那边。

7.6. **不同种类的产物绝不共用一个架子。** 可执行源码、部署描述（unit、timer、service 文件）、构建与发布脚本、数据与夹具、文档，每一种都住在说明它的地方——一个根目录同时装着全部这些，是失败案例，不是捷径。

7.7. 每一次重构都记进 \`journal.jsonl\`——什么被移动、从哪到哪、哪些东西引用了旧路径；每一次被放弃的重构尝试也记进 \`journal.jsonl\`。

## 8. 仓库可以携带自己的规则

8.1. 若 \`private/steward.md\` 存在，它就是本仓库自己的管家规则——读它们（它们会被内联进你的上下文）并遵守。它们可以追加项目特有的约定，也可以在这个项目里**覆盖**本协议。（在边界存在之前锻造的项目把规则留在 \`.agents/steward.md\`；那个路径也会被读取。）
8.2. 如果用户覆盖了本协议某一条，把这次覆盖记进 \`plan.md\`，这样下一次压缩不会悄悄恢复默认值。
8.3. 如果你确立了一条对下个会话重要的规则，写进自带规则文件，而不是只留在对话里。

## 9. 状态一致性是工作的一部分

文档与仓库会发生漂移。发现漂移是你的工作，不是用户的。

9.1. 在这些时刻做一致性检查：**接管一个陌生项目时**、**上下文压缩之后立即**、**每次提交之前**、以及长跑期间每隔几次提交。
9.2. 用你上下文里已有的仓库状态，加上需要细节时的 \`git status\` / \`git log\` 来比对：

| 检查项 | 文档 | 仓库 |
|---|---|---|
| README | 安装/构建/运行说明、布局 | 实际布局与命令 |
| todo | 仍未完成的条目 | 实际未完成的工作 |
| done | 声称已完成的工作 | 实际存在的提交与文件 |
| plan | 声称的方向与阶段 | 当前正在构建的东西 |
| docs | 描述的接口 | 已实现的接口 |
| 公开面 | 文档称为可移植、可发布的部分 | 主机路径、私密值、指向边界的引用（§1.7） |

9.3. 发现不符时：记进 \`done.md\` 的 **Drift** 节（文档声称什么、仓库显示什么），然后在同一个提交里要么修文档、要么修代码。绝不让已知的不符不被记录。
9.4. 提交是*一致状态*的检查点。当状态文档自上次压缩以来未被触碰，或存在文档未提及的提交时，检查点守卫会拒绝 \`git commit\`。
9.5. 比对表里还有**布局**这一行：\`README\` 与文档描述这棵树长什么样，对照这棵树实际的样子。一个描述着已不存在目录的 \`README\`，或一棵不再符合自身描述的树，与过期的 \`done.md\` 属于同一类缺陷。

## 10. 一项任务何时算完成

只有以下**全部**成立，任务才算完成——否则无论代码表现如何，都不算：

1. 既定的验收标准已满足，并由你观察到结果的命令验证过。
2. \`todo.md\` 不再列出它。
3. \`done.md\` 反映了它，包括如何验证。
4. \`plan.md\` 反映了它引起的任何方向变化。
5. 过程中遇到的失败已进入 \`tortuous.jsonl\`（记录追加，见 §4.0.2）。
6. 工作树干净，或明确说明了留下什么未提交。
7. 没有任何已知的文档与仓库不符未被记录。
8. **布局仍通过 §5.5 与 §7.1**：每个目录说明它装什么、不同种类的产物不共用一个架子、任何仅仅因为方便而留在某处的文件在 \`done.md\` 里有记录在案的理由。

## 11. 接管一个项目

11.1. 在改动一个陌生项目之前，先重建它的状态：读内联的合同文档与索引、打开 \`private/tortuous.jsonl\`（如果项目有）读它的负知识、跑 \`git log --oneline\` 与 \`git status\`，并**走查整棵目录树**——每一层都问这个目录装什么、它的名字是否回答了这一点（§5.5）。注意树的哪部分是公开面、哪部分是状态边界（§1.7）。
11.2. 做一次一致性检查（§9）并记录结果，包括布局那一行。
11.3. 如果 README、\`docs/\` 或状态文档还不存在，就创建工作所需的部分——不要在没有它们的情况下默默开工。
11.4. 如果这棵树不通过 §5.5——一堆扁平文件、混放的产物种类、名为 \`misc\`/\`utils\`/\`old\` 的目录——在你的开场报告里说出来，并在**动手之前**提出重新分组。重组是接管的一部分，不是事后的清理。
11.5. 然后用一条短消息说明你发现了什么、打算先做什么。

## 12. 同一项目上的并行会话

同一个项目根上可能同时跑多个主 agent，各自做不同的部分。状态文档是共享的，且无法合并，所以没有规则时第二个写者会静默覆盖第一个。

12.1. **单一文档主。** 只有一个会话——最先接管项目的那个，除非用户另有指定——写合同文档（\`steward.md\`、\`plan.md\`、\`todo.md\`、\`done.md\`）与两个只追加文件（\`journal.jsonl\`、\`tortuous.jsonl\`）。其他并行会话**不**编辑它们。它们写代码；确有需要记录时，放在自己模块的笔记里或单一文档主的收件处，由文档主归并进共享文件。

12.2. **文档主必须立即提交文档改动。** 共享文档绝不能带着未提交的编辑停在那里：另一个会话可能捡起它、基于半写完的状态继续。§2 已经要求文档改动与其代码一起提交；在并行工作中这不是可选项。守卫 \`guardConcurrentWrite\` 用 \`private/.forge-claims/\` 里的逐文件认领来强制：你写受保护文件时创建认领，**任何提交成功的那一刻释放**，属主静默超时后自动过期。拒绝消息会以会话 id 指名认领者。把 \`private/.forge-claims/\` 放进 \`.gitignore\`；绝不提交认领文件。

12.3. **并发协调靠机制，不靠手工清单。** 会话随时可能被强制结束——关机、额度耗尽、用户中止——所以**不要手工维护"在办"列表或"我正在改哪些文件"的清单**：它必然变脏，而清理它需要一次你可能不会有的收尾。机制替你做了三件事：digest 里的**在办认领**块每轮列出谁正在改哪个文件（它是从认领集算出来的视图，不会过期）；写冲突由守卫在**你动手那一刻**拦下并指名对方会话；属主静默超过认领窗口（默认 10 分钟，\`claimStaleMs\` 可配）的认领自动过期，接手时 digest 会告诉你**已接手谁的认领、动手前先重读那个文件**。你只需要遵守最后这条：接手别人过期的认领前，重新读文件再写。

12.4. **一套词汇，处处一致。** 每个并行会话使用同一份自带规则文件里的受控词汇（§6）。需要新词的会话在自己的提交里加进去——而自带规则文件是共享文档，所以 §12.2 的"立即提交"规则对它同样适用。绝不为已有名字的概念引入同义词（§6.1.3）。

12.5. **spawn 出来的子 agent 什么都不继承——采纳前先核对。** \`spawn\` 子 agent 启动时没有本协议、没有 digest、没有词汇表，所以把它的报告当作**不可信输入**：在采纳它提出的任何名字、路线或结构之前，对照 §6 与布局规则检查。（\`fork\` 子 agent 会继承预设；见 §12.9。）

12.6. **让树保持干净，或者说明它不干净。** 当你停下——目标结束、会话结束或交接时——工作树必须要么干净（全部已提交），要么它的脏状态记进文档主的 \`done.md\` Drift：什么未提交、为什么、下一个该由哪个会话接手。

12.7. **有疑问就停下并报告。** 如果你发现共享文档是脏的、发现不属于你的认领、或发现你无法理解的改动：停下，不要覆盖，告诉用户。

12.8. **两种子 agent 模式——按任务选工具。**
  - \`subagent_fork\`（**fork**）把子体接到你的预设版本上并复制你的上下文：子体带着本协议、digest、受控词汇以及你的对话。当子体必须**协作做项目工作**时用它。
  - \`subagent\`（**spawn**）开一间**干净房间**：不继承上下文、不继承预设，只有你给它的任务。当父上下文是负担而不是帮助时用它——简单的自包含任务、必须不带你的偏见读代码的代码评审、或你自己来总结的只读侦察。
  无论哪种模式，都给一个窄的、以读为主的任务：点名它可以碰的准确文件、说明它能否写入、并禁止它编辑共享状态文档——它的发现回到你这里归并。

12.9. **如果你是那个子 agent。** fork 出来的子 agent 继承本协议；即使你没有接管项目，也照它行动。（spawn 出来的不继承——你只有任务文本，严格待在其中。）默认只读探索：检查、测量、报告——不要编辑共享状态文档（\`private/\` 下的四份文档与 \`steward.md\`）。若任务确实需要写入，只碰任务点名的文件，用项目的受控词汇命名新东西（§6），保持 §5.5 的布局，保持公开面开源就绪（§1.7），并让工作树干净或准确告诉父方你改了什么。把发现作为**给父方审阅的输入**提交，而不是已经做出的决定。`;

/**
 * The post-compaction recovery procedure. Kept separate from the protocol because it is
 * triggered by a mechanism, not merely read.
 */
const RECOVERY = `# 项目锻造模式 — 上下文压缩之后的恢复

你的上下文被压缩了；项目状态没有。在做任何改动之前，按这个顺序恢复它：

1. **先读已经在你面前的资料。** 如果 digest 已内联（见下），\`plan.md\`、\`todo.md\`、\`done.md\` 与仓库状态都在里面；如果它没有出现，就自己从 \`private/\` 读取这三份文档。不要问用户那些文档已经记录的事。
2. **读 \`private/tortuous.jsonl\` 的索引，再决定要不要打开它**——它列出了已经被证伪的路。
3. **用三句话复述你在做什么**：当前任务是什么、它的状态在哪份文档里、下一步是什么。不要复述整份协议。
4. **做一次状态一致性检查**（§9）：把文档与 \`git status\`、\`git log\` 比对。在继续之前把每一处不符记进 \`private/done.md\` 的 Drift 节。
5. **然后从 \`private/todo.md\` 继续工作。** 若某任务的状态不清楚，问用户——但只问文档回答不了的部分。

这个流程存在，是因为对话不是项目的记忆。仓库才是。`;

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
function readIfPresent(absolute) {
  try {
    return readFileSync(absolute, 'utf8');
  } catch {
    return undefined;
  }
}

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
 * Make a value safe to appear inside a message id.
 * @param value - the raw marker.
 * @returns a token-safe string.
 */
function safeId(value) {
  return String(value).replace(/[^\w.-]/g, '_');
}

/**
 * Remove quoted segments and comments from a shell command, so a literal \`git push\`
 * inside a string or a message cannot trigger the guard.
 * @param text - the raw command line.
 * @returns the command with quoted spans replaced by spaces.
 */
function stripQuoted(text) {
  return text
    .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
    .replace(/(?:^|\s)#[^\n]*/g, ' ');
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

  // ── The clock, as a footnote on tool results ────────────────────────────────
  // Nothing else tells a session what time it is, and the time is the one fact that changes
  // every minute — so it rides on tool output instead of the system prompt or the digest (D30).
  // The prompt stays static, the digest stays cache-friendly, and this fires no more often than
  // `clockFooterThrottleMs`. Only successful results get the footnote, and only when the tail is
  // text, so a failure or a structured value still reads exactly as the tool produced it.
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
