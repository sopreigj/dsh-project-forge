/**
 * The privacy policy that Guard E enforces: what a public surface may not contain.
 *
 * privacy-guard: allow — naming the state boundary and the machine-specific patterns is this file's job;
 * the unit tests are the reason it may.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import {
  runGitOrNothing,
  isInsideStateDir,
} from '../shared/index.js';

/** Extensions whose files are configuration: the one place outside the boundary that may
 * carry a private value, provided an example file ships beside it for newcomers. */
export const CONFIG_EXTENSIONS = Object.freeze([
  '.cfg', '.conf', '.env', '.ini', '.json', '.jsonc', '.properties', '.toml', '.yaml', '.yml',
]);

/** Extensions scanned as source: a reach into the state boundary from one of these is a
 * runtime dependency on unshared material, while prose may legitimately describe the rule. */
export const SOURCE_EXTENSIONS = Object.freeze([
  '.c', '.cc', '.cpp', '.cs', '.cjs', '.dart', '.go', '.h', '.java', '.js', '.jsx', '.kt',
  '.mjs', '.php', '.ps1', '.py', '.rb', '.rs', '.sh', '.swift', '.ts', '.tsx', '.vue',
]);

/** Binary artefacts the privacy scan skips: they carry no reviewable text. */
export const BINARY_EXTENSIONS = Object.freeze([
  '.7z', '.avif', '.class', '.db', '.dll', '.dylib', '.eot', '.exe', '.gif', '.gz', '.ico',
  '.jar', '.jpeg', '.jpg', '.mov', '.mp3', '.mp4', '.otf', '.pdf', '.png', '.pyc', '.rar',
  '.so', '.sqlite', '.ttf', '.webp', '.woff', '.woff2', '.zip',
]);

/** The privacy scan reads at most this many bytes of one file, and this many files per commit. */
export const PRIVACY_SCAN_BYTES = 262144;

export const PRIVACY_SCAN_LIMIT = 400;

/** Absolute home directories of a machine, whatever the OS: never a fact a public file needs. */
export const HOME_PATH_PATTERNS = Object.freeze([
  [/(^|[^A-Za-z0-9])[A-Za-z]:\/Users\/[^/\s"'`]+/i, 'an absolute Windows user path'],
  [/(^|[^A-Za-z0-9])\/home\/[^/\s"'`]+/, 'an absolute POSIX home path'],
  [/(^|[^A-Za-z0-9])\/Users\/[^/\s"'`]+/, 'an absolute macOS home path'],
  [/(^|[^A-Za-z0-9])\/root(\/|\b)/, 'the root home directory'],
]);

/** High-confidence secret literals: an assignment or a key block, not prose about secrets. */
export const SECRET_LITERAL_PATTERNS = Object.freeze([
  /\b(?:api[_-]?key|apikey|access[_-]?key|secret|token|password|passwd|passphrase|private[_-]?key)\b\s*[:=]\s*["'`][A-Za-z0-9_\-+/=]{16,}["'`]/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]);

/**
 * A file carrying this marker is exempt from the privacy scan: the mode's own sources and
 * fixtures must be able to show what the guard refuses. An exemption is visible in the file
 * and in the diff, which is the point — this guard is anti-slip, not a security boundary.
 */
export const PRIVACY_ALLOW_MARKER = 'privacy-guard: allow';

/** Extensions and names that mark a root file as a kind of artifact. */
export const KIND_BY_EXTENSION = Object.freeze({
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
export function readTreeFacts(cwd, documents) {
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
export function acknowledgesLayout(documents, facts) {
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
export function publicSurfaceCandidates(cwd, config) {
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
export function privacyFindings(cwd, config, relPath) {
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
export function scanPublicSurface(cwd, config) {
  const findings = [];
  for (const path of publicSurfaceCandidates(cwd, config)) {
    const reasons = privacyFindings(cwd, config, path);
    if (reasons.length > 0) findings.push({ path, reasons });
  }
  return findings;
}