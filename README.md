# Icedream's Pi extensions

This is the repository where I maintain my own extensions for Pi coding agent.

While I personally use these, I only currently maintain them as I need to work with them during regular work. Respectively, documentation may be lacking, minimal or even non-existent unless I consider an extension useful enough for general public use.

## Extensions

The badge on each row says how much of my own work the extension has carried. ![Daily driver][daily-badge] means it runs in my daily sessions and its behaviour has held up there. ![Experimental][experimental-badge] means it is recent, or has not yet seen enough deep use to be trusted: expect the design to change, and expect less documentation.

| Extension | Status | Description |
|-----------|--------|-------------|
| [budget-routing](budget-routing/) | ![Daily driver][daily-badge] | Monthly spend cap for one provider: nudges, prepares, and diverts light subagents to a local model |
| [pi-model-context](pi-model-context/) | ![Daily driver][daily-badge] | Discovers models with the context window and input modalities the endpoint actually reports |
| [pi-slot-sharing](pi-slot-sharing/) | ![Daily driver][daily-badge] | Lets several Pi sessions take turns on a single-sequence Strata or llama.cpp server by saving and restoring the server's slot conversation, gated on the RAM the server has free |
| [pi-symbol-index](pi-symbol-index/) | ![Experimental][experimental-badge] | Builds and exposes a symbol index for Go projects via `gopls` |
| [pi-thinking-hygiene](pi-thinking-hygiene/) | ![Experimental][experimental-badge] | Drops a reasoning model's recited "this is only a system-prompt setup" blocks from the prompt so they cannot seed the next turns |
| [pi-mcp-hygiene](pi-mcp-hygiene/) | ![Experimental][experimental-badge] | Rewords the MCP adapter's "I'll respond to your prompts" UI notice in tool results, so an adapter status line does not read as a first-person voice in the model's context |
| [pi-skill-reminder](pi-skill-reminder/) | ![Experimental][experimental-badge] | Names the skills a session already read after a compaction, so the next turn applies them instead of re-reading them |

pi-symbol-index is demoted from daily driver rather than newly written. `symbol_index_build` can hang a session outright when Pi was launched outside the project it should scan, and the models driving it have not taken to the tools often enough to depend on them. Tracked in [#31](https://github.com/icedream/pi-extensions/issues/31).

[daily-badge]: https://img.shields.io/badge/daily%20driver-%20?style=flat-square&color=44bb00
[experimental-badge]: https://img.shields.io/badge/experimental-%20?style=flat-square&color=feb042

