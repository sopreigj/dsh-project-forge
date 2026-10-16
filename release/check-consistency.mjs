/**
 * release/check-consistency.mjs — the two internal duplications that must not drift.
 *
 * 1. `docs/configuration.md` is the user-facing reference for every config field, and
 *    `plugin/schema.js`'s `DEFAULTS` is the code that implements them. Those two were written by
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
 * Usage: node release/check-consistency.mjs   (exit 1 on any mismatch)
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULTS } from '../plugin/schema.js';

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

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  console.error(`\nconsistency: ${failures.length} 处不一致`);
  process.exit(1);
}
console.log(`consistency: clean（配置表 ${documented.size} 个字段与 schema 一致；内置技能两份副本一致）`);
