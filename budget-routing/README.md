# budget-routing

Pi extension for a monthly spend cap on one provider (default: GitHub Copilot). It reads Pi's own session logs, estimates month-to-date cost, and changes behavior by tier as the cap fills.

| Tier | Default | What happens |
|------|---------|--------------|
| nudge | 70% | Advisory section added to the system prompt: prefer the local model for light subagents |
| warn | 80% | Notification |
| prepare | 95% | Compacts the main session while the provider still works, between agent runs |
| divert | 100% | Rewrites launches of `localSubagents` to the local model. Blocks other launches for the provider. Offers to switch the main session to the local model (confirmation required) |

## Install

From the repository root:

```sh
pi install $(pwd)/budget-routing
```

Then create the config file (see below) and run `/reload`. Without a config file the extension does nothing.

## Config

Path: `~/.pi/agent/budget-routing.json`, or the file in `PI_BUDGET_ROUTING_CONFIG`. Start from [budget-routing.example.json](budget-routing.example.json).

| Key | Meaning |
|-----|---------|
| `provider` | Provider name as recorded in session logs, e.g. `github-copilot` |
| `monthlyCapUsd` | The cap. Spend is compared to this gross |
| `thresholds` | Fractions of the cap for `nudge`, `warn`, `prepare`, `divert`. Must not decrease |
| `localModel` | `provider` and `modelId` for the main-session switch, plus `subagentRef`, the id the subagent tool accepts |
| `localSubagents` | Agent names that may run locally at divert |

## Tests

```sh
cd budget-routing
node --test budget.test.ts     # or: npm test
npm run typecheck              # after npm install
```

## Limitations

- Spend is Pi's estimate at API list prices, not the invoice. Calibrate against your billing page. The estimate can run a few percent off.
- Subagent child sessions are counted from their own session files. Transcripts under `subagent-artifacts/` are skipped because they duplicate those files.
- Divert sees top-level `subagent` launches and `tasks` arrays only. Launches inside workflow scripts are not rewritten.
- `prepare` runs between agent runs. A single long run can jump from below `prepare` to `divert` without compacting first.
- Local models have a smaller context window and cold-start slowly. Switching mid-task is risky.
- Only unit tests and a typecheck have been run so far. Check the live behavior in Pi before relying on it.
