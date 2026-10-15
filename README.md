# Icedream's Pi extensions

This is the repository where I maintain my own extensions for Pi coding agent.

While I personally use these, I only currently maintain them as I need to work with them during regular work. Respectively, documentation may be lacking, minimal or even non-existent unless I consider an extension useful enough for general public use.

## Extensions

| Extension | Description |
|-----------|-------------|
| [pi-symbol-index](pi-symbol-index/) | Builds and exposes a symbol index for Go projects via `gopls` |
| [budget-routing](budget-routing/) | Monthly spend cap for one provider: nudges, prepares, and diverts light subagents to a local model |
| [pi-model-context](pi-model-context/) | Discovers models with the context window and input modalities the endpoint actually reports |
| [pi-slot-sharing](pi-slot-sharing/) | Lets several Pi sessions take turns on a single-sequence Strata or llama.cpp server by saving and restoring the server's slot conversation, gated on the RAM the server has free |

