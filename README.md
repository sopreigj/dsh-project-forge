# dsh-project-forge

English | [中文](docs/README.zh.md)

**Project Forge (项目锻造模式)** — a DeepSeek Harness agent preset that turns an agent into the steward of a project: it keeps the project recoverable (local git), traceable (four state documents + decision log), well-organized (layout & naming discipline), and safe to continue after context loss (compaction recovery), with five write guards that hold even when the model does not cooperate.

It ships two presets:

| Preset | For |
|---|---|
| `project-forge` | Full stewardship: protocol, live document digest, compaction recovery, 5 write guards |
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

- **Local-only git**: never push, add a remote, or rewrite history until the user explicitly asks.
- **Four state documents** at the project root: `done.md` (current state + shortest reproducible path), `todo.md` (queue), `plan.md` (strategy), `tortuous.md` (negative knowledge, fixed entry template). The digest inlines the tail of the first three plus repo state and `.agents/steward.md` every turn.
- **Checkpoint protocol**: close a logical unit → run checks → update documents → one commit. Never commit per command.
- **Layout & naming**: directory/file/identifier names follow one-word-one-meaning at every level; checked at every checkpoint; the layout guard refuses unacknowledged mixed-artifact roots.
- **Parallel sessions**: single document owner, per-file claims released on commit, stale claims self-clean (30 min).
- **No secrets in git**: refuses to commit credential files (`.env`, `*.pem`, ...).
- **Compaction recovery**: a real `compaction/end` event folds a recovery message (protocol restatement + fresh digest) into the next step.

## Configuration

All switches default on; set `false` to disable.

| Field | Default | Meaning |
|---|---|---|
| `protocol` / `recoveryProcedure` | `true` | register the protocol / recovery prompt sections |
| `digest` / `digestFiles` | `true` / `[plan.md, todo.md, done.md]` | inline document tails every turn |
| `digestTailLimits` | `{plan.md:20000, todo.md:10000, done.md:20000}` | per-document tail budget |
| `digestMaxBytes` | `32768` | overall digest ceiling |
| `stewardFile` / `stewardFilePath` | `true` / `.agents/steward.md` | inline the repo's own rules |
| `injectOnCompaction` / `recoveryMinTurnStep` | `true` / `1` | recovery message, at most one per turn |
| `guardLocalGit` / `guardCommitCheckpoint` / `guardLayoutCheckpoint` / `guardSecrets` / `guardConcurrentWrite` | `true` | the five write guards |
| `concurrentWriteMode` | `both` | which files the claim guard protects |

## Layout of this repo

```
dsh-project-forge/
├── package.json          # bundle manifest (dsh.bundle.patch)
├── cordis.patch.yml      # the preset composition (project-forge)
├── plugin/               # the mode plugin (protocol + digest + recovery + guards)
├── skills/project-forge-grilling/   # bundled discussion skill
├── review/               # the review-mode bundle (its own package.json)
└── README.md / LICENSE
```

## Development

```sh
node plugin/index.test.mjs plugin/index.js   # self-test (config, digest, all five guards)
```

The plugin imports only Node builtins — profile-installed bundles resolve no third-party packages. The hand-written Standard Schema in `plugin/schema.js` implements the exact `~standard.validate` interface Cordis requires (the official docs use `@deepseek-ai/schemastery`; a hand-written schema is used here to keep the bundle dependency-free).

## Boundaries (read before trusting it)

- Guards refuse at the shell-tool boundary; they are anti-slip, not a security boundary (alternate phrasing/scripts/provider APIs can bypass).
- Guard E protects high-contention files only (the four documents + `.agents/steward.md` + source files); merge conflicts in ordinary files are git's job.
- The protocol is prompt text: it is always *present*; whether the model *obeys* is not machine-verified except where a guard enforces it.

## License

MIT — see [LICENSE](./LICENSE).