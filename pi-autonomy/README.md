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
| stall | 2 | two consecutive turns with no tool calls and no marker (talking, not working) |
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
| `/autonomy status` | current phase, goal, forced-continuation count, runtime |
| `/autonomy` | status while active, usage otherwise |

The footer shows `autonomy: check-in / working (n/40) / paused (reason)` while a session
is live. You can steer a running session by typing normally (your message is delivered
as steering) — the session keeps running until the marker or a guard.

## Tuning

Defaults live in `protocol.ts` (`DEFAULT_CONFIG`): `maxContinuations`, `maxStallTurns`,
`repeatLimit`, `maxMinutes`. Edit and reload to change them.

## Notes and limits

- State is per session and in memory: a reload, `/new`, or `/resume` resets the session
  to idle (a running autonomous run dies with the process anyway).
- The check-in is as long as the questions are; `/autonomy go` force-starts the work
  phase at any point, `/autonomy stop` aborts everything.
- The wall-clock and continuation caps are per working phase; resuming with
  `/autonomy go` starts a fresh budget.

## Development

```sh
npm install
npm test        # node --test protocol.test.ts index.test.ts
npm run typecheck
```

`protocol.ts` is pure (no Pi imports); `protocol.test.ts` covers the decision table and
`index.test.ts` drives the state machine against a stubbed `ExtensionAPI`.
