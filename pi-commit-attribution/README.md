# pi-commit-attribution

Puts the `Assisted-by:` trailer on commits an agent makes, so the attribution does not depend on the
model remembering to write it, and leaves nothing installed in the repository afterwards.

```
feat: read the drain flag before opening the pool

The flag was read after the pool was opened, which lost the reason an earlier
attempt was abandoned.

Assisted-by: pi 1.4.0 / Claude Sonnet 5.5 (cloud, GitHub Copilot)
Assisted-by: pi 1.4.0 / Qwen 3.8 Flash Next (local, self-hosted, Strata)
Operated-by: Carl Kittelberger <icedream@icedream.pw>
```

One line per model that influenced the files in the commit. `Operated-by:` appears when the person
driving the session is not the address the commit is authored with. Existing `Co-authored-by` lines are
kept.

## How it reaches the commit

At session start the extension writes a directory of hooks it owns, `~/.pi/agent/attribution/hooks`, and
adds to the session's environment:

```sh
GIT_CONFIG_COUNT=1
GIT_CONFIG_KEY_0=core.hooksPath
GIT_CONFIG_VALUE_0=<that directory>
PI_ATTR=1
```

`GIT_CONFIG_*` is git's documented equivalent of `-c`: it outranks repository and global config and lives
only in the process that carries it. Nothing is written into a repository, no git config file is touched,
and the arrangement ends with the process.

The hooks then do two things in this order:

1. Run the hook the repository declares. `core.hooksPath` is exclusive, so without this step a session
   would silently disable `pre-commit`, husky, Gerrit `Change-Id` hooks and the rest. The arguments and
   the exit status pass through: a repository hook that refuses a commit still refuses it. This is plain
   sh, so a chained hook costs milliseconds.
2. Add the trailers with `git interpret-trailers`, and only when the process also carries Pi's
   `PI_MODEL`. A human at a terminal gets nothing, and so do Pi's own internal git calls.

The model name comes from Pi's model catalog, cloud or local from the address that catalog reports, and
the version from the running Pi. A commit that is amending an existing message (`--amend --no-edit`,
`git commit -C <sha>`) keeps whatever trailers that message had and gets none of its own; a commit that
writes a new message, including `--amend -m`, is credited.

## Which models a commit credits

The model that ran `git commit` is credited, plus any model recorded as having changed a file the commit
contains. Git cannot see that history, so a session that runs a file-changing tool takes a
`git status --porcelain -z` snapshot before the next commit and appends the changed paths and its own
`Assisted-by:` line to `<git common dir>/pi-attribution/ledger.jsonl`. The hook intersects that ledger
with `git diff --cached --name-only -z` and drops entries older than the commit being replaced.

Pi subagent children write the same ledger from their own sessions, which is what puts a subagent's model
on a commit the parent made. A background child loads this extension through pi-subagents'
`registerRequiredChildExtensions`; a local foreground child runs inside the parent process and does not
load ambient extensions, so that registration is what makes the child's line appear. Without pi-subagents
installed, a commit credits only the models of the session that made it.

## Install

```bash
pi install <path-to>/pi-commit-attribution
```

Configuration lives in `~/.pi/agent/attribution.json`; a missing or empty file is a working config. See
[attribution.example.json](attribution.example.json).

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` injects nothing. `/attribution disable` does the same for one session. |
| `inject` | `process-env` | `off` skips injection. |
| `operator` | unset | `Name <address>` for `Operated-by:`, emitted only when it differs from the commit author. |
| `localDomains` | `[]` | Domains on your own network whose names resolve publicly, so models served there read as local. |
| `providers` | `{}` | Per provider: `placement`, `label`, `engine`. |
| `models` | `{}` | Per `provider/modelId`: `name`, plus the provider fields. |
| `maxModels` | `8` | Cap on `Assisted-by:` lines per commit. |
| `ledger` | `true` | Record which model changed which file. |
| `chainRepoHooks` | `true` | Run the repository's own hook first. Turning this off disables those hooks. |
| `onExistingTrailer` | `merge` | `keep` leaves a message alone once it carries an `Assisted-by:` of the model's own. |
| `skipRepos` | `[]` | Repositories where injection is skipped. |

## Commands

- `/attribution` — what is injected, the line this session's model would produce, the repository's own
  hooks and whether each is chained, and any config problem.
- `/attribution test` — one commit in a temporary repository, printing the message it produced.
- `/attribution disable` — stop attributing for the rest of the session.

## Shortcomings

Known and measured, not hypothetical.

- **A commit outside Pi's environment is not attributed.** A daemon, a `nohup`ed script, or another
  agent has no `PI_MODEL` in reach, so the hook cannot know who was driving.
- **A command that overrides the git environment wins.** `git -c core.hooksPath=…` or the command's own
  `GIT_CONFIG_COUNT` replaces what the session injected. The session reports the missing trailer rather
  than rewriting your commit.
- **Push-target hooks are not chained.** `update`, `pre-receive`, `post-receive`, `post-update`,
  `push-to-checkout`, `proc-receive` and `fsmonitor-watchman` are absent from the hook directory, because
  a stub that exits 0 would change what git does there. A repository acting as a push target will not run
  its own hook of those names during a Pi session. `/attribution` lists them when it finds them.
- **Human edits made while a session sits idle are credited to the model.** A snapshot cannot tell who
  changed a path. A file two models touched credits both, which is the intent.
- **Subagent attribution needs pi-subagents.** Without it, or in a runner that does not load Pi
  extensions, a child's work is credited to the session that committed it.
- **A commit costs about 125 ms more.** Measured: 159 ms with the hooks against 33 ms without. Two Node
  starts for the message hooks, plus `git interpret-trailers`. Chained hooks are sh and cost a few
  milliseconds each.
- **The ledger is kept in `.git/`.** `<git common dir>/pi-attribution/ledger.jsonl` holds model names and
  changed paths for a week, then is pruned. Nothing goes into a tracked file.
- **A hand-written trailer can end up beside the session's.** With `merge`, a line the model wrote naming
  a different model stays and the accurate line is added next to it; identical lines are never duplicated.
  `onExistingTrailer: "keep"` leaves the message alone once any `Assisted-by:` is present.

## Tests

```bash
npm test           # format, config, injection, hook farm, ledger
npm run test:git   # commit paths against real git in temporary repositories
npm run typecheck
```

`commit-paths.test.sh` is the load-bearing suite: the paths a commit can take (`-m`, `-F -`, a heredoc
inside a script, `--no-verify`, an editor-composed message, a linked worktree, `git -C`, amend in both
forms, cherry-pick, an empty message), the repository's own hooks (a declared `core.hooksPath`, a failing
`pre-commit`, `pre-push`, the default `.git/hooks`), the multi-model ledger with its cap and its
de-duplication, and a signed commit checked with `git verify-commit`.

## Requirements

Pi 1.1 or newer, and any Node Pi itself runs on. `apply.mjs` and `format.mjs` are plain ES modules so the
hook does not depend on a Node release that can read TypeScript.
