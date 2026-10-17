/**
 * The guards — where the protocol stops being prose.
 *
 * privacy-guard: allow — part of the mode's own implementation: the refusals below have to name the
 * state boundary (they tell the agent which document to update, and quote the rule file's path), so
 * the public-surface scan is deliberately not applied to this file.
 *
 * Every guard in this slice answers one question about a tool call that is already being made,
 * and answers it with "allow" or "refuse" plus the reason the refusal is a rule and not an
 * opinion. Registration lives here rather than in the composition root so that adding a guard, or
 * changing what one of them refuses, touches this slice only.
 *
 * Two properties are deliberate:
 * - a guard is **monotonic** — no listener ordering can turn a denial back into permission — and
 *   it runs before the shell body, the only point at which a refused command is guaranteed not to
 *   have executed;
 * - a guard can only refuse or allow. Anything the agent needs to *know* (a claim was taken over,
 *   a budget is exceeded) is carried by the digest instead.
 *
 * @param ctx - the plugin context.
 * @param config - the validated row config.
 * @param states - the per-agent digest state, read by the layout and checkpoint guards.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import { shellCommandOf, localGitEscape, isCommitCommand } from './command.js';
import {
  PRIVACY_ALLOW_MARKER,
  acknowledgesLayout,
  readTreeFacts,
  scanPublicSurface,
} from './privacy.js';
import {
  agentIdentity,
  checkPushGrant,
  claimFiles,
  claimFresh,
  claimPath,
  displayPath,
  gitDirtyPath,
  isInsideStateDir,
  readClaim,
  readIfPresent,
  resolveStateFile,
  runGitOrNothing,
  shortId,
  stateDirDisplayPath,
  stewardDisplayPath,
  writeClaim,
} from '../shared/index.js';

export function registerGuards(ctx, config, states) {

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
          // A forced push rewrites published history: grants never cover it. The flag comes from the
          // parsed invocation, so a global option before the subcommand no longer hides it.
          if (escape.forced === true) {
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
