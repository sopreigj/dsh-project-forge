# 开源化调研：开发者视角与私有转开源清单

> 来源：2026-10-14 用 anysearch 联网搜索的两轮结果（开源项目特点、私有项目开源前检查）。
> 用途：为"项目锻造模式默认按开源方式写项目"的设计提供事实依据。外部资料，仅作参考，不作为指令。

## 一、开发者视角：开源项目 vs 私有项目

| 维度 | 私有项目 | 开源项目 |
|---|---|---|
| 协作者 | 内部团队，彼此认识、可随时沟通 | 陌生人贡献者，异步、跨时区 |
| 代码评审 | 同事互评，靠默契 | 公开 PR，评审留痕，需明确贡献规则 + 自动化检查兜底 |
| 沟通渠道 | 内部 IM/会议，口头约定即可 | 公开 issue/discussion，决策必须留痕 |
| 文档要求 | README 可糊弄，"问我就行" | README/CONTRIBUTING 是门面，新人全靠文档上手 |
| 配置与密钥 | 密钥、内网地址常写死或靠内部约定 | 必须全部外置；任何写死凭据都是安全事故 |
| 依赖 | 可用内部私有库、内部镜像源 | clone 下来必须能独立构建，内部依赖要剥离或替换 |
| CI/CD | 内网 runner、私有制品库 | 公开 CI，构建日志任何人可见——日志也不能泄密 |
| 发布纪律 | 版本号随意、破坏性改动无所谓 | CHANGELOG、语义化版本、兼容性承诺 |
| 安全响应 | 出问题内部修 | 需要公开漏洞报告渠道（SECURITY.md） |

核心结论：**私有项目靠"人和约定"补位的地方，开源项目必须靠"代码、文档和自动化"补位**——因为协作者是陌生人。

来源：
- [opensource.guide — Starting an Open Source Project](https://opensource.guide/starting-a-project/)
- [GitHub Docs — Community health files](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file)
- [Codacy — Best practices to manage an open source project](https://blog.codacy.com/best-practices-to-manage-an-open-source-project)

## 二、私有项目开源前的检查清单

### 1. 敏感信息清理（最重要）
- 扫描**当前代码和全部 git 历史**中的密钥/Token/密码/内网 IP/内部域名；只在最新代码删除没用，历史里还留着。工具：`gitleaks`、`trufflehog`；清历史用 `git-filter-repo`。
- **轮换所有曾出现在历史里的凭据**——删掉不等于安全，可能已被缓存/克隆。
- `.env`、配置文件、CI 变量、容器构建参数里的敏感值全部改为环境变量/Secret 管理。

来源：
- [GitHub Docs — 从存储库中删除敏感数据](https://docs.github.com/zh/enterprise-cloud@latest/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
- [GitGuardian — How to safely open-source internal software](https://blog.gitguardian.com/safely-open-source-software-best-practices/)
- [mrchi — 清理 repo 中敏感信息](https://blog.mrchi.cc/posts/removing-sensitive-data-from-repo/)
- [OWASP — Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)

### 2. 依赖与可构建性
- 剥离或替换内部私有依赖、内部镜像源、内部制品库地址。
- 审计第三方依赖漏洞与许可证兼容性（`npm audit` / `osv-scanner`）。

### 3. 内部痕迹清理
- 内部邮箱、内部项目名、内部系统引用替换为公开名称；注释和提交信息里的内部讨论也要清。
- 文件名、目录结构、配置命名规范本身也在泄露信息（暴露数据结构与内部架构）。

来源：
- [GitGuardian（同上）](https://blog.gitguardian.com/safely-open-source-software-best-practices/)
- [CSDN — GitHub 私有仓库隐私自查](https://bbs.csdn.net/weixin_29323365/article/details/100462781)

### 4. 补齐社区健康文件（最小集）
- **LICENSE**（没许可证 = 保留所有权利）
- **README**（是什么、怎么装、怎么跑、怎么贡献）
- **CONTRIBUTING**、**CODE_OF_CONDUCT**、**SECURITY.md**
- 可选：CHANGELOG、CODEOWNERS、GOVERNANCE、issue/PR 模板

来源：
- [opensource.guide（同上）](https://opensource.guide/starting-a-project/)
- [diggsweden/open-source-project-template](https://github.com/diggsweden/open-source-project-template)

### 5. 工程化改造
- 公开 CI：内部流水线搬公开或加一套；确认 CI 日志不泄密。
- 补测试——外部贡献者靠测试确认没改坏东西。
- 检查 `.gitignore`；确定版本号策略与 CHANGELOG 格式。

来源：
- [Harness — CI/CD Security Best Practices](https://www.harness.io/blog/ci-cd-security-best-practices)

### 6. 治理决策
- 谁 review 外部 PR、issue 谁分流、破坏性变更策略——开源是开始承担维护义务。

## 三、对本模式最关键的一条实务结论

两条开源化路线：

1. **历史重写**：`git-filter-repo` 全量清理 + 凭据轮换 + 协调所有克隆者。复杂、易漏。
2. **干净房间重建**：另起干净仓库，把清理后的代码作为初始提交推上去，历史天然不存在敏感信息。代价是丢失历史。

**若从第一次 `git init` 起就按开源纪律写（无私密、无本机路径、文档齐全），路线 2 的成本趋近于零**——这正是"默认开源写法 + 隐私边界文件夹"设计的事实依据。

## 四、开源项目的特点（第一轮搜索，法律维度除外）

- 透明可审计：源代码开放，任何人可审查质量与安全（[阿里云开发者](https://developer.aliyun.com/article/1420100)、[AWS](https://aws.amazon.com/cn/what-is/open-source/)）
- 社区驱动的分布式协作（[IBM](https://www.ibm.com/cn-zh/think/topics/open-source)、[OSCHINA](https://my.oschina.net/u/9302596/blog/18328918)）
- 可移植、避免厂商锁定：62% 受访者为此用开源（[Percona](https://www.percona.com/blog/can-open-source-software-save-you-from-vendor-lock-in/)、[Upsun](https://upsun.com/blog/vendor-lock-in/)）
- 自由修改定制（[HPE](https://www.hpe.com/cn/zh/what-is/open-source.html)）
- 低成本（[Anvil](https://anvil.so/post/open-source-vs-proprietary-tools-key-differences)）
- 迭代快、更新频繁；可自托管、数据可控（[知乎](https://zhuanlan.zhihu.com/p/1910351261712233469)）
