# budget-routing

Pi extension for monthly spend caps on the paid providers a session is billed on, several at once
(GitHub Copilot, Anthropic, Mistral, ...). Month-to-date spend comes from Pi's session logs, from the
provider's own usage API where one exists ([`seat`](#seat-figure) for Copilot), or from a hand-written
`observed` figure. Behaviour then changes per provider by tier as its cap fills, and the model gets a
priced route menu so it can move work to a cheaper route before it has to fall back to a local model.

| Tier | Default | What happens, for that provider |
|------|---------|---------------------------------|
| nudge | 70% | Advisory prompt section naming its state, and the `budget` tool for the priced menu |
| warn | 80% | Notification |
| prepare | 95% | Compacts the main session while that provider still works, between agent runs. Only a session spending that provider compacts |
| divert | 100% | Depends on `enforce`: `reject` (default) refuses launches that would spend it, with the open routes listed so the task gets re-queued elsewhere; `rewrite` points `localSubagents` at the local model and refuses the rest; `off` does nothing. Offers to switch the main session to the local model (confirmation required) |

Each provider also carries a compact footer indicator next to the session cost, one per configured
provider: `copilot 92%  anthropic $5.46  mistral $0.19`, coloured by tier. A leading `~` means the
figure is estimated from Pi's own logs rather than the provider's own figure; `!` and `over` mark the
prepare and divert tiers. A provider with no cap shows its spend instead of a percentage.

## Install

From the repository root:

```sh
pi install $(pwd)/budget-routing
```

Then create the config file (see below) and run `/reload`. Without a config file the extension does nothing.

## Config

Path: `~/.pi/agent/budget-routing.json`, or the file in `PI_BUDGET_ROUTING_CONFIG`. Start from [budget-routing.example.json](budget-routing.example.json).

Top level:

| Key | Meaning |
|-----|---------|
| `providers` | The providers to track, one object each. See below |
| `thresholds` | Fractions of a cap for `nudge`, `warn`, `prepare`, `divert`. Must not decrease. Shared by all providers |
| `localModel` | `provider` and `modelId` for the main-session switch, plus `subagentRef`, the id the subagent tool accepts |
| `localSubagents` | Agent names that may run locally. Used by `enforce: "rewrite"` |
| `enforce` | `reject` (default), `rewrite`, or `off`. What a divert does to a launch |
| `advisory.models` | Optional route menu. Model references the cost table should list. Absent means the models Pi's `subagents.agentOverrides` already points at, plus the local model and the session model |
| `advisory.maxModels` | Cap on that menu. Default 8 |

Per provider entry:

