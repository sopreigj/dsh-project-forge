/**
 * The changelog guard: `package.json` 的版本必须在这份日志里有条目，且顶部保留 `[Unreleased]`。
 *
 * 为什么由脚本守：`CHANGELOG.md` 是公开面上唯一"说清版本之间有什么变化"的文件，而它恰好是
 * 最容易被跳过的一步——发版时改了 `package.json`、忘了动它，读者就会看到一份停在旧版本的日志。
 * 这条检查把"该写没写"变成一次可失败的运行，而不是靠记性。
 *
 * 断言（每条都会以精确差异 exit 1）：
 *   1. 文件存在，且顶部有 `## [Unreleased]` 区块（新条目总有一个落点）；
 *   2. `## [<package.json 的 version>]` 条目存在；
 *   3. 每个 `## [` 标题要么是 `Unreleased`，要么是 `x.y.z` 且日期形如 `YYYY-MM-DD`；
 *   4. 摘要里报出**找到了多少个版本条目**，第一次跑就肉眼核对它是否等于预期（T69）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const failures = [];

const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const version = pkg.version;
if (typeof version !== 'string' || version.trim() === '') {
  console.error('✗ package.json 里没有 version —— 更新日志无从对账');
  process.exit(1);
}

let changelog;
try {
  changelog = readFileSync(join(repo, 'CHANGELOG.md'), 'utf8');
} catch {
  // 找不到就是失败，不是跳过：一份没有更新日志的项目不满足公开面要求（§3.5）。
  console.error(`✗ 缺少 CHANGELOG.md —— 版本 ${version} 没有可读的变更说明`);
  process.exit(1);
}

const headings = [...changelog.matchAll(/^## \[([^\]]+)\](.*)$/gm)].map((match) => ({
  label: match[1].trim(),
  rest: match[2].trim(),
  line: match[0],
}));

if (!headings.some((heading) => heading.label === 'Unreleased')) {
  failures.push('顶部缺少 `## [Unreleased]` 区块：新条目没有落点，下一个人只会把它记在某处或忘掉');
}

if (!headings.some((heading) => heading.label === version)) {
  failures.push(`没有 \`## [${version}]\` 条目：package.json 已经是 ${version}，日志里却找不到这个版本`);
}

for (const heading of headings) {
  if (heading.label === 'Unreleased') {
    if (heading.rest !== '') failures.push(`\`## [Unreleased]\` 后面不该跟东西：${heading.line}`);
    continue;
  }
  if (!/^\d+\.\d+\.\d+$/.test(heading.label)) {
    failures.push(`版本标题不是 x.y.z：${heading.line}`);
    continue;
  }
  const dateMatch = /^-\s*(\d{4}-\d{2}-\d{2})$/.exec(heading.rest);
  if (dateMatch === null) {
    failures.push(`\`## [${heading.label}]\` 缺少 \`YYYY-MM-DD\` 日期：${heading.line}`);
  } else {
    const [, date] = dateMatch;
    const parsed = Date.parse(`${date}T00:00:00Z`);
    const roundTrip = Number.isNaN(parsed) ? '' : new Date(parsed).toISOString().slice(0, 10);
    if (roundTrip !== date) failures.push(`日期不是真实存在的日子：${date}`);
  }
}

const released = headings.filter((heading) => heading.label !== 'Unreleased');
if (released.length === 0) {
  failures.push('一个版本条目都没有：这份日志等于不存在');
}

if (failures.length > 0) {
  console.error('✗ CHANGELOG.md 与 package.json 对不上：');
  for (const failure of failures) console.error(`  · ${failure}`);
  process.exit(1);
}

console.log(
  `changelog: clean（package.json ${version} 有条目；${released.length} 个版本条目 + Unreleased；标题与日期格式合法）`,
);
