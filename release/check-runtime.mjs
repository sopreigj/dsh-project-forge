#!/usr/bin/env node
/**
 * Check a live DSH installation from the outside: is this mode really mounted, is the session log
 * readable, and does the bundled skill resolve?
 *
 * Every input is an argument or an environment variable — no machine-specific path is baked in, so
 * this file may live on the public surface (§1.7). Typical use:
 *
 *   node release/check-runtime.mjs --session <path-to-session.v4.jsonl.zstd>
 *   node release/check-runtime.mjs --copy <profile>/node_modules/dsh-project-forge --self-test
 *
 * Exit code 1 when any check fails. Checks that lack their input are reported as skipped, not as
 * passes: "we did not look" must never look like "it is fine".
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const has = (name) => args.includes(`--${name}`);

const failures = [];
const skipped = [];
const lines = [];
const ok = (message) => lines.push(`  ✓ ${message}`);
const bad = (message) => {
  lines.push(`  ✗ ${message}`);
  failures.push(message);
};
const skip = (message) => {
  lines.push(`  – ${message}`);
  skipped.push(message);
};

/**
 * Decode a session log. The whole-buffer and streaming routes both stop after the FIRST frame —
 * a 10 MB log decodes to 229 bytes that way — so walk the frames by their magic number instead.
 * @returns {{frames: number, bytes: number, text: string, naiveBytes: number}}
 */
function decodeSession(file) {
  const buffer = readFileSync(file);
  const naive = tryZstd(buffer);
  const parts = [];
  let offset = 0;
  let frames = 0;
  while (offset < buffer.length) {
    const next = magicAt(buffer, offset + 4);
    const end = next === -1 ? buffer.length : next;
    const part = tryZstd(buffer.subarray(offset, end));
    if (part === undefined) break;
    parts.push(part);
    frames += 1;
    if (next === -1) break;
    offset = next;
  }
  const text = Buffer.concat(parts).toString('utf8');
  return { frames, bytes: Buffer.byteLength(text), text, naiveBytes: naive?.length ?? 0 };
}

function tryZstd(buffer) {
  try {
    return zstdDecompressSync(buffer);
  } catch {
    return undefined;
  }
}

function magicAt(buffer, from) {
  for (let i = from; i < buffer.length - 3; i += 1) {
    if (buffer[i] === 0x28 && buffer[i + 1] === 0xb5 && buffer[i + 2] === 0x2f && buffer[i + 3] === 0xfd) return i;
  }
  return -1;
}

// ── 1. the session log ────────────────────────────────────────────────────────
const sessionFile = value('session') ?? newestSession(value('sessions-root'));
function newestSession(root) {
  if (!root || !existsSync(root)) return undefined;
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.jsonl.zstd')) found.push({ path, mtime: statSync(path).mtimeMs });
    }
  };
  walk(root);
  return found.sort((a, b) => b.mtime - a.mtime)[0]?.path;
}

if (!sessionFile) {
  skip('会话日志：没给 --session 或 --sessions-root，跳过解码与事件检查');
} else {
  const decoded = decodeSession(sessionFile);
  const raw = readFileSync(sessionFile);
  const rows = decoded.text.split('\n').filter((line) => line.trim().length > 0);
  lines.push(`  会话日志：${raw.length} 字节 → ${decoded.frames} 帧 → ${decoded.bytes} 字节 → ${rows.length} 行`);
  if (decoded.frames > 1 && decoded.naiveBytes < decoded.bytes) {
    ok(`多帧：逐帧走读拿到 ${decoded.bytes} 字节，整缓冲只给 ${decoded.naiveBytes} 字节（差 ${(decoded.bytes / decoded.naiveBytes).toFixed(0)}×）——所以必须逐帧`);
  } else {
    ok(`单帧（整缓冲与逐帧一致：${decoded.bytes} 字节）`);
  }

  // The tail of a live log may be a partial write; every other line must parse.
  const events = [];
  let unparsed = 0;
  rows.forEach((row, index) => {
    try {
      events.push(JSON.parse(row));
    } catch {
      if (index === rows.length - 1) ok('末行是未写完的半行（会话仍在写），已按规矩放行');
      else unparsed += 1;
    }
  });
  if (unparsed === 0) ok(`全部 ${events.length} 行可解析为事件`);
  else bad(`有 ${unparsed} 行既不是末行也无法解析——日志损坏，不是活会话`);

  const header = events[0];
  const effective = effectivePreset(events);
  if (effective === undefined) skip('生效预设：日志里既没有会话头也没有 agent-preset/selected');
  else {
    const note = header?.agentPreset && header.agentPreset !== effective ? `（会话头写的是 ${header.agentPreset}；以后者为准）` : '';
    if (effective === 'project-forge') ok(`生效预设 = ${effective}${note}`);
    else bad(`生效预设 = ${effective}${note}，不是 project-forge`);
  }

  const lastType = events[events.length - 1]?.type;
  const ageMinutes = (Date.now() - statSync(sessionFile).mtimeMs) / 60000;
  const normalEnd = new Set(['turn/end', 'session/end', 'session/closed']);
  const dead = lastType !== undefined && !normalEnd.has(lastType) && ageMinutes > 90;
  lines.push(
    `  末事件 ${lastType}，静默 ${ageMinutes.toFixed(1)} 分钟 → ${
      dead ? '判为已死（末事件不在正常收尾集合 且 静默 > 90 分钟）' : '判为活/正常（两个条件未同时成立）'
    }`,
  );
  const compactions = events.filter((event) => String(event.type).startsWith('compaction/')).length;
  if (compactions > 0) ok(`日志里有 ${compactions} 条 compaction/* 事件（压缩确实发生过）`);
  else skip('日志里没有 compaction/* 事件，没法从这条会话验证压缩');
}

