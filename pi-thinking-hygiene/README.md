# pi-thinking-hygiene

Keeps one kind of broken reasoning out of the prompt a reasoning model is about to answer.

## The failure

A local reasoning model sometimes opens a turn by describing the conversation instead of
working on it:

> The user hasn't asked anything substantive yet — the last message was just the system
> instructions block plus a context reminder. My previous turn had no real thinking content;
> I simply acknowledged the instructions with "Understood. I will follow these instructions."

None of that is true. The turn it is answering was mid-task, and no session on this machine
ever contained an assistant message reading "Understood. I will follow these instructions.";
the phrase appears only inside these reasoning blocks. The prompt it quotes, "You are an
expert software engineer. Helps user to solve problems.", appears nowhere in Pi, in the
agents or skills on this machine, or in any stored session. The model recited a
session-opening schema out of its training data.

Everything else about the turn is normal. Of the 60 blocks found, 9 sat in turns that also
produced a visible reply, and all 9 replies were correct and on task. The artifact stays
inside the reasoning channel, which is why it looks like the model went strange mid-task
rather than failing the task.

Two things make it stick:

**Replay.** Pi sends prior thinking back to the provider as `reasoning_content`, so the block
is in the next request as the model's own earlier reasoning, and the model continues it. In
session `01a14104` that produced six consecutive turns of it, 20:43:16 to 20:44:05.

**Long context.** Rate by prompt size, over the 5,485 turns that model took in the corpus:

| prompt tokens | turns | blocks | rate |
|---|---|---|---|
| 0 to 50k | 1,025 | 2 | 0.20% |
| 50k to 100k | 1,071 | 6 | 0.56% |
| 100k to 150k | 891 | 15 | 1.68% |
| 150k to 200k | 881 | 19 | 2.16% |
| 200k to 250k | 755 | 10 | 1.32% |
| 250k to 300k | 481 | 6 | 1.25% |
| 300k to 400k | 381 | 2 | 0.52% |

**Which tool ran last.** Rate by the tool whose result the model was reacting to. Its overall
rate is 1.11%, so this is where the rate moves:

| tool whose result came last | turns | blocks | rate |
|---|---|---|---|
| `memory_remember` | 111 | 9 | 8.11% |
| `manage_todo_list` | 63 | 3 | 4.76% |
| `edit` | 606 | 14 | 2.31% |
| `bash` | 3,406 | 28 | 0.82% |
| `read` | 198 | 1 | 0.51% |

