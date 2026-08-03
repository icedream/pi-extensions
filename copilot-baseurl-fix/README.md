# copilot-baseurl-fix

Fixes GitHub Copilot Business/Enterprise compaction failures (421 / "Connection error").

## What it does

When using GitHub Copilot Business or Enterprise plans, `/compact` fails with:
- **Enterprise**: `421 Misdirected Request`
- **Business**: `Connection error` (underlying `RequestContentLengthMismatchError`)

This extension patches `globalThis.fetch` to rewrite the endpoint from the default individual host to the correct seat-specific host, read dynamically from your token.

## Root cause

Pi's summarization path for compaction sends requests to `api.individual.githubcopilot.com` regardless of the user's actual seat type. The endpoint rejects or drops the request because the token doesn't match.

The fix was introduced in commit `9993c969` (v0.80.8) which moved Copilot endpoint resolution into per-request auth — but the summarization path only forwards the token and loses the resolved URL.

## Usage

1. Copy `index.ts` to `~/.pi/agent/extensions/copilot-baseurl-fix.ts`
2. Run `/reload` in Pi

Or clone the repo and symlink:

```bash
ln -s /path/to/copilot-baseurl-fix/index.ts ~/.pi/agent/extensions/copilot-baseurl-fix.ts
```

## How it works

The extension:
1. Reads `~/.pi/agent/auth.json` on each request (so token refreshes are picked up)
2. Extracts the `proxy-ep` field from the GitHub Copilot token
3. Rewrites the host from `api.individual.githubcopilot.com` → `api.{plan}.githubcopilot.com`

## Known limitations

- Patches `globalThis.fetch` globally — could affect other processes (limited in practice since it only rewrites the specific endpoint)
- Synchronously reads `auth.json` on each fetch call
- Only handles the Business/Enterprise seat mismatch — other Copilot issues are out of scope

## Credits

Forked from [evillase's comment](https://github.com/earendil-works/pi/issues/6768#issuecomment-5172433814) on the upstream issue.

## Related

- Upstream issue: [earendil-works/pi#6768](https://github.com/earendil-works/pi/issues/6768)
- Upstream fix (PR): [Marvae/fix/copilot-summarization-base-url](https://github.com/earendil-works/pi/compare/main...Marvae:fix/copilot-summarization-base-url)
- Workaround: [NitroAshi's models.json approach](https://github.com/earendil-works/pi/issues/6768#issuecomment-5099452465)
