# pi-model-context

Discovers models for `models.json` providers marked `"discoverModels": true`, and registers them
with the **context window and input modalities the endpoint actually reports**.

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
| `apiKey` | Literal, `$NAME`, `${NAME}`, `$$`, `$!`. A leading `!command` is refused for discovery requests. |

`models.json` values for a model override what discovery reports, so a context window pinned by
hand survives every refresh.

## What is read from `GET /models`

| Field | Used for | Fallback |
|---|---|---|
| `id` | Model id | entry skipped if missing |
| `name` | Display name | `id` |
| `meta.n_ctx`, `n_ctx`, `context_window`, `contextWindow`, `max_model_len` | `contextWindow` | **none** - the model is skipped |
| `meta.n_predict`, `max_tokens`, `maxTokens` | `maxTokens` | 65,536, clamped to the context window, with a notice |
| `architecture.input_modalities` | `input` | `["text"]` |
| `architecture.output_modalities` containing `decisions` | classifier marker | entry skipped with a notice |

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
  10 seconds each and reports one error line instead of hanging.
- A failed refresh keeps the last list it registered and warns, rather than emptying `/model`.
- `reasoning` is registered as `true` and `thinkingLevelMap` maps `xhigh` and `max`, so those
  levels appear in `/thinking`. For a model that rejects them, set them to `null` per id with
  `modelOverrides` in `models.json`.
- `PI_MODELS_JSON` overrides the `models.json` path (default `~/.pi/agent/models.json`).

## Develop

```sh
npm install
npm run typecheck
npm test
```
