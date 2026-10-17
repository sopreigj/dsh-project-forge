# publish.ps1 — 把 dev 工作区的发布快照同步到一个指定的发布目录。
#
# 分工（协议 §1.7）：
#   · **做法在这里**（公开面）：跑完全部检查 → 镜像 → 由发布目录提交并推送。
#   · **本机约定在配置里**：发布目录、DSH 源码树、额外排除项都从 `release/publish.config.json`
#     读取；那份文件被 .gitignore 忽略，且镜像时排除，所以它既不进公开面也不进发布副本。
#     仓库附带一份示例孪生 `publish.config.example.json`，按它的形状写自己的那一份即可。
#
# 工作方式：
#   1. 先跑全部检查，任一不过就拒绝发布——它们各自对应一类"静默腐烂"：
#        · test/run.mjs              自测：配置解析、digest、全部守卫、patch↔schema 漂移
#        · check-consistency.mjs     文档与代码：配置参考表 ↔ schema；两份技能副本逐字节相同
#        · check-preset-sync.mjs     组合与上游：本仓 patch 的行集合 ↔ 内置 standard
#        · check-public-surface.mjs  公开面：用本模式自己的隐私守卫检查它自己的仓库
#        · check-prompt-variables.mjs 提示词：patch 里的 {{...}} 必须已注册
#        · check-changelog.mjs      更新日志：package.json 的版本必须有条目、顶部留 Unreleased
#        · check-runtime.mjs         运行时 ×2（主 bundle 与 review bundle）
#   2. 再镜像：**除下面三类之外的全部内容**都复制过去——
#        ① `.git`（发布目录有自己的历史）
#        ② 状态边界 `private/`（合同与记录不进发布副本）
#        ③ 用户自己配置的东西（默认 `.gitignore` 与 `publish.config.json`）
#      第 ③ 类是配置项，不是硬编码：`excludeDirs` / `excludeFiles` 可以按机器再加。
#   3. 由发布目录提交；不带 -NoPush 时推送。
#
# 用法（在 dev 仓库根运行，**用 pwsh 7**——Windows PowerShell 5.1 会按 ANSI 读中文注释而解析失败）：
#   pwsh release/publish.ps1 [-NoPush] [-PublicRepo <路径>] [-DshSource <DSH 源码树>] [-Message "…"]
#   取值优先级：命令行参数 > release/publish.config.json > 环境变量 FORGE_PUBLIC_REPO / DSH_SOURCE。
#
# 路径**不写死在脚本里**：它们是这台机器的布局，写进来就成了不可移植的公开文件（协议 §1.7）。

param(
  [string]$PublicRepo,
  [string]$Message,
  [string]$DshSource,
  [switch]$NoPush
)

$ErrorActionPreference = 'Stop'
$dev = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $PSScriptRoot 'publish.config.json'

# 本机配置：存在就读，不存在就是"没有本机约定"（靠参数或环境变量）。
$config = $null
if (Test-Path $configPath) {
  # 配置里放的是本机路径，它绝不能进公开面：被 git 跟踪就是缺陷，直接拒绝。
  git -C $dev ls-files --error-unmatch 'release/publish.config.json' 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) {
    throw "release/publish.config.json 被 git 跟踪了：它装着本机路径，不能进公开面。请 git rm --cached 它并确认 .gitignore 生效。"
  }
  try {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    Write-Output "配置: release/publish.config.json"
  } catch {
    throw "release/publish.config.json 解析失败（$($_.Exception.Message)）：请对照 publish.config.example.json 修好。"
  }
}

if (-not $PublicRepo) { $PublicRepo = if ($config) { $config.publicRepo } else { $env:FORGE_PUBLIC_REPO } }
if (-not $DshSource) { $DshSource = if ($config) { $config.dshSource } else { $env:DSH_SOURCE } }
# 真值取自哪个提交：源码树通常是「脏」的（正在改的下一版），而装上去跑的是某个发布。给了 tag 就
# 一律读 `git show <tag>:<path>`，绝不退回工作区——见 release/source-truth.mjs。
$DshSourceTag = if ($DshSourceTag) { $DshSourceTag } elseif ($config -and $config.dshSourceTag) { $config.dshSourceTag } else { $env:DSH_SOURCE_TAG }
if (-not $Message) { $Message = if ($config -and $config.message) { $config.message } else { 'sync: snapshot from dev' } }
if (-not $PublicRepo) {
  throw "没有发布目录：用 -PublicRepo、release/publish.config.json 或环境变量 FORGE_PUBLIC_REPO 指定（见 publish.config.example.json）"
}
if (-not (Test-Path "$PublicRepo\.git")) { throw "发布目录不是 git 仓库: $PublicRepo" }

