# budget-routing

Pi extension for spend caps on the paid providers a session is billed on, several at once (GitHub
Copilot, Anthropic, Mistral, a prepaid gateway such as Opper). Spend comes from Pi's session logs,
from the provider's own usage API where one exists ([`seat`](#seat-figure) for Copilot,
[`balance`](#wallet-figures) for a prepaid wallet, [`usage`](#request-counters) for a request counter),
or from a hand-written `observed` figure.
Behaviour then changes per provider by tier as its budget fills, and the model gets a priced route
menu so it can move work to a cheaper route before it has to fall back to a local model.

| Tier | Default | What happens, for that provider |
|------|---------|---------------------------------|
| nudge | 70% | Advisory prompt section naming its state, and the `budget` tool for the priced menu |
| warn | 80% | Notification |
| prepare | 95% | Compacts the main session while that provider still works, between agent runs. Only a session spending that provider compacts |
| divert | 100% | Depends on `enforce`: `reject` (default) refuses launches that would spend it, with the open routes listed so the task gets re-queued elsewhere; `rewrite` points `localSubagents` at the local model and refuses the rest; `off` does nothing. Offers to switch the main session to the local model (confirmation required) |

Each provider also carries a compact footer indicator next to the session cost, one per provider
this machine tracks: `copilot 92%  anthropic $5.46  opper 12% $8.77 left`, coloured by tier. A leading `~` means
the figure is estimated from Pi's own logs rather than the provider's own figure; `!` and `over` mark
the prepare and divert tiers. A provider with no cap shows its spend instead of a percentage, and a
prepaid account shows what is left in it. `? balance unknown` means the wallet fetch is failing or its
figure has aged out, so only Pi's logs are being counted.

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
| `provider` | Provider name as recorded in session logs, e.g. `github-copilot`. It must be a provider this machine has models for, see [Registered providers](#registered-providers) |
| `monthlyCapUsd` | The cap. Omit it to track and price the provider without ever limiting it |
| `reset` | `local` (default) or `utc`: which calendar the provider's monthly reset follows. Anthropic and Mistral reset on the 1st UTC |
| `billing` | Optional override: `credits` (flat seat), `metered` (per token), `free`. Derived when absent: Copilot is `credits`, a provider whose models carry zero registry prices is `free`, everything else `metered` |
| `observed` | The provider's own usage figure, copied by hand: `creditsUsed`, `asOf` (ISO time you read it), `usdPerCredit` (default `0.01`). In-month replaces the meter as the baseline, and Pi spend since `asOf` is added on top |
| `seat` | Copilot only. Fetches the figure instead of copying it. See [Seat figure](#seat-figure) |
| `balance` | Prepaid wallets, currently `opper` only. Fetches the account balance and period spend. See [Wallet figures](#wallet-figures) |
| `usage` | A request counter for a provider with no readable bill, e.g. a GCP project whose billing account is not visible here. Displayed only, never capped. See [Request counters](#request-counters) |

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
    { "provider": "mistral", "reset": "utc" },
    { "provider": "opper", "monthlyCapUsd": 8, "reset": "utc", "billing": "metered", "balance": { "refreshMinutes": 15 } }
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
provider        billing   cap       spent    pct   headroom    figure
copilot         credits  $150.00   $136.50  91%    9% left     live (seat)
anthropic       metered  $60.00     $5.46    9%    91% left    meter
mistral         metered  none       $0.19    -    no cap      meter
opper           metered   $8.00     $1.22   15%    $8.77 left  live (balance)

route                              billing  $/Mtok in/out  cache r/w   ctx     provider room
mistral/magistral-medium-latest    metered  2/5            -/0.6       128k    no cap
anthropic/claude-sonnet-5-5        metered  3/15           0.3/3.75    1M      91% left
github-copilot/claude-sonnet-5.5   credits  2/10           0.1/2.5     1M      9% left
strata/qwen3.8-flash-next-iq3_s    free     -              -           393k    not tracked  (last resort: self-hosted, cold start)
```

Prices come from Pi's model registry. They are list prices, not invoices: on a `credits` provider the
registry price is what the same model would cost on a metered API, while what you actually pay is one
seat credit per request. A wrong model id under a provider this machine has stays in the table marked
`price unknown` rather than disappearing, so a typo in `advisory.models` is visible. A reference for a
provider with no models here is dropped, see [Registered providers](#registered-providers).

## Registered providers

A provider counts as this machine's when Pi can authenticate to it here: an `auth.json` entry, an
`apiKey` in `models.json`, an environment key, or an extension that supplies one. That covers a
`discoverModels` provider whose catalog has not loaded yet, whose endpoint is down or still starting
while its spend is still this machine's to count. Catalog presence is deliberately not a test: Pi ships
the model catalog of providers such as Anthropic and Mistral on every install, and a machine without a
key for them never bills on them. An entry with no credential here is inert, and one notification per
session says which entry that is.

The config file is usually shared between machines, and the provider set is not. Without the gate the
model gets told about a cap it can never spend against and about routes its subagent tool cannot
launch on, and the number it reads for that provider is whatever other machines spent. Route references
are the one place the rule stays strict: a reference only counts when the registry has that model,
because that is what the subagent tool resolves against.

What an inert entry stops doing on that machine:

- no footer indicator, and it is absent from the `<budget>` prompt section, from `/budget`, from the
  `budget` tool and from the price table appended to `subagent({action: "models"})`
- route references in `advisory.models` under that provider are dropped from the menu
- no seat or wallet fetch, which have no credential to read here anyway
- no cap, so a launch aimed at that provider is never refused for spend

`localModel` is gated by the same rule: while its `provider` is not this machine's, the routing advice
and the rejection reason leave out the local fallback, because there is none to fall back to.

## Out of budget

A configured cap is your own number, and it can sit above the account's real limit. Anthropic's spend
limit, a depleted credit balance or a Copilot quota are enforced by the provider, so the meter can read
11% while every call already fails. The extension therefore also listens to the provider itself.

When an assistant message ends with `stopReason: "error"` and the message says the account is out of
spend or credit, that provider is marked out of budget:

- its footer shows `anthropic out of budget`
- its tier becomes `divert` regardless of measured spend or of whether it has a cap at all, so launches
  that would spend it are refused with the open routes listed, and a session running on it is offered
  the switch to the local model
- `/budget` shows `out of budget` in the headroom column, and `/budget <provider>` names the reason and
  the reset time

A plain rate limit does not trigger this: Anthropic reports both as `429 rate_limit_error`, so the text
is what separates a spent allowance from a short throttle. Recognised wording covers `enforced_spend_limit_reached`,
"reached your specified API usage limits", "credit balance is too low", `insufficient_quota` and
`quota_exceeded`.

The state clears when a call to that provider succeeds again, when the reset instant the provider named
passes, or at the next month boundary in that provider's `reset` zone, since a spend limit is usually a
monthly allowance. A wallet figure saying `blocked` is the exception: it is re-read from the provider
every refresh, so it clears as soon as the account has money again rather than waiting for a month.
It is held in memory, so a restart forgets it and the next failed call detects it again.
`/budget clear <provider>` drops it by hand, for a limit you just raised.

## The `/budget` command

`/budget` prints the table above for you, in the TUI only, so it costs no model tokens.

`/budget <provider>` prints one provider's state and its per-model usage for the current window:

```
anthropic: metered, no cap, spent $5.89 (meter), since 2026-11-01 00:00 UTC

model              msgs  input  output  cache r  cache w  cost
claude-haiku-5-5   168   368    297k    60.0M    1.8M     $4.89
claude-sonnet-5-5  33    70     58k     1.4M     113k     $1.00
total              201   438    355k    61.4M    1.9M     $5.89
```

The argument completes from the providers in your config, but it is not limited to them: any provider
name that appears in the session logs works, including ones you never configured, and those are marked
`not in budget-routing.json, usage only`. A local provider shows its token counts at `$0.00`, which is
still useful for spotting which model a session actually ran on.

When the spent figure comes from the provider's own usage page (`source` is `live` or `calibrated`)
the report also prints what Pi logged, because the two cover different spans: the provider figure
counts everything up to its snapshot, the log only what this machine recorded after it.

Usage is read from the session logs, so it covers this machine only and starts at the provider's own
month boundary (`reset`).

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

## Wallet figures

A prepaid gateway has no monthly allowance: you buy credit and the next call that runs out is refused.
For those providers the meter runs on the money in the account rather than on a calendar month. Add a
`balance` block, currently honoured for the provider name `opper` only:

```json
"balance": { "refreshMinutes": 15 }
```

It fetches `https://api.opper.ai/v3/me` with the API key Pi already uses for that provider
(`modelRegistry.getApiKeyForProvider`), and reads:

| Field | Used for |
|---|---|
| `balance.balance_cents` | Money left. Part of the cap and the number in the footer |
| `spend.spent_cents` | What the provider billed in its own period: the baseline the meter starts from |
| `spend.limit_cents` | A Spend limit rule, which becomes a ceiling of its own |
| `spend.period_start` / `period_end` | The window the figure is valid for; outside it the figure is ignored |
| `blocked` + `block_reason` | The provider refusing spend, which forces the divert tier |

**The cap.** `monthlyCapUsd` stays the ceiling you set for yourself. The wallet adds two of its own:
`spend + max(0, balance)`, the money that actually exists, and `limit_cents` if the account has a
Spend limit rule. The lowest of the three is the cap, so with $1.22 spent and $8.77 left an entry with
`monthlyCapUsd: 8` tiers against $8.00, and one with no cap tiers against $9.99. A top-up raises the
cap and pulls the percentage back down by itself. A wallet with nothing in it caps at 0, which is
divert rather than a division by zero.

The percentage therefore counts the whole organization's spend, including other keys, other machines
and the dashboard. That is the point, but it also means the number can move without Pi causing it.

**Staleness.** A figure is used only while it is inside its own billing period and no older than four
`refreshMinutes`. After that the wallet stops setting a cap, `monthlyCapUsd` is all that is left, the
footer reads `opper ? balance unknown`, and the meter falls back to Pi's logs. A failed fetch is
recorded as an attempt, so a dead endpoint or a key without the `billing:read` permission is retried on
the same interval rather than after every agent run. `/budget-balance` forces a fetch now and reports
the numbers. Without any figure the provider is fail-open: tracked and priced, but nothing refuses a
launch unless you configured `monthlyCapUsd`.

**Blocked accounts.** `blocked: true` marks the provider out of budget from the provider's own word, no
error-message matching involved: the footer reads `opper out of budget`, launches that would spend it
are refused, and the session is offered the local model. A spend-cap block clears at `period_end`; an
empty balance has no period to wait out, so it clears when a later fetch says the account is fine, or
with `/budget clear opper`.

The key is sent to `api.opper.ai` and nowhere else, is never logged, and is never written to a config
file. Like the seat fetch, the provider name is matched literally: a provider you have renamed locally
gets no wallet figure.

## Request counters

A provider can bill you in a way you cannot read from this machine: the project that carries the key may
have no accessible Cloud Billing account, so there is no dollar figure to fetch and no usage endpoint of
its own. For those, a `usage` block counts requests instead. It is displayed and never tiered: caps stay
USD, so a counter cannot refuse a launch.

```json
{
  "provider": "google",
  "reset": "utc",
  "usage": { "source": "gcp-quota", "projectEnv": "BUDGET_GOOGLE_PROJECT", "refreshMinutes": 15 }
}
```

`project` names the project outright; `projectEnv` names a variable holding it, which is what a config
file shared between work and private machines wants, so the project that carries the key stays on the
machine that has it. Without either, the counter is skipped and one notification says which entry is
missing the value. `quotaMetric` defaults to
`generativelanguage.googleapis.com/api_requests` and may be set to any quota metric the project reports. The fetch reads
`serviceruntime.googleapis.com/quota/rate/net_usage` for the tracked month from
`monitoring.googleapis.com`, authenticating with `gcloud auth print-access-token` (no project argument:
gcloud validates that argument against the account context and fails when the configured project is
elsewhere, while the bare token reads every project the account can see). It needs no key in this
process and never sees a service-account credential. `/budget-usage` forces a fetch and reports it. The `budget` tool then appends a counter table:

```text
provider  requests this month  period start (UTC)  largest method
google    2,314                2026-11-01          google.ai.generativelanguage.v1beta.GenerativeService.GenerateContent
```

A counter starts at zero with the month, so the first refresh after a reset reports what the month has
cost in calls rather than in money. Points before the period start are dropped, not clamped, because the
fetch window reaches back past the boundary on every refresh.

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
  `seat`, from `balance`, or from a hand-written `observed`) the meter sees only this machine's logs, so
  usage on other machines or in the IDE is missed and the estimate can read low. A gateway that bills at
  provider rates with no markup, like Opper, is metered exactly once its models carry prices.
- Copilot and Opper have figures the extension can fetch. Anthropic's cost report needs an admin API key
  (`sk-ant-admin-...`), which is a separate credential from the one Pi uses, and Mistral's billing API
  is Enterprise-only. For those two, hand-writing `observed` is the only way to count non-Pi usage.
- A provider entry without `monthlyCapUsd` is priced and reported but never tiered, so it never nudges,
  compacts, or refuses anything. For a wallet provider that also means: while its balance fetch is
  failing there is no ceiling at all.
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
