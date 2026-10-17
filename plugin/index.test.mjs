/**
 * Unit check for the Project Forge mode plugin.
 *
 * privacy-guard: allow — this file is a fixture set: it writes home paths, boundary paths and
 * secret literals into throwaway repositories to prove what the guard refuses, so the privacy
 * scan is deliberately not applied to it.
 *
 * The plugin's behavior is (1) the protocol and recovery prompt sections, (2) the project
 * memory digest — documents, repository state and the repository's own rule file, (3) the
 * recovery message folded into the first post-compaction step, and (4) the guards.
 * This file drives `apply()` against a stub Cordis context that records what was
 * registered, then asserts each layer.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PROJECT_MARKERS,
  agentListeners,
  createdAgent,
  initRepo,
  makeCtx,
  plugin,
  pluginPath,
  project,
  shell,
  standard,
} from '../test/harness.mjs';


assert.equal(plugin.name, 'project-forge', 'plugin name');
assert.deepEqual(plugin.inject, ['systemPrompt', 'tools'], 'injected services');

// ── Config contract ─────────────────────────────────────────────────────────────
// The Loader validates a row's config through the Standard Schema interface
// (`Config['~standard'].validate`). A plain object here fails the whole preset, so this
// contract is asserted before any behavior check.
assert.ok(plugin.Config, 'plugin exports Config');
assert.ok(standard, 'Config implements the ~standard interface');
assert.equal(standard.version, 1, 'standard schema version');
assert.equal(typeof standard.validate, 'function', 'standard schema validate');

for (const [raw, expected] of [
  [undefined, { protocol: true, digest: true, injectOnCompaction: true }],
  [null, { protocol: true, digest: true, injectOnCompaction: true }],
  [{}, { protocol: true, digest: true, injectOnCompaction: true }],
  [{ protocol: false }, { protocol: false, digest: true, injectOnCompaction: true }],
  [{ digest: false }, { protocol: true, digest: false, injectOnCompaction: true }],
]) {
  const result = standard.validate(raw);
  assert.ok(!('issues' in result), `valid config accepted: ${JSON.stringify(raw)}`);
  const value = result.value;
  assert.equal(value.protocol, expected.protocol, `protocol for ${JSON.stringify(raw)}`);
  assert.equal(value.digest, expected.digest, `digest for ${JSON.stringify(raw)}`);
  assert.equal(value.injectOnCompaction, expected.injectOnCompaction, `injectOnCompaction for ${JSON.stringify(raw)}`);
  assert.equal(value.repoStateInDigest, true, 'repoStateInDigest default');
  assert.equal(value.stewardFile, true, 'stewardFile default');
  assert.equal(value.stewardFilePath, 'private/steward.md', 'stewardFilePath default');
  assert.equal(value.stateDir, 'private', 'stateDir default');
  assert.equal(value.guardLocalGit, true, 'guardLocalGit default');
  assert.equal(value.guardCommitCheckpoint, true, 'guardCommitCheckpoint default');
  assert.equal(value.guardPrivacyBoundary, true, 'guardPrivacyBoundary default');
  assert.deepEqual(value.digestFiles, ['plan.md', 'done.md', 'todo.md'], 'contract documents default (least volatile first)');
  assert.deepEqual(
    value.documentBudgets,
    { 'steward.md': 6000, 'plan.md': 15000, 'done.md': 2000, 'todo.md': 5000 },
    'per-document budgets default',
  );
  assert.equal(value.documentBudgetDefault, 20000, 'budget fallback');
  assert.equal(value.journalFile, 'journal.jsonl', 'journal file default');
  assert.equal(value.tortuousFile, 'tortuous.jsonl', 'negative-knowledge file default');
  assert.equal(value.journalRecoveryEntries, 5, 'recovery carries five journal entries');
  assert.equal(value.tortuousIndexBytes, 2500, 'negative-knowledge index ceiling');
  assert.equal(value.digestMaxBytes, 28000, 'digestMaxBytes default (fuse)');
  assert.equal(value.digestRefreshMs, 5000, 'digestRefreshMs default');
  assert.equal(value.claimStaleMs, 600000, 'claimStaleMs default (10 minutes)');
}
for (const [raw, why] of [
  [{ protocol: 'yes' }, 'string for a boolean'],
  [{ nope: 1 }, 'unknown field'],
  [{ digestFiles: [1] }, 'non-string file list'],
  [{ digestMaxBytes: 0 }, 'non-positive number'],
  [{ claimStaleMs: 0 }, 'non-positive claim window'],
  [{ stewardFilePath: '   ' }, 'blank steward path'],
  [{ stateDir: '   ' }, 'blank state directory'],
  [{ documentBudgets: { 'plan.md': 'lots' } }, 'non-numeric per-document budget'],
  [{ documentBudgets: { 'plan.md': 0 } }, 'zero per-document budget'],
  [{ documentBudgets: { 'plan.md': -1 } }, 'negative per-document budget'],
  [{ journalFile: '   ' }, 'blank journal file'],
  [{ tortuousFile: '   ' }, 'blank negative-knowledge file'],
]) {
  const result = standard.validate(raw);
  assert.ok(Array.isArray(result.issues) && result.issues.length > 0, `rejected: ${why}`);
}

// ── Preset patch ↔ schema drift guard ─────────────────────────────────────────
// The preset row is the only place the Loader takes this plugin's config from. When the
// schema renames a field and the patch is not updated (this happened on 2026-10-16:
// `digestTailLimits` survived the v4 rename to `documentBudgets`), every session on the — vocabulary-guard: allow
// preset fails to resume with `invalid config: unknown config field ...`. Validate the
// shipped row through the same Standard Schema the Loader uses, so `npm test` catches it.
{
  const patchPath = [
    join(dirname(pluginPath), '..', 'cordis.patch.yml'), // argv[2] = plugin/index.js
    join(dirname(pluginPath), 'cordis.patch.yml'),       // argv[2] = .../plugin
    join(pluginPath, 'cordis.patch.yml'),                // argv[2] = package root
    join(pluginPath, '..', 'cordis.patch.yml'),
  ].find((candidate) => existsSync(candidate));
  assert.ok(patchPath, 'cordis.patch.yml found next to the plugin package');
  const patchLines = readFileSync(patchPath, 'utf8').split(/\r?\n/);
  const rowIndex = patchLines.findIndex((line) => /^\s*-\s+id:\s*project-forge\s*$/.test(line));
  assert.ok(rowIndex >= 0, 'preset patch declares the project-forge plugin row');

  let nameLine = -1;
  let configLine = -1;
  for (let i = rowIndex + 1; i < patchLines.length; i++) {
    if (/^\s*(#|$)/.test(patchLines[i])) continue;
    if (/^\s*-\s+id:/.test(patchLines[i])) break; // next row
    if (/^\s*name:/.test(patchLines[i])) nameLine = i;
    if (/^\s*config:\s*$/.test(patchLines[i])) { configLine = i; break; }
  }
  assert.ok(nameLine >= 0 && configLine >= 0, 'patch row has a name and a config block');
  const pkg = JSON.parse(readFileSync(join(dirname(patchPath), 'package.json'), 'utf8'));
  assert.equal(
    patchLines[nameLine].replace(/^\s*name:\s*/, '').replace(/^['"]|['"]$/g, ''),
    pkg.name,
    'patch row loads this package',
  );

  // Direct children of `config:` are scalars; any nested mapping (e.g. documentBudgets)
  // is collected as an object of its own scalar children.
  const configIndent = patchLines[configLine].match(/^\s*/)[0].length;
  const parseScalar = (text) => {
    const value = text.trim().replace(/\s+#.*$/, '');
    if (value === 'true' || value === 'false') return value === 'true';
    if (/^-?\d+$/.test(value)) return Number(value);
    if (/^\[.*\]$/.test(value)) return value.slice(1, -1).split(',').map((item) => item.trim()).filter(Boolean);
    return value.replace(/^['"]|['"]$/g, '');
  };
  const rowConfig = {};
  let childIndent = -1;
  let currentKey = null;
  for (let i = configLine + 1; i < patchLines.length; i++) {
    const line = patchLines[i];
    if (/^\s*(#|$)/.test(line)) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= configIndent) break;
    const entry = /^\s*([A-Za-z_][\w]*):\s*(.*)$/.exec(line);
    if (!entry) continue;
    const key = entry[1];
    const rawValue = entry[2] ?? '';
    if (childIndent < 0) childIndent = indent;
    if (indent > childIndent) {
      if (currentKey !== null && rowConfig[currentKey] !== null && typeof rowConfig[currentKey] === 'object') {
        rowConfig[currentKey][key] = parseScalar(rawValue);
      }
      continue;
    }
    currentKey = key;
    rowConfig[key] = rawValue.trim() === '' ? {} : parseScalar(rawValue);
  }

  const checked = standard.validate(rowConfig);
  assert.ok(
    !('issues' in checked),
    `preset patch config satisfies the plugin schema: ${JSON.stringify(checked.issues ?? [])}`,
  );
}


// ── Protocol and recovery sections ──────────────────────────────────────────────
{
  const { ctx, record } = makeCtx();
  plugin.apply(ctx, standard.validate({ digest: false, injectOnCompaction: false }).value);
  assert.deepEqual(
    record.sections.map((section) => section.name),
    ['project-forge:protocol', 'project-forge:recovery'],
    'both sections registered',
  );
  const protocol = record.sections[0].text({});
  const recovery = record.sections[1].text({});
  assert.equal(record.sections[0].order, 400, 'protocol order');
  assert.equal(record.sections[1].order, 410, 'recovery order');

  // §-by-§: every rule the protocol is expected to state, as it is worded now. The wording
  // assertions are intentionally literal — they fail when a rule is silently reworded away,
  // which is the failure mode a prompt rewrite actually has.
  for (const needle of [
    // §0: the five layers and where they live.
    '持久化', '当前状态', '下一步状态', '战略', '负知识', '工作记录', '这些文件都在状态边界内',
    // §1: local git, the consumable grant, the boundary, the open-source surface.
    'git init', 'push allowed:', '可消耗的许可，不是长期权限', 'guardSecrets',
    '把公开面当作项目已经开源来写', '删掉 `private/`、复制整棵树、`git init`',
    '可移植，无机器痕迹', '除配置外不含隐私', '示例孪生', '从第一天起就有开源卫生',
    'README 描述这条边界约定是允许的', '不得有指向边界的悬空引用',
    'guardPrivacyBoundary', '把本机家目录、伸手进边界的源码文件',
    // §2: the checkpoint loop.
    '提交是**检查点**', '检查公开面', '任务级的发布许可随任务一起死亡', 'feat:', 'docs:',
    // §3: README versus docs.
    '我刚拿到这个项目', '过期的文档就是缺陷', '绝不让 README 长成 docs',
    // §4: the three classes, the warning line, and the fixed section orders.
    '合同', '记录', '按需', '整份内联，绝不截断', '告警线，不是裁剪线', '顺序就是牺牲顺序',
    '窗口吃**头**', '只允许在文件末尾追加', '一条记录一行', '类型标记写在记录前部',
    'Current state', 'Verification', 'Drift', '不写"最短复现路径"', '越预算时把最旧的工作记录搬进',
    '## 排队', '## 待验证', '## 等用户', '## 现在做', '一条一行、可开工',
    '一次一个"当前方向"', '显式处置',
    'journal.jsonl', 'tortuous.jsonl', 'kind', 'conclusion', 'rationale/',
    '文件里不抄规则',
    '只记失败的探索', '绝不因为难堪',
    // §5: layered organization and the layout rules.
    '分层模块化层级 + 明确模块边界与依赖方向', '高内聚、低耦合、最小重复',
    '只要必要注释', '解释 **why**',
    '布局主要是给人类开发者看的，不是给 agent 看的', '你的方便绝不能决定结构',
    '五秒测试', '不开任何文件就能说出', '名字表达意义，而不是机制', '绝不按产生时间命名',
    '这条规则适用于每一层，不只顶层', '位置也是历史的一部分', '每个检查点都重新审视布局',
    // §6: naming and the controlled vocabulary.
    '每个名字恰好表示一件事，每件事恰好有一个名字', '受控词汇', '一个概念，一个词，处处一致',
    '高熵词才是要修的词', '信号不是频率，是**散布**',
    '小写、无空格、无日期、无版本号、无个人名字',
    'misc`、`utils`、`helpers`、`common`、`shared`、`temp`、`new`、`old`、`backup`、`extra`、`stuff',
    '不可能不小心出现第二个同类的', '集合用复数',
    '文件名说明**这个文件是什么**', '一个文件一个主要概念', '测试文件镜像它测试的对象',
    '名字是关于领域的词组', '长度随它可见的作用域增大', '布尔名读起来要像断言',
    '一个名字里需要"and"的函数是两个函数', '不编码噪音',
    '被记录的偏差是知识；没被记录的是腐烂', '读目录列表，再读文件名',
    '尺度不改变规则，只改变数量', '趋势比任何单个名字更重要',
    // §7: the tree, artifact kinds, tests.
    '整棵树——每个目录，不只是根', '绝不散落在项目根',
    '组织成项目根下的独立 `test/` 项目', '超过三个测试文件是"做这个判断"的触发信号',
    '单个测试文件不是 §7.1 或 §5.5 的豁免', '不同种类的产物绝不共用一个架子',
    '每一次重构都记进 `journal.jsonl`',
    // §8 / §9 / §10: repo rules, consistency, completion.
    '仓库可以携带自己的规则', '把这次覆盖记进 `plan.md`',
    '发现漂移是你的工作，不是用户的', '上下文压缩之后立即', '公开面',
    '只有以下**全部**成立，任务才算完成',
    // §11 / §12: takeover and parallel sessions.
    '走查整棵目录树', '提出重新分组', '并发协调靠机制，不靠手工清单',
    '不要手工维护"在办"列表', '动手前先重读那个文件', 'claimStaleMs',
    '单一文档主', '立即提交文档改动', 'guardConcurrentWrite',
    'spawn 出来的子 agent 什么都不继承', '两种子 agent 模式', 'subagent_fork', '干净房间',
    '如果你是那个子 agent', '默认只读探索', '给父方审阅的输入',
  ]) {
    assert.ok(protocol.includes(needle), `protocol mentions ${needle}`);
  }
  for (const needle of ['`private/tortuous.jsonl`', '`plan.md`', '`todo.md`', '`done.md`', '状态一致性检查', 'git status']) {
    assert.ok(recovery.includes(needle), `recovery mentions ${needle}`);
  }
  // The prompt must not carry the developer's own history: incidents, dates, session ids or a
  // real machine path are facts about someone's machine, not rules a new agent needs. The
  // placeholder forms the protocol uses to illustrate the rule (`C:\Users\…`, `/home/…`) end
  // in an ellipsis and have no second segment, so they are not what these patterns match.
  for (const leaked of [
    /20\d\d-\d\d-\d\d/,
    /session-[0-9a-f]{8}/,
    /[A-Za-z]:\\[A-Za-z0-9._-]+\\[A-Za-z0-9]/,
    /\/(?:home|Users)\/[A-Za-z0-9._-]+\//,
  ]) {
    assert.ok(!leaked.test(protocol), `protocol carries no developer history: ${leaked}`);
  }
  // A link in the protocol would be an external reference, and the protocol must stand alone
  // (its rationale lives in the repository, not behind a URL). This says NOTHING about project
  // content: project documents and source may link freely — they are inlined into the digest
  // as the project's own facts, and the privacy guard deliberately allows them.
  assert.ok(!/https?:\/\//.test(protocol), 'protocol is self-contained: no external links');
  assert.ok(!protocol.includes('{{'), 'no unrendered variables');
  console.log('sections: OK');
}

{
  // Each switch disables exactly its own section.
  for (const [raw, expected] of [
    [{ protocol: false, digest: false, injectOnCompaction: false }, ['project-forge:recovery']],
    [{ recoveryProcedure: false, digest: false, injectOnCompaction: false }, ['project-forge:protocol']],
    [{ protocol: false, recoveryProcedure: false, digest: false, injectOnCompaction: false }, []],
  ]) {
    const { ctx, record } = makeCtx();
    plugin.apply(ctx, standard.validate(raw).value);
    assert.deepEqual(record.sections.map((section) => section.name), expected, `config ${JSON.stringify(raw)}`);
  }
  console.log('section switches: OK');
}

// ── Digest: documents, repository state, steward file ───────────────────────────

{
  const { ctx, record } = makeCtx();
  plugin.apply(ctx, standard.validate({}).value);
  const { contexts } = createdAgent(record, project);
  assert.equal(contexts.length, 1, 'digest context registered');
  const digest = contexts[0];
  assert.equal(digest.name, 'project-forge:digest', 'digest name');
  assert.equal(digest.order, 130, 'digest order');
  assert.equal(digest.interpolate, false, 'document prose is not interpolated');

  const text = digest.text({});
  for (const marker of [PROJECT_MARKERS.plan, PROJECT_MARKERS.todo, PROJECT_MARKERS.done]) {
    assert.ok(text.includes(marker), `digest inlines ${marker}`);
  }
  assert.ok(
    text.includes(PROJECT_MARKERS.tortuousHeadline),
    'the negative-knowledge index carries the record headline',
  );
  assert.ok(!text.includes(PROJECT_MARKERS.tortuousProse), 'the record prose is never inlined');
  assert.ok(text.includes('tortuous.jsonl'), 'the digest names the read-on-demand files');
  assert.ok(text.includes('STEWARD-MARK'), 'the repository rule file is inlined');
  assert.ok(text.includes('## Repository state'), 'repository state is inlined');
  assert.ok(text.includes('branch:'), 'branch reported');
  assert.ok(text.includes('HEAD:'), 'HEAD reported');
  assert.ok(text.includes('chore: initial commit'), 'recent commit subject reported');
  console.log('digest: OK');

  // ── The state boundary: documents under `private/` ───────────────────────────
  // This fixture is the layout the protocol now asks for: everything the project keeps for
  // itself — the four documents and the steward rules — inside one directory, and the public
  // surface outside it. (The block above is the fallback case: documents still at the root
  // and rules at `.agents/steward.md` are read there, so a project forged before the
  // boundary existed keeps working.)
  const bounded = mkdtempSync(join(tmpdir(), 'steward-boundary-'));
  mkdirSync(join(bounded, 'private'), { recursive: true });
  writeFileSync(join(bounded, 'private', 'plan.md'), `# plan\n${PROJECT_MARKERS.plan}\n`);
  writeFileSync(join(bounded, 'private', 'todo.md'), `# todo\n${PROJECT_MARKERS.todo}\n`);
  writeFileSync(join(bounded, 'private', 'done.md'), `# done\n${PROJECT_MARKERS.done}\n`);
  writeFileSync(join(bounded, 'private', 'steward.md'), '# repo rules\nBOUNDARY-STEWARD-MARK\n');
  writeFileSync(join(bounded, 'README.md'), '# project\n');
  initRepo(bounded);

  const { ctx: boundaryCtx, record: boundaryRecord } = makeCtx();
  plugin.apply(boundaryCtx, standard.validate({ injectOnCompaction: false }).value);
  const { contexts: boundaryContexts } = createdAgent(
    boundaryRecord,
    bounded,
    `session-boundary-${Date.now().toString(36)}`,
  );
  const boundaryText = boundaryContexts[0].text({});
  for (const marker of [PROJECT_MARKERS.plan, PROJECT_MARKERS.todo, PROJECT_MARKERS.done]) {
    assert.ok(boundaryText.includes(marker), `the boundary digest inlines ${marker}`);
  }
  assert.ok(boundaryText.includes('### private/plan.md'), 'documents are labelled by their path inside the boundary');
  assert.ok(boundaryText.includes('BOUNDARY-STEWARD-MARK'), 'the steward rules are read from inside the boundary');
  assert.ok(boundaryText.includes('private/steward.md (this repository'), 'the rules are labelled with their path');
  // The per-document budget is keyed by the configured name, not by the resolved path.
  assert.ok(!boundaryText.includes('…omitted'), 'a small document is not truncated by the boundary label');
  rmSync(bounded, { recursive: true, force: true });
  console.log('state boundary: OK');

  // ── Digest braces: a document quoting {{…}} must not poison prompt assembly ───
  // dsh-system-prompt always interpolates context entries (the interpolate option
  // exists only for sections), and a strict {{name}} scan throws on Vue/mustache
  // syntax like {{playCount|formatPlayCount}} — which killed real sessions
  // (dc6b5fa7 10-03, 4ddb3937 10-13: every turn failed with
  // "malformed prompt variable reference" until the digest text changed).
  writeFileSync(
    join(project, 'done.md'),
    `# done\n${PROJECT_MARKERS.done}\nquote: {{playCount|formatPlayCount}} and {{ok}}\n`,
  );
  const { contexts: braceContexts } = createdAgent(record, project, 'session-braces');
  const braceDigest = braceContexts[0];
  const braceText = braceDigest.text({});
  assert.ok(!braceText.includes('{{'), 'no raw {{ survives into the digest');
  assert.ok(braceText.includes('{ {playCount|formatPlayCount}}'), 'the quoted template stays readable');
  // The strict scan that killed those sessions, replayed over the digest:
  assert.doesNotThrow(() => /\{\{[^}]*\}\}/.test(braceText) && (() => {
    for (const m of braceText.matchAll(/\{\{(.*?)\}\}/g)) {
      if (!/^[a-z][a-z0-9_]*$/.test(m[1])) throw new Error(`malformed prompt variable reference "{{${m[1]}}}"`);
    }
  })(), 'a dsh-style strict scan of the digest does not throw');
  console.log('digest braces: OK');

  // ── Checkpoint guard: compaction arms it, a document write disarms it ─────────
  const { ctx: guardCtx, record: guardRecord } = makeCtx();
  plugin.apply(guardCtx, standard.validate({}).value);
  const { agent } = createdAgent(guardRecord, project);
  const { agent: guardAgent } = createdAgent(guardRecord, project, 'session-guard');
  const commitGuard = guardRecord.guards.find(
    (guard) => typeof guard({ name: 'pwsh', arguments: { command: 'git commit -m x' }, agent: guardAgent }) === 'string',
  ) ?? guardRecord.guards.find(
    (guard) => guard({ name: 'pwsh', arguments: { command: 'git commit -m x' }, agent: guardAgent }) !== undefined,
  );
  const commit = (target) => ({ name: 'pwsh', arguments: { command: 'git commit -m "x"' }, agent: target });
  const shell = (command, target) => ({ name: 'pwsh', arguments: { command }, agent: target });

  // Before any compaction: a commit is allowed (this repository is consistent).
  const preStep = guardRecord.listeners.filter((entry) => entry.name === 'agent/pre-step');
  const next = async () => ({ kind: 'proceed', messages: [{ id: 'u1', role: 'user' }] });
  const guardEvents = agentListeners(guardAgent).find((entry) => entry.name === 'session/event');
  assert.ok(guardEvents, 'the guard agent also listens for compaction events');
  guardEvents.handler(guardAgent.session, { type: 'compaction/end', seq: 3 });
  await preStep[0].handler({ agent: guardAgent, turn: 1, step: 1 }, next);

  const refused = commitGuard(commit(guardAgent));
  assert.equal(typeof refused, 'string', 'a post-compaction commit is refused');
  assert.ok(refused.includes('不是一个一致状态的检查点'), 'refusal explains why');
  assert.ok(refused.includes('done.md'), 'refusal names the document to update');

  // Writing a state document disarms it.
  const touchListener = guardRecord.listeners.find((entry) => entry.name === 'tools/result');
  touchListener.handler(
    { name: 'edit', arguments: { file_path: join(project, 'done.md') }, agent: guardAgent },
    { isError: false },
  );
  assert.equal(commitGuard(commit(guardAgent)), undefined, 'the checkpoint guard clears after a document update');

  // Unrelated tools and non-commit commands are untouched.
  assert.equal(commitGuard({ name: 'read', arguments: {}, agent: guardAgent }), undefined, 'other tools untouched');
  assert.equal(commitGuard(shell('git status --short', guardAgent)), undefined, 'non-commit commands untouched');
  assert.ok(agent.id !== guardAgent.id, 'sanity');
  console.log('checkpoint guard: OK');

  // ── Recovery: the real compaction event, once per compaction, once per turn ──
  {
    // A unique id per run: recovery markers are persisted per session on disk, so a fixed
    // id would make the second run of this file start already-recovered.
    const unique = `session-recovery-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const { ctx: recCtx, record: recRecord } = makeCtx();
    plugin.apply(recCtx, standard.validate({}).value);
    const { agent: recAgent } = createdAgent(recRecord, project, unique);
    const preStepHandler = recRecord.listeners.find((entry) => entry.name === 'agent/pre-step').handler;
    const proceed = async () => ({ kind: 'proceed', messages: [{ id: 'u1', role: 'user' }] });
    const step = (turn, stepNumber) => preStepHandler({ agent: recAgent, turn, step: stepNumber }, proceed);
    const recoveryOf = (decision) =>
      decision.messages.find((message) => message.id?.startsWith('project-forge:recovery:'));

    // The listener must live on the agent's own context: `session/event` is a Scoped
    // event and a plugin-scoped registration does not receive it.
    const eventListener = agentListeners(recAgent).find((entry) => entry.name === 'session/event');
    assert.ok(eventListener, 'the compaction listener is registered on the agent context');

    // A surface generation change alone (pruning, spill) must NOT arm recovery.
    recAgent.session.surface.replaceGeneration = 7;
    let decision = await step(1, 1);
    assert.equal(recoveryOf(decision), undefined, 'a generation change alone does not inject recovery');

    // A real compaction arms it, and the next eligible step carries it.
    eventListener.handler(recAgent.session, { type: 'compaction/end', seq: 12 });
    decision = await step(1, 1);
    const message = recoveryOf(decision);
    assert.ok(message, 'a compaction/end arms one recovery message');
    assert.equal(message.role, 'user', 'recovery rides the user role for the model');
    assert.equal(message.source.kind, 'project-forge', 'recovery declares its own producer kind');
    assert.equal(message.source.form, 'snapshot', 'recovery uses the injected-context form');
    assert.equal(message.source.sections.length, 1, 'recovery carries one named section');
    assert.equal(message.source.sections[0].name, 'project-forge:recovery', 'section name');
    assert.ok(message.source.sections[0].text.includes('Project Forge recovery:'), 'section text matches the body');
    assert.ok(
      message.content[0].text.includes(PROJECT_MARKERS.done),
      'the recovery message carries the digest',
    );

    // Same compaction, later steps: nothing more.
    assert.equal(recoveryOf(await step(1, 2)), undefined, 'later steps of the same turn stay quiet');
    assert.equal(recoveryOf(await step(2, 1)), undefined, 'a later turn without compaction stays quiet');

    // Two compactions inside one turn still produce at most one message.
    eventListener.handler(recAgent.session, { type: 'compaction/end', seq: 20 });
    eventListener.handler(recAgent.session, { type: 'compaction/end', seq: 21 });
    const first = await step(3, 1);
    assert.ok(recoveryOf(first), 'the first step of the turn carries recovery');
    assert.equal(recoveryOf(await step(3, 2)), undefined, 'the second step of that turn does not repeat it');

    // A distinct compaction in a new turn is answered again, once.
    eventListener.handler(recAgent.session, { type: 'compaction/end', seq: 30 });
    const second = await step(4, 1);
    const secondMessage = recoveryOf(second);
    assert.ok(secondMessage, 'a new compaction is answered in its own turn');
    assert.notEqual(secondMessage.id, message.id, 'each compaction gets its own message id');
    console.log('recovery message: OK');
  }

  // ── Guard A: local-only git, with no false positives ─────────────────────────
  const localGitGuard = guardRecord.guards.find(
    (guard) => typeof guard(shell('git push origin main', guardAgent)) === 'string',
  );
  assert.ok(localGitGuard, 'the local-git guard is registered');
  for (const command of [
    'git push',
    'git remote add origin https://example.com/x.git',
    'git remote set-url origin https://example.com/x.git',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git branch -D feature',
  ]) {
    assert.ok(
      String(localGitGuard(shell(command, guardAgent))).includes('仅本地'),
      `refuses ${command}`,
    );
  }
  for (const command of [
    'git status --short',
    'git log --oneline',
    'git add -A && git commit -m "docs: note that we never git push"',
    "git commit -m 'remote add is forbidden here'",
    'echo "git push"',
    'git fetch --all',
    'git remote -v',
  ]) {
    assert.equal(localGitGuard(shell(command, guardAgent)), undefined, `allows ${command}`);
  }
  // The bypass surfaces found by probing (T43): a git global option used to sit between `git` and
  // its subcommand, or a shell wrapper hiding the real command inside quotes, or the plumbing push.
  for (const command of [
    'git -c credential.helper=store push origin main',
    'git -c push.default=current push',
    'git -C . push origin main',
    'git --no-pager push origin main',
    'git -c core.pager=cat push origin main',
    'bash -c "git push origin main"',
    'sh -c \'git push origin main\'',
    'pwsh -NoProfile -Command "git push origin main"',
    'git send-pack origin main',
    'git -c credential.helper=store send-pack origin main',
    'git config --global alias.p push',
    'gh api -X POST /repos/o/r/git/refs',
    'gh api --method=PATCH /repos/o/r',
    'gh release create v1',
  ]) {
    assert.ok(
      String(localGitGuard(shell(command, guardAgent))).includes('仅本地'),
      `refuses the bypass shape ${command}`,
    );
  }
  // Still allowed: read-only or unrelated uses, including the plumbing that does not publish.
  for (const command of [
    'git fetch --all --prune',
    'git remote update',
    'git --no-pager log --oneline',
    'bash -c "git status --short"',
    'gh api /repos/o/r',
    'gh pr list',
  ]) {
    assert.equal(localGitGuard(shell(command, guardAgent)), undefined, `still allows ${command}`);
  }
  console.log('local-git guard: OK');

  // ── Guard A: one-shot push grants — consume on use, never standing permission ──
  {
    const { readFileSync: rfs2 } = await import('node:fs');
    const repo = mkdtempSync(join(tmpdir(), 'forge-grant-'));
    writeFileSync(join(repo, 'app.py'), 'print(1)\n');
    mkdirSync(join(repo, '.agents'), { recursive: true });
    initRepo(repo);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/sopreigj/nhentai-downloader.git'], { cwd: repo, stdio: 'pipe' });

    const { ctx: gCtx, record: gRecord } = makeCtx();
    plugin.apply(gCtx, standard.validate({ injectOnCompaction: false }).value);
    const { agent: gAgent } = createdAgent(gRecord, repo, `session-grant-${Date.now().toString(36)}`);
    const pushGuard = gRecord.guards.find(
      (guard) => typeof guard(shell('git push origin main', gAgent)) === 'string',
    );
    assert.ok(pushGuard, 'the push guard is registered');

    // No grant: refused, and the refusal teaches the one-shot grant syntax.
    const noGrant = pushGuard(shell('git push origin main', gAgent));
    assert.ok(String(noGrant).includes('仅本地') && String(noGrant).includes('push allowed:'), 'refused without a grant, with grant syntax in the refusal');

    // Write a ×1 grant: one push passes, the grant line is consumed, the next push is refused.
    writeFileSync(join(repo, '.agents', 'steward.md'), '# rules\n\npush allowed: github.com/sopreigj/nhentai-downloader ×1\n');
    assert.equal(pushGuard(shell('git push origin main', gAgent)), undefined, 'first push consumes the ×1 grant');
    const stewardAfter1 = rfs2(join(repo, '.agents', 'steward.md'), 'utf8');
    assert.ok(!stewardAfter1.includes('push allowed'), 'the ×1 grant line is gone after use');
    assert.ok(String(pushGuard(shell('git push origin main', gAgent))).includes('仅本地'), 'second push refused — the grant was one-shot');

    // ×2 grant: counts down, then runs out.
    writeFileSync(join(repo, '.agents', 'steward.md'), 'push allowed: github.com/sopreigj/* ×2\n');
    assert.equal(pushGuard(shell('git push origin main', gAgent)), undefined, 'first of ×2');
    assert.ok(rfs2(join(repo, '.agents', 'steward.md'), 'utf8').includes('×1'), 'counted down to ×1');
    assert.equal(pushGuard(shell('git push origin main', gAgent)), undefined, 'second of ×2');
    assert.ok(!rfs2(join(repo, '.agents', 'steward.md'), 'utf8').includes('push allowed'), '×2 exhausted, line removed');
    assert.equal(typeof pushGuard(shell('git push origin main', gAgent)), 'string', 'third push refused');

    // A grant for a different remote does not cover this one.
    writeFileSync(join(repo, '.agents', 'steward.md'), 'push allowed: github.com/someone-else/*\n');
    assert.ok(String(pushGuard(shell('git push origin main', gAgent))).includes('仅本地'), 'mismatched grant refused');

    // An explicit-URL push matches the URL form directly.
    writeFileSync(join(repo, '.agents', 'steward.md'), 'push allowed: github.com/sopreigj/* ×1\n');
    assert.equal(pushGuard(shell('git push https://github.com/sopreigj/nhentai-downloader.git main', gAgent)), undefined, 'explicit-URL push covered by glob grant');

    // Force pushes are never covered by a grant, even with grants in stock.
    writeFileSync(join(repo, '.agents', 'steward.md'), 'push allowed: *\n');
    assert.ok(String(pushGuard(shell('git push -f origin main', gAgent))).includes('强推'), 'force push refused despite wildcard grant');
    assert.ok(String(pushGuard(shell('git push --force-with-lease origin main', gAgent))).includes('强推'), 'force-with-lease refused');
    assert.ok(String(pushGuard(shell('git remote add upstream https://github.com/x/y.git', gAgent))).includes('仅本地'), 'remote add never covered');

    // The predicate is about the *command*, not the tool that carries it: a command inside another
    // tool's arguments (an MCP tool, say) is inspected too. Anything outside command/cmd stays out
    // of reach, and that boundary is asserted here rather than described in prose.
    const wrapped = (command) => ({ name: 'mcp__example__tool_invoke', arguments: { tool: 'run', command }, agent: gAgent });
    assert.ok(String(pushGuard(wrapped('git remote add upstream https://github.com/x/y.git'))).includes('仅本地'), 'a command carried by another tool is inspected');
    assert.equal(pushGuard(wrapped('kicad-cli pcb export step')), undefined, 'an unrelated command carried by another tool is allowed');
    assert.equal(
      pushGuard({ name: 'mcp__example__tool_invoke', arguments: { note: 'git remote add upstream https://github.com/x/y.git' }, agent: gAgent }),
      undefined,
      'a command outside command/cmd stays out of reach (documented boundary)',
    );

    rmSync(repo, { recursive: true, force: true });
    console.log('one-shot push grants: OK');
  }

  // ── All six guards are switchable ────────────────────────────────────────────
  const { ctx: offCtx, record: offRecord } = makeCtx();
  plugin.apply(offCtx, standard.validate({
    digest: false,
    injectOnCompaction: false,
    guardLocalGit: false,
    guardCommitCheckpoint: false,
    guardLayoutCheckpoint: false,
    guardSecrets: false,
    guardPrivacyBoundary: false,
    guardConcurrentWrite: false,
    guardAppendOnly: false,
  }).value);
  assert.equal(offRecord.guards.length, 0, 'no guards when every guard is off');
  console.log('guard switches: OK');

  // ── Guard F: malformed tool-call repair ─────────────────────────────────────
  // A model that writes a broken function tag (mimo-v2.6-flash does this under
  // frustration) makes pi-ai emit a tool-call block with an EMPTY id. The loop
  // survives that in memory, but the V4 session codec refuses to persist the
  // tool/result with an empty callId ("requires toolCallId matching its tool
  // source"), the drain wedges on the poisoned batch, and the session file
  // freezes mid-turn forever — seven sessions died exactly so, 2026-10-08..12.
  // The repair rewrites the empty id to a synthetic one at the stream boundary,
  // turning the fatal poison into an ordinary unknown-tool error.
  {
    const { ctx: mCtx, record: mRecord } = makeCtx();
    plugin.apply(mCtx, standard.validate({ digest: false, injectOnCompaction: false }).value);
    const streamListener = mRecord.listeners.find((entry) => entry.name === 'llm/stream');
    assert.ok(streamListener, 'the llm/stream repair listener is registered');

    const { agent: mAgent } = createdAgent(mRecord, project, 'session-malformed');
    const options = { sessionId: mAgent.session.header.id };

    async function* malformedStream() {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'let me run ' };
      yield { type: 'block-start', index: 1, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 1, id: '', argumentsDelta: '{"command":"ls' };
      yield { type: 'tool-call-delta', index: 1, id: '', argumentsDelta: '"}' };
      yield {
        type: 'block-end',
        index: 1,
        block: { type: 'tool-call', id: '', name: '', arguments: '{"command":"ls"}' },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    }

    const repaired = [];
    for await (const chunk of streamListener.handler(options, () => malformedStream())) repaired.push(chunk);
    const deltas = repaired.filter((chunk) => chunk.type === 'tool-call-delta');
    const end = repaired.find((chunk) => chunk.type === 'block-end');
    assert.ok(end.block.id.length > 0, 'the empty block id is repaired');
    assert.ok(end.block.id.startsWith('malformed-'), 'the synthetic id is recognisable');
    assert.equal(deltas.length, 2, 'both deltas pass through');
    assert.ok(deltas.every((chunk) => chunk.id === end.block.id), 'deltas and block-end agree on the synthetic id');
    assert.equal(end.block.name, '', 'the name is left alone — the call fails as unknown tool, recoverably');
    assert.ok(
      mRecord.logs.some(([level, ...rest]) => level === 'warn' && rest.join(' ').includes('malformed')),
      'the repair is logged',
    );

    // A well-formed stream passes through untouched (identity check per chunk).
    async function* healthyStream() {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: 'call_abc', name: 'pwsh', argumentsDelta: '{}' };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'call_abc', name: 'pwsh', arguments: '{}' },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    }
    const healthy = [];
    for await (const chunk of streamListener.handler(options, () => healthyStream())) healthy.push(chunk);
    assert.equal(healthy.length, 4, 'healthy stream chunk count unchanged');
    assert.equal(healthy[2].block.id, 'call_abc', 'a well-formed id is untouched');

    // Streams of other presets' sessions are not touched (the waterfall is process-wide).
    async function* foreignStream() {
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: '', name: '', arguments: '{}' },
      };
    }
    const foreign = [];
    for await (const chunk of streamListener.handler({ sessionId: 'session-not-ours' }, () => foreignStream())) {
      foreign.push(chunk);
    }
    assert.equal(foreign[0].block.id, '', 'a session this plugin does not own is left alone');
    console.log('malformed tool-call repair: OK');
  }

  // ── Guard G switch: repair can be disabled ───────────────────────────────────
  {
    const { ctx: noRepairCtx, record: noRepairRecord } = makeCtx();
    plugin.apply(noRepairCtx, standard.validate({
      digest: false,
      injectOnCompaction: false,
      guardMalformedToolCall: false,
    }).value);
    assert.ok(
      !noRepairRecord.listeners.some((entry) => entry.name === 'llm/stream'),
      'no llm/stream listener when the repair is off',
    );
    console.log('malformed tool-call repair switch: OK');
  }


  // ── Guard E: per-file claims allow parallel work on different files ──────────
  {
    const repo = mkdtempSync(join(tmpdir(), 'forge-concurrent-'));
    writeFileSync(join(repo, 'done.md'), '# done\nbaseline\n');
    writeFileSync(join(repo, 'plan.md'), '# plan\n');
    writeFileSync(join(repo, 'todo.md'), '# todo\n');
    writeFileSync(join(repo, 'a.py'), 'print(1)\n');
    writeFileSync(join(repo, 'b.py'), 'print(2)\n');
    initRepo(repo);
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'chore: init'], { cwd: repo, stdio: 'pipe' });

    const { ctx: cwCtx, record: cwRecord } = makeCtx();
    plugin.apply(cwCtx, standard.validate({ injectOnCompaction: false }).value);
    const hexA = `${Date.now().toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    const hexB = `${(Date.now() + 1).toString(16).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
    const { agent: agentA } = createdAgent(cwRecord, repo, `session-${hexA}`);
    const { agent: agentB } = createdAgent(cwRecord, repo, `session-${hexB}`);
    // Guard E is the last-registered guard.
    const cwGuard = cwRecord.guards[cwRecord.guards.length - 1];
    assert.ok(cwGuard, 'the concurrent-write guard is registered');

    // Two agents writing DIFFERENT files both proceed (parallel work on different places).
    assert.equal(cwGuard({ name: 'write', arguments: { file_path: join(repo, 'a.py') }, agent: agentA }), undefined, 'A writes a.py');
    assert.equal(cwGuard({ name: 'write', arguments: { file_path: join(repo, 'b.py') }, agent: agentB }), undefined, 'B writes b.py in parallel');
    assert.equal(cwGuard({ name: 'write', arguments: { file_path: join(repo, 'done.md') }, agent: agentA }), undefined, 'A writes done.md');

    // A second agent on the SAME file is refused while A's claim holds.
    const refused = cwGuard({ name: 'write', arguments: { file_path: join(repo, 'done.md') }, agent: agentB });
    assert.equal(typeof refused, 'string', 'B is refused on a file A has claimed');
    assert.ok(/已被会话/.test(refused), 'the refusal names the claim');
    // The refusal must show a recognisable owner id, not the "session-" prefix: owner ids all
    // start with "session-", so a naive slice(0,8) rendered an anonymous ghost (real bug,
    // PaperQuer 2026-10-08). The UUID portion must be visible.
    assert.ok(!/已被会话 session-$/.test(refused), 'the owner id is not truncated to "session-"');
    assert.ok(/已被会话 [0-9a-f]{8}/.test(refused), 'the refusal shows the owner UUID');

    // A stale claim (owner gone quiet past the staleness window) is deleted and taken over.
    const { readFileSync: rfs, writeFileSync: wfs, existsSync: exs } = await import('node:fs');
    const claimDir = join(repo, 'private', '.forge-claims');
    const doneClaim = JSON.parse(rfs(join(claimDir, 'done.md.json'), 'utf8'));
    wfs(join(claimDir, 'done.md.json'), JSON.stringify({ owner: 'session-zzz-gone-0000-000000000000', time: Date.now() - 31 * 60 * 1000 }));
    assert.equal(cwGuard({ name: 'write', arguments: { file_path: join(repo, 'done.md') }, agent: agentB }), undefined, 'B takes over a stale claim');
    assert.ok(!exs(join(claimDir, 'done.md.json')) || JSON.parse(rfs(join(claimDir, 'done.md.json'), 'utf8')).owner === agentB.session.header.id, 'the stale claim is deleted or re-owned by B, never left as residue');

    // A successful commit releases every claim in the project.
    const commitListeners = cwRecord.listeners.filter((entry) => entry.name === 'tools/result');
    assert.ok(commitListeners.length > 0, 'tools/result listeners exist');
    assert.ok(exs(join(claimDir, 'a.py.json')), 'a.py is claimed before the commit');
    for (const listener of commitListeners) {
      listener.handler({ name: 'pwsh', arguments: { command: 'git commit -m "release"' }, agent: agentA }, { isError: false });
    }
    assert.ok(!exs(join(claimDir, 'a.py.json')), 'a commit releases every claim');
    assert.ok(!exs(join(claimDir, 'b.py.json')), 'including claims held by other sessions');

    // A file outside the project is never claimed: scratch files in Temp or elsewhere must
    // not leave claims in this project's claim directory.
    const outside = join(tmpdir(), `forge-outside-${Date.now().toString(36)}.py`);
    writeFileSync(outside, 'print(0)\n');
    assert.equal(cwGuard({ name: 'write', arguments: { file_path: outside }, agent: agentA }), undefined, 'an outside file is writable');
    const claimNames = exs(claimDir) ? (await import('node:fs')).readdirSync(claimDir) : [];
    assert.ok(!claimNames.some((name) => name.includes('forge-outside')), 'no claim is created for an outside file');

    // A file on ANOTHER DRIVE is the case `path.relative` cannot express: it returns the
    // target unchanged, so the "starts with .." test alone let a scratch file under %TEMP%
    // be claimed by a project on a different drive (real defect, 2026-10-14).
    {
      const { existsSync: exs2, readdirSync: rds2 } = await import('node:fs');
      const ownDrive = tmpdir().slice(0, 1).toUpperCase();
      const otherDrive = ['C', 'D', 'E', 'F'].find((letter) => letter !== ownDrive && exs2(`${letter}:\\`));
      if (otherDrive === undefined) {
        console.log('cross-drive claim check skipped (no second drive)');
      } else {
        const crossDrive = `${otherDrive}:\\forge-crossdrive-${Date.now().toString(36)}.py`;
        try {
          writeFileSync(crossDrive, 'print(0)\n');
          assert.equal(
            cwGuard({ name: 'write', arguments: { file_path: crossDrive }, agent: agentA }),
            undefined,
            'a cross-drive file is writable',
          );
          assert.ok(
            !rds2(claimDir).some((name) => name.includes('forge-crossdrive')),
            'no claim is created for a cross-drive file',
          );
          rmSync(crossDrive, { force: true });
        } catch (error) {
          console.log(`cross-drive claim check skipped (${otherDrive}: not writable: ${error.code ?? error.message})`);
        }
      }
    }

    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { force: true });
    console.log('concurrent-write guard: OK');
  }

  // ── Parallel sessions: the in-flight view rides the digest, nothing is hand-kept ──
  // A session may be killed at any moment (machine off, quota gone, user interrupted), so no
  // rule may depend on it cleaning up after itself. What survives is: claims expire on their
  // own, and "who is editing what" is DERIVED from the claim set into the digest every turn.
  {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const repo = mkdtempSync(join(tmpdir(), 'forge-inflight-'));
    mkdirSync(join(repo, 'private'), { recursive: true });
    writeFileSync(join(repo, 'private', 'done.md'), '# done\n');
    writeFileSync(join(repo, 'a.py'), 'print(1)\n');
    initRepo(repo);
    // A clean baseline: the guard refuses to write a file with uncommitted changes, so the
    // first writer must be working on a committed tree.
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'chore: init'], { cwd: repo, stdio: 'pipe' });

    const { ctx: ifCtx, record: ifRecord } = makeCtx();
    plugin.apply(ifCtx, standard.validate({
      injectOnCompaction: false,
      digestRefreshMs: 5,
      claimStaleMs: 1000,
    }).value);
    const hexA = `${Date.now().toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    const hexB = `${(Date.now() + 1).toString(16).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
    const { agent: writer, contexts: writerContexts } = createdAgent(ifRecord, repo, `session-${hexA}`);
    const { agent: reader, contexts: readerContexts } = createdAgent(ifRecord, repo, `session-${hexB}`);
    const cwGuard = ifRecord.guards[ifRecord.guards.length - 1];
    const digestOfReader = () => {
      const context = readerContexts[0];
      return context.text({});
    };

    // Before anyone writes: no in-flight block at all.
    assert.ok(!digestOfReader().includes('在办认领'), 'nothing in flight → no block');

    // The writer claims a file simply by writing it; the other session sees it in its digest.
    assert.equal(
      cwGuard({ name: 'write', arguments: { file_path: join(repo, 'a.py') }, agent: writer }),
      undefined,
      'the writer may write its own file',
    );
    await sleep(15);
    const seen = digestOfReader();
    assert.ok(seen.includes('在办认领'), 'the digest gains an in-flight block');
    assert.ok(seen.includes('`a.py`'), 'the block names the claimed file');
    assert.ok(seen.includes(hexA.slice(0, 8)), 'the block names the owning session');
    assert.ok(seen.includes('静默 0 分钟'), 'the block reports how long the owner has been quiet');
    assert.ok(!seen.includes('（本会话）'), "another session's claim is not marked as my own");

    // The owner's own digest marks its claim as its own, so it knows it has work in flight.
    const ownerSeen = writerContexts[0].text({});
    assert.ok(ownerSeen.includes('`a.py`'), "the owner's digest lists its own claim");
    assert.ok(ownerSeen.includes('（本会话）'), "the owner's own claim is marked as such");

    // The second session is refused while the claim is live.
    assert.equal(
      typeof cwGuard({ name: 'write', arguments: { file_path: join(repo, 'a.py') }, agent: reader }),
      'string',
      'a live claim still blocks the second writer',
    );

    // The owner goes quiet past `claimStaleMs` but nobody has tried to write the file yet: the
    // digest must already say the claim is takeable. Otherwise a session sees nothing in flight
    // and only learns the claim was abandoned by tripping over it — the failure this view exists
    // to prevent.
    writeFileSync(
      join(repo, 'private', '.forge-claims', 'a.py.json'),
      JSON.stringify({ owner: writer.session.header.id, time: Date.now() - 5000, path: 'a.py' }),
    );
    await sleep(15);
    const staleSeen = digestOfReader();
    assert.ok(staleSeen.includes('`a.py`'), 'an expired claim is still listed');
    assert.ok(staleSeen.includes('已过期'), 'and is marked as expired');
    assert.ok(staleSeen.includes('可接手'), 'with the takeover instruction');
    assert.ok(staleSeen.includes(hexA.slice(0, 8)), 'naming the session that went quiet');

    // Only now does a write take it over, and the digest says who it came from and what to do —
    // a guard can only refuse or allow, never annotate.
    assert.equal(
      cwGuard({ name: 'write', arguments: { file_path: join(repo, 'a.py') }, agent: reader }),
      undefined,
      'an expired claim is taken over instead of blocking forever',
    );
    await sleep(15);
    const afterTakeover = digestOfReader();
    assert.ok(afterTakeover.includes('已接手'), 'the digest announces the takeover');
    assert.ok(afterTakeover.includes(hexA.slice(0, 8)), 'the notice names the session that died');
    assert.ok(afterTakeover.includes('先重读该文件'), 'the notice says what to do next');

    // Pinning what was observed live (2026-10-16): the claim outlives the file it names. Deleting
    // the claimed file does NOT release the claim — only a commit or the staleness window does.
    rmSync(join(repo, 'a.py'), { force: true });
    assert.ok(
      existsSync(join(repo, 'private', '.forge-claims', 'a.py.json')),
      'deleting the claimed file does not release its claim',
    );

    rmSync(repo, { recursive: true, force: true });
    console.log('in-flight digest: OK');
  }

  // ── Guard C: the layout checkpoint ───────────────────────────────────────────
  {
    // A root that has become a shelf for several kinds of artifact: code + a unit + a script.
    const messy = mkdtempSync(join(tmpdir(), 'forge-layout-messy-'));
    writeFileSync(join(messy, 'tool.py'), 'print(1)\n');
    writeFileSync(join(messy, 'daemon.service'), '[Unit]\n');
    writeFileSync(join(messy, 'deploy.sh'), 'echo deploy\n');
    writeFileSync(join(messy, 'done.md'), '# done\nnothing about the tree yet\n');
    writeFileSync(join(messy, 'todo.md'), '# todo\n');
    writeFileSync(join(messy, 'plan.md'), '# plan\n');
    initRepo(messy);

    const { ctx: layCtx, record: layRecord } = makeCtx();
    plugin.apply(layCtx, standard.validate({ injectOnCompaction: false }).value);
    const { agent: layAgent } = createdAgent(layRecord, messy, `session-layout-${Date.now().toString(36)}`);
    const layoutGuard = layRecord.guards.find(
      (guard) => typeof guard(shell('git commit -m x', layAgent)) === 'string',
    );
    assert.ok(layoutGuard, 'the layout guard is registered');
    const refusal = layoutGuard(shell('git commit -m "x"', layAgent));
    assert.equal(typeof refusal, 'string', 'a mixed-kind root is refused until acknowledged');
    assert.ok(refusal.includes('布局'), 'the refusal is about the layout');
    assert.ok(refusal.includes('tool.py'), 'the refusal names what it measured');

    // A bare file name in the documents does NOT acknowledge: state documents mention file
    // names incidentally, so accepting one would pass on a lucky string, not on a real walk.
    writeFileSync(join(messy, 'done.md'), '# done\n\ntoday we touched tool.py and daemon.service\n');
    assert.equal(
      typeof layoutGuard(shell('git commit -m x', layAgent)),
      'string',
      'a bare file name does not acknowledge the tree',
    );

    // Naming a directory does: it can only come from having looked at the tree.
    mkdirSync(join(messy, 'deploy'), { recursive: true });
    writeFileSync(join(messy, 'done.md'), '# done\n\nthe root keeps tool.py; units and scripts go under deploy/\n');
    assert.equal(layoutGuard(shell('git commit -m x', layAgent)), undefined, 'naming a directory acknowledges the tree');
    rmSync(join(messy, 'deploy'), { recursive: true, force: true });

    // So does an explicit decision to stay flat.
    writeFileSync(join(messy, 'done.md'), '# done\n\n保持扁平：这个项目只有三个文件，不值得分层\n');
    assert.equal(layoutGuard(shell('git commit -m x', layAgent)), undefined, 'a recorded flat decision acknowledges it');

    // Emptied again: the guard is about the tree, not about the document being written.
    writeFileSync(join(messy, 'done.md'), '# done\n');
    assert.equal(typeof layoutGuard(shell('git commit -m x', layAgent)), 'string', 'an empty document does not acknowledge');

    // Only commits are governed, and unrelated tools are untouched.
    assert.equal(layoutGuard(shell('git status --short', layAgent)), undefined, 'non-commit commands are untouched');
    assert.equal(layoutGuard({ name: 'read', arguments: {}, agent: layAgent }), undefined, 'other tools are untouched');

    // One kind of artifact is not a mess: a flat source-only root stays committable.
    const tidy = mkdtempSync(join(tmpdir(), 'forge-layout-tidy-'));
    writeFileSync(join(tidy, 'a.py'), 'print(1)\n');
    writeFileSync(join(tidy, 'done.md'), '# done\n');
    initRepo(tidy);
    const { ctx: tidyCtx, record: tidyRecord } = makeCtx();
    plugin.apply(tidyCtx, standard.validate({ injectOnCompaction: false }).value);
    const { agent: tidyAgent } = createdAgent(tidyRecord, tidy, `session-tidy-${Date.now().toString(36)}`);
    const tidyGuard = tidyRecord.guards.find(
      (guard) => typeof guard(shell('git commit -m x', tidyAgent)) === 'string',
    );
    assert.equal(tidyGuard, undefined, 'a single-kind root with few files is not flagged');

    rmSync(messy, { recursive: true, force: true });
    rmSync(tidy, { recursive: true, force: true });
    console.log('layout guard: OK');
  }

  // ── Guard D: no secrets into the repository ──────────────────────────────────
  {
    // A tracked credential file must refuse the commit.
    const leaky = mkdtempSync(join(tmpdir(), 'forge-secrets-'));
    writeFileSync(join(leaky, 'app.py'), 'print(1)\n');
    writeFileSync(join(leaky, '.env'), 'API_KEY=shhh\n');
    writeFileSync(join(leaky, 'done.md'), '# done\n');
    writeFileSync(join(leaky, 'todo.md'), '# todo\n');
    writeFileSync(join(leaky, 'plan.md'), '# plan\n');
    initRepo(leaky);
    execFileSync('git', ['add', '-A'], { cwd: leaky, stdio: 'pipe' });

    const { ctx: secCtx, record: secRecord } = makeCtx();
    plugin.apply(secCtx, standard.validate({
      guardLocalGit: false, guardCommitCheckpoint: false, guardLayoutCheckpoint: false,
    }).value);
    const { agent: secAgent } = createdAgent(secRecord, leaky, `session-secrets-${Date.now().toString(36)}`);
    const secretsGuard = secRecord.guards.find(
      (guard) => typeof guard(shell('git commit -m x', secAgent)) === 'string',
    );
    assert.ok(secretsGuard, 'the secrets guard is registered');
    const refusal = secretsGuard(shell('git commit -m "x"', secAgent));
    assert.equal(typeof refusal, 'string', 'a tracked .env refuses the commit');
    assert.ok(refusal.includes('凭据'), 'the refusal is about secrets');
    assert.ok(refusal.includes('.env'), 'the refusal names the offending file');

    // Untracking the credential file clears it.
    execFileSync('git', ['rm', '--cached', '.env'], { cwd: leaky, stdio: 'pipe' });
    assert.equal(secretsGuard(shell('git commit -m x', secAgent)), undefined, 'untracking the credential clears the refusal');

    // A tracked private key also refuses; a tracked ordinary source file does not.
    execFileSync('git', ['add', '-A'], { cwd: leaky, stdio: 'pipe' });
    writeFileSync(join(leaky, 'server.pem'), '-----BEGIN PRIVATE KEY-----\n');
    execFileSync('git', ['add', 'server.pem'], { cwd: leaky, stdio: 'pipe' });
    assert.equal(typeof secretsGuard(shell('git commit -m x', secAgent)), 'string', 'a tracked .pem refuses');
    execFileSync('git', ['rm', '--cached', 'server.pem'], { cwd: leaky, stdio: 'pipe' });

    // Non-commit commands and other tools are untouched.
    assert.equal(secretsGuard(shell('git status --short', secAgent)), undefined, 'non-commit commands are untouched');
    assert.equal(secretsGuard({ name: 'read', arguments: {}, agent: secAgent }), undefined, 'other tools are untouched');

    // The same file inside the state boundary is the local-only side of the project: a
    // repository that keeps its own state may keep its own credentials there (§1.7).
    execFileSync('git', ['rm', '--cached', '.env'], { cwd: leaky, stdio: 'pipe' });
    mkdirSync(join(leaky, 'private'), { recursive: true });
    writeFileSync(join(leaky, 'private', '.env'), 'API_KEY=local-only\n');
    execFileSync('git', ['add', 'private/.env'], { cwd: leaky, stdio: 'pipe' });
    assert.equal(
      secretsGuard(shell('git commit -m x', secAgent)),
      undefined,
      'a credential file inside the boundary is allowed',
    );

    rmSync(leaky, { recursive: true, force: true });
    console.log('secrets guard: OK');
  }

  // ── Guard E: the public surface stays open-source-ready ──────────────────────
  // The export motion is "delete the state boundary, copy, `git init`", so whatever sits
  // outside `private/` is published as-is. This guard refuses the commit that would publish
  // machine-private material. Every other guard is off here, so the only guard that can
  // refuse is the one under test.
  {
    const pub = mkdtempSync(join(tmpdir(), 'forge-privacy-'));
    mkdirSync(join(pub, 'private'), { recursive: true });
    writeFileSync(join(pub, 'README.md'), '# project\n');
    writeFileSync(join(pub, 'app.py'), 'print(1)\n');
    writeFileSync(join(pub, 'private', 'done.md'), '# done\n');
    writeFileSync(join(pub, 'private', 'todo.md'), '# todo\n');
    writeFileSync(join(pub, 'private', 'plan.md'), '# plan\n');
    initRepo(pub);
    execFileSync('git', ['add', '-A'], { cwd: pub, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'chore: init'], { cwd: pub, stdio: 'pipe' });

    const { ctx: pvCtx, record: pvRecord } = makeCtx();
    plugin.apply(pvCtx, standard.validate({
      guardLocalGit: false,
      guardCommitCheckpoint: false,
      guardLayoutCheckpoint: false,
      guardSecrets: false,
      injectOnCompaction: false,
    }).value);
    const { agent: pvAgent } = createdAgent(pvRecord, pub, `session-privacy-${Date.now().toString(36)}`);
    const commit = () => shell('git commit -m "x"', pvAgent);
    assert.ok(pvRecord.guards.length > 0, 'the privacy guard is registered');
    const refusalFor = () => pvRecord.guards
      .map((guard) => guard(commit()))
      .find((verdict) => typeof verdict === 'string');

    assert.equal(refusalFor(), undefined, 'a clean public surface commits');

    // 1. A home directory of the machine that wrote the file.
    writeFileSync(join(pub, 'app.py'), 'NOTES = "C:\\Users\\someone\\project\\notes.txt"\n');
    const homeRefusal = refusalFor();
    assert.equal(typeof homeRefusal, 'string', 'a home path in the public surface refuses the commit');
    assert.ok(homeRefusal.includes('app.py'), 'the refusal names the offending file');
    assert.ok(homeRefusal.includes('家目录'), 'the refusal says what leaked');
    writeFileSync(join(pub, 'app.py'), 'print(1)\n');

    // 2. Source reaching into the state boundary: after export that path does not exist.
    writeFileSync(join(pub, 'app.py'), `NOTES = "${'private'}/notes/session.md"\n`);
    const reachRefusal = refusalFor();
    assert.equal(typeof reachRefusal, 'string', 'source reaching into the boundary refuses the commit');
    assert.ok(reachRefusal.includes('状态边界'), 'the refusal names the boundary');
    writeFileSync(join(pub, 'app.py'), 'print(1)\n');

    // 3. A high-confidence secret literal outside a configuration file.
    writeFileSync(join(pub, 'app.py'), 'api_key = "AKIAIOSFODNN7EXAMPLE"\n');
    const secretRefusal = refusalFor();
    assert.equal(typeof secretRefusal, 'string', 'a secret literal in source refuses the commit');
    assert.ok(secretRefusal.includes('配置文件'), 'the refusal points at the config-file rule');

    // A configuration file is the sanctioned carrier — with an example twin for newcomers.
    writeFileSync(join(pub, 'config.yaml'), 'api_key: "AKIAIOSFODNN7EXAMPLE"\n');
    writeFileSync(join(pub, 'config.example.yaml'), 'api_key: "replace-me"\n');
    writeFileSync(join(pub, 'app.py'), 'print(1)\n');
    assert.equal(refusalFor(), undefined, 'a configuration file may carry the value');

    // The boundary itself is exempt: that directory is the local-only side of the project.
    writeFileSync(
      join(pub, 'private', 'notes.md'),
      'local note: C:\\Users\\someone\\project and api_key = "AKIAIOSFODNN7EXAMPLE"\n',
    );
    assert.equal(refusalFor(), undefined, 'files inside the boundary are not the public surface');

    // A file whose whole job is to demonstrate the boundary declares the marker.
    writeFileSync(join(pub, 'fixtures.py'), '# privacy-guard: allow — boundary fixtures\nHOME = "C:\\Users\\someone"\n');
    assert.equal(refusalFor(), undefined, 'a file carrying the allow marker is exempt');

    // Links are project content, not a privacy leak: a paper crawler's README, docs and source
    // cite URLs all day. The guard only refuses what identifies a machine or a secret.
    writeFileSync(
      join(pub, 'README.md'),
      '# paper crawler\n\nSources: https://example.org/paper/1234 and https://example.org/api/query\n',
    );
    writeFileSync(join(pub, 'crawler.py'), 'BASE = "https://example.org/api/query"\n');
    assert.equal(refusalFor(), undefined, 'URLs in the public surface are allowed');

    // Non-commit commands and other tools are untouched.
    assert.equal(pvRecord.guards.map((guard) => guard(shell('git status --short', pvAgent))).find(Boolean), undefined,
      'non-commit commands are untouched');
    assert.equal(pvRecord.guards.map((guard) => guard({ name: 'read', arguments: {}, agent: pvAgent })).find(Boolean), undefined,
      'other tools are untouched');

    rmSync(pub, { recursive: true, force: true });
    console.log('privacy boundary guard: OK');
  }

  // ── Digest configuration ─────────────────────────────────────────────────────
  const { ctx: cfgCtx, record: cfgRecord } = makeCtx();
  plugin.apply(cfgCtx, standard.validate({
    digestFiles: ['done.md'],
    repoStateInDigest: false,
    stewardFile: false,
    injectOnCompaction: false,
  }).value);
  const { contexts: cfgContexts } = createdAgent(cfgRecord, project, 'session-config');
  const configured = cfgContexts[0].text({});
  assert.ok(configured.includes(PROJECT_MARKERS.done), 'configured document inlined');
  assert.ok(!configured.includes(PROJECT_MARKERS.plan), 'unlisted document not inlined');
  assert.ok(!configured.includes('STEWARD-MARK'), 'steward file off');
  assert.ok(!configured.includes('## Repository state'), 'repository state off');
  assert.ok(!configured.includes('…omitted'), 'no omission note while the budget suffices');

  // ── Contract documents are inlined whole, over budget or not ─────────────────
  // The failure this replaces: a long `done.md` used to be inlined as its tail, so the head
  // — where the current state lives — vanished silently. v4 never truncates a contract: an
  // over-budget document is still complete, and the digest reports the overrun instead.
  const longProject = mkdtempSync(join(tmpdir(), 'steward-long-'));
  const head = `HEAD-ONLY-MARK\n${'x'.repeat(2000)}`;
  const tail = 'TAIL-MARK';
  writeFileSync(join(longProject, 'done.md'), `${head}\n${tail}\n`);

  const { ctx: overCtx, record: overRecord } = makeCtx();
  plugin.apply(overCtx, standard.validate({
    digestFiles: ['done.md'],
    documentBudgets: { 'done.md': 300 },
    repoStateInDigest: false,
    stewardFile: false,
    injectOnCompaction: false,
  }).value);
  const { contexts: overContexts } = createdAgent(overRecord, longProject, 'session-over');
  const overText = overContexts[0].text({});
  assert.ok(overText.includes('HEAD-ONLY-MARK'), 'an over-budget document is still complete');
  assert.ok(overText.includes('TAIL-MARK'), 'and its tail is there too');
  assert.ok(!overText.includes('…omitted'), 'nothing is ever truncated');
  assert.ok(overText.includes('超出预算'), 'the overrun is reported');
  assert.ok(/done\.md \d+\/300/.test(overText), 'the report carries the size and the budget');
  assert.ok(overText.includes('journal.jsonl'), 'the report says where the detail should go');

  // A document inside its budget gets no warning.
  const { ctx: fitCtx, record: fitRecord } = makeCtx();
  plugin.apply(fitCtx, standard.validate({
    digestFiles: ['done.md'],
    documentBudgets: { 'done.md': 8000 },
    repoStateInDigest: false,
    stewardFile: false,
    injectOnCompaction: false,
  }).value);
  const { contexts: fitContexts } = createdAgent(fitRecord, longProject, 'session-fit');
  const fitText = fitContexts[0].text({});
  assert.ok(fitText.includes('HEAD-ONLY-MARK'), 'a document inside its budget comes through whole');
  assert.ok(!fitText.includes('超出预算'), 'no warning while inside the budget');

  // A document the map does not name uses the fallback budget — and is still whole.
  const { ctx: fbCtx, record: fbRecord } = makeCtx();
  plugin.apply(fbCtx, standard.validate({
    digestFiles: ['done.md'],
    documentBudgets: {},
    documentBudgetDefault: 120,
    repoStateInDigest: false,
    stewardFile: false,
    injectOnCompaction: false,
  }).value);
  const { contexts: fbContexts } = createdAgent(fbRecord, longProject, 'session-fallback');
  const fbText = fbContexts[0].text({});
  assert.ok(fbText.includes('TAIL-MARK') && fbText.includes('HEAD-ONLY-MARK'), 'the fallback budget inlines whole');
  assert.ok(fbText.includes('超出预算'), 'the fallback budget warns when exceeded');

  // ── Negative knowledge: the index is inlined, the file is not ────────────────
  // One line per record, so a model can see that a route was already disproved without
  // carrying the whole unbounded file; the `kind` marker at the head of each record is what
  // lets the index say which sort of entry it is.
  writeFileSync(join(longProject, 'tortuous.jsonl'), [
    JSON.stringify({ id: 'T1', kind: 'route', title: 'old parser', conclusion: '不要再用旧解析器' }),
    JSON.stringify({ id: 'D1', kind: 'deviation', title: 'global install', conclusion: '不要再用全局安装' }),
    '',
  ].join('\n'));
  writeFileSync(join(longProject, 'journal.jsonl'), `${JSON.stringify({ at: '2026-01-01T00:00:00Z', summary: 'JOURNAL-ONLY-MARK' })}\n`);
  const { ctx: idxCtx, record: idxRecord } = makeCtx();
  plugin.apply(idxCtx, standard.validate({
    digestFiles: ['done.md'],
    documentBudgets: { 'done.md': 8000 },
    repoStateInDigest: false,
    stewardFile: false,
    injectOnCompaction: false,
  }).value);
  const { contexts: idxContexts } = createdAgent(idxRecord, longProject, 'session-index');
  const idxText = idxContexts[0].text({});
  assert.ok(idxText.includes('T1（失败路线）'), 'the index names a failed route');
  assert.ok(idxText.includes('D1（偏差）'), 'the index names a recorded deviation');
  assert.ok(idxText.includes('不要再用旧解析器'), 'the index carries each record conclusion');
  assert.ok(!idxText.includes('JOURNAL-ONLY-MARK'), 'the journal is never inlined');
  assert.ok(idxText.includes('journal.jsonl'), 'the digest names the read-on-demand files');
  rmSync(longProject, { recursive: true, force: true });

  // ── The protocol demands concise, current documents ──────────────────────────
  const { ctx: protocolCtx, record: protocolRecord } = makeCtx();
  plugin.apply(protocolCtx, standard.validate({ digest: false, injectOnCompaction: false }).value);
  const protocolText = protocolRecord.sections
    .find((section) => section.name === 'project-forge:protocol')
    .text({});
  for (const needle of [
    '整份内联，绝不截断',
    '告警线，不是裁剪线',
    '不要靠压缩措辞消掉告警',
    '只允许在文件末尾追加',
    '永不插入、永不改写、永不分小节',
    '顺序就是牺牲顺序',
    '越预算时把最旧的工作记录搬进 `journal.jsonl`',
    '在**完成它的同一个提交**里把条目移出',
    '该条目属于 `todo.md`',
    '不要积累只增不改的计划',
  ]) {
    assert.ok(protocolText.includes(needle), `§4 states the three-class rule: ${needle}`);
  }
  console.log('digest configuration: OK');
}

// ── Guard: append-only records ────────────────────────────────────────────────
// The two jsonl files are read as "one record per line, appended only". The guard is found by
// what it refuses rather than by index, so another guard's opinion on the same write (the
// concurrent-write guard also looks at `write`) cannot make this test vacuous.
{
  const { ctx: appendCtx, record: appendRecord } = makeCtx();
  plugin.apply(appendCtx, standard.validate({ digest: false, injectOnCompaction: false }).value);
  const { agent: appendAgent } = createdAgent(appendRecord, project, 'session-append');
  const recordDir = join(project, 'private');
  mkdirSync(recordDir, { recursive: true });
  const recordPath = join(recordDir, 'journal.jsonl');
  const existing = '{"id":"J1","kind":"checkpoint"}\n';
  writeFileSync(recordPath, existing);
  const refusalFor = (content) => appendRecord.guards
    .map((guard) => guard({ name: 'write', arguments: { file_path: recordPath, content }, agent: appendAgent }))
    .find((answer) => typeof answer === 'string' && answer.includes('只追加'));
  const refusal = refusalFor('{"id":"J2","kind":"checkpoint"}\n');
  assert.equal(typeof refusal, 'string', 'a write that drops the records already on disk is refused');
  assert.ok(refusal.includes('journal.jsonl'), 'the refusal names the file');
  assert.equal(
    refusalFor(`${existing}{"id":"J2","kind":"checkpoint"}\n`),
    undefined,
    'the same guard allows the append — the previous text is the prefix',
  );
  console.log('append-only guard: OK');
}

// ── Guard: size ratchet (opt-in) ──────────────────────────────────────────────
// The budgets are warning lines by default: the digest prints "⚠ 超出预算 <file> a/b" and nothing
// blocks (§4.0.1). `sizeLimitMode: 'ratchet'` adds exactly one commit-time refusal, and what that
// refusal measures is two sizes: the document must already be **over** its hard cap AND this commit
// must make it **bigger**. Shrinking, splitting and moving always pass — an absolute threshold would
// refuse the very commit that starts the slimming, which is how a file freezes at its over-budget size.
{
  const { ctx: warnCtx, record: warnRecord } = makeCtx();
  plugin.apply(warnCtx, standard.validate({ digest: false, injectOnCompaction: false }).value);
  const { ctx: ratchetCtx, record: ratchetRecord } = makeCtx();
  plugin.apply(ratchetCtx, standard.validate({ digest: false, injectOnCompaction: false, sizeLimitMode: 'ratchet' }).value);
  assert.equal(
    ratchetRecord.guards.length,
    warnRecord.guards.length + 1,
    'the ratchet adds exactly one guard when it is switched on',
  );
  assert.equal(
    standard.validate({ sizeLimitMode: 'hard' }).issues.some((issue) => issue.path?.[0] === 'sizeLimitMode'),
    true,
    'an unknown sizeLimitMode is rejected by the schema',
  );

  // Drive the refusal against a throwaway repository: `before` comes from `git show HEAD:<path>`,
  // so the fixture needs one commit to compare against. done.md's budget is 2000, so the hard cap
  // is 3000. The commit below is issued directly, not through the guard, which is how a fixture
  // gets into the "already over the cap" state the ratchet is about.
  const repo = mkdtempSync(join(tmpdir(), 'forge-ratchet-'));
  const docPath = join(repo, 'private', 'done.md');
  mkdirSync(dirname(docPath), { recursive: true });
  const git = (...args) => execFileSync(
    'git',
    ['-C', repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
    { encoding: 'utf8' },
  );
  const body = (n) => `# done.md\n${'x'.repeat(n)}\n`;
  writeFileSync(docPath, body(1000));
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture under the hard cap');
  const { agent: ratchetAgent } = createdAgent(ratchetRecord, repo, 'session-ratchet');
  const refusalFor = () => ratchetRecord.guards
    .map((guard) => guard({ name: 'pwsh', arguments: { command: 'git commit -m x' }, agent: ratchetAgent }))
    .find((answer) => typeof answer === 'string' && answer.includes('硬上限'));

  writeFileSync(docPath, body(2900));
  assert.equal(refusalFor(), undefined, 'growth that stays under the hard cap passes');
  writeFileSync(docPath, body(3200));
  const refusal = refusalFor();
  assert.equal(typeof refusal, 'string', 'a commit that grows an already-over-cap document is refused');
  assert.ok(refusal.includes('done.md'), 'the refusal names the document');
  assert.ok(refusal.includes('3000'), 'the refusal states the hard cap it measured against');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture over the hard cap');
  writeFileSync(docPath, body(3100));
  assert.equal(refusalFor(), undefined, 'a commit that shrinks an over-cap document passes — that is the ratchet');
  rmSync(repo, { recursive: true, force: true });
  console.log('size ratchet: OK');
}

// ── The clock footnote (D30) ──────────────────────────────────────────────────
// The clock must not enter the system prompt or the digest, so it rides on tool results: one
// footer on a successful call, nothing inside the throttle window, nothing on a failure. The
// listener is driven directly here — what the harness does with the returned decision is its
// own business and is covered by the tool packages' tests.
{
  const { ctx: clockCtx, record: clockRecord } = makeCtx();
  plugin.apply(clockCtx, standard.validate({ digest: false, injectOnCompaction: false }).value);
  const hook = clockRecord.listeners.find((listener) => listener.name === 'tools/post-execute');
  assert.ok(hook !== undefined, 'the clock hook is registered on tools/post-execute');
  const { agent: clockAgent } = createdAgent(clockRecord, project, 'session-clock');
  const call = (result) => hook.handler(
    { name: 'read', arguments: {}, agent: clockAgent },
    result,
    async () => ({ kind: 'accept' }),
  );
  const ok = { isError: false, content: [{ type: 'text', text: 'file contents' }] };
  const first = await call(ok);
  assert.equal(first.kind, 'accept', 'the decision stays an accept');
  assert.match(first.content[0].text, /^file contents\n\n---\n⏱ \d{4}-\d\d-\d\dT/, 'the footnote carries the time and keeps the output above it');
  const second = await call(ok);
  assert.equal(second.content, undefined, 'a second call inside the throttle window is left alone');
  const failed = await call({ isError: true, content: [{ type: 'text', text: 'boom' }] });
  assert.equal(failed.content, undefined, 'a failed result is never decorated');
  console.log('clock footnote: OK');
  // ── repoCommitWindow: the recent-commit list is a configured window ──────────
  // The failure this replaces: the window was hardcoded to 8 for both the digest and the
  // checkpoint guard's drift signal, so a busy history could not be widened or narrowed.
  // `.git/logs/HEAD` is written by hand — `readRepoState` reads that file, not `git log`.
  const { mkdirSync } = await import('node:fs');
  const windowProject = mkdtempSync(join(tmpdir(), 'steward-window-'));
  mkdirSync(join(windowProject, '.git', 'logs'), { recursive: true });
  mkdirSync(join(windowProject, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(windowProject, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(windowProject, '.git', 'refs', 'heads', 'main'), 'abcdef1234567890\n');
  const logLines = [];
  for (let i = 1; i <= 12; i += 1) {
    const hash = String(i).padStart(8, '0').repeat(2);
    logLines.push(`0000000 ${hash} A <a@b> 1700000000 +0000\tcommit: subject ${i}`);
  }
  writeFileSync(join(windowProject, '.git', 'logs', 'HEAD'), `${logLines.join('\n')}\n`);
  // The digest returns early when it has no document to inline, and that early return is
  // *before* the repository block — so the fixture needs one file to make the digest render.
  writeFileSync(join(windowProject, 'done.md'), 'WINDOW-FIXTURE-MARK\n');

  const commitsIn = (window) => {
    const { ctx, record } = makeCtx();
    plugin.apply(ctx, standard.validate({
      digestFiles: ['done.md'], repoCommitWindow: window, stewardFile: false, injectOnCompaction: false,
    }).value);
    const { contexts } = createdAgent(record, windowProject, `session-window-${window}`);
    return (contexts[0].text({}).match(/^- [0-9a-f]{8} subject /gm) ?? []).length;
  };
  assert.equal(commitsIn(3), 3, 'repoCommitWindow 3 lists exactly three commits');
  assert.equal(commitsIn(5), 5, 'repoCommitWindow 5 lists exactly five');
  assert.equal(commitsIn(undefined), 8, 'the default window stays 8 when the field is not set');
  rmSync(windowProject, { recursive: true, force: true });
  console.log('repoCommitWindow: OK');
}

rmSync(project, { recursive: true, force: true });

console.log('\nall plugin checks passed');
