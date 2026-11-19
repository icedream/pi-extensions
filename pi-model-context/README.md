# pi-model-context

Discovers models for `models.json` providers marked `"discoverModels": true`, and registers them
with the **context window, input modalities, list price and thinking levels the endpoint actually
reports**.

## Configure

In `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "myhost/strata": {
      "api": "openai-completions",
      "baseUrl": "http://127.0.0.1:8080/v1",
      "apiKey": "$STRATA_API_KEY",
      "discoverModels": true
    }
  }
}
```

| Key | Meaning |
|---|---|
| `discoverModels: true` | Discover this provider at startup, on each session start, and on `/model-context-refresh`. |
| `discoverModels: false` | Turn discovery back off for this provider; it returns to plain `models.json` handling. |
| `modelsUrl` | Optional. Overrides the discovery URL only. Chat requests still use `baseUrl`. Use a trusted endpoint: the provider's credentials are sent to it. |
| `discover` | Optional. Discovery knobs: `require`, `pricing`, `refreshMinutes`. See [Narrowing a large list](#narrowing-a-large-list). |
| `apiKey` | Literal, `$NAME`, `${NAME}`, `$$`, `$!`. A leading `!command` is refused for discovery requests. |

The models registered here replace the provider's `models` entries in `models.json`, so a value written
for a model there is dropped. Per-model corrections go in that provider's `modelOverrides`, which Pi
1.5.2 applies above the registered models, and a context window pinned there survives every refresh.

## What is read from `GET /models`

| Field | Used for | Fallback |
|---|---|---|
| `id` | Model id | entry skipped if missing |
| `name` | Display name | `id` |
| `meta.n_ctx`, `n_ctx`, `context_window`, `contextWindow`, `max_model_len`, `context_length` | `contextWindow` | **none** - the model is skipped |
| `meta.n_predict`, `max_tokens`, `maxTokens`, then `max_output_tokens` inside any object-valued field | `maxTokens` | 65,536, clamped to the context window, with a notice |
| `architecture.input_modalities` | `input` | `["text"]` |
| `architecture.output_modalities` containing `decisions` | classifier marker | entry skipped with a notice |
| `architecture.output_modalities` declared but without `text` (embeddings, image-only) | not a chat model | entry skipped with a notice |
| `pricing.prompt`, `pricing.completion`, `pricing.input_cache_read`, `pricing.input_cache_write` | `cost`, converted from USD per token to USD per million tokens | no cost, so the model stays free |
| `opper.reasoning.supported`, `params.reasoning.supported` | `thinkingLevelMap`: only the levels named get offered, and a named `none` becomes Pi's `off` | previous guess, which maps `xhigh` and `max` |
| `opper.capabilities` or `capabilities` containing `reasoning` | `reasoning` | `true` |

## Narrowing a large list

A gateway can list over a thousand models. Registering all of them makes `/model` unusable, so a
provider can filter what registers:

```json
"discover": { "require": ["opper.gdpr_residency=EU"], "pricing": true, "refreshMinutes": 10 }
```

| Key | Meaning |
|---|---|
| `require` | `dotted.path=value` predicates, all of which must match. Case-insensitive; an array on the path matches when any element matches, so `opper.capabilities=tools` reads as "the model can use tools". A path the endpoint does not report rejects the model, so a filter that stops matching fails the provider with a message naming the predicate instead of quietly registering nothing. |
| `pricing` | `false` registers the provider as free even when the endpoint reports prices, for a host whose prices are display-only or in another currency. |
| `refreshMinutes` | How long a fetched list is reused inside one Pi process. Default 10. The startup fetch already blocks, so `session_start` would otherwise fetch the same list again seconds later. `/model-context-refresh` ignores this. |

## Commands

```
/model-context
```

A menu listing every provider that has a `baseUrl` or `modelsUrl`, each marked `on` or `off`. Picking
one flips its `discoverModels` flag in `models.json` and registers or unregisters that provider
immediately - no restart needed. The menu stays open so several providers can be changed in one go,
and offers a refresh action. The write is surgical: only the flag's value token changes, or one
member line is inserted, so hand-chosen layout, inline objects and comments survive. The previous
copy is kept as `models.json.bak`.

```
/model-context-refresh
```

Re-reads `models.json` and re-fetches every discovery provider, reporting one line per provider with
how many models it registered and how many it skipped.

```
/model-context-list [provider]
```

Two scrollable picks - provider, then model - and one notification with what the endpoint reported
for that model: display name, context window, max output, input modalities and the URL it came from.
This is where the per-model detail lives; the discovery lines themselves only give counts. Passing
the provider id skips the first pick. The list is whatever the last successful fetch saw, so
`/model-context-refresh` first if a server has changed since the session started.

## Behaviour and limits

- **Discovery reports counts, never a dump.** An aggregator can list hundreds of models, and one line
  per model buries everything else in the terminal. A provider gets a count of what registered and a
  count per reason for what did not:

  ```
  pi-model-context: aggregator: 446 model(s) from https://aggregator.example/v1/models
  pi-model-context: aggregator: 56 model(s) skipped: no context window reported
  pi-model-context: aggregator: 446 model(s) report no output limit; using 65536 (pin "maxTokens" in models.json to change it)
  ```

  `/model-context-list` is the way in to the individual models.

- **No cache file.** There is nothing to go stale and no fingerprint to invalidate. The cost is
  that startup performs one request per discovery provider; an unreachable endpoint costs up to
  10 seconds each and reports one error line instead of hanging. Within one process a fetched list
  is reused for `discover.refreshMinutes` (default 10), so a session does not fetch again at
  `session_start`.
- A failed refresh keeps the last list it registered and warns, rather than emptying `/model`.
- Thinking levels come from the endpoint when it names them, so a route without `xhigh` is not offered
  `xhigh`, and a level the endpoint does not name is never offered. Pi's `off` is sent as the endpoint's
  own `none` token when it names one; without that mapping `off` sends no reasoning value and a model
  that thinks by default keeps thinking. An endpoint that names no levels gets `xhigh` and `max` mapped
  as before; for a model that rejects them, set them to `null` per id with `modelOverrides` in
  `models.json`.
- A registered price is what Pi's cost display, and `budget-routing`'s meter, multiply tokens
  against. A gateway that bills at provider rates with no markup is therefore metered accurately. A
  model missing a price on either side is registered unpriced rather than half-priced.
- `PI_MODELS_JSON` overrides the `models.json` path (default `~/.pi/agent/models.json`).

## Develop

```sh
npm install
npm run typecheck
npm test
```
