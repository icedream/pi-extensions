# pi-skill-reminder

Names the skills a session has already read after the context is compacted.

Pi keeps the `<available_skills>` block in the system prompt, so compaction does not lose it. What
compaction loses is that a particular skill's text was read and applied. The next turn then re-reads the
file, or answers without rules it had already loaded.

## What it does

- A `read` tool result whose path matches `…/skills/<name>/<file>.md` puts that skill in the session's
  set. A failed read does not count.
- After any compaction (manual `/compact`, the context threshold, or overflow recovery), one hidden
  message enters the next turn with the set and the instruction to apply the rules rather than re-read
  them. Nothing is sent while the set is unchanged.
- `session_start` scans the transcript, so a resume or a fork rebuilds the set instead of starting empty.
- `/skills-loaded` prints the set for the current session.

The reminder lists skill-relative paths (`skills/no-ai-slop/SKILL.md`), not absolute ones.

## Install

Add the directory to `packages` in `~/.pi/agent/settings.json`:

```json
"packages": ["../../Documents/Source/Git/github.com/icedream/pi-extensions/pi-skill-reminder"]
```

## Tests

```bash
npm test              # node --test: handlers and message shape, no session and no model
npm run typecheck     # tsc -p tsconfig.json
```