| Key | Meaning |
|-----|---------|
| `provider` | Provider name as recorded in session logs, e.g. `github-copilot` |
| `monthlyCapUsd` | The cap. Omit it to track and price the provider without ever limiting it |
| `reset` | `local` (default) or `utc`: which calendar the provider's monthly reset follows. Anthropic and Mistral reset on the 1st UTC |
| `billing` | Optional override: `credits` (flat seat), `metered` (per token), `free`. Derived when absent: Copilot is `credits`, a provider whose models carry zero registry prices is `free`, everything else `metered` |
| `observed` | The provider's own usage figure, copied by hand: `creditsUsed`, `asOf` (ISO time you read it), `usdPerCredit` (default `0.01`). In-month replaces the meter as the baseline, and Pi spend since `asOf` is added on top |
| `seat` | Copilot only. Fetches the figure instead of copying it. See [Seat figure](#seat-figure) |

A v1 file with a top-level `provider`, `monthlyCapUsd`, `observed` and `seat` still works: it reads as a
one-entry `providers` list. A file that carries both forms is rejected rather than picking one.

```json
{
  "localModel": { "provider": "strata", "modelId": "qwen3.8-flash-next-iq3_s", "subagentRef": "strata/qwen3.8-flash-next-iq3_s" },
  "localSubagents": ["scout", "delegate", "Plan", "Explore"],
  "thresholds": { "nudge": 0.7, "warn": 0.8, "prepare": 0.95, "divert": 1.0 },
  "enforce": "reject",
  "providers": [
    { "provider": "github-copilot", "monthlyCapUsd": 150, "seat": { "refreshMinutes": 15 } },
    { "provider": "anthropic", "monthlyCapUsd": 60, "reset": "utc" },
    { "provider": "mistral", "reset": "utc" }
  ]
}
```

## Cost table and the `budget` tool

Pi records every provider's tokens at list price, but it never tells the model what a route costs, and
the subagent tool's model list carries no prices. So the extension supplies the table, in three places,
each chosen to cost tokens only when it is worth it:

- The `budget` tool (`action: "status"` or `"models"`) is the lookup. Read it before fanning work out,
  or after a launch was refused for spending an over-cap provider.
- A `<budget>` prompt section carries only tier bands, never percentages, so its text changes a handful
  of times a month. Pi then ships a prompt *patch* for that section instead of rewriting the leading
  system message, which would cost a full cache miss on providers that bill a cached prefix cheaper than
  a fresh one. This is why the numbers are not in the prompt.
- `subagent({action: "models"})` gets the table appended to its own result, so the prices arrive at the
  exact moment a routing decision is made.

```
provider        billing   cap       spent    pct   headroom  figure
copilot         credits  $150.00   $136.50  91%    9% left    live
anthropic       metered  $60.00     $5.46    9%    91% left   meter
mistral         metered  none       $0.19    -    no cap      meter

route                              billing  $/Mtok in/out  cache r/w   ctx     provider room
mistral/magistral-medium-latest    metered  2/5            -/0.6       128k    no cap
anthropic/claude-sonnet-5-5        metered  3/15           0.3/3.75    1M      91% left
github-copilot/claude-sonnet-5.5   credits  2/10           0.1/2.5     1M      9% left
strata/qwen3.8-flash-next-iq3_s    free     -              -           393k    not tracked  (last resort: self-hosted, cold start)
```

Prices come from Pi's model registry. They are list prices, not invoices: on a `credits` provider the
registry price is what the same model would cost on a metered API, while what you actually pay is one
seat credit per request. A reference that is not in the registry stays in the table marked `price
unknown` rather than disappearing, so a typo in `advisory.models` is visible.

`/budget` prints the same table for you.

## Seat figure

The numbers on `github.com/settings/copilot/features` come from an API the extension can call
directly, so the figure does not have to be copied into `observed` by hand. Add a `seat` block:

```json
"seat": { "refreshMinutes": 15, "credential": "auto" }
```

| Key | Meaning |
|-----|---------|
| `refreshMinutes` | Minimum minutes between fetches. Default 15. |
| `credential` | `auto` (default), `pi`, or `gh`. |

It fetches `https://api.github.com/copilot_internal/user` and reads
`quota_snapshots.premium_interactions`: `credits_used` is the month-to-date figure,
`timestamp_utc` is its snapshot time, and `entitlement` is the credit allowance
(`entitlement × usdPerCredit` is the USD cap). That figure replaces `observed` as the baseline while
it is current, and is held in memory only: the config file is never written. Refreshes run on
`session_start` and after agent runs settle, never inside a turn. `/budget-seat` forces one now and
reports the numbers. When the fetch fails the hand-written `observed` is used instead, with one
notification per session. If the seat entitlement and `monthlyCapUsd` disagree it notifies once per
session rather than changing your cap.

**The GitHub credential is used only for a `github-copilot` entry.** Any other provider in the list
never reaches GitHub at all.

Two credential sources, either of which is enough:

1. `pi`: Pi's own `github-copilot` credential in `~/.pi/agent/auth.json`. Its `access` field is a
   Copilot proxy token (`tid=…`) that `api.github.com` rejects; the `refresh` field is the GitHub
   user-to-server token (`ghu_…`) that Pi exchanges for it, and that one is accepted. The extension
   accepts a value only if it looks like a GitHub token, so a `tid=` or `ghr_` value is never sent.
   No extension API exposes this credential: `getApiKeyForProvider` returns the `tid=` token.
2. `gh`: `gh auth token`, where gh reads its own keyring and the token never enters this process.

The token is sent to `api.github.com` and nowhere else, is never logged, and is never written to a
config file. If both sources fail, the extension keeps the `observed` already in the file and
notifies once per session.

**Overlap.** `monthSpend` adds Pi-logged spend since the snapshot on top of the seat figure. With a
fresh figure the minutes between GitHub's snapshot and now are counted twice, at most a few cents
at the default interval. The alternative would drop non-Pi usage in that window, so the overlap is
kept.

## Tests

```sh
cd budget-routing
node --test budget.test.ts runtime.test.ts   # or: npm test
npm run typecheck                            # after npm install
```

`budget.test.ts` covers the pure logic. `runtime.test.ts` drives `index.ts` against a fake pi and a
throwaway agent directory built by `PI_BUDGET_ROUTING_AGENT_DIR`: a known session log, a config, and
`settings.json` with agent overrides, so tiers and table numbers are exact instead of whatever this
machine happens to have logged.

## Limitations

- Spend is Pi's estimate at API list prices, not the invoice. Without a current provider figure (from
  `seat`, or from a hand-written `observed`) the meter sees only this machine's logs, so usage on other
  machines or in the IDE is missed and the estimate can read low.
- Only Copilot has a figure the extension can fetch. Anthropic's cost report needs an admin API key
  (`sk-ant-admin-...`), which is a separate credential from the one Pi uses, and Mistral's billing API
  is Enterprise-only. For those two, hand-writing `observed` is the only way to count non-Pi usage.
- A provider entry without `monthlyCapUsd` is priced and reported but never tiered, so it never nudges,
  compacts, or refuses anything.
- Subagent child sessions are counted from their own session files. Transcripts under
  `subagent-artifacts/` are skipped because they duplicate those files.
- `enforce` sees top-level `subagent` launches and `tasks` arrays only. Launches inside workflow scripts
  are not seen.
- A launch is attributed to a provider by its `model` argument: an exact `provider/id` match, or a bare
  id that only one known model has. A launch with no `model` is attributed to the session model's
  provider, and an unresolvable `model` string takes the worst tier among the capped providers. A
  default model coming from `subagents.agentOverrides` is invisible to that decision, so such a launch
  is judged by the session model even though the route menu does read those overrides.
- `prepare` runs between agent runs. A single long run can jump from below `prepare` to `divert` without
  compacting first.
- Local models have a smaller context window and cold-start slowly. Switching mid-task is risky.
- Checked so far: unit tests, the runtime wiring tests, a typecheck, and one non-interactive pi run
  against the real model registry and the real Copilot seat figure. The tier-crossing behaviours
  (pre-switch compaction, the switch confirm, footer colour changes over a long session) are only
  covered by the wiring tests, so watch them the first time a cap actually fills.
