# pi-symbol-index

A Pi coding agent extension that builds and exposes a **symbol index** for Go projects. Uses `gopls` via the **LSP protocol** to accurately extract definitions and references.

## What it does

When the model works on a Go project, it often needs to find:
- Where a symbol is **defined** (function, struct, interface)
- Where a symbol is **used** (call/reference locations)
- A **high-level overview** of the project

Without this extension, the model has to read multiple source files, grep manually, or hallucinate. **pi-symbol-index replaces all of that with structured data.**

## Registered tools

### `pi_symbol_build`

Builds the symbol index by:
1. Spawning `gopls serve` in the current project
2. Scanning Go files
3. Querying `textDocument/documentSymbol` for definitions
4. Querying `textDocument/references` for usages
5. Writing the index to `.pi-index/symbols.json`

### `pi_symbol_info(name)`

Looks up a symbol across the project. Returns:
- File location
- Line range
- Container type
- Usages (where it's referenced)

### `pi_project_symbols()`

Shows a high-level summary of:
- Files scanned
- Symbol counts by file
- Types and functions found

## Architecture

```
Extension → vscode-jsonrpc → gopls serve (LSP)
                      ↘ index.ts/symbols.json (persisted)
```

- Uses `vscode-jsonrpc` for stdio transport (no raw protocol)
- Uses `vscode-languageserver-types` for LSP data structures
- gopls `serve` spawns a new subprocess per build
- `TextDocument/documentSymbol` + `textDocument/references` are the two key LSP methods used
- Error-tolerant: gopls responses like "no identifier found" are handled silently

## Dependencies

| Package | Version | Role |
|---------|---------|------|
| `vscode-jsonrpc` | ^9.0.1 | LSP JSON-RPC over stdio (StreamMessageReader/Writer) |
| `vscode-languageserver-types` | ^3.18.0 | LSP type definitions (DocumentSymbol, Location) |
| `@sinclair/typebox` | ^0.34.4 | Tool parameter schemas |
| `@earendil-works/pi-coding-agent` | ^0.1.0 | `ExtensionAPI` type |

## Development

```bash
# In pi-symbol-index/
npm install

# Run unit tests
npx tsx test.test.ts

# Test with a Go project
cd /path/to/go-project
timeout 90 pi -p 'Run pi_symbol_build. Then run pi_project_symbols.'
```

## Limitations / known issues

- `session_start` event has no `cwd`, so auto-build on session start doesn't work without a `go.mod` detection
- References may fail for symbols gopls doesn't fully resolve yet
- Only built for Go — TypeScript would need a similar typescript-language-server integration

## Future work (Phase 2)

- [ ] TypeScript/JavaScript support via `typescript-language-server`
- [ ] Add `pi_replace_block` tool (the replacement that removes the `oldText` requirement)
- [ ] Add duplicate detection / hash-based identification of code blocks
- [ ] Add session-keepalive (reuse gopls connection across multiple sessions)
