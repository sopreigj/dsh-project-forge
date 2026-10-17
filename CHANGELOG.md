# 更新日志

本文件记录**项目锻造模式（Project Forge Mode）**每个版本的显著变动，供使用者与贡献者阅读。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

它是**给人看的**，不是 git 日志的搬运：每条说明做了什么、为什么；同类改动归组；新版本在前。
每个版本一行日期（`YYYY-MM-DD`）；不兼容的变动写进 `Changed` 或 `Removed` 并注明迁移方式。

## [3.7.0] - 2026-10-17

### Fixed

- 检查点守卫的豁免现在**会过期**。此前会话只要用 write/edit 改过一次合同文档，此后每一次提交都被放行——
  于是一个长批次里"先改文档、再连做十处代码改动、最后只提交代码"完全不触发对账。
  现在豁免绑定到**写入那一刻的 HEAD**：HEAD 一动，豁免就作废，提交必须重新对账。
- 「合同文档」统一成协议说的**四份**（`plan` / `done` / `todo` / 仓库规则文件）。此前漂移计数、
  提交守卫与拒绝消息只认三份，导致"只更新了 `steward.md`"被判成"没有任何合同文档被更新"——
  同一个词指两件事（§6.1.2）。

### Changed

- 检查点守卫改为在提交那一刻**直接问 git**（`rev-parse HEAD` + 最后一个碰过合同文档的提交之上有几个提交），
  不再依赖 digest 的 5 秒缓存：刚落地一秒的提交不会被"看不见"。

### Notes

- 已在 DSH 0.2.1-rc.2 上复验：`agent/pre-step`、`agent/created`、`session/event`、`tools.guard`、
  `tools/post-execute`、`compaction/end`、`replaceGeneration` 都还在；提示词变量仍只有 `provider` / `model`，
  所以 persona 里不要写 `{{cwd}}` 这类未注册变量。宿主下限仍是 `≥ 0.2.1-rc`。

## [3.6.0] - 2026-10-17

### Added

- `release/source-truth.mjs`：导出真值的检查可以按**某个提交**读源码（`--tag <ref>` → `git show <ref>:<path>`），
  而不是读开发者工作区。发布脚本把配置里的 `dshSourceTag` 透传成 `--tag`，本机配置因此只多一行、仓库不多一个本机路径。

### Changed

- `check-prompt-variables` 与 `check-preset-sync` 都改用这个来源：给了 `--tag` 就**绝不退回工作区**
  （取不到即失败并点名原因），没给才按老办法读文件。
  过去源码树一旦有未提交改动，这两门检查比的就不是装上去跑的那份代码——而"检查看了别的东西"和"检查通过了"看起来一模一样。

### Fixed

- `check-preset-sync` 在本机终于真跑起来：此前的跳过分支让"patch ↔ 上游 standard"这一门长期形同虚设。
  现在默认配置指向发布 tag，它每次都真的比（本仓 34 行 / 上游 32 行，差异全部已记录）。

## [3.4.0] - 2026-10-17

### Added

- 采纳上游 `standard` 的三条：`time-context`、`tool-schedule` 启用，`tool-plugin-market` 跟随上游保持 `disabled: true`。
  preset 是上游清单的副本，不同步就等于悄悄比上游少能力。

### Changed

- `clockFooter` 默认值 `true` → `false`：时间由宿主的 `time-context` 提供，一个时间来源就够。
  需要旧行为的预设显式设为 `true`。

### Fixed

- digest 不再把文档里的 `{{` 改写成 `{ {`：宿主 0.2.1-rc 起 `systemPrompt.context` 也尊重 `interpolate: false`，
  旧的改写手段只剩副作用（引用 Vue/mustache 的文档会被改坏）。

### Notes

- **宿主下限：DeepSeek Harness ≥ 0.2.1-rc**。digest 依赖 context 级的 `interpolate: false`（见 V11）。
## [Unreleased]

## [3.5.0] - 2026-10-17

### Added

