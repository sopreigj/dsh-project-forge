/**
 * release/check-consistency.mjs — the two internal duplications that must not drift.
 *
 * 1. `docs/configuration.md` is the user-facing reference for every config field, and
 *    `plugin/config/schema.js`'s `DEFAULTS` is the code that implements them. Those two were written by
 *    hand from the same facts once, and drifted: the README still documented `digestTailLimits`
 *    after the schema renamed it, which is exactly what broke a session resume on 2026-10-16.
 *    The check parses the table's default column as JSON and compares it to `DEFAULTS`, so a
 *    rename or default change fails here instead of at the next restart.
 *
 * 2. The bundled grilling skill exists twice — `skills/` for the main bundle and
 *    `review/skills/` for the review bundle, because each bundle resolves its own package and
 *    cannot reach into the other (`cordis.patch.yml` in both points `customSkillDirs` at its own
 *    copy). The duplication is deliberate; silently letting the copies differ is not.
 *
 * 3. A rename is not finished while a retired word survives somewhere on the public surface — the
 *    two READMEs, a comment in the patch, the mode-picker cards and the patch row description all
 *    kept one at different times.
 *
 * 4. The public docs name repository paths, and a doc that still points at a renamed or deleted
 *    file is a stale doc — protocol §3 calls that a defect, and only a human reading it could
 *    notice. Both inline paths (`release/check-runtime.mjs`) and relative markdown link targets
 *    are resolved against the tree.
 *
 * 5. `cordis.patch.yml` installs this plugin by naming its config keys literally, and a key the
 *    schema does not declare is rejected at install time — the exact shape of the 2026-10-16
 *    resume failure. `check-preset-sync.mjs` cannot catch it: that script only compares rows against
 *    the *shipped* preset, and this row is ours. The truth is derived from the source here
 *    (`DEFAULTS`), not from a list of key names kept next to the check.
 *
 * Usage: node release/check-consistency.mjs   (exit 1 on any mismatch)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULTS } from '../plugin/config/schema.js';

import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

/** Key-order-independent form, so a table row and `DEFAULTS` compare equal when they say the same. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

// ── 1. the configuration reference versus the schema's defaults ────────────────
const reference = join(root, 'docs', 'configuration.md');
const documented = new Map();
for (const line of readFileSync(reference, 'utf8').split('\n')) {
  // `| \`field\` | \`default\` | meaning |` — the default cell is a JSON literal by design.
  const row = /^\|\s*`([A-Za-z][A-Za-z0-9]*)`\s*\|\s*`([^`]+)`\s*\|/.exec(line);
  if (row === null) continue;
  try {
    documented.set(row[1], JSON.parse(row[2]));
  } catch {
    failures.push(`docs/configuration.md: ${row[1]} 的默认值不是合法 JSON 字面量：${row[2]}`);
  }
}
for (const [field, value] of Object.entries(DEFAULTS)) {
  if (!documented.has(field)) {
    failures.push(`docs/configuration.md 没有记载字段 ${field}`);
    continue;
  }
  if (canonical(documented.get(field)) !== canonical(value)) {
    failures.push(`docs/configuration.md: ${field} 写作 ${canonical(documented.get(field))}，schema 是 ${canonical(value)}`);
  }
}
for (const field of documented.keys()) {
  if (!Object.hasOwn(DEFAULTS, field)) failures.push(`docs/configuration.md 多出一个 schema 里没有的字段：${field}`);
}

// ── 2. the two copies of the bundled skill ─────────────────────────────────────
const copies = ['skills/project-forge-grilling/SKILL.md', 'review/skills/project-forge-grilling/SKILL.md'];
const [primary, review] = copies.map((path) => readFileSync(join(root, path), 'utf8'));
if (primary !== review) {
  failures.push(`${copies[0]} 与 ${copies[1]} 内容不一致——两份自包含 bundle 各带一份，必须逐字节相同`);
}

// ── 3. retired vocabulary must not come back into the public surface ───────────
// A rename is finished only when *every* copy stopped using the old word, and this repository has
// been bitten four times by a copy that kept it (the two READMEs, a comment in the patch, the
// mode-picker cards, the patch row description). The check is mechanical: a retired term anywhere
// outside the state boundary fails, unless that very line carries the marker
// `vocabulary-guard: allow` next to a reason.
const RETIRED = new Map([
  ['tortuous.md', 'negative knowledge is append-only JSONL: `tortuous.jsonl`'],
  ['journal.md', 'the work record is append-only JSONL: `journal.jsonl`'],
  ['digestTailLimits', 'renamed to `documentBudgets` — the drift that once broke session resume'],
  ['digestDefaultTailLimit', 'renamed to `documentBudgetDefault`'],
  ['层级聚类', 'D11: 分层模块化 + 明确边界与依赖方向'],
  ['层级模块架构', 'D11 rendering variant: 分层模块化 + 明确边界与依赖方向'],
  ['layered module hierarchy', 'D11: layered modularity with explicit module boundaries'],
]);
const TEXT_FILE = /\.(md|json|jsonl|ya?ml|js|mjs|cjs|ts|ps1|sh|svg|txt)$/;
const SKIP_DIR = new Set(['.git', 'node_modules', 'private']);
const SELF = join(root, 'release', 'check-consistency.mjs');

/** The public surface: the state boundary and the tool directories are not part of it. */
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else {
      yield join(dir, entry.name);
    }
  }
}