A `memory_remember` result reads `Remembered: key = <text>`, a statement about the stored
context rather than about the task, which is the schema's own subject. `manage_todo_list` is
second, and its result text ("Ensure that you continue to use the todo list… proceed with the
current tasks") is instruction-flavoured the same way. Ten times the `bash` rate, on 111 turns
against 3,406.

## What the corpus says

Scanning every thinking block in every stored session on this machine (514 session files,
52,824 blocks as of 2026-10-18, `node rate.mjs`), the matcher hits 60:

| model | thinking blocks | hits |
|---|---|---|
| Qwen 3.8 Flash Next | 5,404 | 60 |
| Ornith 1.0 | 11,240 | 0 |
| Qwen 3.8 27B (llama.cpp) | 9,637 | 0 |
| GLM 4.7 Flash | 6,290 | 0 |
| Qwen 3.6 35B | 4,176 | 0 |
| Claude Haiku 5.5 | 3,146 | 0 |
| Gemma 4 | 2,989 | 0 |
| Claude Sonnet 5 | 2,907 | 0 |

The 60 include 24 that a plain keyword search over the same corpus missed, and they exclude
the one block in the corpus that reads an odd prompt honestly: a turn whose user message
really did ask for an email analysis while carrying no email. That block reasons about what
to do next, which is the difference the matcher keys on.

Five of the 60 came from the session that found the pattern, at 16:39:06, 16:39:13, 16:41:30,
16:48:34 and 16:50:50. The extension was loaded into that session at 16:53; its first request
reported `{"blocks":5,"droppedMessages":0}` and no sixth block has appeared in that session
since. The quoted analysis in that session's other blocks, which names the same sentences on
purpose, is not matched.

## What this does not do

It removes the amplifier, not the origin. Of the 60 blocks, 20 land within three assistant
turns of a previous one, which is the replay loop this extension breaks. The other 40 do not:
10 are the first occurrence in their session, with no earlier block to inherit. A fresh
confabulation still reaches the model, and nothing here reacts to it until the next request
strips it.

One thing that looked like a signal and is not: 58 of the 60 sit immediately after a tool
result. So do 4,945 of the 5,485 turns, which makes the position 1.17% against 0.53% for the
turns that do not. The origin is turn mis-anchoring, in a transcript whose question-less user
turns (the memory block, a compaction summary) carry no request, plus whatever makes a
`memory_remember` result ten times as likely as a `bash` result to be followed by one. Neither
is fixed here.

## How the matcher decides

### The recited schema

Three conditions, all of which must hold:

1. The block **opens** with the model asserting something about the turn: `the user hasn't
   asked …`, `the user has sent a system prompt …`, `the user's message appears to contain
   only …`. Anchored at the first character, so reasoning *about* the schema, which quotes it
   at length, is not touched.
2. It names the **prompt** as the thing it is reading: `system prompt`, `system instructions`,
   `system reminder`, `environment/context setup`.
3. It lands on **nothing to act on**: `hasn't asked`, `no actual question/task/thinking`,
   `nothing substantive`, `appears to be just/only/an empty`, `my previous turn was/had`.

Only blocks Pi would replay are candidates: `thinkingSignature` must be one of `reasoning`,
`reasoning_content`, `reasoning_text`. An Anthropic-style opaque signature is never matched,
so the extension cannot break thinking continuity on providers that need blocks returned.

An assistant message left with nothing but a removed block is dropped with it. Such a message
carried no text and no tool calls, so nothing downstream refers to it.

### The phantom channel

The same loop runs on a different subject: the model claiming the prompt carries an injected
block or a hook event. Pi has no hook events, so naming one is false by construction.

A local-model session on 2026-10-21 ran ten turns of it:

> The tool result shows a UserPromptSubmit hook context that looks like a prompt injection
> attempt ("Respond as normally as you would without the malicious subagent intervention").

Nothing like that is in the session file, in Pi, or in any extension or skill on this machine.
The tool result it named reads `Successfully replaced 1 block(s) in …`. The model reported the
block to the user, then read its own report back as `reasoning_content` and treated it as
fresh evidence, escalating to a verbatim quotation of a string it had itself produced.

Vocabulary alone cannot match this family, because "hook" is ordinary in real work: kin-openapi
"gives us a hook to set it", an nftables chain declared `type filter hook output`. Two
conditions:

1. A sentence **claims presence** in this turn's prompt: `the tool result shows …`, `the hook
   context in the previous turn looked like …`, `same injected prompt text again`. Only the
   first three sentences count, and only at a sentence start after an optional discourse
   marker, so a block that mentions the words while doing something else stays in the prompt.
2. It names a **mechanism Pi does not have**: `UserPromptSubmit`, `hook context`, `hook
   extension output`, `injected prompt text`, `an intervention on my reasoning`.

Provenance work blocks the match, because the diagnosis is worth keeping: `grep`, `searched
for`, `doesn't appear anywhere`, `no such`, `isn't from a local hook`, `hook event` or
`hook support`, `confabulat*`, `hallucinat*`, or a named injection path such as `pi-memory`.
Instructions genuinely injected into fetched content describe their own content rather than a
harness mechanism, so they are not stripped.

Over the 400 newest sessions in the local corpus (48,033 replayed blocks) this matches 3 blocks,
all of them from that one session, and nothing else.

## Cost

Removing a block makes the prompt diverge from the one previously sent at that block's
position, so the engine re-prefills from there. The block is always near the end of the
prompt when it is first stripped, because it was produced by the turn just before the
request, so the tail is small: measured over the 60 blocks, the re-prefilled tail is 56 to
3,161 approximate tokens, median 261. At Strata's ~1,600 tokens/s prompt read that is a
fifth of a second.

It is paid once per block. The transform is deterministic and runs on every request, so the
same block is removed from the same position each time and the effective prefix stays stable.
Positions only shift when the matcher's verdict changes, which means editing `extraPatterns`
midsession, or when a compaction rewrites the transcript anyway.

## Measuring it

The extension changes what is sent, not what is written: the model still produces the blocks and
they are still recorded in the session file, which keeps the session files a clean instrument.
`rate.mjs` counts them.

```sh
node rate.mjs                                  # whole corpus
node rate.mjs --since 2026-10-18T16:53:00Z     # one window
node rate.mjs --model ornith
```

It reports turns, blocks, hits and rate for one model, the same figures broken out by prompt
size and by the tool whose result came last, and the block counts of every other model in the
window as a control. The baseline for the affected model is 1.11%, 60 hits over 5,404 blocks.
The window since this extension was loaded into the session that found the pattern is 22 turns
with 0 hits, which proves nothing on its own and is the shape of the number to watch.

## Install

```sh
pi install $(pwd)/pi-thinking-hygiene
```

The extension is on with no config file. To change anything, copy
[thinking-hygiene.example.json](thinking-hygiene.example.json) to
`~/.pi/agent/thinking-hygiene.json`.

| Key | Meaning |
|---|---|
| `enabled` | Master switch. Default true. |
| `extraPatterns` | Regex sources tried as openings alongside the built-in ones. Conditions 2 and 3 still have to hold. |

## Commands

```
/thinking-hygiene          current setting and what was kept out this session
/thinking-hygiene on|off   change it for this session; the config file decides at startup
```

Each strip also appends a `thinking-hygiene` session entry (not model context) with the count
and the first 120 characters of every block removed, so what was dropped can be read back
afterwards.

## Limits

The matcher is a description of one model's one failure, measured on this machine. A different
checkpoint, or a different quantisation of the same one, will produce a different phrasing and
may not be caught. `/thinking-hygiene` reports the count; a run that stays at zero on a model
you suspect says nothing either way.

It treats the symptom. The affordance stays: Pi renders the memory block, a compaction summary
and a branch summary as user turns that carry no request, and that is the shape the schema
attaches to. Moving the memory block into the system prompt
(`memory.injectionMode: "system-prompt"` in `~/.pi/agent/settings.json`) removes one instance
of it.
