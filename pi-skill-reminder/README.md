# pi-skill-reminder

Names the skill rules a compaction dropped, so the model reloads the ones its task needs.

Pi keeps the `<available_skills>` block in the system prompt and the compaction summary lists every file the
session read under `<read-files>`. Neither carries the rules. A session that lost a skill's text still sees
the path, so it answers from recall of a read it can no longer quote, and follows rules it never actually has.

## What it does

- A skill counts as loaded once the session reads `…/skills/<name>/….md` successfully, or once Pi expands a
  skill block for it. A failed read does not count.
- The extension compares the transcript against the compaction-aware projection
  (`buildContextEntries`) to find skills whose text is no longer in the model's context.
- For those skills it puts a hidden message into the next turn: name, frontmatter description and path, with
  the order that the model reads the files that apply to its current task **in full** before applying any
  rule from them, leaves the ones that do not apply alone, and never restates a rule from a file it has not
  read in this context window.
- The check runs after a compaction inside a run (delivered by steering, so the turns that follow the
  compaction get it) and at the start of any run that begins on a compacted transcript, a resume, a fork or a
  branch jump.
- One notice per compaction boundary. A read of a listed file closes it, so it is not nagged again.
- `/skills-loaded` lists the skills the session read and which of them still hold their text, plus the mode.
- `/skills-reload` reads the skill files and puts their text into context now; `force` includes text that is
  already in context.

## Modes

`PI_SKILL_RULES` selects what the message carries:

| Value | Behaviour |
|-------|-----------|
| `relevant` (default) | the list with descriptions; the model re-reads in full only what its task needs |
| `full` | the extension reads every dropped file and injects the text itself |
| `off` | leave the summary alone |

`full` costs the whole text of everything the session read, at every compaction: several large skills are
several thousand tokens per compaction. Files over 48 KB are cut at a line boundary with the offset to resume
at, since the read tool would not have given more either, and messages split at 160 KB. The default costs the
list plus whatever the model decides to read.

## Install

Add the directory to `packages` in `~/.pi/agent/settings.json`:

```json
"packages": ["../../Documents/Source/Git/github.com/icedream/pi-extensions/pi-skill-reminder"]
```

## Tests

```bash
npm test              # node --test: handlers and message shape, no session and no model
npm run typecheck     # tsc -p tsconfig.json
npm run e2e           # real AgentSession against a scripted endpoint, asserting on request bodies
```
