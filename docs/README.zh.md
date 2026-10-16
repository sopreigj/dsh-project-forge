# dsh-project-forge

[English](../README.md) | **中文**

**项目锻造模式（Project Forge）** —— 一个 DeepSeek Harness Agent 预设（agent preset）：把 Agent 变成项目的**管家**，让项目始终可恢复（本地 git）、可追溯（四份状态文档 + 决策记录）、结构清晰（布局与命名纪律）、且在上下文压缩之后依然能继续推进（压缩恢复机制），并有六条写入守卫在**模型不配合时也照样生效**。

本仓库提供两个预设：

| 预设 | 用途 |
|---|---|
| `project-forge` | 完整管家：协议 + 文档 digest + 压缩恢复 + 6 条守卫 |
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

- **状态边界**：项目自己的一切——四份状态文档、仓库自带规则、并发认领——都放在一个目录里（默认 `private/`）。边界之外是**公开面**，从第一次提交起就按"已经开源"写：可移植、除配置文件外不含任何隐私（配置文件必须配一份示例给后来者）、不引用边界内的路径。开源动作因此是机械的：删掉边界目录 → 复制 → `git init`。
- **仅本地的 git**：未经用户明确要求，永不 push、永不加 remote、永不改写历史。
- **状态文档在边界内**：`private/done.md`（当前状态 + 最短可复现路径）、`private/todo.md`（执行队列）、`private/plan.md`（战略与决策）、`private/tortuous.md`（负知识，固定六段式条目模板）。digest 每轮内联前三份的**尾部** + 仓库状态 + `private/steward.md`。文档仍留在项目根的旧项目照常读取（规则也从 `.agents/steward.md` 读），不会被这次改动打断。
- **检查点协议**：收尾一个逻辑单元 → 跑检查 → 更新文档 → 一次提交；禁止逐命令提交。
- **布局与命名**：目录/文件/标识符三层都执行"一词一义"；每个检查点复查；布局守卫会拒绝"根目录混类且未在文档里说明"的提交。
- **并行会话**：单一文档主；文件级认领（在 `private/.forge-claims/`，commit 即释放，30 分钟超时自愈）。
- **禁止密钥越界入库**：边界之外的凭据文件（`.env`、`*.pem` 等）拒绝提交；边界内允许本地仓自留。
- **压缩恢复**：真实 `compaction/end` 事件触发，把恢复消息（重申协议 + 最新 digest）折入下一步。

## 配置

所有开关默认开，设 `false` 关闭。完整配置表见[英文 README](../README.md#configuration)。

```yaml
# 在 profile 的 cordis.patch.yml 里按行覆盖示例
- id: project-forge
  name: 'dsh-project-forge'
  config: { digestTailLimits: { plan.md: 10000, todo.md: 5000, done.md: 10000 } }
```

## 目录结构

```
dsh-project-forge/
├── package.json          # bundle 清单（dsh.bundle.patch）
├── cordis.patch.yml      # 预设组合（project-forge）
├── plugin/               # 模式插件本体（协议 + digest + 恢复 + 6 守卫）
├── skills/project-forge-grilling/   # 自带讨论技能
├── review/               # 审查模式子包（独立 package.json）
└── README.md / README.zh.md / LICENSE
```

本开发仓的状态边界 `private/`（四份状态文档 + 自带规则）纳入 git 跟踪以便回滚，但被 `release/publish.ps1` **整目录排除**，因此不会出现在公开发行版里。边界的设计、导出流程与守卫覆盖面见 [状态边界](state-boundary.md)。

## 开发

```sh
node plugin/index.test.mjs plugin/index.js   # 自测（配置、digest、全部守卫）
```

插件只 import Node 内建模块——profile 安装的 bundle 解析不到第三方包。`plugin/schema.js` 的手写 Standard Schema 实现了 Cordis 要求的 `~standard.validate` 接口（官方示例用 `@deepseek-ai/schemastery`，这里选手写是为了零依赖，README 已注明）。

## 边界（信任之前请读）

- 守卫拦在 shell 工具边界，是**防手滑不是安全边界**（换写法/脚本/provider API 可绕过）。
- 隐私守卫（`guardPrivacyBoundary`）只判三件可判定的事——本机家目录路径、源码伸进状态边界、配置文件之外的高置信密钥字面量——**不判"这段文字读起来是否公开"**。文件可用标记 `privacy-guard: allow` 自我豁免；模式自己的插件与夹具就带这个标记。
- 并发守卫只护高争用文件（四文档 + 自带规则 + 源码）；普通文件的合并冲突交给 git。
- 协议是提示词文本：它保证**在场**，模型是否**照做**只有守卫强制的那部分可被机器验证。

## 协议依据

本 bundle 按 DeepSeek Harness 官方插件契约编写：`dsh.bundle.patch` 声明、纯 JS 入口、Standard Schema 配置接口。官方教程见源码仓库 `docs/user/develop/basic/`（index / config / publish）。

## 许可证

MIT —— 见 [LICENSE](../LICENSE)。