/**
 * The session header records the preset the session was CREATED with; a later
 * `agent-preset/selected` event overrides it (its `data.agentPreset` is the id as a plain string).
 * A session can therefore be created as `standard` and run as `project-forge` — read the event last.
 */
function effectivePreset(events) {
  let selected;
  for (const event of events) {
    if (event.type !== 'agent-preset/selected') continue;
    const value = event.data?.agentPreset ?? event.data?.presetId ?? event.data?.id;
    selected = typeof value === 'object' && value !== null ? value.id : value;
  }
  return selected ?? events[0]?.agentPreset;
}

// ── 2. the bundled skill ──────────────────────────────────────────────────────
const skillPath = join(repo, 'skills', 'project-forge-grilling', 'SKILL.md');
if (!existsSync(skillPath)) {
  bad(`内置技能不在 ${skillPath}`);
} else {
  const text = readFileSync(skillPath, 'utf8');
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  if (/^name:\s*\S/m.test(front) && /^description:\s*\S/m.test(front)) ok('内置技能有 name/description frontmatter');
  else bad('内置技能缺 name 或 description frontmatter（技能目录不会被认出来）');
  if (text.includes('project-forge')) ok('技能正文提到 project-forge');
  else skip('技能正文没提 project-forge（不一定错，但值得看一眼）');
}

// ── 3. the preset row points at that skill ────────────────────────────────────
const patchPath = join(repo, 'cordis.patch.yml');
if (!existsSync(patchPath)) {
  bad('找不到 cordis.patch.yml');
} else {
  const patch = readFileSync(patchPath, 'utf8');
  const block = /customSkillDirs:\s*\n((?:\s*-\s*.+\n?)+)/.exec(patch)?.[1];
  const entry = block?.split('\n').map((line) => line.replace(/^\s*-\s*/, '').trim()).filter(Boolean)[0];
  if (entry === undefined) skip('cordis.patch.yml 里没有 customSkillDirs');
  else if (entry.startsWith('!!js')) {
    // The value is computed at load time (it resolves the package and joins 'skills'), so there is
    // no literal path to stat. Check the two things that can actually be wrong: the expression still
    // targets 'skills', and this bundle ships one.
    if (!entry.includes("'skills'")) bad(`customSkillDirs 的 !!js 表达式不再指向 'skills'：${entry}`);
    else if (existsSync(join(repo, 'skills'))) ok("customSkillDirs 是加载时计算的 !!js 表达式，指向 'skills'，且本仓确实有 skills/");
    else bad('customSkillDirs 指向 skills，但本仓没有 skills/ 目录');
  } else if (existsSync(resolve(repo, entry.replace(/^\.\//, '')))) {
    ok(`customSkillDirs 指向的目录存在：${entry}`);
  } else {
    bad(`customSkillDirs 指向不存在的目录：${entry}`);
  }
}

// ── 4. the effective copy (optional) ─────────────────────────────────────────
const copy = value('copy');
if (copy === undefined) {
  skip('生效副本：没给 --copy，跳过"装的是哪一份"与自测');
} else if (!existsSync(copy)) {
  bad(`--copy 指向的路径不存在：${copy}`);
} else {
  const real = realpathSync(copy);
  if (resolve(real) === resolve(repo)) ok(`生效副本就是本仓：${real}`);
  else bad(`生效副本是 ${real}，不是本仓 ${repo}——你改的可能不是生效的那一份`);
  if (has('self-test')) {
    try {
      execFileSync(process.execPath, [join(real, 'plugin', 'index.test.mjs'), join(real, 'plugin', 'index.js')], {
        stdio: 'pipe',
      });
      ok('生效副本自测通过');
    } catch (error) {
      bad(`生效副本自测失败：${String(error.stdout ?? error.message).trim().split('\n').slice(-3).join(' / ')}`);
    }
  } else {
    skip('生效副本自测：没给 --self-test');
  }
}

// ── report ────────────────────────────────────────────────────────────────────
console.log('runtime check:');
for (const line of lines) console.log(line);
if (failures.length > 0) {
  console.error(`\nruntime: ${failures.length} 处不通过`);
  process.exit(1);
}
console.log(`\nruntime: clean（${skipped.length} 项因缺输入而跳过——跳过不等于通过）`);
