# dsh-project-forge-review

**Project Forge · Review Mode (项目锻造 · 干净审查)** — the read-mostly member of the [Project Forge](https://github.com/sopreigj/dsh-project-forge) family for DeepSeek Harness.

Use it for code review, simple self-contained tasks, and clean-room looks at a project: a review session does not carry the steward mode's conversation context, so it suits audits and small fixes. When it runs as a forked child of a `project-forge` session, the project protocol, digest and controlled vocabulary are inherited via fork.

## Install

```sh
dsh plugin --profile web add github:sopreigj/dsh-project-forge#main   # main mode (this package lives in its review/ dir)
# or, from a checkout:
dsh plugin --profile web add link:/path/to/dsh-project-forge/review
```

Bundle plugins take effect after restarting `dsh web`.

## Layout

This package is the `review/` subdirectory of the `dsh-project-forge` repository, shipped as its own bundle (`dsh-project-forge-review`). It deliberately does **not** declare the forge plugin: a forked child inherits the parent's preset (`agent-preset-registry` `composeFrom`), and joining a preset twice throws — so this preset ships only the tool set and an audit persona.

## License

MIT — same as the parent repository.
