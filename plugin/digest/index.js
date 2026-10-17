/**
 * The digest slice — everything that renders the per-turn project memory that rides in the
 * runtime context: the contract documents, the negative-knowledge index, the journal tail, the
 * in-flight claims view, the repository state, and the over-budget warning.
 *
 * It only reads and formats. Deciding what to do about a stale document, a dirty working tree or
 * an unclaimed edit is the guards' job — keeping those apart is what makes both slices small.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import {
  claimFiles,
  claimFresh,
  readIfPresent,
  resolveStateFile,
  displayPath,
  shortId,
} from '../shared/index.js';
/** Heading of the inlined project-memory block. */
export const DIGEST_HEADING = '## Project memory (maintained documents)';

/** Heading of the inlined repository-state block. */
export const REPO_HEADING = '## Repository state (read from .git)';

/**
 * Heading of the in-flight block: who is editing what right now, rendered from the claim set
 * rather than written down by hand. A hand-kept list would be stale exactly when it matters,
 * because the session that should have cleaned it up is the one that was killed.
 */
export const IN_FLIGHT_HEADING = '## 在办认领（谁正在改什么）';

/** Trailing note the digest carries about the one document it omits. */
export const BUDGET_HEADING = '## ⚠ 超出预算（不截断，只提示）';

/** Heading of the block that reports tool calls this session had to repair. */
export const REPAIR_HEADING = '## ⚠ 本会话修复过的畸形工具调用';

/**
 * Report the malformed tool calls repaired so far, or `undefined` when there were none.
 *
 * The repair is logged (`ctx.logger.warn`) — the logger is a built-in, non-optional service of
 * the runtime context — but a log line is not something the model reads. The failure it repairs
 * (`<function=psh?`, an empty call id) surfaces at the tool layer as an *unknown tool*, so
 * without this line the model sees only the symptom and retries the same broken tag. One line
 * in the digest puts the cause where the model is actually looking; the block is absent until
 * something was repaired, so a healthy session pays nothing for it.
 *
 * @param count - repaired calls in this session.
 */
export function renderRepairs(count) {
  if (typeof count !== 'number' || count <= 0) return undefined;
  return `- 本会话已修复 **${count}** 个畸形工具调用（模型写出了坏掉的 function 标签，空 call id 被换成合成 id，所以那个调用会以 unknown tool 失败）。重试前先检查是不是标签写坏了，不要重复同一个形状。`;
}

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
export function renderInFlight(cwd, config, selfId, takeovers) {
  const now = Date.now();
  const live = [];
  const expired = [];
  for (const claimFile of claimFiles(cwd, config)) {
    let claim;
    try {
      claim = JSON.parse(readFileSync(claimFile, 'utf8'));
    } catch {
      continue;
    }
    const rel = typeof claim.path === 'string' && claim.path.length > 0
      ? claim.path
      : basename(claimFile).replace(/\.json$/, '');
    const idleMinutes = Math.max(0, Math.round((now - claim.time) / 60000));
    const mine = selfId !== undefined && String(claim.owner) === String(selfId);
    // An expired claim is not "nothing in flight": the owner may have been killed. Saying so is
    // the whole point of a derived view — otherwise the reader sees nothing and only learns about
    // the abandoned claim by tripping over it when it happens to write that file.
    if (!claimFresh(claim, config)) {
      expired.push(`- ⚠ \`${rel}\` 的认领已过期（原属会话 ${shortId(claim.owner)}，静默 ${idleMinutes} 分钟）——可接手，动手前先重读该文件`);
      continue;
    }
    live.push(`- \`${rel}\` ← 会话 ${shortId(claim.owner)}${mine ? '（本会话）' : ''}，静默 ${idleMinutes} 分钟`);
  }
  const lines = live.concat(expired);
  for (const takeover of takeovers ?? []) {
    lines.push(
      `- 已接手 \`${takeover.path}\`：原属会话 ${shortId(takeover.owner)} 的认领已过期——动手前先重读该文件`,
    );
  }
  return lines.length === 0 ? undefined : lines.join('\n');
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
export function readJsonlRecords(absolute) {
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
export function tortuousIndexLine(record) {
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
export function renderTortuousIndex(cwd, config) {
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
export function renderJournalTail(cwd, config) {
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
export function renderReadOnDemand(cwd, config) {
  const name = (relative) => `\`${displayPath(cwd, resolveStateFile(cwd, config, relative).absolute)}\``;
  return `按需读（不内联）：${name(config.tortuousFile)}（负知识：失败路线与偏差）、`
    + `${name(config.journalFile)}（工作记录）、\`${displayPath(cwd, resolveStateFile(cwd, config, 'rationale').absolute)}/\`（推导与取证）。`;
}

/**
 * Read the repository state that the digest renders: current branch, HEAD commit and
 * the most recent commit subjects. Read straight from \`.git\` so it is synchronous and
 * needs no subprocess.
 * @param cwd - the session's working directory.
 * @param limit - how many recent commits to report.
 * @returns rendered lines, or undefined when the directory is not a repository.
 */
export function readRepoState(cwd, limit = 8) {
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
 * Resolve a git directory from a working directory, following a \`.git\` file
 * (a worktree or submodule pointer) when present.
 * @param cwd - the session's working directory.
 * @returns the git directory path, or undefined when there is none.
 */
export function gitDirOf(cwd) {
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