# AGENTS.md

Practical guide for AI agents working on this codebase.

## Repository Overview

Manifest V3 Chrome Extension that injects an AI assistant into any page running Google Blockly (including Scratch GUI and React wrappers). It connects to Groq's chat completions API with tool/function calling to inspect, build, and modify Blockly workspaces with snapshot-based undo.

## Architecture & Boundary Rules

- **`manifest.json`**: MV3, min Chrome 116+. Uses dual content scripts:
  - `main-world.js` runs in `world: "MAIN"` at `document_start` to interact directly with page JavaScript (`Blockly`, `ScratchBlocks`, React fibers).
  - `content.js` runs in `world: "ISOLATED"` at `document_idle` as the RPC bridge between `background.js` and `main-world.js`.
- **Security Boundaries**:
  - API keys and user settings are stored in `chrome.storage.local` with `AccessLevel: TRUSTED_CONTEXTS`.
  - Content scripts and `main-world.js` cannot read `chrome.storage`. Raw API keys are never passed to the page or DOM.
  - Conversation histories live in `chrome.storage.session`, keyed by `tabId`.
- **Inter-context Messaging**:
  - `background.js` <-> `content.js`: `chrome.tabs.sendMessage`.
  - `content.js` <-> `main-world.js`: `window.postMessage` tagged with channel `'groq-blockly-bridge'`, verified request IDs, and window source checking.
- **Blockly Workspace Detection Order** (in `main-world.js`):
  1. `window.__groqBlocklyWorkspace` (opt-in explicit workspace)
  2. `Blockly.getMainWorkspace()` / `Blockly.common.getMainWorkspace()` / `Blockly.mainWorkspace` / `Blockly.workspace`
  3. `Blockly.common.getAllWorkspaces()` / `Blockly.Workspace.getAll()` / `Blockly.WorkspaceSvg.getAll()` / `Blockly.Workspace.WorkspaceDB_` (filtered by `isUsableWorkspace` to reject flyouts/mutators)
  4. Common page globals: `window.workspace`, `window.mainWorkspace`, `window.blocklyWorkspace`, `window.ws`, `window.editor`, `window.mcblockly`, `window.app`, etc.
  5. DOM & Component Tree Inspection:
     - Direct element properties on `#blocklyDiv`, `.blocklyDiv`, `.injectionDiv`, `.blocklySvg`, `.blocklyWorkspace` (`element.workspace`, `element.__blocklyWorkspace`, etc.)
     - Vue 3 component tree (`__vueParentComponent` -> `setupState.workspace`, `ctx`, `proxy`, `data`, unwrapping `Ref` / `shallowRef`)
     - Vue 2 component tree (`__vue__` -> `workspace`, `ws`, `$data`)
     - React component tree (`__reactFiber$*` / `__reactInternalInstance$*` / `__reactContainer$*` -> `stateNode.workspace`, `memoizedProps`, and `memoizedState` hooks linked list for `useRef` / `useState`)
     - Svelte component tree (`__svelte`)
  6. SVG `<g class="blocklyWorkspace" id="...">` ID lookup in discovered Blockly namespaces
  7. Global Window Property Scanner: inspects non-builtin `window.*` properties and 1-level deep object paths for workspaces and Blockly namespaces
  8. Same-origin `<iframe>` inspection (`iframe.contentWindow.Blockly`, `iframe.contentWindow.workspace`)
  9. Namespace fallbacks: `window.Blockly`, `window.ScratchBlocks`, `window.blockly`, component-discovered namespaces, scanned global namespaces, `window.__groqBlockly`
- **Undo & Mutation Safety**:
  - `addBlockToWorkspace` and `clearWorkspace` require safe XML snapshot support (`Blockly.Xml.workspaceToDom`).
  - If a mutation fails mid-operation, the snapshot is automatically restored.
  - Users can undo the last AI modification via the popup/side-panel button.
- **MCP Bridge**:
  - `mcpServerEnabled` is stored in `chrome.storage.local` and defaults to `false`.
  - The background polls `http://127.0.0.1:8765` only while the setting is on; disabling clears the timer and aborts the in-flight request.
  - The setting is exposed in the extension Settings panel and saved immediately.
- **Groq API Quirks**:
  - `llama-3.3-70b-versatile` was decommissioned on August 16, 2026. The default model is `openai/gpt-oss-120b` (user-configurable in Settings).
  - When returning tool call results to Groq, the role is `"tool"` with `"tool_call_id"` and JSON string `"content"`. Do not include a `"name"` field in tool response messages.

## Verification & Development Commands

- **Syntax & type validation**:
  ```bash
  deno check background.js content.js main-world.js popup.js
  # or
  node --check background.js && node --check content.js && node --check main-world.js && node --check popup.js
  ```
- **Manifest validation**:
  ```bash
  deno eval "const m=JSON.parse(Deno.readTextFileSync('manifest.json')); console.log('MV' + m.manifest_version, m.version);"
  ```
- **Loading into Chrome**:
  - Go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select this repository directory.
