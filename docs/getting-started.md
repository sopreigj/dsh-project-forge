# 上手：从安装到第一次接管

这是一篇**教程**：跟着做一遍，你会得到一个已经按项目锻造模式运行的会话。每条命令都在真实环境里跑过；
本文只讲"怎么做"，为什么这样设计见 [状态边界](state-boundary.md)，全部配置键见 [配置参考](configuration.md)。

记号：`<checkout>` 是这份 bundle 在本机的位置，`<profile>` 是你要装进的那个 profile 名。
**profile 名不是路径**：它的实际位置由你在用的那套 DSH 决定（`dsh` 命令行与源码 checkout 各有自己的 `$HOME/.dsh` 或 `<checkout>/.dsh`），
所以下面一律用 `--profile` 指代，不手写目录。

## 1. 确认 dsh 可用

```powershell
dsh --version
```

看到版本号即可（本文验证于 `0.1.7-rc.2`）。

## 2. 安装 bundle

两条：模式本体，以及它附带的审查模式（可分开装，建议一起装）。

```powershell
dsh plugin --profile <profile> add link:<checkout>
dsh plugin --profile <profile> add link:<checkout>/review
```

`dsh plugin` 是 pnpm 的转发：`link:` 表示"就地引用这份 checkout"，你改文件、重启即生效，不必重装。
重复执行是安全的——值没变时 pnpm 不会改动 profile 清单。

**两条注意**：

- 桌面版自己的 profile **不接受命令行安装**（会报 `profile "<名字>" is managed exclusively by the Electron application`），
  它由桌面应用自己管——在那里用应用的方式装。
- 命令行能装的 profile 名取决于你这套 DSH 装了哪些（本文环境里是 `web`）。

## 3. 重启，并在选单里确认

重启你的 DSH 客户端（桌面版直接重开；源码版重新起 `dsh web`）。新建会话时选模式，卡片文案是：

- 中文界面：**项目锻造模式 Project Forge**
- 英文界面：**Project Forge mode**

选不到它，说明第 2 步装到了另一个 profile（或者那套 DSH 用的不是同一个 `--profile` 名）。

## 4. 确认"生效的是哪一份副本"

`link:` 让同一份代码可能出现在多处。**先问清哪一份是活的**，再去改它，否则你会在错误的文件里排查问题：

```powershell
dsh plugin --profile <profile> exec node -p "require('fs').realpathSync('node_modules/dsh-project-forge')"
```

输出应当是你第 2 步 `add` 的那个 `<checkout>`。再让这份活副本自证：

```powershell
node "<上一步的输出>\plugin\index.test.mjs" "<上一步的输出>\plugin\index.js"
```

看到 `all plugin checks passed` 即通过。

## 5. 第一次接管

给模式一个真实项目。**它需要本地 git**，所以先建仓库：

```powershell
mkdir my-project; cd my-project
git init
```

在这个目录里开一个新会话，选项目锻造模式，然后说一句：

> 接管这个项目。

它会先走查整棵目录树，再把四份**合同**写进 `private/`：`steward.md`（本仓库自己的规则）、`plan.md`（战略）、
`done.md`（当前状态）、`todo.md`（执行队列），外加两份**只追加的记录** `journal.jsonl` 与 `tortuous.jsonl`。
没弄清的事情它会问你，而不是编一个。

## 6. 确认它真的接管了

三处证据，缺一说明模式没生效：

1. 项目里出现了 `private/`，里面有上面那四份合同；
2. 之后每个**工具结果**末尾都有一行 `⏱ …` 时间脚注；
3. `git log --oneline` 里能看到检查点提交，且每个提交都伴随状态文档的更新。

## 7. 之后怎么用

- 干完一个逻辑单元（一件事）就让它收尾提交一次：跑相关检查、更新状态文档，然后一个提交。
- 想知道"现在什么是真的"读 `done.md`；"还剩什么没做"读 `todo.md`。
- 禁止它做什么：**不会**添加远端，**不会**推送，除非你在同一次对话里明确要它发布。

## 8. 下一步

- 要改模式自己的行为（协议正文、守卫）→ [配置参考](configuration.md)。
- 想知道状态边界为什么这样切 → [状态边界](state-boundary.md)。
