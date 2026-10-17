#!/usr/bin/env node
/**
 * release/source-truth.mjs — read a file out of the DSH source tree as **truth**, not as a
 * working copy.
 *
 * Why this exists: a checkout on a developer machine is usually dirty, so a check that reads
 * the working tree is comparing this bundle against code the installed harness never ran. The
 * answer git gives — `git show <ref>:<path>` — is the same bytes regardless of what someone is
 * editing, so it is the only defensible source of truth for "what does the harness register".
 *
 * Two callers (`check-prompt-variables`, `check-preset-sync`) both need this, and both must
 * behave the same way when the answer cannot be had: say so, and fail. A check that quietly
 * falls back to the working tree after being handed a ref is worse than one with no ref at all.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The ref to read through, from `--tag <ref>` or `$DSH_SOURCE_TAG`.
 * Kept as a value rather than a default because the tag is host state, not project fact: a
 * repository must not hard-code which harness release the developer happens to run.
 * @returns the ref, or undefined when none was given.
 */
export function sourceRef(argv = process.argv) {
  if (argv.includes('--tag')) return argv[argv.indexOf('--tag') + 1];
  const env = process.env.DSH_SOURCE_TAG;
  return env === undefined || env === '' ? undefined : env;
}

const gitShow = (dir, ref, relative) => {
  try {
    return execFileSync('git', ['-C', dir, 'show', `${ref}:${relative}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    }).toString('utf8');
  } catch {
    return undefined;
  }
};

/**
 * Read one of several candidate paths (first hit wins).
 * @param dir - the DSH checkout, or undefined/empty when none was given.
 * @param relatives - repo-relative, POSIX-separated candidate paths.
 * @param ref - a git ref; when given, the working tree is never consulted.
 * @returns `{ text, origin }` on success, `{ error }` when the answer was expected but is not
 *          available, and `undefined` when no source was given at all.
 */
export function readSourceText(dir, relatives, ref) {
  if (dir === undefined || dir === '') return undefined;
  if (ref !== undefined && ref !== '') {
    for (const relative of relatives) {
      const text = gitShow(dir, ref, relative);
      if (text !== undefined) return { text, origin: `${dir}@${ref}:${relative}` };
    }
    // Fail closed: the caller asked for the tagged truth, so a working-tree read would be a
    // different answer to a different question.
    return { error: `给定了 --tag ${ref}，但 \`git -C ${dir} show ${ref}:<path>\` 取不到任何候选路径（${relatives.join(' / ')}）——先确认该 tag 与路径存在于这个源码树里` };
  }
  for (const relative of relatives) {
    // `...split('/')` rather than joining the whole string: a POSIX-relative path joined as one
    // segment would mix separators and never resolve on Windows (the earlier version of this
    // line did exactly that, and only the tag branch hid it).
    const candidate = resolve(dir, ...relative.split('/'));
    if (existsSync(candidate)) return { text: readFileSync(candidate, 'utf8'), origin: candidate };
  }
  return { error: `源码树 ${dir} 里找不到候选路径（${relatives.join(' / ')}）——用 --source 指到 checkout 根，或加 --tag 读某个提交` };
}
