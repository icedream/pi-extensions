# pi-mcp-hygiene

Rewords one line that the released MCP adapter appends to its own tool results, so it does not
read as a voice inside the model's context.

## The line

`pi-mcp-adapter` adds a status sentence to any tool result that opened an interactive UI. As
released it reads:

> Interactive UI is open. I'll respond to your prompts and intents as you interact with it.

That sentence is adapter state, not server output, and it enters the model's context inside a tool
result, next to other additions the model did not write (the memory block, a compaction summary).
A local reasoning model was seen claiming, over ten turns, that unrelated text in its prompt came
from an outside party that had told it not to mention the intervention. None of that text existed;
the model was continuing its own replayed reasoning. This line is not the origin of that failure,
and it is a plausible accelerant for the class of them.

## What it does

`tool_result` handlers run after a tool produced its result and compose, so the extension rewrites
the sentence in place:

| before | after |
|---|---|
| `Interactive UI is open. I'll respond to your prompts and intents as you interact with it.` | `Interactive UI is open; follow-up input may arrive from it.` |
| `Updated the open UI. I'll respond …` | `Updated the open UI; follow-up input may arrive from it.` |

The fact is kept, including in the session file, so the record still says a UI was open. Only the
adapter's own tools are considered (`mcp`, `mcp__…`, `mcp-…`), and a result with no notice is
returned by reference. `/mcp-hygiene` reports how many notices were reworded this session, and a
dim status line shows the count while it is nonzero.

## Relationship to the other two levers

This is the no-fork option. Two alternatives exist and are independent of it:

- `appendStructuredContent: false` on a server in `~/.config/mcp/mcp.json` stops the adapter from
  also appending its `structuredContent` payload to the model-visible text. That covers the machine
  payload (server session ids, account ids, feature flags), which this extension does not touch.
- Patching the adapter source itself, which is what a fork does. If the wording is fixed upstream,
  the table in [notices.ts](notices.ts) has nothing left to match and the extension goes quiet on
  its own.

## Tests

`npm test` covers both notices, the two impersonal notices that must stay untouched, payload blocks
returned by reference, notices that arrive as their own content block, and tool-name filtering.
