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
| `observed` | Optional. The seat figure from the GitHub Copilot usage page: `creditsUsed` (as shown), `asOf` (ISO time you read it), and `usdPerCredit` (default `0.01`, i.e. 15,000 credits = $150). When `asOf` is in the current month, it replaces the meter as the baseline, and Pi spend since `asOf` is added on top. Update it whenever you check the page, or let `seat` keep it current for you. An observation from another month is ignored with a warning. |
| `seat` | Optional. Absent means the extension never contacts GitHub. When present, it fetches the seat figure and uses it as the month-to-date baseline, in memory. See [Seat figure](#seat-figure). |

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
it is current, and is held in memory only — the config file is never written. Refreshes run on
`session_start` and after agent runs settle, never inside a turn. `/budget-seat` forces one now and
reports the numbers. When the fetch fails the hand-written `observed` is used instead, with one
notification per session. If the seat entitlement and `monthlyCapUsd` disagree it notifies once per
session rather than changing your cap.

**The GitHub credential is used only while `provider` is `github-copilot`.** For any other provider
the extension does not contact GitHub at all.

Two credential sources, either of which is enough:

1. `pi` — Pi's own `github-copilot` credential in `~/.pi/agent/auth.json`. Its `access` field is a
   Copilot proxy token (`tid=…`) that `api.github.com` rejects; the `refresh` field is the GitHub
   user-to-server token (`ghu_…`) that Pi exchanges for it, and that one is accepted. The extension
   accepts a value only if it looks like a GitHub token, so a `tid=` or `ghr_` value is never sent.
   No extension API exposes this credential: `getApiKeyForProvider` returns the `tid=` token.
2. `gh` — `gh auth token`, where gh reads its own keyring and the token never enters this process.

The token is sent to `api.github.com` and nowhere else, is never logged, and is never written to a
config file. If both sources fail, the extension keeps the `observed` already in the file and
notifies once per session.

**Overlap.** `monthSpend` adds Pi-logged spend since the snapshot on top of the seat figure. With a
fresh figure the minutes between GitHub's snapshot and now are counted twice — at most a few cents
at the default interval. The alternative would drop non-Pi usage in that window, so the overlap is
kept.

## Tests

```sh
cd budget-routing
node --test budget.test.ts     # or: npm test
npm run typecheck              # after npm install
```

## Limitations

- Spend is Pi's estimate at API list prices, not the invoice. Without a current seat figure — from `seat`, or from a hand-written `observed` — the meter sees only this machine's logs, so usage on other machines or in the IDE is missed and the estimate can read low.
- Subagent child sessions are counted from their own session files. Transcripts under `subagent-artifacts/` are skipped because they duplicate those files.
- Divert sees top-level `subagent` launches and `tasks` arrays only. Launches inside workflow scripts are not rewritten.
- `prepare` runs between agent runs. A single long run can jump from below `prepare` to `divert` without compacting first.
- Local models have a smaller context window and cold-start slowly. Switching mid-task is risky.
- Only unit tests and a typecheck have been run so far. Check the live behavior in Pi before relying on it.
