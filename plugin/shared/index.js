import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';


/**
 * The shared layer — the lowest layer of this bundle, and the only one every slice may import.
 *
 * privacy-guard: allow — naming the state boundary (`private/`) is this layer's whole job.
 *
 * It holds facts more than one slice needs: where the state boundary is and how a path inside it
 * is displayed, how to run git without throwing, and how a per-file claim is read, written and
 * judged fresh. It renders nothing and guards nothing, which is what keeps it *below* the digest
 * and the guards rather than between them — the import direction is one-way: slices -> shared.
 */

export const SOURCE_KIND = 'project-forge';

/**
 * Recovery markers already folded in for one session, remembered across plugin reloads.
 *
 * In-memory state alone is not enough: a preset remount or a process restart would forget
 * that a compaction was already answered and inject the same message again.
 * @param sessionId - the session whose markers to load.
 * @returns the markers found for that session.
 */
export function loadRecoveredMarkers(sessionId) {
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
export function rememberRecoveredMarker(sessionId, marker) {
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
export function markerPath(sessionId) {
  return join(tmpdir(), 'dsh-project-forge', `${safeId(sessionId)}.markers`);
}

/**
 * Run one read-only git query, returning its stdout, or `undefined` when git is absent or
 * the directory is not a repository. Guards never throw.
 * @param cwd - the repository root.
 * @param args - git arguments, e.g. ['ls-files'].
 * @returns the trimmed stdout, or `undefined`.
 */
export function runGitOrNothing(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * Whether git already tracks one path. This is the predicate the claim guard uses to decide
 * whether a file is *project content* rather than a scratch or generated file: an untracked
 * path may be a build artifact or a draft, and refusing writes to those would be a false
 * positive storm, while a tracked path is by definition something the project committed to.
 * @param cwd - the repository root.
 * @param absolute - the file's absolute path.
 * @returns true when the path is tracked, false when it is not or git could not be consulted.
 */
export function gitTracksPath(cwd, absolute) {
  const rel = relative(cwd, absolute).replace(/\\/g, '/');
  // `--error-unmatch` makes git exit non-zero for a path it does not know, which is the
  // difference between "untracked" and "tracked but clean" that `ls-files` alone blurs.
  return runGitOrNothing(cwd, ['ls-files', '--error-unmatch', '--', rel]) !== undefined;
}

/**
 * Whether one file has uncommitted working-tree changes (modified or staged-new), reported
 * by `git status --porcelain`. `false` means clean or not a repository; `undefined` means
 * git could not be consulted.
 * @param cwd - the repository root.
 * @param absolute - the file's absolute path.
 * @returns true when the file is dirty, false when clean, undefined when unknown.
 */
export function gitDirtyPath(cwd, absolute) {
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
export function stateDirPath(cwd, config) {
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
export function isInsideStateDir(cwd, config, relPath) {
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
export function resolveStateFile(cwd, config, relative) {
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
export function stewardCandidates(cwd, config) {
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
export function firstPresent(candidates) {
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
export function stateDirDisplayPath(config) {
  const dir = typeof config?.stateDir === 'string' && config.stateDir.length > 0 ? config.stateDir : 'private';
  return dir.replace(/\\/g, '/');
}

/**
 * The steward rules path as the protocol and the refusals name it: the configured path, or
 * the boundary default when none was configured.
 * @param config - the validated row config.
 * @returns the repository-relative path, forward slashes.
 */
export function stewardDisplayPath(config) {
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
export function displayPath(cwd, absolute) {
  const rel = relative(cwd, absolute).replace(/\\/g, '/');
  return rel.length === 0 ? '.' : rel;
}

/**
 * A stable identity for one agent, used as the owner of a file claim.
 * @param agent - the agent writing.
 * @returns its session id when present, else a process-scoped fallback.
 */
export function agentIdentity(agent) {
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
export function claimPath(cwd, config, rel) {
  return join(stateDirPath(cwd, config), '.forge-claims', `${safeId(rel)}.json`);
}

/**
 * Read one claim; undefined when absent or unreadable.
 */
export function readClaim(cwd, config, rel) {
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
export function writeClaim(cwd, config, rel, claim) {
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
export function claimFiles(cwd, config) {
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
export function claimFresh(claim, config) {
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
export function checkPushGrant(cwd, config, command) {
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
export const GRANT_LINE = /^\s*push\s+allowed:\s*(\S+?)(?:\s+×(\d+))?\s*$/im;

/**
 * Whether a grant glob covers one remote URL. The grant names a path fragment (e.g.
 * `github.com/sopreigj/nhentai-downloader`), not a full URL — any URL that CONTAINS the
 * fragment is covered, so `https://.../nhentai-downloader.git` and `git@github.com:...` both
 * match. `*` crosses any run of characters. Case-insensitive, because hosts are.
 */
export function grantMatches(glob, url) {
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
export function pushTargetUrl(cwd, command) {
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
  if (url !== undefined) return url.trim();
  // Falling back to the config file is not belt-and-braces: resolving through `git` means spawning
  // a process, and a host that cannot spawn turns every grant into a silent mismatch (the guard
  // then refuses a push the user authorized). `.git/config` holds the same answer as a plain read.
  return remoteUrlFromConfig(cwd, target);
}

/**
 * The URL of one configured remote, read straight out of `.git/config` — no subprocess, so it
 * still works where spawning git does not. Handles both repository shapes: `.git` as a directory
 * (`config` inside it) and `.git` as a file pointing at a worktree/temporary git directory.
 * @param cwd - the repository root.
 * @param name - the remote name, e.g. 'origin'.
 * @returns the URL, or `undefined` when the remote is not configured.
 */
export function remoteUrlFromConfig(cwd, name) {
  const dotGit = join(cwd, '.git');
  let configPath = join(dotGit, 'config');
  if (!existsSync(configPath)) {
    const pointer = readIfPresent(dotGit);
    const match = pointer === undefined ? null : /^gitdir:\s*(.+)$/m.exec(pointer);
    if (match === null) return undefined;
    configPath = join(cwd, match[1].trim(), 'config');
  }
  const text = readIfPresent(configPath);
  if (text === undefined) return undefined;
  const lines = text.split(/\r?\n/);
  let inRemote = false;
  for (const line of lines) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section !== null) {
      inRemote = /^remote\s+"([^"]+)"$/.test(section[1]) && section[1].includes(`"${name}"`);
      continue;
    }
    if (!inRemote) continue;
    const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (url !== null) return url[1];
  }
  return undefined;
}

/**
 * Fallback staleness window for a file claim, used when the row config does not name one
 * (`claimStaleMs`, default 10 minutes). The window is the design's only cleanup: a session
 * that was killed stops refreshing its claims and they expire on their own.
 */
export const CLAIM_STALE_MS = 10 * 60 * 1000;

export function readIfPresent(absolute) {
  try {
    return readFileSync(absolute, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Make a value safe to appear inside a message id.
 * @param value - the raw marker.
 * @returns a token-safe string.
 */
export function safeId(value) {
  return String(value).replace(/[^\w.-]/g, '_');
}

/**
 * Remove quoted segments and comments from a shell command, so a literal \`git push\`
 * inside a string or a message cannot trigger the guard.
 * @param text - the raw command line.
 * @returns the command with quoted spans replaced by spaces.
 */
export function stripQuoted(text) {
  return text
    .replace(/'(?:[^'\\]|\\.)*'/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
    .replace(/(?:^|\s)#[^\n]*/g, ' ');
}

/**
 * A short, recognisable form of a session id for error messages. `owner.slice(0, 8)` was a
 * real bug: every session id starts with `session-`, so the slice showed `session-` and the
 * owner was invisible in the refusal (an anonymous "ghost" blocker).
 * @param owner - the claim owner's session id.
 * @returns the UUID portion, truncated to 8 characters.
 */
export function shortId(owner) {
  return String(owner).replace(/^session-/, '').slice(0, 8);
}
