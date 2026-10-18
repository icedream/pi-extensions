# pi-slot-sharing

Lets several Pi sessions take turns on a server that holds **one** conversation at a time.

Works with Strata and with llama.cpp. The save/restore API is llama.cpp's own, and Strata implements it
(`serve/server.py`: *"llama-server's POST /slots/{id}?action=save|restore"*), so "slot" is the word both
servers use for the thing being shared. See [Backends](#backends) for what they share and where they
differ.

A server started with a slot save path can write the conversation the engine is holding out to a file and
read it back (`POST /slots/0?action=save|restore`). Reading it back is much cheaper than re-prefilling
it. Measured on Qwen3.8-Flash-Next IQ3_S, int8 KV, 393,216 position context:

| | 107,695 tokens |
|---|---|
| save | 561 ms |
| restore | 6,804 ms |
| re-prefill instead | 64,500 ms |
| next request after restore | 107,690 of 107,695 prompt tokens reused |

So the extension saves this session's conversation when it gives up the slot and restores it before the
next request, and arbitrates through a lock file so concurrent Pi processes do not decide against each
other. When a conversation is too large to bring back, it says so and lets the request re-prefill — the
session still works, it just pays what it would have paid anyway.

The same round trip on llama.cpp b10920 with a 260K test model, after a different prompt had evicted the
slot: save 377 tokens, restore 377 tokens, and the next identical request reported `cache_n 373,
prompt_n 1`.

Every figure quoted in this file comes from **one reference machine**: RX 7900 XTX (gfx1100), 62 GiB of
system RAM, Qwen3.8-Flash-Next IQ3_S at int8 KV with a 393,216 position context. They are worked examples
of the arithmetic, not constants — `/slot-sharing` prints the figures for the server you are actually
running, and the extension learns them from that server rather than assuming them.

## Install

From the repository root:

```sh
pi install $(pwd)/pi-slot-sharing
```

Then create `~/.pi/agent/slot-sharing.json` (see below) and run `/reload`. Without a config file the
extension does nothing.

## Server side

Two things have to be true of the server; the extension checks both and stays quiet if either fails.

- **A slot save path must be configured.** On Strata it is a top-level key in the server config, not an
  engine argument: `"slot_save_path": "/data/sessions"`. Passing `--slot-save-path` to the Strata engine
  makes the engine refuse to start. On llama.cpp it is the other way round: the `--slot-save-path PATH`
  engine flag.
- **One slot.** With several live slots the server is already serving sessions concurrently and there is
  nothing to take turns over, so the extension stands down. On Strata that means no `--batch` /
  `--slots` (the server answers 501 for save/restore under parallel requests). On llama.cpp it means
  `-np, --parallel N` must be 1 — see [Backends](#backends).

## Backends

The backend is detected from `/props`: `build_info` reads `"Strata 0.1.44"` on one and `"b10850-6e09de1b4"`
on the other. There is nothing to state.

| | Strata | llama.cpp |
|---|---|---|
| save/restore endpoint | `POST /slots/0?action=save\|restore` | same — it is llama.cpp's API |
| response fields | `n_saved`/`n_written`, `n_restored`/`n_read` | identical |
| feature off | 501 | 501 (`ERROR_TYPE_NOT_SUPPORTED` → `format_error_response` → 501) |
| capability probe | works | works — `post_slots` checks `slot_save_path.empty()` before the action, verified against a live server started without the flag |
| context, model, version | `/v1/status`, `/metrics` | `/props` |
| KV type | `/metrics` `engine.kv` | not reported over HTTP |
| engine start time | `/v1/status` `started` | not reported — a restart cannot be noticed, failures are handled instead |
| server RAM | `/v1/status` `machine.ram` | not reported |
| refuses a restore it cannot hold | **yes** — the gate applies | **no** — no admission check exists, so the restore is attempted and the failure handled |
| several slots at once | refuses save/restore with `--batch` | `-np N`, and per-request `id_slot` |

### llama.cpp router mode

With `--models-preset`, one process fronts one child server per model. Two things follow, and the extension
handles both:

- **Slot routes must name the model.** The router answers `GET /props` itself with a synthetic payload — no
  `total_slots`, `n_ctx` 0 — and refuses `GET /slots` or `POST /slots/0` with *"model name is missing from
  the request"* unless the model is given: `?model=` on GET, `"model"` in the body on POST. The extension
  takes the name from `ctx.model.id`; the router resolves aliases to canonical names itself.
- **Naming a model loads it.** Router autoload is on by default, so a slot call naming a non-resident model
  would start a multi-minute load. Every router call carries `autoload=false`: if the model is not resident
  the call fails, the session re-prefills, and nothing waited on a load the extension started. `GET /props`
  is asked the same way, so the real `n_ctx` and `total_slots` come from the child when the model is loaded
  and stay unknown when it is not.

Verified against a live router with nothing resident: detection reported `llama.cpp` in router mode, the
capability probe reached the slot route, and a save returned *"model is not loaded"* rather than *"model
name is missing"* — the model parameter was honoured — with 0 of 27 models loaded afterwards.

llama.cpp with `-np N` is the better answer to "three sessions on one server" when the VRAM fits N
contexts — no extension involved. b10920 also has `--kv-unified-per-slot N`, which sizes a shared KV pool
to `n_parallel*N` with a per-slot limit. This extension is for the case where there is only room for one.

## Config

Path: `~/.pi/agent/slot-sharing.json`, or the file in `PI_SLOT_SHARING_CONFIG`. Start from
[slot-sharing.example.json](slot-sharing.example.json).

The rule for this file: **if the server can be asked, the extension asks.** No key is required — an empty
object is a working config. What is in here is only what no server can be asked for.

| Key | Required | Meaning |
|-----|----------|---------|
| `ramFloorMib` | no | The engine's `--conversation-cache-min-free-mib`. Strata 0.1.44 reports it on `/metrics`, so this is only needed for a server that does not, or to keep more headroom than the engine asks for. When stated it wins; otherwise the server's figure, and failing that 2560 (Strata's own default). Strata backend only |
| `marginMib` | no | Extra headroom beyond the floor. Default 256. Covers our own allocations and the gap between `MemAvailable` and the `used/total` pair the server reports |
| `bytesPerTokenFallback` | no | Assumed bytes/token until a save reports `n_written` / `n_saved`. Default 16896 (int8 KV). Only used for reporting, never to decide a restore |
| `maxSessionTokens` | no | Refuse to swap a session larger than this at all — no save, and no restore of a file that big. A save writes roughly `tokens × KV-bytes-per-token` to disk, so on a server with no RAM gate this is the only brake. Default: unlimited, though a Strata restore is still refused by the RAM gate |
| `saveEveryTurns` | no | Save after every N agent runs. Default 1 |
| `lockStaleMs` | no | A lock older than this, held by a process that is gone, is taken over. Default 120000 |
| `lockWaitMs` | no | How long to wait for another session's lock before giving up on a save or restore. The winner holds it across one HTTP call — seconds for a large restore — and waiting is far cheaper than the re-prefill a skipped swap costs. Default 10000 |
| `enabled` | no | Master switch. Default true |
| `providers` | no | Per-provider overrides, keyed by the model's provider name. Each block starts from the top level and replaces only what it names — see [Per-provider settings](#per-provider-settings) |

### Per-provider settings

The numbers in this file describe one server, not the extension. A Strata engine at 393,216 positions with
int8 KV and a llama.cpp server at 160k with `q8_0` KV have different RAM floors and different restore
ceilings, so `providers` keys off `ctx.model.provider` and overrides per provider:

```json
{
  "ramFloorMib": 2560,
  "marginMib": 256,
  "providers": {
    "icedream-homepc/strata": { "marginMib": 512 },
    "lab/llamacpp": { "ramFloorMib": 0, "maxSessionTokens": 60000 }
  }
}
```

Each block inherits the top level and replaces only what it names, so a provider that differs in one number
states one number. An unlisted provider gets the top level, and `/slot-sharing` reports which block applied.
A bad value inside a block is reported as `providers.<name>.<key>`, not as a bare key.

State (index, owner record, lock) lives in `~/.pi/agent/slot-sharing/`, override with
`PI_SLOT_SHARING_STATE`. The session files themselves live on the server.

## Credentials

**Nothing to configure.** The slot API is authenticated by the same token the model's requests carry, and
Pi already holds it, so the extension asks Pi: `ctx.modelRegistry.getApiKeyAndHeaders(model)` returns the
key and headers the provider is configured with — from `models.json`, from the environment, or an OAuth
credential with its refresh handled. The extension never sees where it came from and never stores it.

Keeping a second copy in the extension's own config would be a second thing to rotate, a second file to
keep out of git, and a second place to be stale after a rotation — and it could not refresh an expiring
credential at all.

There is no credential to configure and no fallback to set up. If the model's provider has no credential,
the extension says so rather than failing silently, and `/slot-sharing` reports what it found.

Credentials are resolved per model, so switching model re-resolves them; a provider that cannot
authenticate is reported with Pi's own error text.

## What is read from the server
| Value | Source |
|-------|--------|
| Context size | `/v1/status` `context.max_positions`, `/metrics` `engine.max_context` |
| Model, engine version, KV type | `/metrics` `engine.model`, `.version`, `.kv` |
| Slot count | `/props` `total_slots` |
| RAM floor for a restore | `/metrics` `engine.conversation_cache_min_free_mib` (Strata 0.1.44); `ramFloorMib` overrides it |
| Engine start time (restart = slot state lost) | `/v1/status` `started` |
| Server RAM | `/v1/status` `machine.ram.used_gib` / `total_gib` |
| Whether save/restore is switched on | probed: `POST /slots/0?action=capability` answers 501 when off, 400 when on. No file is written either way |
| Bytes per token of a session file | learned from the first save's `n_written` / `n_saved` |

When the server is on the loopback interface, free RAM is read from `/proc/meminfo` `MemAvailable` —
the exact number the engine's own guard reads. Otherwise the extension falls back to the server's
`total - used`. Those two figures differ in **either** direction, not a predictable one — measured 37 MiB
apart on the reference machine, with `total - used` the more optimistic of the two. That gap is what
`marginMib` exists to absorb; it is not a claim that the fallback is safe on its own. If the server is
local but reached through a LAN address (as Pi's provider entry often is), the fallback is what runs.
llama.cpp reports neither figure, which is why it has no gate to fall back on at all.

## The RAM gate

A restore is not free of RAM, and this is the part that decides whether the feature works at all on a
given machine. Strata's own arithmetic, mirrored in [sessions.ts](sessions.ts) and applied only by the
Strata backend:

```
peak(file)  = file + 16 MiB + (file / 16 MiB + 1) * 4096 + 1 MiB
admitted    = available >= peak + floor
```

The floor is the engine's `--conversation-cache-min-free-mib`. Strata 0.1.44 reports it on `/metrics`, so
nothing has to be stated; `ramFloorMib` in the config overrides it when a server does not report one, or
when you want to keep more headroom than the engine asks for. With neither, the default is Strata's own
2560.

A save needs none of that — it streams out in 16 MiB blocks — which is why saves succeed at sizes where
restores are refused. That asymmetry has a cost of its own: an uncapped save writes a file you may never
be able to read back, onto a disk that has to hold it. `maxSessionTokens` stops the write as well as the
read, using the size the server reports on `GET /slots`. Two consequences worth knowing:

- **The outgoing conversation is not released first.** The engine reads the new file, and only afterwards
  drops the K/V it was holding. So the RAM available is whatever the *current* conversation leaves.
- **File size is what to shrink, not the floor.** At int8 KV a session file costs about 16.1 KB per
  token, so a 256K conversation needs about 4.1 GiB free on top of the floor. Whether that is available
  depends entirely on what the machine has already committed to the model and the live conversation: on
  the 62 GiB reference machine it is not, no floor setting makes it fit, and restores stop working around
  190–220K tokens. A machine with more free RAM reaches further, and `/slot-sharing` prints the ceiling
  for yours. `--kv k8v4` moves the ceiling by shrinking the file, at a quality cost on long documents
  that has not been measured.

`/slot-sharing` prints the current figure: how much is free, how many tokens a restore could bring
back at that moment, and whether this session's context window is larger than that.

## Commands

| Command | What it does |
|---------|--------------|
| `/slot-sharing` | Server figures, gate math, who holds the slot, what is saved for whom |
| `/slot-sharing-forget` | Drop this session's saved conversation from the index |

## When a saved conversation stops being usable

The file is a snapshot of one conversation on one engine configuration. The extension marks it stale,
and re-prefills instead of reading it, after:

- compaction, a fork, or moving in the session tree — the transcript changed underneath it
- a model switch — a file is refused by a differently configured engine
- another process took the slot and this session's copy is gone from it
- a save was refused because the slot was not holding this session's conversation (see below)

An engine restart does **not** invalidate a file: session files survive restarts, and the extension
re-reads `started` to notice the restart happened.

## Limits

- **A save writes whatever the engine is holding.** The owner record says who meant to use the slot last,
  not what is in it, and the server queues a `save` behind whatever request is already running. So a save
  can capture another session's conversation. The extension checks the size the server reports on
  `GET /slots` against the size this session's last request had (`usage.input + cacheRead + cacheWrite +
  output` of its final assistant message) and refuses the save when the two cannot be the same
  conversation, marking the record instead. A run that was aborted or failed reports no usage, so it saves
  nothing. A llama.cpp server started without `--slots` reports no slot size, and the check fails open.
- **One slot.** Sessions take turns, they do not run concurrently. A server reporting more than one slot
  is left alone: it is already serving sessions at once.
- **On llama.cpp there is nothing to predict.** It has no RAM admission check, so a restore that will not
  fit is discovered by it failing, not by the extension declining. And with no `started` figure, an
  engine restart is noticed only through a failed restore.
- **The lock is cooperation, not enforcement.** It arbitrates between Pi processes on one machine that
  use this extension. Another client hitting the API directly can still take the slot; the extension
  notices at the next save and marks its record stale rather than writing someone else's conversation
  out under this session's name.
- **Contention is expected and quiet.** Several sessions reaching their next turn at the same moment
  means one of them waits for another's save or restore to finish, up to `lockWaitMs`. If the wait runs
  out the swap is skipped and the note says so at info level — the request prefills as it would have
  anyway, and no error is raised. A lock whose holder is gone is taken over once `lockStaleMs` passes.
- **Session files on HIP/AMD are not exercised upstream.** Strata's own notes say the Windows engine, HIP
  and AMD cards have not been run for session files. A transfer failure after the device writes began
  ends the engine. Saves and restores were verified working on an RX 7900 XTX (gfx1100) at 37K, 108K and
  283K tokens, but treat the first large save on a new setup as the risky one.
- **Restore throughput degrades with size**, and not linearly: 1.10 GB/s at 37K tokens against
  0.276 GB/s at 108K on the reference machine. Cause not established. Budget the time accordingly.
