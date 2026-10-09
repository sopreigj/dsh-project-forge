# publish.ps1 — 把 dev 工作区的发布快照同步到公开仓库。
#
# 工作方式：
#   dev 目录（本仓库）是日常开发处，含四份状态文档（私有仓跟踪）；
#   本脚本把除状态文档与 .gitignore 外的全部内容镜像到发布目录，
#   由发布目录提交并推送（公开仓 = 干净单提交流的追加）。
#
# 用法（在 dev 仓库根运行）：
#   pwsh scripts/publish.ps1 [-Message "sync: 一句话说明"]

param(
  [string]$Message = "sync: snapshot from dev"
)

$ErrorActionPreference = 'Stop'
$dev = Split-Path -Parent $PSScriptRoot
$pub = 'D:\code\Agnets_and_Tools\dsh-project-forge'

if (-not (Test-Path "$pub\.git")) { throw "发布目录不是 git 仓库: $pub" }

# 镜像同步：排除 .git、四份状态文档、.gitignore（发布版 .gitignore 保持"忽略状态文档"）
robocopy $dev $pub /MIR /XD .git /XF done.md plan.md todo.md tortuous.md .gitignore /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败 exit=$LASTEXITCODE" }

Push-Location $pub
try {
  git add -A
  if (-not (git status --porcelain)) { Write-Output '无改动，跳过提交'; return }
  git -c user.email=forge@local -c user.name="project-forge" commit -qm $Message
  git push
  Write-Output "已发布: $(git log --oneline -1)"
} finally {
  Pop-Location
}
