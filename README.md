# browser-mcp

`browser-mcp` is a small browser-runtime MCP server for coding agents. It connects directly to a Chrome DevTools Protocol (CDP) endpoint and exposes eight high-level tools instead of mirroring the very large CDP API.

## Tools

| Tool | Purpose |
| --- | --- |
| `get_pages` | List tabs, refresh the default to the focused page, and begin console/network capture |
| `inspect_page` | Return a compact, bounded DOM tree |
| `inspect_element` | Inspect one CSS-selected element, its box and computed style |
| `pick_element` | Highlight the page and block until the user clicks a visually referenced element |
| `evaluate` | Evaluate JavaScript, await promises, and test runtime mutations |
| `screenshot` | Return a viewport or full-page image to the agent |
| `get_console` | Read buffered console events or wait for the next matching event |
| `get_network` | Read buffered requests or wait for the next matching request |

All potentially large outputs have hard limits. Network output intentionally excludes headers such as `Authorization` and `Cookie`.

## Requirements

- Node.js 22 or newer
- Chrome, Chromium, or Chrome for Testing with a CDP HTTP endpoint
- Cursor or another MCP client that supports stdio servers

Chrome 136 and newer ignore `--remote-debugging-port` for the normal Chrome profile. Use a separate `--user-data-dir`, which is also the safer way to give an agent runtime access.

## Install and build

```bash
npm install
npm run build
```

The ordinary settings are at the top of [`src/config.ts`](src/config.ts). The CDP endpoint defaults to `http://127.0.0.1:9222`; set `BROWSER_CDP_URL` only when a different local endpoint is needed.

## Start Chrome with CDP

Close or leave your ordinary Chrome untouched, then start a separate debugging profile.

macOS:

```bash
open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir=/tmp/browser-mcp-profile
```

Linux:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/browser-mcp-profile
```

Windows PowerShell:

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\browser-mcp-profile"
```

Open `http://127.0.0.1:9222/json/list` to verify that Chrome is exposing tabs.

## Configure Cursor

Create or edit `.cursor/mcp.json` in the project that should use the tools. Replace the path with the absolute path to this project.

```json
{
  "mcpServers": {
    "browser-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/browser-mcp/dist/server.js"],
      "env": {
        "BROWSER_CDP_URL": "http://127.0.0.1:9222"
      }
    }
  }
}
```

Restart or reload Cursor after changing the configuration. Cursor CLI users can verify the registration with `agent mcp list-tools browser-mcp`.

## Suggested agent flow

The server sends model-facing instructions with its MCP initialization response. They tell the agent to treat the user as an active debugging partner and use page-runtime or two-phase coordination instead of guessing. No workflow depends on the client rendering an input or confirmation form.

For element work:

1. `get_pages`
2. `inspect_page` when the target is already identifiable
3. For phrases such as “this logo”, the agent tells the user what to click and calls `pick_element({ interaction_prompt: "Click the logo you mean · Esc to cancel" })`
4. The browser page displays that instruction, highlights hovered elements, and waits for a click
5. The same tool call returns the clicked element's selector, tag, text, box, and clipped HTML; Escape cancels
6. `inspect_element`, `evaluate`, and `screenshot` can then analyze, test, and verify the change

`get_pages` refreshes the default page on every call. It prefers the page for which `document.hasFocus()` is true and `visibilityState` is `visible`; if Chrome reports no focused page, it falls back to the first current `/json/list` page. Passing `page_id` targets only that tool call and never changes the default. Call `get_pages` again after the user opens or switches tabs when subsequent calls will omit `page_id`.

For a network action:

1. `get_pages`
2. The agent calls `get_network({ capture_action: "start" })` and retains the signed `captureId`
3. The agent tells the user in ordinary chat exactly what browser action to perform; the page displays a green capture-active banner
4. After the user reports completion, the agent calls `get_network({ capture_action: "finish", capture_id: "...", ...filters })`
5. The finish call returns only requests whose event sequence began after the start boundary

The same start/chat/finish transaction works for console output with `get_console`. Results include `startedAt`, `finishedAt`, and per-event sequence numbers. Filters are evaluated on the finish call, so repeat the desired filters there.

The older `wait_for_next` mode remains available when the desired endpoint is one specific event rather than a user-confirmed capture window. `wait_until` controls whether a network wait ends when the request starts, its response arrives, or loading finishes.

Calling `pick_element` without `interaction_prompt` uses the default page banner. Supplying it changes only the banner text; both paths use the same blocking page-runtime picker. A client's tool-permission prompt merely authorizes execution and is not treated as interaction completion. For less common DOM events, `evaluate` can install a one-shot event listener and return a Promise that resolves after the user action.

Console and network capture begin when `get_pages` (or the first page-specific tool) attaches to the tab. They cannot reconstruct events that Chrome no longer has after a disconnected session.

## v0.5.0 boundaries

- Direct CDP-over-WebSocket connection only. Chrome 144's consent-based `--autoConnect` flow for attaching to an ordinary running profile is not implemented in this version.
- The main frame and open shadow roots are inspectable. Cross-origin iframe contents require a later multi-target implementation.
- `get_network` returns metadata, not response bodies or WebSocket frames.
- `pick_element` waits up to two minutes; click an element or press Escape.
- `evaluate` is intentionally powerful and can mutate the page or read data available to page JavaScript. Use a dedicated debugging profile.

## Development

```bash
npm test
```

The test suite covers the MCP tool catalog, CDP command/event transport, output limits, selector interpolation safety, and an end-to-end fake-CDP flow through all eight runtime operations.

## References

- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [Chrome 136 remote-debugging profile change](https://developer.chrome.com/blog/remote-debugging-port)
- [Chrome 144 consent-based active-session connection](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Cursor MCP documentation](https://cursor.com/docs/mcp)