- **第八门检查 `release/check-installed.mjs`：把「装进去没有」变成可失败的判定**。它扫
  `~/.dsh/profiles/*/node_modules` 下的 `dsh-project-forge` 与 `@local/dsh-project-forge`，
  用 `lstat` 判「有没有条目」、`realpath` 判「目标还在不在」，分 `dev` / `copy` / `dangling` 三类，
  摘要里报对象数——一个条目都没扫到也会失败，因为「没找到」和「装好了」长得一模一样。
  悬空条目即 exit 1：那样的 profile 列着一个永远加载不起来的 bundle，而此前所有检查都是绿的。
- **安装面处置**：desktop 与 headless 里指向不存在目标的 `@local/dsh-project-forge` 条目已删除
  （两份清单从未引用它，只有旧的 `pnpm-lock.yaml` 留着那一段）；改环境前的清单备份在状态边界内。

### Changed

- **digest 的「状态文档落后于仓库」判据换成 git 自己的答案**：原先要求「某个提交的 hash 出现在
  合同文档里」，这等于规定项目必须把提交号写进散文——本仓恰好相反，于是每轮都报「文档落后」。
  现在数的是「最后一次改了合同文档的提交之上还有几个提交」，文档里不必出现任何 hash。

- 发布流程拆成"做法 / 本机约定"：`release/publish.ps1` 只跑检查与镜像，目标目录、DSH 源码树、额外排除项
  从 `release/publish.config.json` 读取——那份文件被 gitignore 且镜像时排除，仓库只带 `publish.config.example.json`。
  镜像规则也写成"除 `.git`、状态边界 `private/`、用户配置项之外的全部内容"。


### Fixed
- digest 不再改写文档里的 `{{`：宿主 0.2.1 起 `systemPrompt.context` 也尊重 `interpolate: false`，旧宿主上必要的 `{ {` 拆分如今只剩副作用（引用 Vue/mustache 的文档会被改坏）。

- **修掉一个让模式装上即失效的缺陷：persona 的 `suffix` 引用了不存在的提示词变量**。两份 patch
  （主仓与 `review/`）的 persona 行都写着 `Your working directory is {{cwd}}.`，而 harness 只注册
  `provider` 与 `model` 两个变量。`dsh-system-prompt` 的插值是严格的：认不出的 `{{name}}` 会在
  组装 system prompt 时抛错，且发生在任何模型请求之前——所以选中该模式的每个回合都会失败，而不是
  某个角落变难看。已删除该行：工作目录由 working-directory 服务作为运行时上下文提供，本就不该由
  persona 声明（harness 自己的文档点名了这个反模式）。
- **新增第八门检查 `release/check-prompt-variables.mjs`**：把两份 patch 的 persona/`section` 文本
  里每一处 `{{...}}` 对着已注册变量集合核一遍，认不出即拒绝发布。真值从 agent-loop 源码导出
  （`--source`/`$DSH_SOURCE`）；没有源码树时按文档化的最小集合 `provider`/`model` 失败关闭，
  而不是放行一切——"没查"不能长得像"没问题"。已接进 `publish.ps1`。
  变异验证：注入 `{{cwd}}` → 检查以 `{{cwd}}` 与行号报错；换成 `{{model}}`/`{{provider}}` → 放行。

### Fixed

- 推送授权不再依赖子进程解析远端：「这次推哪个远端」先问 `git`，问不到时回退读 `.git/config`（含 worktree 的 `gitdir:` 形态）。此前在无法启动子进程的宿主里任何授权都不可能匹配，而拒绝消息仍叫你去写一条新的授权行——现在会直接点名「目标远端解析不到」。

## [3.3.0] - 2026-10-17

### Added

- **补齐本文件的历史**：补上 `3.0.0` 与 `3.1.0` 的完整条目。更早的版本（v1 与 v2.0–v2.3 的几次改造）
  没有可考的发布日期，所以并入 `3.0.0` 的说明里，而不是给它们编一个日期——"是否有更新日志"这一栏，
  宁可空着也不要写假的时间。

