#!/usr/bin/env node
/**
 * Is the mode actually installed? A bundle that is listed in a profile but points at a target
 * that no longer exists loads as nothing — no protocol, no guards — and nothing says so. This
 * check resolves every `dsh-project-forge*` / `@local/dsh-project-forge*` entry under
 * `~/.dsh/profiles/<profile>/node_modules` and reports what each one really is:
 *
 *   dev      → this checkout (`link:` install, the shape development uses)
 *   copy     → some other checkout/copy
 *   dangling → the entry exists but its target does not (a FAILURE: the profile lists a bundle
 *              that cannot load)
 *
 * Usage: `node release/check-installed.mjs [--home <dir>] [--allow-missing]`
 *   --home <dir>       read profiles from <dir> instead of ~/.dsh (for tests)
 *   --allow-missing    pass even when no install entries were found (not for publishing)
 *
 * Exit code 1 on any dangling entry — that is the whole point: a publish must not ship while an
 * installed profile points at nothing.
 */
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const PACKAGES = ['dsh-project-forge', '@local/dsh-project-forge'];

function parseArgs(argv) {
  const options = { home: join(homedir(), '.dsh'), allowMissing: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--home') {
      index += 1;
      options.home = resolve(argv[index] ?? '');
    } else if (argv[index] === '--allow-missing') {
      options.allowMissing = true;
    }
  }
  return options;
}

/** Every profile directory that has a `node_modules`, so an empty tree is visible as such. */
function profileDirs(home) {
  const root = join(home, 'profiles');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((profile) => existsSync(join(profile, 'node_modules')));
}

/**
 * Classify one install entry. `lstat` answers "is there an entry at all"; `realpath` answers
 * "does its target still exist" — a junction to a deleted directory passes the first and fails
 * the second, which is the dangling case this check exists for.
 */
function classify(entryPath) {
  let stats;
  try {
    stats = lstatSync(entryPath);
  } catch {
    return undefined; // not installed in this profile
  }
  let target;
  try {
    target = realpathSync(entryPath);
  } catch {
    return { kind: 'dangling', target: undefined };
  }
  if (!existsSync(target) || !statSync(target).isDirectory()) return { kind: 'dangling', target };
  const insideRepo = target === repoRoot || target.startsWith(`${repoRoot}\\`) || target.startsWith(`${repoRoot}/`);
  return { kind: insideRepo ? 'dev' : 'copy', target };
}

const options = parseArgs(process.argv.slice(2));
const rows = [];
for (const profile of profileDirs(options.home)) {
  for (const name of PACKAGES) {
    const entryPath = join(profile, 'node_modules', name);
    const verdict = classify(entryPath);
    if (verdict === undefined) continue;
    rows.push({
      profile: profile.slice(profile.lastIndexOf('\\') + 1).split('/').pop(),
      name,
      ...verdict,
    });
  }
}

// Reporting the object count is deliberate: a scan that silently found nothing looks exactly
// like a healthy install (T69).
const counts = { dev: 0, copy: 0, dangling: 0 };
for (const row of rows) counts[row.kind] += 1;
if (rows.length === 0) {
  console.log(`check-installed: 没有找到任何安装条目（在 ${join(options.home, 'profiles')} 下扫了 `
    + `${PACKAGES.length} 个包名 / ${profileDirs(options.home).length} 个 profile）`);
  if (options.allowMissing) process.exit(0);
  console.log('check-installed: FAIL — 发布要求至少一个 profile 真的装着这个 bundle（否则装上即失效，'
    + '而这里看不出区别）。用 --allow-missing 只在开发机上跳过。');
  process.exit(1);
}

for (const row of rows) {
  const target = row.target === undefined ? '（目标不存在）' : row.target;
  console.log(`  ${row.kind.padEnd(8)} ${row.profile}/${row.name} → ${target}`);
}
console.log(`check-installed: ${rows.length} 个安装条目（dev ${counts.dev} / copy ${counts.copy} / `
  + `dangling ${counts.dangling}）`);

if (counts.dangling > 0) {
  console.log('check-installed: FAIL — 上面标记 dangling 的条目指向不存在的目标：'
    + 'profile 里列着一个永远加载不起来的 bundle。重建它，或把那个条目删掉。');
  process.exit(1);
}
console.log('check-installed: clean');
