/**
 * the protocol and recovery prompt sections, rule by rule.
 *
 * privacy-guard: allow — a fixture set: it writes home paths, boundary paths and secret literals
 * into throwaway repositories to prove what the guards refuse.
 */


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