### Changed

- `3.1.0` 的条目重新按 `Added / Changed` 归组（此前全部塞在 `Added` 下）。

## [3.2.0] - 2026-10-17

### Added

- **协议 §2 的诊断块补两条判据**：先排除"会让整个方案失效"的那一类原因（环境、宿主版本、安装路径、权限），
  再排常见原因；证据够到"能排除其余候选"就停手——收集到"能证明它"属于验证阶段。前者是鉴别诊断里
  最容易被跳过的 must-not-miss，后者给"动手之前该想多久"一条停手线。
- **`2.9` 改进型工作只在最慢的那一步上做**：非瓶颈修快不会让整体变快；能改但不是最慢的写进队列不做。
- **`2.10` 一次失败不构成一条规则**：加规则、加守卫、加检查之前先确认这是反复出现的一类，还是一次坏运气。
- **`2.11` 删改既有东西之前，先说清它在挡什么**（切斯特顿栅栏）：查不到"谁加的、为什么"不等于没有原因。
- **协议 §3 新增 `3.5`：`CHANGELOG.md` 的写法**——一版一入口、`[Unreleased]` 区块、六类分组
  （`Added / Changed / Deprecated / Removed / Fixed / Security`）、ISO 日期、与 `package.json` 的版本一致。
- **`release/check-changelog.mjs`**：发布前的第七门检查，版本必须在本文件里有条目、顶部保留 `[Unreleased]`；
  条目格式不合规即拒绝发布。

### Changed

- **`2.8` 的可发布判据收紧**：除"版本号 + 检查全绿 + 已镜像 + 文档描述的就是这个版本"，还要求
  **使用者要走的那条路完整可用**——不许留"背后一半"。
- **协议 §2 的备料以"跑过一次完整空验证"结束**（套件/构建/发布脚本），而不是"我觉得准备好了"。

## [3.1.0] - 2026-10-17

### Added

- 协议新增"鉴别诊断 + 单元粒度"：动手前列出全部候选原因、用仓库里的证据逐条排除，然后一次治完一组；
  禁止"改一处 → 跑一次 → 再猜"。
- digest 新增条件块"状态文档落后于仓库"：状态里一直在算、却只喂给检查点守卫的信号，现在每轮可见。
- 本文件（更新日志）从这一版开始维护。

### Changed

- 协议规定**一个大轮收尾 = 一个可发布版本**，并给出记账与产出的比例判据（记账不应显著超过代码改动量）。

## [3.0.0] - 2026-10-09

模式 v2 系列的基线，此后所有版本都在它之上增量演进。这一版包含 v1 与 v2.0–v2.3 的累积改造：

### Added

- **十二节常驻协议**（角色、git 安全网、开发循环、README/docs、状态文档三类、代码组织、命名、
  文件架构、仓库自带规则与并发、状态一致性、完成判定、接管）——作为系统提示词的一个小节，每个模型请求现场渲染。
- **`private/` 状态边界**：四份合同（`plan` / `done` / `todo` / `steward` 规则）、两份只追加记录
  （`journal.jsonl` / `tortuous.jsonl`）、按需读的 `rationale/`；边界之外按"已经开源"写。
- **digest**：每轮把合同正文 + 仓库状态 + 负知识索引内联进运行时上下文；压缩之后由恢复消息自带整份 digest。
- **七个守卫**：本地 git 发布/毁历史、检查点前对账、布局走查、密钥字面量、隐私边界、并发写认领、
  只追加文件；外加流边界的畸形工具调用修复。体积阈值用棘轮（软预算只告警）。
- **`review/` 独立 bundle** 与随附技能；两处安装都是 `link:`，改一处即两处生效。
- 本仓库自己的 `release/` 检查链：配置表↔schema、技能副本逐字节一致、公开面词表、patch↔内置 standard、运行时 ×2。

### Changed

- 提示词语言统一为**中文**（实测同语义下中文 token 略省）；提示词不再携带开发者的历史叙述，
  只留下由此产生的规则。
