# webtools-mcp

A zero-dependency Bun MCP server that gives an agent website-interaction
tools. Mounted in this machine's DSH layer (`~/.dsh/cordis.patch.yml`) as
plugin id `mcp-webtools`, so tools land as `mcp__webtools__<name>` in every
new session.

## Tools

| Tool | Purpose |
|---|---|
| `web_get` | Fetch a URL; HTML becomes readable markdown/text (raw with `format:"html"`). JSON is pretty-printed. Non-2xx bodies are returned, not thrown. |
| `web_search` | DuckDuckGo lite search, no API key. Returns ranked `{title,url,snippet}`; GET first, POST retry. |
| `web_links` | Unique absolute links on a page, optional case-insensitive regex filter over URL+text. |
| `http_request` | Generic method/headers/body (JSON or raw) for APIs and form posts. Cookies are not persisted. |
| `web_download` | Streamed file download to an absolute path, 200 MB cap, refuses overwrite unless `overwrite:true`. |

## Run

```sh
bun server.ts          # stdio MCP server (newline-delimited JSON-RPC)
bun test lib.test.ts   # unit tests: converter, links, DDG parsing
bun smoke.ts           # end-to-end: spawns the server, exercises all five tools live
```

## Mount / unmount

The plugin row lives at the bottom of `~/.dsh/cordis.patch.yml`
(`id: mcp-webtools`). Remove that block and start a new session to unmount.
Tools appear in NEW sessions only — no host restart needed.

## Extending

Add a tool by appending one entry to `TOOLS` in server.ts
(name + description + JSON Schema `inputSchema` + async `run(args)`); it is
picked up automatically by `tools/list`. Keep stdout protocol-pure: logs go
through `log()` (stderr). Reusable page-processing logic belongs in lib.ts
with unit tests in lib.test.ts.

## Known limits

- HTTP-level interaction only — no JavaScript execution, clicks, or cookies.
  For JS-heavy sites use a headless browser (e.g. Playwright) as a future tool.
- The extractor is a single-pass tokenizer tuned for readability, not
  rendering fidelity; complex layouts may lose some structure.
