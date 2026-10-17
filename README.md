# dsh-project-forge

English | [中文](README.zh.md)

**Project Forge (项目锻造模式)** — a DeepSeek Harness agent preset that turns an agent into the steward of a project: it keeps the project recoverable (local git), traceable (four state documents plus append-only records), well-organized (layout & naming discipline), and safe to continue after context loss (compaction recovery), with write guards that hold even when the model does not cooperate.

It ships two presets:

| Preset | For |
|---|---|
| `project-forge` | Full stewardship: protocol, live document digest, compaction recovery, the write guards |
| `project-forge-review` (in `review/`) | Read-mostly review mode: code review, simple tasks, clean-room subagents |

## Install

```sh
# Local development checkout
dsh plugin --profile web add link:/path/to/dsh-project-forge
dsh plugin --profile web add link:/path/to/dsh-project-forge/review

# Or straight from git
dsh plugin --profile web add github:sopreigj/dsh-project-forge#main
```

Bundle plugins take effect after restarting `dsh web`. Then pick 项目锻造模式 / 项目锻造 · 干净审查 in the mode picker.

## What the mode enforces

- **A state boundary.** Everything the project keeps for itself — the state documents, the
  repository's own rules, the concurrent-write claims — lives in one directory (`private/` by
  default). Everything outside it is the **public surface**, written as if the project were
  already open source: portable, no private fact outside a configuration file (which ships an
  example twin), no reference into the boundary. Publishing is then mechanical: delete the
  boundary, copy the tree, `git init`.
- **Local-only git**: never push, add a remote, or rewrite history until the user explicitly asks.
- **State documents in three classes**, all inside the boundary. *Contracts* —
  `private/steward.md` (the repository's own rules), `plan.md` (strategy), `done.md` (current
  state), `todo.md` (queue) — are inlined **in full** every turn: each has a soft budget, and a
  budget is a warning threshold, never a truncation. *Records* — `private/journal.jsonl` (work
  log) and `private/tortuous.jsonl` (negative knowledge: failed routes and recorded deviations) —
  are append-only JSONL, one record per line, never inlined; only a one-line-per-record index and
  the last few journal entries ride the digest and the recovery message. *On-demand* material
  lives in `private/rationale/`. A project whose documents still sit at the project root is read
  there (and its rules at `.agents/steward.md`), so nothing forged before the boundary existed
  breaks.
- **Checkpoint protocol**: close a logical unit → run checks → update documents → one commit. Never commit per command.
- **Layout & naming**: directory/file/identifier names follow one-word-one-meaning at every level; checked at every checkpoint; the layout guard refuses unacknowledged mixed-artifact roots.
- **Parallel sessions**: single document owner, per-file claims under `private/.forge-claims/`, released on commit, stale claims expire by themselves (10 minutes of silence).
- **No secrets in git**: refuses to commit credential files outside the boundary (inside it, a local-only repository may hold them).
- **Compaction recovery**: a real `compaction/end` event folds a recovery message (protocol restatement + fresh digest) into the next step.

## Configuration

Every switch defaults on. The complete reference — all 32 fields, their defaults and what they
do — is **[docs/configuration.md](docs/configuration.md)**. `release/check-consistency.mjs` compares
that table against the plugin schema, so the two cannot drift apart.

The two you are most likely to touch:

```yaml
- id: project-forge
  name: 'dsh-project-forge'
  config:
    sizeLimitMode: ratchet    # also refuse a commit that grows an already-over-cap document
    stateDir: '.'             # fall back to the pre-boundary layout (documents at the root)
```

## Layout of this repo

```
dsh-project-forge/
├── package.json          # bundle manifest (dsh.bundle.patch)
├── cordis.patch.yml      # the preset composition (project-forge)
├── plugin/               # the mode plugin (protocol + digest + recovery + guards) + its test
├── skills/project-forge-grilling/   # bundled discussion skill
├── review/               # review-mode bundle (own package.json + its own copy of the skill)
├── release/              # release tooling: two checks and the publish script
├── docs/                 # documentation for users and contributors
└── README.md / README.zh.md / LICENSE
```

`docs/` follows Diátaxis — one reader need per file: [getting-started.md](docs/getting-started.md) is
the tutorial (install, verify which copy is live, first takeover),
[how-to-change-the-mode.md](docs/how-to-change-the-mode.md) shows how to change the mode itself
(protocol text, a guard, a config field), [configuration.md](docs/configuration.md) is the reference, [state-boundary.md](docs/state-boundary.md) explains the boundary (design, export
flow, guard coverage), and [init-a-project.md](docs/init-a-project.md) is the how-to for bringing a project under the mode.

In this development repository the state boundary `private/` is tracked by git (so state is
recoverable) and **excluded wholesale by `release/publish.ps1`**, which is why it does not appear
in the published bundle.

## Development

```sh
node test/run.mjs plugin/index.js   # self-test: config, digest, guards, patch↔schema drift
node release/check-consistency.mjs           # docs/configuration.md ↔ schema; the two skill copies
node release/check-preset-sync.mjs --source <dsh-checkout>   # preset rows vs the shipped `standard`
node release/check-public-surface.mjs        # the mode's privacy guard, applied to this repo
node release/check-runtime.mjs               # skill frontmatter + the customSkillDirs target
```

The plugin imports only Node builtins — profile-installed bundles resolve no third-party packages. The hand-written Standard Schema in `plugin/config/schema.js` implements the exact `~standard.validate` interface Cordis requires (the official docs use `@deepseek-ai/schemastery`; a hand-written schema is used here to keep the bundle dependency-free).

`release/` holds the release tooling: `check-public-surface.mjs` is the check above,
`check-consistency.mjs` keeps the documentation and the two copies of the bundled skill in sync
with their single sources, `check-preset-sync.mjs` diffs the preset's rows against the shipped
`standard` preset so a row this mode should carry cannot be silently missed (it needs a DSH
checkout — `--source <dir>` or `$DSH_SOURCE` — and skips cleanly without one), and `publish.ps1`
runs **all five** checks before mirroring this tree into the public repository, so a stale or
broken public surface is refused rather than published. The publish directory comes from
`-PublicRepo` or `$env:FORGE_PUBLIC_REPO`, never from a hard-coded path — a machine path in a
public script is exactly what §1.7 forbids.

## Boundaries (read before trusting it)

- Guards refuse at the shell-tool boundary; they are anti-slip, not a security boundary (alternate phrasing/scripts/provider APIs can bypass).
- Guard E (`guardPrivacyBoundary`) checks three decidable things — a home directory of this machine, a source file reaching into the boundary, a high-confidence secret literal outside a configuration file — and nothing about whether prose "reads public". A file may opt out with the marker `privacy-guard: allow`; the mode's own plugin and fixtures carry it.
- Guard F protects high-contention files only (the four contract documents + the steward rules + source files); merge conflicts in ordinary files are git's job.
- The protocol is prompt text: it is always *present*; whether the model *obeys* is not machine-verified except where a guard enforces it.

## License

MIT — see [LICENSE](./LICENSE).
