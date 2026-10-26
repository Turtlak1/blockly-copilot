(() => {
  'use strict';

  if (window.__groqBlocklyContentInstalledV1) return;
  window.__groqBlocklyContentInstalledV1 = true;

  const REQUEST_SOURCE = 'groq-blockly-extension';
  const BRIDGE_SOURCE = 'groq-blockly-bridge';
  const BRIDGE_WAIT_MS = 2500;
  const BRIDGE_COMMAND_TIMEOUT_MS = 45000;
  const STATUS_TIMEOUT_MS = 10000;

  const TOOL_COMMANDS = Object.freeze({
    getBlocklyWorkspaceState: 'getState',
    addBlockToWorkspace: 'addBlock',
    createVariable: 'createVariable',
    createProcedure: 'createProcedure',
    editBlockInWorkspace: 'editBlock',
    deleteBlockFromWorkspace: 'deleteBlock',
    clearWorkspace: 'clearWorkspace'
  });

  const pendingBridgeRequests = new Map();
  const bridgeReadyWaiters = new Set();
  let bridgeReady = false;

  function makeId() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch {
      // Fall through.
    }
    return `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  function makeError(code, message, details) {
    const error = new Error(message);
    error.code = code || 'BLOCKLY_CONTENT_ERROR';
    if (details !== undefined) error.details = details;
    return error;
  }

  function publicError(error) {
    const result = {
      code: error && error.code ? String(error.code) : 'BLOCKLY_CONTENT_ERROR',
      message: error && error.message ? String(error.message) : 'The page bridge failed.'
    };
    if (error && error.details !== undefined) result.details = error.details;
    return result;
  }

  function postToBridge(payload) {
    try {
      window.postMessage({ source: REQUEST_SOURCE, ...payload }, '*');
    } catch {
      // The page may be navigating.
    }
  }

  function markBridgeReady() {
    if (bridgeReady) return;
    bridgeReady = true;
    for (const waiter of Array.from(bridgeReadyWaiters)) {
      try {
        waiter();
      } catch {
        // Ignore.
      }
    }
    bridgeReadyWaiters.clear();
  }

  function waitForBridge(timeoutMilliseconds = BRIDGE_WAIT_MS) {
    if (bridgeReady) return Promise.resolve();

    postToBridge({ type: 'PING' });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        bridgeReadyWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        bridgeReadyWaiters.delete(finish);
        reject(makeError(
          'BRIDGE_UNAVAILABLE',
          'The Blockly page bridge did not respond. The extension may need to be refreshed on this tab.'
        ));
      }, Math.max(250, timeoutMilliseconds));

      bridgeReadyWaiters.add(finish);
    });
  }

  function callBridge(command, args, timeoutMilliseconds = BRIDGE_COMMAND_TIMEOUT_MS) {
    return waitForBridge(BRIDGE_WAIT_MS).then(() => new Promise((resolve, reject) => {
      const id = makeId();
      const timer = setTimeout(() => {
        pendingBridgeRequests.delete(id);
        reject(makeError(
          'BRIDGE_TIMEOUT',
          'The Blockly page did not respond in time. The editor may be busy or the page may be frozen.'
        ));
      }, Math.max(1000, timeoutMilliseconds));

      pendingBridgeRequests.set(id, { resolve, reject, timer });
      postToBridge({
        type: 'TOOL_REQUEST',
        id,
        command,
        args: args && typeof args === 'object' && !Array.isArray(args) ? args : {}
      });
    }));
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== BRIDGE_SOURCE) return;

    if (data.type === 'READY' || data.type === 'PONG') {
      markBridgeReady();
      return;
    }

    if (data.type !== 'TOOL_RESULT' || typeof data.id !== 'string') return;
    const pending = pendingBridgeRequests.get(data.id);
    if (!pending) return;

    markBridgeReady();
    clearTimeout(pending.timer);
    pendingBridgeRequests.delete(data.id);

    if (data.ok) {
      pending.resolve(data.result);
    } else {
      const bridgeError = data.error && typeof data.error === 'object' ? data.error : {};
      pending.reject(makeError(
        bridgeError.code || 'BLOCKLY_TOOL_ERROR',
        bridgeError.message || 'The Blockly tool failed.',
        bridgeError.details
      ));
    }
  });

  function getPageInfo() {
    return {
      url: String(location.href || ''),
      title: String(document.title || ''),
      topFrame: window.top === window
    };
  }

  async function handleStatus() {
    await waitForBridge(BRIDGE_WAIT_MS);
    const status = await callBridge('status', {}, STATUS_TIMEOUT_MS);
    return {
      ok: true,
      bridgeReady: true,
      page: getPageInfo(),
      status
    };
  }

  async function handleExecuteTool(message) {
    const name = typeof message.name === 'string' ? message.name : '';
    const command = TOOL_COMMANDS[name];
    if (!command) {
      throw makeError('UNKNOWN_TOOL', `Unknown Blockly tool: ${name || '(missing name)'}`);
    }

    const args = message.args === undefined ? {} : message.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw makeError('INVALID_TOOL_ARGUMENTS', 'Tool arguments must be a JSON object.');
    }

    await waitForBridge(BRIDGE_WAIT_MS);
    const result = await callBridge(command, args, BRIDGE_COMMAND_TIMEOUT_MS);
    return { ok: true, result };
  }

  async function handleUndo() {
    await waitForBridge(BRIDGE_WAIT_MS);
    const result = await callBridge('undo', {}, 25000);
    return { ok: true, result };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!sender || sender.id !== chrome.runtime.id) return false;
    if (!message || typeof message !== 'object') return false;

    if (message.type === 'GROQ_BLOCKLY_PING') {
      if (!bridgeReady) postToBridge({ type: 'PING' });
      sendResponse({
        ok: true,
        bridgeReady,
        page: getPageInfo()
      });
      return false;
    }

    if (message.type === 'GROQ_BLOCKLY_GET_STATUS') {
      handleStatus()
        .then((response) => sendResponse(response))
        .catch((error) => {
          sendResponse({ ok: false, error: publicError(error), page: getPageInfo() });
        });
      return true;
    }

    if (message.type === 'GROQ_BLOCKLY_EXECUTE_TOOL') {
      handleExecuteTool(message)
        .then((response) => sendResponse(response))
        .catch((error) => {
          sendResponse({ ok: false, error: publicError(error) });
        });
      return true;
    }

    if (message.type === 'GROQ_BLOCKLY_UNDO') {
      handleUndo()
        .then((response) => sendResponse(response))
        .catch((error) => {
          sendResponse({ ok: false, error: publicError(error) });
        });
      return true;
    }

    return false;
  });

  // Give the page bridge a chance to handshake as soon as the content script
  // is ready. This also covers programmatic injection into already-open tabs.
  postToBridge({ type: 'PING' });
})();