let scanned = 0;
for (const file of walk(root)) {
  if (file === SELF || !TEXT_FILE.test(file)) continue; // `SELF` is where the list itself lives
  scanned += 1;
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (line.includes('vocabulary-guard: allow')) return;
      for (const [term, reason] of RETIRED) {
        if (line.includes(term)) {
          failures.push(`${relative(root, file)}:${index + 1} 出现退役用词「${term}」（${reason}）`);
        }
      }
    });
}

// ── 4. every repository path the public docs name must exist ───────────────────
// Two shapes are checked: an inline path whose first segment is a public top-level directory, and
// a relative markdown link target. A line may opt out with `path-guard: allow` plus its reason —
// for a path that belongs to the reader's project rather than to this repository.
const PUBLIC_DOCS = [
  'README.md',
  'README.zh.md',
  ...readdirSync(join(root, 'docs')).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`),
];
const TOP_LEVEL = ['docs', 'plugin', 'release', 'skills', 'review', 'locale'];
// 扩展名按**长到短**排列：正则候选按书写顺序取第一个匹配，把 `js` 放在 `json` 之前会让
// `docs/x.json` 被截成 `docs/x.js`，于是每一处 .json/.jsonl 引用都被报成不存在的路径。
const INLINE_PATH = new RegExp(`(?<![\\w./-])((?:${TOP_LEVEL.join('|')})/[\\w./-]*\\.(?:jsonl|json|ya?ml|mjs|cjs|ps1|md|js))`, 'g');
const MARKDOWN_LINK = /\]\(([^)\s]+)\)/g;

let docPaths = 0;
for (const doc of PUBLIC_DOCS) {
  readFileSync(join(root, doc), 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (line.includes('path-guard: allow')) return;
      const candidates = [...line.matchAll(INLINE_PATH)].map((match) => match[1]);
      for (const match of line.matchAll(MARKDOWN_LINK)) {
        const target = match[1].split('#')[0];
        if (target === '' || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue;
        candidates.push(relative(root, resolve(root, dirname(doc), target)).replace(/\\/g, '/'));
      }
      for (const candidate of candidates) {
        docPaths += 1;
        if (!existsSync(join(root, candidate))) failures.push(`${doc}:${index + 1} 引用了不存在的路径 ${candidate}`);
      }
    });
}

// ── 5. the row that installs this plugin may only set keys the schema declares ─
// Derived truth: `DEFAULTS` above is the set of keys the running plugin accepts. Reading the row's
// keys out of the patch text is deliberately narrow — the install row is `- name: '<package>'`
// followed by its own `config:` block, so indentation alone decides where that block ends.
function rowConfigKeys(patchText, packageName) {
  const lines = patchText.split(/\r?\n/);
  const nameIdx = lines.findIndex((line) => line.trim() === `name: '${packageName}'`);
  if (nameIdx === -1) return null;
  const nameIndent = lines[nameIdx].search(/\S/);
  let configIdx = -1;
  for (let i = nameIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue;
    // Strictly less: a sibling key (`id`, `config`) sits at the *same* indent as `name`.
    if (lines[i].search(/\S/) < nameIndent) break; // the row ended before any config block
    if (lines[i].trim() === 'config:') { configIdx = i; break; }
  }
  if (configIdx === -1) return [];
  const configIndent = lines[configIdx].search(/\S/);
  const keys = [];
  for (let i = configIdx + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    const indent = raw.search(/\S/);
    if (indent <= configIndent) break;
    const match = /^([A-Za-z][\w]*):/.exec(raw.trim());
    if (match !== null && indent === configIndent + 2) keys.push(match[1]);
  }
  return keys;
}

const PATCH = join(root, 'cordis.patch.yml');
const INSTALL_ROW = 'dsh-project-forge';
const patchKeys = existsSync(PATCH) ? rowConfigKeys(readFileSync(PATCH, 'utf8'), INSTALL_ROW) : null;
if (patchKeys === null) {
  // Not vacuous: the check is only meaningful while the row exists, so its absence fails here.
  failures.push(`cordis.patch.yml 里找不到装了 ${INSTALL_ROW} 的那一行——本检查会失去对象，请确认安装行是否被改名`);
} else {
  for (const key of patchKeys) {
    if (!Object.hasOwn(DEFAULTS, key)) {
      failures.push(`cordis.patch.yml 的 ${INSTALL_ROW} 行设了 schema 里没有的键「${key}」——安装时会被拒收（改名后必须同步这一行）`);
    }
  }
}

// ── 6. every script under release/ must at least parse ────────────────────
// This exists because a syntax error in one of them reached a real release run: nothing in the
// suite imports these scripts, so nothing had ever parsed them. `node --check` is enough for the
// .mjs ones; the PowerShell file is parsed with its own AST parser, and when no PowerShell host is
// on PATH the section says so instead of pretending to have checked it.
const releaseDir = join(root, 'release');
let parsedScripts = 0;
let powershellSkips = 0;
for (const entry of readdirSync(releaseDir).sort()) {
  const file = join(releaseDir, entry);
  if (entry.endsWith('.mjs') || entry.endsWith('.cjs') || entry.endsWith('.js')) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
      const reason = (result.stderr ?? '').trim().split('\n').slice(0, 2).join(' / ');
      failures.push(`release/${entry} 语法不通过：${reason}`);
    }
    parsedScripts += 1;
  } else if (entry.endsWith('.ps1')) {
    const probe = spawnSync('pwsh', ['-NoProfile', '-Command',
      `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}',[ref]$null,[ref]$e);if($e.Count){$e[0].Message;exit 1}`],
    { encoding: 'utf8', shell: false });
    if (probe.error || probe.status === null) {
      powershellSkips += 1;
    } else {
      if (probe.status !== 0) failures.push(`release/${entry} 语法不通过：${(probe.stdout ?? probe.stderr ?? '').trim().split('\n')[0]}`);
      parsedScripts += 1;
    }
  }
}
if (!existsSync(releaseDir)) failures.push('release/ 目录不存在');

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  console.error(`\nconsistency: ${failures.length} 处不一致`);
  process.exit(1);
}
console.log(`consistency: clean（配置表 ${documented.size} 个字段 ↔ schema；技能两份副本一致；公开面 ${scanned} 个文件无退役用词；文档 ${docPaths} 处路径引用真实存在；安装行 ${patchKeys?.length ?? 0} 个配置键 ⊆ schema；release/ 下 ${parsedScripts} 个脚本可解析${powershellSkips ? `，${powershellSkips} 个 .ps1 因本机没有 PowerShell 未检查` : ''}）`);
