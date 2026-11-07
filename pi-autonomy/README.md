# pi-autonomy

Run a goal autonomously: hand Pi a goal and it keeps working — check-in, work, verify —
until it clearly signals the goal is fully done, or a safety guard stops it.

## What it does

`/autonomy <goal>` puts the agent into an **autonomous session** with two phases:

1. **Check-in** (default). The agent reviews the goal and asks its open questions in a
   single batch (it may use `ask_user_question`); you answer in the normal way. When it
   has nothing left to ask, it ends a message with `[autonomy:ready]` on the final line,
   and the working phase starts. Use `/autonomy now <goal>` to skip the check-in.
2. **Working**. The agent works without user interaction. Every time it stops without
   finishing (a text-only turn with no completion marker), the extension forces one more
   model request with a hidden nudge, so the run continues instead of settling. The
   session ends when the agent ends a message with `[autonomy:done]` on the final line —
   the protocol tells it to do so *only when the goal is fully complete and verified*.

Markers only count at the end of a message, so the agent quoting the protocol mid-prose
("I will emit `[autonomy:done]` later") never trips the machine.

## Runaway guards

A halt pauses the session (status line turns red, a note is appended to the transcript,
`/autonomy go` resumes):

| Guard | Default | Trips when |
|-------|---------|------------|
| continuation cap | 40 | the agent stopped 40 times without a completion marker |
| stall | 2 | 2 turns in a row get nudged with no tool calls and no marker; the third one halts (talking, not working) |
| repeated tool calls | 3 | the same tool call (name + args) three times in a row, or a tight ABAB / ABCABC cycle |
| wall clock | 60 min | the working phase runs longer than this |

An interrupted (Esc) or errored run also pauses instead of silently dying.

## Commands

| Command | Effect |
|---------|--------|
| `/autonomy <goal>` | check-in first, then work autonomously |
| `/autonomy now <goal>` | work autonomously immediately (skip the check-in) |
| `/autonomy go` | start working now (after a check-in) or resume after a pause |
| `/autonomy stop` | end the session (aborts the current run) |
| `/autonomy status` | current phase, goal, forced-continuation count, runtime, effective guard values |
| `/autonomy` | status while active, usage otherwise |

The footer shows `autonomy: check-in / working (n/40) / paused (reason)` while a session
is live. You can steer a running session by typing normally (your message is delivered
as steering) — the session keeps running until the marker or a guard.

## Configuration

Copy [autonomy.example.json](autonomy.example.json) to `~/.pi/agent/autonomy.json`. Every
key is optional — anything you leave out keeps its default.

| Key | Default | Rule | Meaning |
|-----|---------|------|---------|
| `maxContinuations` | 40 | integer ≥ 1 | forced continuations per working phase |
| `maxStallTurns` | 2 | integer ≥ 1 | tool-free turns that get nudged; the turn after them halts |
| `repeatLimit` | 3 | integer 2…6 | identical consecutive tool calls that trip the loop guard |
| `maxMinutes` | 60 | finite number > 0 | wall clock per working phase |

`repeatLimit` tops out at 6 because the loop guard only remembers the last 6 calls: a
higher number does not mean a looser guard, it means a guard that can never trip, so the
config layer refuses it.

Layers, lowest precedence first, merged key by key:

1. the defaults in `protocol.ts`
2. `~/.pi/agent/autonomy.json` (or `$PI_AUTONOMY_CONFIG`, see below)
3. `<project>/.pi/autonomy.json`, read only in a trusted project

`PI_AUTONOMY_CONFIG` replaces **all** layers with the single file it names. That is how you
try a setting without touching your real config, and how you ignore a project file you do
not want to obey.

A file with a syntax error, an unknown key, or an out-of-range value is dropped whole: a
warning names the file and the key, the other layers still apply, and the stricter defaults
cover the rest. `/autonomy status` repeats the warning and prints the values actually in
force, each attributed to the file that set it, plus a note when a project file was skipped
because the project is untrusted.

**Trust**: a committed `.pi/autonomy.json` loosens the guards for every collaborator who
trusts that repository — project trust is the only gate. Keep generous caps in your own
agent dir and use a project file to make a repository *stricter*, not looser.

Config is read at session start, so an edit wants a `/reload`. That reload resets the
session anyway, which is the point: `repeatLimit` is baked into the loop detector when a
working phase begins while the other budgets are read turn by turn, so a live reload would
leave one running session governed by a mix of old and new numbers.

## Notes and limits

- State is per session and in memory: a reload, `/new`, or `/resume` resets the session
  to idle (a running autonomous run dies with the process anyway).
- The check-in is as long as the questions are; `/autonomy go` force-starts the work
  phase at any point, `/autonomy stop` aborts everything.
- The wall-clock and continuation caps are per working phase; resuming with
  `/autonomy go` starts a fresh budget.
- Guard values come from the config files listed under Configuration, read once per
  session: `/autonomy status` shows what is in force and where each value came from.

## Development

```sh
npm install      # only needed for typecheck; the tests import no Pi values
npm test         # node --test protocol.test.ts config.test.ts index.test.ts
npm run typecheck
```

`protocol.ts` and `config.ts` are pure (no Pi imports): `protocol.test.ts` covers the
decision table, `config.test.ts` the parsing and layering against temp dirs, and
`index.test.ts` drives the state machine against a stubbed `ExtensionAPI`. Both lists in
`package.json` and `tsconfig.json` name files explicitly — a new file is neither tested nor
typechecked until it is added there.
