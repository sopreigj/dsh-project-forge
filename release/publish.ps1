# publish.ps1 — 把 dev 工作区的发布快照同步到公开仓库。
#
# 工作方式：
#   1. 先跑五项检查，任一不过就拒绝发布——它们各自对应一类"静默腐烂"：
#        · test/run.mjs              自测：配置解析、digest、全部守卫、patch↔schema 漂移
#          （切片检查在 test/ 下，runner 按原顺序逐个 import；传的第二个参数是要加载的插件入口）
#        · check-consistency.mjs     文档与代码：配置参考表 ↔ schema；两份技能副本逐字节相同
#        · check-preset-sync.mjs     组合与上游：本仓 patch 的行集合 ↔ 内置 standard（无源码树时自跳过）
#        · check-public-surface.mjs  公开面：用本模式自己的隐私守卫检查它自己的仓库
#        · check-changelog.mjs      更新日志：package.json 的版本必须有条目、顶部留 Unreleased
#        · check-runtime.mjs         运行时：内置技能的 frontmatter、customSkillDirs 计算出的目标
#                                    （--repo 可指向第二个 bundle，所以 review/ 也跑同一组检查）
#          （它还能解码会话日志、核对生效预设与"装的是哪一份"，那些要另传 --session/--copy）
#   2. 再镜像：`private/`（状态边界：四份合同 + 记录）与 `.gitignore` 之外的全部内容
#      复制到发布目录；发布目录自带一份忽略状态边界的 .gitignore。
#   3. 由发布目录提交并推送（公开仓 = 干净单提交流的追加）。
#
# 用法（在 dev 仓库根运行）：
#   pwsh release/publish.ps1 -PublicRepo <公开仓路径> [-Message "sync: 一句话说明"] [-DshSource <DSH 源码树>]
#   或先设环境变量 FORGE_PUBLIC_REPO（以及可选的 DSH_SOURCE），然后 `pwsh release/publish.ps1`
#
# 路径**不写死在脚本里**：发布目录与 DSH 源码树都是这台机器的布局，写进来就成了不可移植的公开文件（协议 §1.7）。

param(
  [string]$PublicRepo = $env:FORGE_PUBLIC_REPO,
  [string]$Message = "sync: snapshot from dev",
  [string]$DshSource = $env:DSH_SOURCE,
  [switch]$NoPush
)

$ErrorActionPreference = 'Stop'
$dev = Split-Path -Parent $PSScriptRoot

if (-not $PublicRepo) {
  throw "请用 -PublicRepo <路径> 或环境变量 FORGE_PUBLIC_REPO 指定公开仓目录"
}
if (-not (Test-Path "$PublicRepo\.git")) { throw "发布目录不是 git 仓库: $PublicRepo" }

# 1) 发布前的五项检查。检查脚本各自返回非零表示不通过。
function Invoke-Check([string]$Label, [string]$Script, [string[]]$Arguments) {
  Write-Output "── $Label"
  & node $Script @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Label 未通过（exit=$LASTEXITCODE），拒绝发布" }
}

Invoke-Check '自测（配置 / digest / 守卫 / patch↔schema）' "$dev\test\run.mjs" @("$dev\plugin\index.js")
Invoke-Check '一致性（配置参考表 ↔ schema；技能副本）' "$dev\release\check-consistency.mjs" @()
$presetArgs = if ($DshSource) { @('--source', $DshSource) } else { @() }
Invoke-Check '预设同步（本仓 patch ↔ 内置 standard）' "$dev\release\check-preset-sync.mjs" $presetArgs
Invoke-Check '公开面（本模式自己的隐私守卫）' "$dev\release\check-public-surface.mjs" @()
Invoke-Check '更新日志（package.json 的版本必须有条目）' "$dev\release\check-changelog.mjs" @()
Invoke-Check '运行时（技能 frontmatter；customSkillDirs 的目标）' "$dev\release\check-runtime.mjs" @()
Invoke-Check '运行时·review bundle（技能 frontmatter；customSkillDirs 的目标）' "$dev\release\check-runtime.mjs" @('--repo', "$dev\review")

# 2) 镜像同步：排除 .git、整个状态边界 private/、.gitignore
#    （发布版的 .gitignore 由发布目录自己维护，内容是"忽略状态边界"）。
robocopy $dev $PublicRepo /MIR /XD .git private /XF .gitignore /NFL /NDL /NJH /NJS /NP | Out-Null
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
