# test/ — the check project

Every check that guards this bundle lives here, one file per slice of `plugin/`. They share one
process and one fixture repository, so the runner owns the fixture (`harness.mjs`) and the node
builtins, installs them on `globalThis`, then imports the slice files in the order they were
originally written. A failure names the file that failed.

```
node test/run.mjs plugin/index.js
```

The argument is the plugin entry to load; omit it to use the current directory (`.`). The runner
prints `<plugin name>: all plugin checks passed` and exits 1 on the first failure.

| file | what it checks |
|---|---|
| `config.test.mjs` | the declared contract: Config, the preset patch row, plugin identity |
| `preset-schema.test.mjs` | the preset patch stays in step with the plugin schema |
| `protocol.test.mjs` | the protocol and recovery prompt sections, rule by rule |
| `digest.test.mjs` | the digest: documents, repository state, the state boundary, brace safety |
| `checkpoint-and-recovery.test.mjs` | the checkpoint guard and the post-compaction recovery message |
| `guards-local-git.test.mjs` | the local-only git guard, its one-shot grants, the guard switches |
| `guards-malformed-calls.test.mjs` | malformed tool-call repair (empty id) and its switch |
| `guards-concurrent-write.test.mjs` | per-file claims and the in-flight view other sessions read |
| `guards-hygiene.test.mjs` | layout, secrets and the public surface, enforced at the commit |
| `digest-configuration.test.mjs` | document budgets, whole-document inlining, the negative-knowledge index |
| `guards-records.test.mjs` | append-only records and the size ratchet |
| `clock.test.mjs` | the clock footnote appended to tool results |
| `repo-window.test.mjs` | `repoCommitWindow`: the recent-commit list is a configured window |

`harness.mjs` writes the fixture repository (plan/todo/done, `tortuous.jsonl`, steward rules, one
commit) and exports the helpers the checks use. A check that needs a name declared by an earlier
file imports it from that file, so the dependency between slices is explicit.
