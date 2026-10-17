/**
 * Shell-command parsing shared by the git guards (escape detection, live-checkpoint detection).
 *
 * privacy-guard: allow — naming the state boundary and the machine-specific patterns is this file's job;
 * the unit tests are the reason it may.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import {
  stripQuoted,
} from '../shared/index.js';
/**
 * The shell command a tool call carries, if any.
 *
 * Every guard used to open with a check on the tool NAME (pwsh/bash), so a shell command wrapped
 * in another tool — an MCP tool whose arguments carry a "command" field, say — was never
 * inspected. Any tool's command/cmd argument is inspected now; stripQuoted still removes quoted
 * spans, so prose that merely mentions a command does not deny the call.
 * @param execution - the read-only tool execution handed to a guard.
 * @returns the command string, or undefined when this call carries none.
 */
export function shellCommandOf(execution) {
  const args = execution.arguments;
  if (args === null || typeof args !== "object") return undefined;
  const candidate = args.command ?? args.cmd;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/**
 * Decide whether one shell command escapes the local-only git contract.
 * @param command - the command line handed to a shell tool.
 * @returns the offending label and fragment, or undefined when acceptable.
 */
export function localGitEscape(command) {
  if (typeof command !== 'string' || command.length === 0) return undefined;
  const bare = stripQuoted(command);
  const escapes = [
    [/\bgit\s+push\b/, 'git push'],
    [/\bgit\s+remote\s+(?:add|set-url)\b/, 'git remote add/set-url'],
    [/\bgit\s+reset\s+--hard\b/, 'git reset --hard'],
    [/\bgit\s+clean\s+-[a-z]*f/, 'git clean -f'],
    [/\bgit\s+branch\s+-D\b/, 'git branch -D'],
  ];
  for (const [pattern, label] of escapes) {
    const match = pattern.exec(bare);
    if (match !== null) return { label, fragment: match[0] };
  }
  return undefined;
}

/**
 * Decide whether one shell command is a commit that the checkpoint protocol governs.
 * @param command - the command line handed to a shell tool.
 * @returns true when the command commits.
 */
export function isCommitCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return false;
  return /\bgit\s+commit\b/.test(stripQuoted(command));
}