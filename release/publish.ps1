# publish.ps1 — 把 dev 工作区的发布快照同步到公开仓库。
#
# 工作方式：
#   1. 先跑 `release/check-public-surface.mjs`：用本模式自己的隐私守卫检查公开面
#      （本机家目录路径 / 源码伸进 private/ / 配置文件之外的密钥字面量），不通过就拒绝发布。
#   2. 再镜像：`private/`（状态边界：四份状态文档 + 自带规则）与 `.gitignore` 之外的全部内容
#      复制到发布目录；发布目录自带一份忽略状态边界的 .gitignore。
#   3. 由发布目录提交并推送（公开仓 = 干净单提交流的追加）。
#
# 用法（在 dev 仓库根运行）：
#   pwsh release/publish.ps1 -PublicRepo <公开仓路径> [-Message "sync: 一句话说明"]
#   或先设环境变量 FORGE_PUBLIC_REPO，然后 `pwsh release/publish.ps1`
#
# 发布目录**不写死在脚本里**：它是这台机器的布局，写进来就成了不可移植的公开文件（协议 §1.7）。

param(
  [string]$PublicRepo = $env:FORGE_PUBLIC_REPO,
  [string]$Message = "sync: snapshot from dev",
  [switch]$NoPush
)

$ErrorActionPreference = 'Stop'
$dev = Split-Path -Parent $PSScriptRoot

if (-not $PublicRepo) {
  throw "请用 -PublicRepo <路径> 或环境变量 FORGE_PUBLIC_REPO 指定公开仓目录"
}
if (-not (Test-Path "$PublicRepo\.git")) { throw "发布目录不是 git 仓库: $PublicRepo" }

# 1) 公开面检查：把本模式自己的守卫用在它自己的仓库上。
node "$dev\release\check-public-surface.mjs"
if ($LASTEXITCODE -ne 0) { throw "公开面检查未通过，拒绝发布" }

# 2) 镜像同步：排除 .git、整个状态边界 private/、.gitignore
#    （发布版的 .gitignore 由发布目录自己维护，内容是"忽略状态边界"）。
robocopy $dev $PublicRepo /MIR /XD .git private /XF .gitignore /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败 exit=$LASTEXITCODE" }

# 3) 提交并推送。
Push-Location $PublicRepo
try {
  git add -A
  if (-not (git status --porcelain)) { Write-Output '无改动，跳过提交'; return }
  git -c user.email=forge@local -c user.name="project-forge" commit -qm $Message
  if ($NoPush) {
    Write-Output "mirrored and committed locally; not pushed (pass without -NoPush to push)"
    Write-Output "  $(git log --oneline -1)"
    return
  }
  git push
  Write-Output "已发布: $(git log --oneline -1)"
} finally {
  Pop-Location
}
