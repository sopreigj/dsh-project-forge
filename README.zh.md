# dsh-project-forge

[English](README.md) | **中文**

**项目锻造模式（Project Forge）** —— 一个 DeepSeek Harness Agent 预设（agent preset）：把 Agent 变成项目的**管家**，让项目始终可恢复（本地 git）、可追溯（四份状态文档 + 只追加的记录）、结构清晰（布局与命名纪律）、且在上下文压缩之后依然能继续推进（压缩恢复），并配有在**模型不配合时也照样生效**的写入守卫。

本仓库提供两个预设：

| 预设 | 用途 |
|---|---|
| `project-forge` | 完整管家：协议 + 文档 digest + 压缩恢复 + 全部写入守卫 |
| `project-forge-review`（在 `review/` 子目录） | 干净审查模式：代码评审、简单任务、干净环境看项目 |

## 安装

```sh
# 本地开发（link 方式）
dsh plugin --profile web add link:/path/to/dsh-project-forge
dsh plugin --profile web add link:/path/to/dsh-project-forge/review

# 或直接从 git 安装
dsh plugin --profile web add github:sopreigj/dsh-project-forge#main
```

bundle 插件安装后需**重启 `dsh web`** 生效。然后在模式选择器里选「项目锻造模式」/「项目锻造 · 干净审查」。

## 模式管什么

- **状态边界**：项目自己的一切——状态文档、仓库自带规则、并发认领——都放在一个目录里（默认 `private/`）。边界之外是**公开面**，从第一次提交起就按"已经开源"写：可移植、除配置文件外不含任何隐私（配置文件必须配一份示例给后来者）、不引用边界内的路径。开源动作因此是机械的：删掉边界目录 → 复制 → `git init`。
- **仅本地的 git**：未经用户明确要求，永不 push、永不加 remote、永不改写历史。
- **状态文档分三类**，全部住在边界内。*合同*——`private/steward.md`（仓库自己的规则）、`plan.md`（战略）、`done.md`（当前状态）、`todo.md`（执行队列）——每轮**整份内联**：每份有软预算，而预算是**告警线，不是裁剪线**。*记录*——`private/journal.jsonl`（工作记录）与 `private/tortuous.jsonl`（负知识：失败路线与记录在案的偏差）——是只追加的 JSONL，一句一条，**不内联**；只有一行一条的索引与最近几条记录会随 digest 和恢复消息出现。*按需*材料住在 `private/rationale/`。文档仍留在项目根的旧项目照常读取（规则也从 `.agents/steward.md` 读），不会被边界这次改动打断。
- **检查点协议**：收尾一个逻辑单元 → 跑检查 → 更新文档 → 一次提交；禁止逐命令提交。
- **布局与命名**：目录/文件/标识符三层都执行"一词一义"；每个检查点复查；布局守卫会拒绝"根目录混类且未在文档里说明"的提交。
- **并行会话**：单一文档主；文件级认领（在 `private/.forge-claims/`，commit 即释放，静默 10 分钟自动过期）。
- **禁止密钥越界入库**：边界之外的凭据文件（`.env`、`*.pem` 等）拒绝提交；边界内允许本地仓自留。
- **压缩恢复**：真实 `compaction/end` 事件触发，把恢复消息（重申协议 + 最新 digest）折入下一步。

## 配置

所有开关默认开。**完整参考（32 个字段、各自默认值与作用）见 [docs/configuration.md](docs/configuration.md)**；`release/check-consistency.mjs` 会把那张表与插件 schema 逐字段比对，因此二者无法各自漂移。

最常改的两个：

```yaml
- id: project-forge
  name: 'dsh-project-forge'
  config:
    sizeLimitMode: ratchet    # 另加：拒绝"已超硬上限还继续变大"的提交
    stateDir: '.'             # 回到边界之前的布局（文档放项目根）
```

## 目录结构

```
dsh-project-forge/
├── package.json          # bundle 清单（dsh.bundle.patch）
├── cordis.patch.yml      # 预设组合（project-forge）
├── plugin/               # 模式插件本体（协议 + digest + 恢复 + 守卫）+ 它的自测
├── skills/project-forge-grilling/   # 自带讨论技能
├── review/               # 审查模式子包（独立 package.json + 自己的一份技能副本）
├── release/              # 发布工具：两个检查 + 镜像脚本
├── docs/                 # 给使用者与贡献者的文档
└── README.md / README.zh.md / LICENSE
```

`docs/` 按 Diátaxis 组织，一篇只服务一种读者需求：[configuration.md](docs/configuration.md) 是**参考**，[state-boundary.md](docs/state-boundary.md) 是**解释**（边界的设计、导出流程与守卫覆盖面），`open-sourcing.md` 是开源笔记。

本开发仓的状态边界 `private/` 纳入 git 跟踪以便回滚，但被 `release/publish.ps1` **整目录排除**，因此不会出现在公开发行版里。

## 开发

```sh
node plugin/index.test.mjs plugin/index.js   # 自测：配置、digest、守卫、patch↔schema 漂移
node release/check-consistency.mjs           # 配置参考表 ↔ schema；技能两份副本是否一致
node release/check-preset-sync.mjs --source <dsh-checkout>   # 本仓 preset 行 ↔ 内置 standard
node release/check-public-surface.mjs        # 把模式自己的隐私守卫用在本仓上
```

插件只 import Node 内建模块——profile 安装的 bundle 解析不到第三方包。`plugin/schema.js` 的手写 Standard Schema 实现了 Cordis 要求的 `~standard.validate` 接口（官方示例用 `@deepseek-ai/schemastery`，这里选手写是为了零依赖）。

`release/` 放发布工具：`check-public-surface.mjs` 是上面那个检查；`check-consistency.mjs` 保证文档与那份重复的技能副本始终与各自的单一来源一致；`check-preset-sync.mjs` 把本仓 preset 的行集合与内置 `standard` 逐行比对，避免"上游加了行而我们没跟"被静默漏掉（需要 DSH 源码树：`--source <dir>` 或 `$DSH_SOURCE`，没有时干净跳过）；`publish.ps1` 在镜像前先跑**全部四项**检查，过期或坏掉的公开面会被拒绝而不是被发布。发布目录来自 `-PublicRepo` 或 `$env:FORGE_PUBLIC_REPO`，**绝不硬编码**——公开脚本里出现本机路径正是 §1.7 要禁止的。

## 边界（信任之前请读）

- 守卫拦在 shell 工具边界，是**防手滑不是安全边界**（换写法/脚本/provider API 可绕过）。
- 隐私守卫（`guardPrivacyBoundary`）只判三件可判定的事——本机家目录路径、源码伸进状态边界、配置文件之外的高置信密钥字面量——**不判"这段文字读起来是否公开"**。文件可用标记 `privacy-guard: allow` 自我豁免；模式自己的插件与夹具就带这个标记。
- 并发守卫只护高争用文件（四份合同文档 + 自带规则 + 源码）；普通文件的合并冲突交给 git。
- 协议是提示词文本：它保证**在场**，模型是否**照做**只有守卫强制的那部分可被机器验证。

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