# 镜像的排除项：默认三类（.git / 状态边界 / 用户配置），可按机器在配置里追加。
$excludeDirs = if ($config -and $config.excludeDirs) { @($config.excludeDirs) } else { @('.git', 'private') }
$excludeFiles = if ($config -and $config.excludeFiles) { @($config.excludeFiles) } else { @('.gitignore', 'publish.config.json') }

# 1) 发布前的检查。检查脚本各自返回非零表示不通过。
function Invoke-Check([string]$Label, [string]$Script, [string[]]$Arguments) {
  Write-Output "── $Label"
  & node $Script @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Label 未通过（exit=$LASTEXITCODE），拒绝发布" }
}

Invoke-Check '自测（配置 / digest / 守卫 / patch↔schema）' "$dev\test\run.mjs" @("$dev\plugin\index.js")
Invoke-Check '一致性（配置参考表 ↔ schema；技能副本）' "$dev\release\check-consistency.mjs" @()
$presetArgs = if ($DshSource) { @('--source', $DshSource) } else { @() }
if ($DshSourceTag) { $presetArgs += @('--tag', $DshSourceTag) }
Invoke-Check '预设同步（本仓 patch ↔ 内置 standard）' "$dev\release\check-preset-sync.mjs" $presetArgs
Invoke-Check '公开面（本模式自己的隐私守卫）' "$dev\release\check-public-surface.mjs" @()
Invoke-Check '提示词变量（patch 里的 {{...}} 必须已注册）' "$dev\release\check-prompt-variables.mjs" $presetArgs
Invoke-Check '更新日志（package.json 的版本必须有条目）' "$dev\release\check-changelog.mjs" @()
# The install surface is part of "does this publish work": a profile that lists a bundle whose
# target is gone loads nothing at all, and nothing else notices.
Invoke-Check '安装面（profile 里的条目必须指向真实存在的副本）' "$dev\release\check-installed.mjs" @()
Invoke-Check '运行时（技能 frontmatter；customSkillDirs 的目标）' "$dev\release\check-runtime.mjs" @()
Invoke-Check '运行时·review bundle（技能 frontmatter；customSkillDirs 的目标）' "$dev\release\check-runtime.mjs" @('--repo', "$dev\review")

# 2) 镜像同步：除排除项之外的全部内容都过去。
Write-Output ("镜像排除：目录 [{0}]、文件 [{1}]" -f ($excludeDirs -join ', '), ($excludeFiles -join ', '))
$xd = @('/XD') + $excludeDirs
$xf = @('/XF') + $excludeFiles
robocopy $dev $PublicRepo /MIR @xd @xf /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败 exit=$LASTEXITCODE" }

# 3) 提交并推送。
Push-Location $PublicRepo
try {
  git add -A
  # 无改动只表示"不用提交"，不表示"不用推送"：已经提交但没推的提交必须照样推出去，
  # 否则这条通道会在下一次镜像时假装成功，而远端一直停在旧版本。
  if (git status --porcelain) {
    git -c user.email=forge@local -c user.name="project-forge" commit -qm $Message
  } else {
    Write-Output '无改动，跳过提交（继续检查是否有未推送的提交）'
  }
  if ($NoPush) {
    Write-Output "mirrored and committed locally; not pushed (pass without -NoPush to push)"
    Write-Output "  $(git log --oneline -1)"
    return
  }
  $unpushed = [int](git rev-list --count 'origin/main..HEAD')
  if ($unpushed -eq 0) {
    Write-Output "远端已是最新: $(git log --oneline -1)"
    return
  }
  Write-Output "待推送提交: $unpushed"
  git push
  if ($LASTEXITCODE -ne 0) {
    throw "git push 失败（exit=$LASTEXITCODE）：远端没收到，别把这次当成已发布。常见急救：重试；仍失败则 git config http.version HTTP/1.1 与 http.postBuffer 加大后重试。"
  }
  $behind = [int](git rev-list --count 'HEAD..origin/main')
  if ($behind -ne 0) { throw "推送后 HEAD 仍与 origin/main 不一致（origin 比本地多 $behind 个提交）" }
  Write-Output "已发布: $(git log --oneline -1)"
} finally {
  Pop-Location
}
