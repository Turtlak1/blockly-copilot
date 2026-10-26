# Blockly Copilot

A Chrome extension that puts a Groq-, Google Gemini-, or OpenRouter-powered AI assistant next to a live Google Blockly workspace. It can inspect and modify the workspace, create named Scratch procedures/functions with typed arguments and bodies, create custom/global/local variables, add or edit blocks, delete individual blocks, serialize the workspace to XML or JSON, clear the workspace with a confirmation, and undo the last AI edit. Assistant replies are rendered as safe Markdown.

The assistant runs in a side panel (or the toolbar popup), while the extension talks to Blockly through a small bridge in the page.

## Requirements

- Chrome 116 or newer (the extension uses the side panel API and MAIN-world content scripts).
- A Groq API key from [console.groq.com/keys](https://console.groq.com/keys), a Google AI API key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey), or an OpenRouter API key from [openrouter.ai/keys](https://openrouter.ai/keys).
- A page that exposes a Blockly workspace. The page does not need any special integration when Blockly is a normal global script.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this directory.
4. Pin **Blockly Copilot** to the toolbar if desired.
5. Open the extension, go to **Settings**, choose Groq, Google Gemini, or OpenRouter, and save the corresponding API key.
6. Open a page with a Blockly editor and start chatting.

There is no build step. Everything is plain JavaScript and HTML.

## OpenCode MCP bridge

The extension can expose its Blockly tools to OpenCode through a local MCP
bridge. The bridge uses standard MCP over stdio for OpenCode and localhost
HTTP only between the bridge and the extension. The extension still performs
all page access through its existing content-script and main-world security
boundary; API keys are not exposed to MCP.

The bridge is **off by default**. Enable **MCP server bridge** in the extension
Settings; the change is saved immediately. While it is off, the extension makes
no requests to the local bridge at `127.0.0.1:8765`. Turn it on only when you
are running the bridge and want MCP clients to control the active Blockly tab.

Start the bridge with Node:

```bash
node ./mcp-server.js
```

Add it to the OpenCode MCP configuration as a local command (use an absolute
path for the repository):

```json
{
  "mcp": {
    "blockly-copilot": {
      "type": "local",
      "command": ["node", "/home/turtlak/Projects/groq-blockly-extension/mcp-server.js"]
    }
  }
}
```

Keep the Blockly page active in Chrome. MCP calls are executed against the
currently active tab. The supported MCP tools are
`getBlocklyWorkspaceState`, `addBlockToWorkspace`, `createVariable`,
`createProcedure`, `editBlockInWorkspace`, `deleteBlockFromWorkspace`, and
`clearWorkspace`.

## Using the assistant

Open the extension from the toolbar or open it in the side panel with the panel button. The side panel stays visible while you edit Blockly.

Example requests:

- "What is on my Blockly workspace?"
- "Add a repeat block that prints Hello ten times."
- "Give me the workspace as XML."
- "Clear the workspace." The assistant asks Blockly to clear only when the request is explicit; the operation requires `confirm: true` internally.
- "Undo the last AI edit." You can also use the **Undo AI edit** button.

The assistant has five tools:

For edits, the assistant should send one complete JSON payload to
`addBlockToWorkspace`: use nested `inputs` for value/statement inputs and
`next` for connected statement chains. Its optional `blocks` array accepts
several top-level block specifications in execution order and chains them
through compatible `next` connections.

Workspace snapshots also include a `blockCatalog`. For each usable toolbox
block it provides the exact type, field names and values/options, input names,
input kinds (`value-input` or `statement-input`), connection checks, and
whether the block supports previous, next, or output connections. It also
includes visible named and unnamed argument labels, block tooltips, and
example text when the custom Blockly implementation exposes them. The AI uses
this catalog instead
of guessing custom Blockly block arguments such as player and message.

| Tool | Purpose |
| --- | --- |
| `getBlocklyWorkspaceState` | Reads workspace metadata, a compact block tree, toolbox block types, and optionally XML/JSON serialization. |
| `addBlockToWorkspace` | Creates a block tree with `workspace.newBlock(type)` and supports fields, nested inputs, `next` connections, and optional coordinates. |
| `editBlockInWorkspace` | Updates field values on an existing block by ID without deleting or re-adding it. |
| `deleteBlockFromWorkspace` | Removes one block by ID after taking a snapshot. |
| `clearWorkspace` | Deletes blocks, variables, and comments after an XML snapshot. Requires `confirm: true`. |

`createProcedure` accepts a name, string/boolean arguments, an optional body block tree, and an optional call block. `createVariable` supports global and local Scratch variables; `addBlockToWorkspace` can also create variables before constructing a block tree.

The AI edit loop runs in the background service worker: the selected provider
returns a tool call, the background forwards it to the content script, the
content script forwards it to the page bridge, and the tool result is sent
back to the selected provider. After each tool round, the extension waits a
random 1–3 seconds and explicitly asks the provider to continue. The agent
allows up to 512 tool rounds per request, subject to the selected model's
context limits. This avoids
an immediate burst of follow-up requests, especially with Google Gemini.

## Chat rendering

Assistant messages support a safe subset of Markdown: headings, bold, italic, strikethrough, inline code, fenced code blocks, links, ordered and unordered lists (including nested lists), blockquotes, tables, and horizontal rules. User messages stay plain text. The renderer creates DOM nodes directly and only allows `http:`, `https:`, and `mailto:` links, so raw HTML, images, and `javascript:` URLs are not injected into the page.

## Provider requests and rate limits

The extension does **not** poll a provider or make automatic requests when a popup, side panel, or tab opens. A provider request happens only when you send a message or press **Test connection**.

When the current page identifies itself as **MCBlockly**, the assistant adds
Minecraft-specific guidance to its prompt: use `send_message` for the current
player, `broadcast` for every player, use the exact block types exposed by
MCBlockly, and connect compatible event/action/condition blocks into complete
scripts.

To keep a normal prompt from consuming several API calls:

- A fresh, compact workspace snapshot is read locally from the page and appended to the system context before the first Groq request. The model normally does not need a separate `getBlocklyWorkspaceState` round trip.
- Requests are paced so rapid tool rounds do not form a burst.
- An HTTP 429 is **not retried automatically**. The extension records the server's `Retry-After` delay (or a 30-second default cooldown), stops sending requests for that period, and shows a message such as “Groq rate limit reached. Try again in 20s.” The cooldown is shared by every tab and stored locally so a background-worker restart does not forget it.
- Further messages during the cooldown fail immediately without contacting Groq.
- Temporary server/network failures may still be retried a small number of times with backoff.

## Models

The default Groq and OpenRouter model is **`openai/gpt-oss-120b`** and the default Google model is **`gemini-3.8-flash`**. The model, temperature, and maximum output tokens are editable in Settings. OpenRouter model discovery uses the API response's `data[].id` values and keeps only models whose `supported_parameters` include `tools`, because Blockly edits require tool calling.

While a request is running, the activity status shows elapsed time and any
token usage reported by the provider. Completed assistant messages retain the
request duration and input/output/total token counts. Google requests do not
have an artificial generation timeout; pressing **Stop** still cancels the
active request. If Chrome restarts the extension service worker during a
long-running request, the pending prompt is recovered and retried for the
selected tab instead of being immediately shown as interrupted.

Groq retired **`llama-3.3-70b-versatile`** for standard accounts on **August 16, 2026**, so it is not the default. If your Groq account still exposes it, you can enter its ID manually, but a current tool-calling model is recommended. The model must support function/tool calling.

Validate a model ID with the **Test connection** button, which lists whether your account can see the configured model.

## API key security

- Provider API keys are stored with `chrome.storage.local`.
- At service-worker startup the extension calls `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`, so content scripts cannot read extension storage.
- Keys are read only by the background service worker. They are never placed in page scope, the Blockly bridge, chat messages, or the DOM after saving.
- Requests go only to `https://api.groq.com/...`, `https://generativelanguage.googleapis.com/...`, or `https://openrouter.ai/...`.
- Chat history is stored in `chrome.storage.session`, keyed by tab, and is not synced. Clearing the browser session clears it.
- Storage is not encrypted at rest. Anyone with access to your Chrome profile or developer tools can inspect extension storage.
- The page owns its Blockly runtime and receives bridge requests in its MAIN world. A hostile page can observe or forge those requests, but it never receives the API key. Treat untrusted pages accordingly.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Save the API key, model selection, rate-limit cooldown, and per-tab session history. |
| `sidePanel` | Keep the assistant open beside the Blockly editor. |
| `scripting` | Inject the bridge/content scripts into tabs that were already open when the extension was installed or reloaded. |
| `<all_urls>` | Blockly can run on any website, so the bridge needs to be available on all pages. |
| `https://api.groq.com/*` | Call the Groq API. |
| `https://generativelanguage.googleapis.com/*` | Call the Google Gemini API. |
| `https://openrouter.ai/*` | Call the OpenRouter API. |

The extension does not inject scripts into browser-owned pages (`chrome://...`, the Chrome Web Store, and similar pages), and those pages will show as inaccessible.

## How Blockly is detected

The bridge uses a multi-tier universal detection pipeline in `main-world.js`:

1. `window.__groqBlocklyWorkspace`, an explicit opt-in global.
2. `Blockly.getMainWorkspace()` / `Blockly.common.getMainWorkspace()` / `Blockly.mainWorkspace` / `Blockly.workspace`.
3. `Blockly.common.getAllWorkspaces()` / `Blockly.Workspace.getAll()` / `Blockly.WorkspaceSvg.getAll()` / `Blockly.Workspace.WorkspaceDB_` (filtered to usable, rendered workspaces).
4. Common workspace globals on `window` (`workspace`, `mainWorkspace`, `blocklyWorkspace`, `ws`, `editor`, `mcblockly`, `app`, etc.).
5. DOM and Component Framework Inspection:
   - Direct properties on DOM elements (`#blocklyDiv`, `.blocklyDiv`, `.injectionDiv`, `.blocklySvg`, `.blocklyWorkspace`, `[class*="blockly"]`).
   - **Vue 3**: inspects `__vueParentComponent` across component ancestors, unwrapping `shallowRef` / `ref` in `setupState`, `ctx`, `proxy`, and `data`.
   - **Vue 2**: inspects `__vue__` and `$parent` hierarchy for `workspace`, `ws`, and `$data`.
   - **React**: inspects `__reactFiber$*`, `__reactInternalInstance$*`, and `__reactContainer$*` traversing fiber hierarchies for `stateNode.workspace`, `memoizedProps`, and hook states (`useState` / `useRef` linked list).
   - **Svelte**: inspects `__svelte` component properties.
6. SVG `<g class="blocklyWorkspace" id="...">` ID lookup in discovered Blockly namespaces.
7. Safe global window scanner: inspects custom `window.*` properties and 1-level deep object paths for workspaces and Blockly namespaces.
8. Same-origin `<iframe>` inspection (`iframe.contentWindow.Blockly`, `iframe.contentWindow.workspace`).
9. Namespace fallbacks: `window.Blockly`, `window.ScratchBlocks`, `window.blockly`, component-discovered namespaces, and `window.__groqBlockly`.

Normal UMD pages, modern ES module bundlers (Vite, Webpack), Vue/React/Svelte apps (including MCBlockly and Scratch GUI), and same-origin embedded iframes are automatically detected. Scratch is a special case: its `window.Blockly` only exposes `Blockly.Msg`, while the full `ScratchBlocks` namespace and the main workspace live in the React component state; the bridge reads those directly.

If your application bundles Blockly as an ES module and keeps it out of global scope, expose the namespace and workspace explicitly:

```js
window.__groqBlockly = Blockly;
window.__groqBlocklyWorkspace = workspace;
```

Exposing both is recommended because editing safety needs `Blockly.Xml.workspaceToDom` (or the equivalent XML API) for snapshots and undo. A workspace that exposes only the workspace object can still be inspected, but edit operations are refused when a safe snapshot cannot be created.

Detection starts in the top frame and can inspect same-origin iframes. A Blockly editor inside a cross-origin iframe is not reachable from the top frame.

## Safety and undo

- `addBlockToWorkspace` snapshots the workspace before mutating it. If block creation or rendering fails, the extension restores the snapshot.
- `clearWorkspace` refuses to run without `confirm: true` and snapshots the entire workspace first.
- The last AI edit can be undone once through the **Undo AI edit** button. The snapshot lives in the page's memory, so navigating away clears it.
- Undo restores the whole workspace snapshot. If you manually change the workspace after an AI edit, undo also replaces those manual changes. The button's tooltip states this.
- Read-only Blockly workspaces and workspaces without XML snapshot support are not edited.
- Page content, block text, comments, and tool output are treated as untrusted data in the system prompt. They are still sent to Groq as part of the request.

## Limitations

- Cross-origin iframes are not accessible. Same-origin iframe detection is best-effort.
- Blockly instances hidden inside a module scope, a shadow root, or a canvas-only custom renderer without exposed XML APIs may only be partially supported.
- Toolbox type extraction is best-effort. Dynamic/custom toolboxes may fall back to the global block registry.
- XML/JSON state and tool results are capped in size. Responses with `truncated: true` contain only the first portion; ask for a summary in that case.
- The assistant cannot execute page code, access arbitrary page variables, or use Blockly's native undo history across reloads.
- Provider API keys are billing credentials. Keep them private and rotate them if exposed.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3 configuration and content-script declarations. |
| `main-world.js` | Runs in the page MAIN world; detects Blockly, serializes state, creates blocks, snapshots, clears, and undoes. |
| `content.js` | Isolated-world RPC between the background worker and the page bridge. |
| `background.js` | Settings/key isolation, Groq requests, tool-call loop, per-tab conversations, and port protocol. |
| `popup.html` / `popup.js` | Side panel and popup chat UI. |
| `icons/` | Extension icon and generated PNG sizes. |

## Troubleshooting

**"No Blockly workspace"** — Wait for the editor to finish loading, then click the workspace status chip to refresh. If the app is an ES module, expose `window.__groqBlocklyWorkspace` and `window.__groqBlockly`.

**"Page not accessible"** — Chrome blocks extensions on `chrome://` pages, the Chrome Web Store, and some internal pages. Open a normal website.

**"The page bridge did not start"** — Refresh the tab. If the page was already open before installation, the background worker will try to inject the scripts, but a refresh is the most reliable fix.

**"Groq rejected the API key"** — Open Settings, paste a fresh key, use **Test connection**, then save.

**A model fails to call tools** — Choose a Groq model that explicitly supports tool/function calling. `openai/gpt-oss-120b` is the default.

## Development

- No dependencies or build step. Edit the files and reload the extension at `chrome://extensions`.
- `node --check background.js content.js main-world.js popup.js` checks syntax.
- The bridge can be exercised on a local Blockly fixture with `chrome.tabs.sendMessage` from the service worker, using the `GROQ_BLOCKLY_*` message types.
- The expected Groq endpoint is `https://api.groq.com/openai/v1/chat/completions`. The key-validation endpoint is `https://api.groq.com/openai/v1/models`.
