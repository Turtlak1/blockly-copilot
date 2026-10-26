(() => {
  'use strict';

  const PORT_NAME = 'groq-blockly-assistant';
  const DEFAULT_MODEL = 'openai/gpt-oss-120b';
  const STATUS_TIMEOUT_MS = 25000;
  const REQUEST_TIMEOUT_MS = 15000;

  const elements = {
    connectionLabel: document.getElementById('connectionLabel'),
    newChatBtn: document.getElementById('newChatBtn'),
    panelBtn: document.getElementById('panelBtn'),
    settingsBtn: document.getElementById('settingsBtn'),
    workspaceChip: document.getElementById('workspaceChip'),
    workspaceDot: document.getElementById('workspaceDot'),
    workspaceText: document.getElementById('workspaceText'),
    undoBtn: document.getElementById('undoBtn'),
    chatScroll: document.getElementById('chatScroll'),
    emptyState: document.getElementById('emptyState'),
    setupHint: document.getElementById('setupHint'),
    setupKeyBtn: document.getElementById('setupKeyBtn'),
    messages: document.getElementById('messages'),
    activity: document.getElementById('activity'),
    activityText: document.getElementById('activityText'),
    notice: document.getElementById('notice'),
    noticeText: document.getElementById('noticeText'),
    noticeClose: document.getElementById('noticeClose'),
    composer: document.getElementById('composer'),
    prompt: document.getElementById('prompt'),
    sendBtn: document.getElementById('sendBtn'),
    stopBtn: document.getElementById('stopBtn'),
    pageLabel: document.getElementById('pageLabel'),
    modelLabel: document.getElementById('modelLabel'),
    settingsPanel: document.getElementById('settingsPanel'),
    settingsScroll: document.getElementById('settingsScroll'),
    closeSettingsBtn: document.getElementById('closeSettingsBtn'),
    apiKey: document.getElementById('apiKey'),
    googleApiKey: document.getElementById('googleApiKey'),
    openRouterApiKey: document.getElementById('openRouterApiKey'),
    providerInput: document.getElementById('providerInput'),
    toggleKeyBtn: document.getElementById('toggleKeyBtn'),
    keyStatus: document.getElementById('keyStatus'),
    saveSettingsBtn: document.getElementById('saveSettingsBtn'),
    testBtn: document.getElementById('testBtn'),
    removeKeyBtn: document.getElementById('removeKeyBtn'),
    modelInput: document.getElementById('modelInput'),
    modelOptions: document.getElementById('modelOptions'),
    temperatureInput: document.getElementById('temperatureInput'),
    maxTokensInput: document.getElementById('maxTokensInput'),
    openPanelBtn: document.getElementById('openPanelBtn'),
    doneSettingsBtn: document.getElementById('doneSettingsBtn'),
    toast: document.getElementById('toast')
  };

  let port = null;
  let reconnectTimer = null;
  let activeTabId = null;
  let chatState = null;
  let appSettings = {
    provider: 'groq',
    hasApiKey: false,
    hasGroqApiKey: false,
    hasGoogleApiKey: false,
    hasOpenRouterApiKey: false,
    model: DEFAULT_MODEL,
    defaultModel: DEFAULT_MODEL,
    temperature: 0.2,
    maxTokens: 2048,
    availableModels: []
  };
  let workspaceState = { kind: 'checking', message: 'Checking page...' };
  let pendingRequests = new Map();
  let sending = false;
  let savingSettings = false;
  let testingConnection = false;
  let statusRequestSequence = 0;
  let toastTimer = null;
  let noticeTimer = null;
  let settingsOpen = false;
  let modelDirty = false;
  let lastRunning = false;
  let lastShownAuthErrorAt = 0;
  let activityTimer = null;

  function makeId() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch {
      // Fall through.
    }
    return `ui_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  function setConnectionLabel(text) {
    elements.connectionLabel.textContent = text;
  }

  function updateConnectionLabel() {
    if (!port) {
      setConnectionLabel('Reconnecting to extension...');
    } else if (!appSettings.hasApiKey) {
      setConnectionLabel(`Add a ${appSettings.provider === 'google' ? 'Google AI' : appSettings.provider === 'openrouter' ? 'OpenRouter' : 'Groq'} key to start`);
    } else {
      setConnectionLabel(`${appSettings.provider === 'google' ? 'Google Gemini' : appSettings.provider === 'openrouter' ? 'OpenRouter' : 'Groq'} Blockly assistant`);
    }
  }

  function connectPort() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (port) return;

    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
    } catch {
      port = null;
      scheduleReconnect();
      return;
    }

    port.onMessage.addListener(handlePortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      rejectAllPending(new Error('The extension background disconnected. Reconnecting...'));
      showNotice('Reconnecting to the extension...', false);
      updateConnectionLabel();
      scheduleReconnect();
    });

    setNoticeHidden();
    updateConnectionLabel();
    if (activeTabId) {
      port.postMessage({ type: 'hello', tabId: activeTabId });
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectPort();
      if (activeTabId && port) port.postMessage({ type: 'hello', tabId: activeTabId });
    }, 500);
  }

  function rejectAllPending(error) {
    for (const entry of pendingRequests.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pendingRequests.clear();
  }

  function request(type, payload = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!port) {
        reject(new Error('The extension is reconnecting. Try again in a moment.'));
        return;
      }

      const requestId = makeId();
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error('The request timed out. Try again.'));
      }, Math.max(1000, timeoutMs));

      pendingRequests.set(requestId, { resolve, reject, timer });

      try {
        port.postMessage({ type, requestId, ...payload });
      } catch (error) {
        clearTimeout(timer);
        pendingRequests.delete(requestId);
        reject(new Error('Could not reach the extension background.'));
      }
    });
  }

  function handlePortMessage(message) {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'response') {
      const pending = pendingRequests.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingRequests.delete(message.requestId);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        const errorInfo = message.error && typeof message.error === 'object' ? message.error : {};
        const error = new Error(errorInfo.message || 'The request failed.');
        error.code = errorInfo.code || 'REQUEST_FAILED';
        if (errorInfo.details !== undefined) error.details = errorInfo.details;
        pending.reject(error);
      }
      return;
    }

    if (message.type === 'settings') {
      if (message.settings) {
        const wasKeySet = appSettings.hasApiKey;
        appSettings = { ...appSettings, ...message.settings };
        renderSettings();
        updateConnectionLabel();
        if (wasKeySet !== appSettings.hasApiKey) updateSetupHint();
      }
      return;
    }

    if (message.type === 'state') {
      if (message.tabId !== activeTabId) return;
      const wasRunning = lastRunning;
      const previousMessages = chatState && chatState.messages;
      const messageSignature = (items) => Array.isArray(items)
        ? items.map((item) => `${item && item.role}:${item && item.at}:${item && item.content}`).join('|')
        : '';
      const onlyRunStateChanged = Boolean(
        chatState
        && message.running
        && previousMessages
        && message.messages
        && messageSignature(message.messages) === messageSignature(previousMessages)
      );
      if (message.settings) {
        appSettings = { ...appSettings, ...message.settings };
      }
      chatState = message;
      lastRunning = Boolean(message.running);
      if (onlyRunStateChanged) {
        renderActivity();
        renderComposerState();
        updateLiveToolCalls();
      } else {
        renderAll();
      }
      if (wasRunning && !lastRunning) {
        void refreshStatus();
      }
      return;
    }

    if (message.type === 'hello') {
      setNoticeHidden();
      updateConnectionLabel();
    }
  }

  async function refreshActiveTab(forceStatus = false) {
    let tab = null;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = tabs && tabs.length ? tabs[0] : null;
    } catch {
      tab = null;
    }

    if (!tab || typeof tab.id !== 'number') {
      const changed = activeTabId !== null;
      activeTabId = null;
      if (changed) {
        chatState = null;
        lastRunning = false;
        workspaceState = { kind: 'unavailable', message: 'No active tab' };
        if (port) port.postMessage({ type: 'hello', tabId: null });
        renderAll();
      }
      return;
    }

    if (tab.id !== activeTabId) {
      activeTabId = tab.id;
      chatState = null;
      lastRunning = false;
      workspaceState = { kind: 'checking', message: 'Checking page...' };
      renderAll();
      if (port) port.postMessage({ type: 'hello', tabId: activeTabId });
      await refreshStatus();
    } else if (forceStatus) {
      await refreshStatus();
    }
  }

  async function refreshStatus() {
    if (!activeTabId) {
      workspaceState = { kind: 'unavailable', message: 'No active tab' };
      renderWorkspaceStatus();
      return;
    }

    const requestedTabId = activeTabId;
    const sequence = ++statusRequestSequence;
    workspaceState = { kind: 'checking', message: 'Checking page...' };
    renderWorkspaceStatus();

    try {
      const result = await request('status', { tabId: requestedTabId }, STATUS_TIMEOUT_MS);
      if (sequence !== statusRequestSequence || requestedTabId !== activeTabId) return;
      const status = result && result.status ? result.status : null;
      const page = result && result.page ? result.page : null;

      if (status && status.found === true) {
        workspaceState = {
          kind: 'found',
          data: status,
          page,
          message: status.hint || 'Ready'
        };
      } else {
        workspaceState = {
          kind: 'notfound',
          data: status,
          page,
          message: (status && status.hint) || 'No Blockly workspace detected on this page.'
        };
      }
      renderWorkspaceStatus();
    } catch (error) {
      if (sequence !== statusRequestSequence || requestedTabId !== activeTabId) return;
      const code = error && error.code ? error.code : '';
      const unavailable = code === 'PAGE_NOT_ACCESSIBLE'
        || code === 'CONTENT_SCRIPT_UNAVAILABLE'
        || code === 'BRIDGE_UNAVAILABLE'
        || code === 'NO_TAB'
        || code === 'TAB_CLOSED';
      workspaceState = {
        kind: 'unavailable',
        message: unavailable
          ? (error.message || 'This page does not allow extension scripts.')
          : (error.message || 'Could not read the workspace status.')
      };
      renderWorkspaceStatus();
    }
  }

  function renderAll() {
    renderMessages();
    renderActivity();
    renderComposerState();
    renderWorkspaceStatus();
    renderSettings();
    updateSetupHint();
    updateConnectionLabel();
  }

  const MAX_MARKDOWN_CHARS = 30000;
  const MAX_MARKDOWN_DEPTH = 8;

  function renderMarkdown(container, text) {
    const source = typeof text === 'string' ? text : '';
    const clipped = source.length > MAX_MARKDOWN_CHARS
      ? `${source.slice(0, MAX_MARKDOWN_CHARS)}\n\n_Message truncated for display._`
      : source;
    const lines = clipped.replace(/\r\n?/g, '\n').split('\n');
    const fragment = document.createDocumentFragment();
    appendMarkdownBlocks(fragment, lines, 0, 0);
    container.replaceChildren(fragment);
  }

  function appendMarkdownBlocks(parent, lines, startIndex, depth) {
    let index = startIndex;
    while (index < lines.length) {
      if (isMarkdownBlank(lines[index])) {
        index += 1;
        continue;
      }

      const fence = parseMarkdownFence(lines, index);
      if (fence) {
        parent.appendChild(fence.element);
        index = fence.nextIndex;
        continue;
      }

      const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[index]);
      if (heading) {
        const headingElement = document.createElement(`h${heading[1].length}`);
        appendInlineMarkdown(headingElement, heading[2], 0);
        parent.appendChild(headingElement);
        index += 1;
        continue;
      }

      if (/^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(lines[index])) {
        parent.appendChild(document.createElement('hr'));
        index += 1;
        continue;
      }

      if (/^\s{0,3}>\s?/.test(lines[index])) {
        const quote = parseMarkdownBlockquote(lines, index, depth);
        parent.appendChild(quote.element);
        index = quote.nextIndex;
        continue;
      }

      if (matchMarkdownListLine(lines[index])) {
        const list = parseMarkdownList(lines, index, depth);
        if (list) {
          parent.appendChild(list.element);
          index = list.nextIndex;
          continue;
        }
      }

      if (isMarkdownTableStart(lines, index)) {
        const table = parseMarkdownTable(lines, index);
        parent.appendChild(table.element);
        index = table.nextIndex;
        continue;
      }

      const paragraphStart = index;
      while (
        index < lines.length &&
        !isMarkdownBlank(lines[index]) &&
        !isMarkdownBlockStart(lines, index)
      ) {
        index += 1;
      }
      if (index === paragraphStart) {
        index += 1;
        continue;
      }

      const paragraph = document.createElement('p');
      appendInlineMarkdown(paragraph, lines.slice(paragraphStart, index).join('\n'), 0);
      parent.appendChild(paragraph);
    }
  }

  function matchMarkdownFenceStart(line) {
    const match = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)?.*$/.exec(line);
    if (!match) return null;
    return {
      marker: match[1][0],
      length: match[1].length,
      language: match[2] || ''
    };
  }

  function parseMarkdownFence(lines, startIndex) {
    const start = matchMarkdownFenceStart(lines[startIndex]);
    if (!start) return null;

    const content = [];
    let index = startIndex + 1;
    while (index < lines.length) {
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(lines[index]);
      if (close && close[1][0] === start.marker && close[1].length >= start.length) {
        index += 1;
        break;
      }
      content.push(lines[index]);
      index += 1;
    }

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    if (start.language && /^[A-Za-z0-9_+.-]+$/.test(start.language)) {
      code.className = `language-${start.language}`;
    }
    code.textContent = content.join('\n');
    pre.appendChild(code);
    return { element: pre, nextIndex: index };
  }

  function parseMarkdownBlockquote(lines, startIndex, depth) {
    const quoteLines = [];
    let index = startIndex;
    while (index < lines.length) {
      const match = /^\s{0,3}>\s?(.*)$/.exec(lines[index]);
      if (!match) break;
      quoteLines.push(match[1]);
      index += 1;
    }

    const blockquote = document.createElement('blockquote');
    if (depth >= MAX_MARKDOWN_DEPTH) {
      blockquote.textContent = quoteLines.join('\n');
    } else {
      appendMarkdownBlocks(blockquote, quoteLines, 0, depth + 1);
    }
    return { element: blockquote, nextIndex: index };
  }

  function matchMarkdownListLine(line) {
    const match = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/.exec(line);
    if (!match) return null;
    return {
      indent: match[1].length,
      ordered: /^\d/.test(match[2]),
      content: match[3]
    };
  }

  function parseMarkdownList(lines, startIndex, depth) {
    const first = matchMarkdownListLine(lines[startIndex]);
    if (!first) return null;

    const baseIndent = first.indent;
    const ordered = first.ordered;
    const list = document.createElement(ordered ? 'ol' : 'ul');
    let index = startIndex;

    while (index < lines.length) {
      const match = matchMarkdownListLine(lines[index]);
      if (!match || match.indent !== baseIndent || match.ordered !== ordered) break;

      const item = document.createElement('li');
      const contentLines = [match.content];
      const nestedElements = [];
      index += 1;

      while (index < lines.length) {
        if (isMarkdownBlank(lines[index])) {
          let lookahead = index + 1;
          while (lookahead < lines.length && isMarkdownBlank(lines[lookahead])) lookahead += 1;
          const nextMatch = lookahead < lines.length
            ? matchMarkdownListLine(lines[lookahead])
            : null;
          if (nextMatch && nextMatch.indent === baseIndent && nextMatch.ordered === ordered) {
            index = lookahead;
            break;
          }
          if (
            lookahead < lines.length &&
            leadingWhitespaceLength(lines[lookahead]) > baseIndent
          ) {
            contentLines.push('');
            index = lookahead;
            continue;
          }
          break;
        }

        const nextMatch = matchMarkdownListLine(lines[index]);
        if (nextMatch) {
          if (nextMatch.indent > baseIndent && depth < MAX_MARKDOWN_DEPTH) {
            const nested = parseMarkdownList(lines, index, depth + 1);
            if (nested) {
              nestedElements.push(nested.element);
              index = nested.nextIndex;
              continue;
            }
          }
          if (nextMatch.indent > baseIndent) {
            contentLines.push(nextMatch.content);
            index += 1;
            continue;
          }
          break;
        }

        const indent = leadingWhitespaceLength(lines[index]);
        if (indent <= baseIndent) break;
        contentLines.push(lines[index].slice(Math.min(indent, baseIndent + 2)));
        index += 1;
      }

      appendInlineMarkdown(item, contentLines.join('\n'), 0);
      for (const nestedElement of nestedElements) item.appendChild(nestedElement);
      list.appendChild(item);
    }

    return { element: list, nextIndex: index };
  }

  function isMarkdownTableStart(lines, index) {
    if (index + 1 >= lines.length) return false;
    const header = lines[index];
    const separator = lines[index + 1];
    if (!header.includes('|') || !separator.includes('|')) return false;
    return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(separator);
  }

  function parseMarkdownTable(lines, startIndex) {
    const headerCells = splitMarkdownTableRow(lines[startIndex]);
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const cellText of headerCells) {
      const th = document.createElement('th');
      appendInlineMarkdown(th, cellText, 0);
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    let index = startIndex + 2;
    while (index < lines.length && !isMarkdownBlank(lines[index]) && lines[index].includes('|')) {
      const cells = splitMarkdownTableRow(lines[index]);
      const row = document.createElement('tr');
      for (let cellIndex = 0; cellIndex < headerCells.length; cellIndex += 1) {
        const td = document.createElement('td');
        appendInlineMarkdown(td, cells[cellIndex] || '', 0);
        row.appendChild(td);
      }
      tbody.appendChild(row);
      index += 1;
    }
    if (tbody.childNodes.length) table.appendChild(tbody);
    return { element: table, nextIndex: index };
  }

  function splitMarkdownTableRow(line) {
    let text = line.trim();
    if (text.startsWith('|')) text = text.slice(1);
    if (text.endsWith('|')) text = text.slice(0, -1);
    return text.split('|').map((cell) => cell.trim());
  }

  function isMarkdownBlockStart(lines, index) {
    const line = lines[index];
    return Boolean(
      matchMarkdownFenceStart(line) ||
      /^\s{0,3}(#{1,6})\s+/.test(line) ||
      /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line) ||
      /^\s{0,3}>\s?/.test(line) ||
      matchMarkdownListLine(line) ||
      isMarkdownTableStart(lines, index)
    );
  }

  function isMarkdownBlank(line) {
    return /^\s*$/.test(line);
  }

  function leadingWhitespaceLength(line) {
    const match = /^\s*/.exec(line);
    return match ? match[0].length : 0;
  }

  function appendInlineMarkdown(parent, text, depth) {
    const source = typeof text === 'string' ? text : '';
    if (depth > MAX_MARKDOWN_DEPTH) {
      parent.appendChild(document.createTextNode(source));
      return;
    }

    let index = 0;
    while (index < source.length) {
      const rest = source.slice(index);
      const character = rest[0];

      if (character === '\n') {
        parent.appendChild(document.createElement('br'));
        index += 1;
        continue;
      }

      if (character === '\\' && /[\\`*_{}\[\]()#+\-.!>~]/.test(rest[1] || '')) {
        parent.appendChild(document.createTextNode(rest[1]));
        index += 2;
        continue;
      }

      if (character === '`') {
        const match = /^(`+)([\s\S]*?)\1/.exec(rest);
        if (match) {
          const code = document.createElement('code');
          code.textContent = match[2].replace(/\n/g, ' ');
          parent.appendChild(code);
          index += match[0].length;
          continue;
        }
      }

      if (rest.startsWith('![')) {
        const match = /^!\[([^\]]*)\]\(([^)]+)\)/.exec(rest);
        if (match) {
          parent.appendChild(document.createTextNode(match[1]));
          index += match[0].length;
          continue;
        }
      }

      if (character === '[') {
        const labelEnd = rest.indexOf('](', 1);
        if (labelEnd > 0) {
          let nesting = 0;
          let linkEnd = -1;
          for (let cursor = labelEnd + 2; cursor < rest.length; cursor += 1) {
            const linkCharacter = rest[cursor];
            if (linkCharacter === '\\') {
              cursor += 1;
              continue;
            }
            if (linkCharacter === '(') {
              nesting += 1;
            } else if (linkCharacter === ')') {
              if (nesting === 0) {
                linkEnd = cursor;
                break;
              }
              nesting -= 1;
            }
          }
          if (linkEnd > labelEnd + 2) {
            const label = rest.slice(1, labelEnd);
            const target = rest.slice(labelEnd + 2, linkEnd).trim();
            const targetMatch = /^(\S+)(?:\s+"[^"]*")?$/.exec(target);
            if (targetMatch) {
              appendMarkdownLink(parent, label, targetMatch[1], depth);
              index += linkEnd + 1;
              continue;
            }
          }
        }
      }

      if (character === '<') {
        const match = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/.exec(rest);
        if (match) {
          appendMarkdownLink(parent, match[1], match[1], depth);
          index += match[0].length;
          continue;
        }
      }

      if (rest.startsWith('**') || rest.startsWith('__')) {
        const marker = rest.slice(0, 2);
        const close = rest.indexOf(marker, 2);
        if (close > 2) {
          const strong = document.createElement('strong');
          appendInlineMarkdown(strong, rest.slice(2, close), depth + 1);
          parent.appendChild(strong);
          index += close + 2;
          continue;
        }
      }

      if (rest.startsWith('~~')) {
        const close = rest.indexOf('~~', 2);
        if (close > 2) {
          const deleted = document.createElement('del');
          appendInlineMarkdown(deleted, rest.slice(2, close), depth + 1);
          parent.appendChild(deleted);
          index += close + 2;
          continue;
        }
      }

      if (character === '*' || character === '_') {
        const close = rest.indexOf(character, 1);
        if (close > 1 && rest[close + 1] !== character) {
          const emphasis = document.createElement('em');
          appendInlineMarkdown(emphasis, rest.slice(1, close), depth + 1);
          parent.appendChild(emphasis);
          index += close + 1;
          continue;
        }
      }

      const urlMatch = /^https?:\/\/[^\s<]+/.exec(rest);
      if (urlMatch) {
        let href = urlMatch[0];
        let trailing = '';
        while (/[.,;:!?)]$/.test(href) && href.length > 1) {
          trailing = `${href.slice(-1)}${trailing}`;
          href = href.slice(0, -1);
        }
        appendMarkdownLink(parent, href, href, depth);
        if (trailing) parent.appendChild(document.createTextNode(trailing));
        index += urlMatch[0].length;
        continue;
      }

      const nextSpecial = rest.slice(1).search(/[\n\\`*_~\[<]/);
      const end = nextSpecial === -1 ? rest.length : nextSpecial + 1;
      parent.appendChild(document.createTextNode(rest.slice(0, end)));
      index += end;
    }
  }

  function appendMarkdownLink(parent, label, rawHref, depth) {
    const href = safeMarkdownHref(rawHref);
    if (!href) {
      appendInlineMarkdown(parent, label, depth + 1);
      return;
    }
    const link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    appendInlineMarkdown(link, label, depth + 1);
    parent.appendChild(link);
  }

  function safeMarkdownHref(rawHref) {
    const value = String(rawHref || '').trim();
    if (!value) return null;
    try {
      const url = new URL(value, window.location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') {
        return null;
      }
      return url.href;
    } catch {
      return null;
    }
  }

  function renderMessages() {
    const messages = chatState && Array.isArray(chatState.messages) ? chatState.messages : [];
    const wasNearBottom = elements.chatScroll.scrollHeight - elements.chatScroll.scrollTop - elements.chatScroll.clientHeight < 90;
    const fragment = document.createDocumentFragment();

    for (const message of messages) {
      if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
      const article = document.createElement('article');
      article.className = `message ${message.role}${message.error ? ' error' : ''}`;

      const label = document.createElement('div');
      label.className = 'message-label';
      label.textContent = message.role === 'user' ? 'You' : 'Copilot';

      const content = document.createElement('div');
      content.className = 'message-content';
      const hasContent = typeof message.content === 'string' && Boolean(message.content.trim());
      if (message.role === 'assistant' && !message.error && hasContent) {
        content.classList.add('markdown');
        renderMarkdown(content, message.content);
      } else {
        content.textContent = hasContent ? message.content : 'No response text.';
      }

      article.append(label, content);
      if (message.role === 'assistant' && message.durationMs) {
        const meta = document.createElement('div');
        meta.className = 'message-label';
        const total = message.usage && Number(message.usage.totalTokens) > 0
          ? ` · ${Number(message.usage.totalTokens).toLocaleString()} tokens (${Number(message.usage.promptTokens || 0).toLocaleString()} in / ${Number(message.usage.outputTokens || 0).toLocaleString()} out)`
          : '';
        meta.textContent = `${(message.durationMs / 1000).toFixed(1)}s${total}`;
        article.appendChild(meta);
      }
      if (Array.isArray(message.toolCalls) && message.toolCalls.length) {
        appendToolCalls(article, message.toolCalls);
      }
      fragment.appendChild(article);
    }
    if (chatState && chatState.running && Array.isArray(chatState.toolCalls) && chatState.toolCalls.length) {
      const liveArticle = document.createElement('article');
      liveArticle.className = 'message assistant live-tool-log';
      appendToolCalls(liveArticle, chatState.toolCalls);
      fragment.appendChild(liveArticle);
    }

    function appendToolCalls(parent, toolCalls) {
      const details = document.createElement('details');
      details.className = 'tool-calls';
      const summary = document.createElement('summary');
      summary.textContent = `Tool calls (${toolCalls.length})`;
      details.appendChild(summary);
      for (const call of toolCalls) {
        if (!call || typeof call !== 'object') continue;
        const item = document.createElement('div');
        item.className = `tool-call ${call.status === 'failed' ? 'failed' : ''}`;
        const heading = document.createElement('div');
        heading.className = 'tool-call-heading';
        heading.textContent = `${call.status === 'success' ? '✓' : call.status === 'failed' ? '✕' : '…'} ${call.name || 'unknown tool'}${Number.isFinite(call.durationMs) ? ` · ${(call.durationMs / 1000).toFixed(1)}s` : ''}`;
        item.appendChild(heading);
        if (call.arguments) {
          const args = document.createElement('pre');
          args.textContent = call.arguments;
          item.appendChild(args);
        }
        if (call.result) {
          const result = document.createElement('pre');
          result.textContent = call.result;
          item.appendChild(result);
        }
        details.appendChild(item);
      }
      parent.appendChild(details);
    }

    function updateLiveToolCalls() {
      const article = elements.messages.querySelector('.live-tool-log');
      const calls = chatState && Array.isArray(chatState.toolCalls) ? chatState.toolCalls : [];
      if (!calls.length) {
        if (article) article.remove();
        return;
      }
      if (!article) {
        renderMessages();
        return;
      }
      const details = article.querySelector('.tool-calls');
      const wasOpen = details ? details.open : false;
      article.replaceChildren();
      appendToolCalls(article, calls);
      const updatedDetails = article.querySelector('.tool-calls');
      if (updatedDetails) updatedDetails.open = wasOpen;
    }

    elements.messages.replaceChildren(fragment);
    const hasMessages = messages.length > 0;
    elements.emptyState.hidden = hasMessages;
    elements.newChatBtn.disabled = !hasMessages || Boolean(chatState && chatState.running);

    if (wasNearBottom || (chatState && chatState.running)) {
      requestAnimationFrame(() => {
        elements.chatScroll.scrollTop = elements.chatScroll.scrollHeight;
      });
    }

    const lastMessage = messages[messages.length - 1];
    if (
      lastMessage && lastMessage.error && lastMessage.code === 'AUTH_ERROR'
      && lastMessage.at !== lastShownAuthErrorAt
    ) {
      lastShownAuthErrorAt = lastMessage.at;
      const providerName = appSettings.provider === 'google'
        ? 'Google Gemini' : appSettings.provider === 'openrouter' ? 'OpenRouter' : 'Groq';
      showToast(`${providerName} rejected the API key. Update it in Settings.`, 'error');
    }
  }

  function renderActivity() {
    const running = Boolean(chatState && chatState.running);
    elements.activity.hidden = !running;
    elements.activityText.textContent = running
      ? `${chatState.activity || 'Working...'} ${formatRunStats()}`
      : '';
    if (running && !activityTimer) {
      activityTimer = setInterval(renderActivity, 1000);
    } else if (!running && activityTimer) {
      clearInterval(activityTimer);
      activityTimer = null;
    }
  }

  function formatRunStats() {
    if (!chatState || !chatState.running) return '';
    const startedAt = Number(chatState.startedAt) || 0;
    const elapsed = startedAt ? Date.now() - startedAt : Number(chatState.elapsedMs) || 0;
    const seconds = Math.floor(Math.max(0, elapsed) / 1000);
    const usage = chatState.usage;
    const tokens = usage && Number(usage.totalTokens) > 0
      ? ` · ${usage.totalTokens.toLocaleString()} tokens (${Number(usage.promptTokens || 0).toLocaleString()} in / ${Number(usage.outputTokens || 0).toLocaleString()} out)`
      : '';
    return `(${seconds}s${tokens})`;
  }

  function renderComposerState() {
    const running = Boolean(chatState && chatState.running);
    const hasText = Boolean(elements.prompt.value.trim());
    elements.sendBtn.hidden = running;
    elements.stopBtn.hidden = !running;
    elements.sendBtn.disabled = running || sending || !hasText;
    elements.newChatBtn.disabled = !(chatState && chatState.messages && chatState.messages.length) || running;
    elements.prompt.placeholder = running ? 'Assistant is working...' : 'Ask about your blocks...';
  }

  function renderWorkspaceStatus() {
    const kind = workspaceState.kind;
    elements.workspaceDot.className = 'dot';

    if (kind === 'found') {
      const workspace = workspaceState.data && workspaceState.data.workspace ? workspaceState.data.workspace : {};
      const count = Number.isFinite(workspace.blockCount) ? workspace.blockCount : 0;
      elements.workspaceDot.classList.add('good');
      elements.workspaceText.textContent = `Blockly · ${count} ${count === 1 ? 'block' : 'blocks'}`;
      elements.workspaceChip.title = workspaceState.message || 'Blockly workspace detected';
      elements.pageLabel.textContent = pageTitle(workspaceState.page);
      elements.pageLabel.title = pageTitle(workspaceState.page);
    } else if (kind === 'checking') {
      elements.workspaceDot.classList.add('checking');
      elements.workspaceText.textContent = 'Checking page...';
      elements.workspaceChip.title = 'Looking for a Blockly workspace';
      elements.pageLabel.textContent = activeTabId ? 'Current tab' : 'No active tab';
      elements.pageLabel.title = '';
    } else if (kind === 'notfound') {
      elements.workspaceDot.classList.add('warn');
      elements.workspaceText.textContent = 'No Blockly workspace';
      elements.workspaceChip.title = workspaceState.message || 'No Blockly workspace detected';
      elements.pageLabel.textContent = pageTitle(workspaceState.page);
      elements.pageLabel.title = pageTitle(workspaceState.page);
    } else {
      elements.workspaceDot.classList.add('bad');
      elements.workspaceText.textContent = 'Page not accessible';
      elements.workspaceChip.title = workspaceState.message || 'This page does not allow extension scripts';
      elements.pageLabel.textContent = activeTabId ? 'Current tab' : 'No active tab';
      elements.pageLabel.title = workspaceState.message || '';
    }

    const canUndo = kind === 'found'
      && workspaceState.data
      && workspaceState.data.canUndo === true
      && !(chatState && chatState.running);
    elements.undoBtn.disabled = !canUndo;
    elements.undoBtn.title = canUndo
      ? 'Restore the workspace from before the last AI edit. Manual edits made since then will also be replaced.'
      : 'No AI edit to undo on this page.';
  }

  function pageTitle(page) {
    if (page && typeof page.title === 'string' && page.title.trim()) return page.title.trim();
    return 'Current tab';
  }

  function renderSettings() {
    const hasKey = Boolean(appSettings.hasApiKey);
    const groqHasKey = Boolean(appSettings.hasGroqApiKey);
    const googleHasKey = Boolean(appSettings.hasGoogleApiKey);
    const openRouterHasKey = Boolean(appSettings.hasOpenRouterApiKey);
    elements.providerInput.value = appSettings.provider || 'groq';
    renderModelOptions();
    elements.apiKey.placeholder = groqHasKey ? 'Saved key - enter a new one to replace' : 'gsk_...';
    elements.googleApiKey.placeholder = googleHasKey ? 'Saved key - enter a new one to replace' : 'AIza...';
    elements.openRouterApiKey.placeholder = openRouterHasKey ? 'Saved key - enter a new one to replace' : 'sk-or-v1-...';
    elements.removeKeyBtn.disabled = !hasKey;
    elements.keyStatus.replaceChildren();
    const dot = document.createElement('span');
    dot.className = `dot${hasKey ? ' good' : ''}`;
    const text = document.createElement('span');
    const providerName = appSettings.provider === 'google'
      ? 'Google AI' : appSettings.provider === 'openrouter' ? 'OpenRouter' : 'Groq';
    text.textContent = hasKey ? `${providerName} key saved in extension storage` : 'No key saved';
    elements.keyStatus.append(dot, text);

    if (!modelDirty && document.activeElement !== elements.modelInput) {
      const configuredModel = appSettings.model || '';
      elements.modelInput.value = appSettings.provider === 'google' && (!configuredModel || configuredModel.startsWith('openai/'))
        ? 'gemini-3.8-flash'
        : configuredModel || DEFAULT_MODEL;
    }
    elements.temperatureInput.value = appSettings.temperature ?? 0.2;
    elements.maxTokensInput.value = appSettings.maxTokens ?? 2048;

    const model = appSettings.model || DEFAULT_MODEL;
    elements.modelLabel.textContent = model;
    elements.modelLabel.title = model;
    elements.modelInput.placeholder = appSettings.provider === 'google' ? 'gemini-3.8-flash' : DEFAULT_MODEL;
    elements.modelInput.title = model;
  }

  function renderModelOptions() {
    if (!elements.modelOptions) return;
    const models = Array.isArray(appSettings.availableModels)
      ? appSettings.availableModels.filter((model) => typeof model === 'string' && model)
      : [];
    elements.modelOptions.replaceChildren();
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model;
      elements.modelOptions.append(option);
    }
  }

  function updateSetupHint() {
    elements.setupHint.hidden = Boolean(appSettings.hasApiKey);
  }

  function resizePrompt() {
    elements.prompt.style.height = 'auto';
    const nextHeight = Math.min(elements.prompt.scrollHeight + 2, 132);
    elements.prompt.style.height = `${nextHeight}px`;
    elements.prompt.style.overflowY = nextHeight >= 132 ? 'auto' : 'hidden';
  }

  function showToast(message, type = '', duration = 4200) {
    if (!message) return;
    if (toastTimer) clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.className = `toast${type ? ` ${type}` : ''}`;
    elements.toast.hidden = false;
    toastTimer = setTimeout(() => {
      elements.toast.hidden = true;
      toastTimer = null;
    }, duration);
  }

  function showNotice(message, isError) {
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    elements.noticeText.textContent = message;
    elements.notice.classList.toggle('error', Boolean(isError));
    elements.notice.hidden = false;
  }

  function setNoticeHidden() {
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    elements.notice.hidden = true;
  }

  function openSettings() {
    modelDirty = false;
    settingsOpen = true;
    elements.settingsPanel.hidden = false;
    elements.settingsScroll.scrollTop = 0;
    elements.apiKey.value = '';
    elements.googleApiKey.value = '';
    elements.openRouterApiKey.value = '';
    elements.apiKey.type = 'password';
    elements.toggleKeyBtn.textContent = 'Show';
    elements.modelInput.value = appSettings.model || DEFAULT_MODEL;
    renderSettings();
    requestAnimationFrame(() => {
      if (!appSettings.hasApiKey) {
        elements.apiKey.focus();
      } else {
        elements.closeSettingsBtn.focus();
      }
    });
  }

  function closeSettings() {
    settingsOpen = false;
    modelDirty = false;
    elements.settingsPanel.hidden = true;
    elements.settingsBtn.focus();
  }

  async function submitPrompt() {
    if (sending || (chatState && chatState.running)) return;
    const text = elements.prompt.value.trim();
    if (!text) return;

    if (!appSettings.hasApiKey) {
      showToast(`Add a ${appSettings.provider === 'google' ? 'Google AI' : appSettings.provider === 'openrouter' ? 'OpenRouter' : 'Groq'} API key in Settings first.`, 'error');
      openSettings();
      return;
    }
    if (!activeTabId) {
      showToast('No active tab is available.', 'error');
      return;
    }

    sending = true;
    renderComposerState();
    try {
      await request('send', { tabId: activeTabId, text }, 15000);
      elements.prompt.value = '';
      resizePrompt();
    } catch (error) {
      if (error.code === 'NO_API_KEY') openSettings();
      showToast(error.message || 'Could not send the message.', 'error');
    } finally {
      sending = false;
      renderComposerState();
    }
  }

  async function saveSettings() {
    if (savingSettings) return;
    const model = elements.modelInput.value.trim();
    if (!model) {
      showToast('Enter a model ID.', 'error');
      elements.modelInput.focus();
      return;
    }

    const apiKey = elements.apiKey.value.trim();
    savingSettings = true;
    elements.saveSettingsBtn.disabled = true;
    elements.saveSettingsBtn.textContent = 'Saving...';

    try {
      const result = await request('saveSettings', {
        tabId: activeTabId,
        provider: elements.providerInput.value,
        model,
        ...(apiKey ? { groqApiKey: apiKey } : {}),
        ...(elements.googleApiKey.value.trim() ? { googleApiKey: elements.googleApiKey.value.trim() } : {}),
        ...(elements.openRouterApiKey.value.trim() ? { openRouterApiKey: elements.openRouterApiKey.value.trim() } : {}),
        temperature: Number(elements.temperatureInput.value),
        maxTokens: Number(elements.maxTokensInput.value)
      }, 20000);
      if (result && result.settings) {
        appSettings = { ...appSettings, ...result.settings };
      }
      elements.apiKey.value = '';
      elements.googleApiKey.value = '';
      elements.openRouterApiKey.value = '';
      elements.apiKey.type = 'password';
      elements.toggleKeyBtn.textContent = 'Show';
      modelDirty = false;
      showToast(result && result.changed ? 'Settings saved.' : 'Settings are already up to date.', 'success');
      elements.settingsScroll.scrollTop = 0;
      renderSettings();
      updateSetupHint();
      updateConnectionLabel();
    } catch (error) {
      showToast(error.message || 'Could not save settings.', 'error');
    } finally {
      savingSettings = false;
      elements.saveSettingsBtn.disabled = false;
      elements.saveSettingsBtn.textContent = 'Save settings';
    }
  }

  async function testConnection() {
    if (testingConnection) return;
    const apiKey = elements.apiKey.value.trim();
    const googleApiKey = elements.googleApiKey.value.trim();
    const openRouterApiKey = elements.openRouterApiKey.value.trim();
    const model = elements.modelInput.value.trim();
    testingConnection = true;
    elements.testBtn.disabled = true;
    elements.testBtn.textContent = 'Testing...';

    try {
      const result = await request('testConnection', {
        provider: elements.providerInput.value,
        ...(apiKey ? { groqApiKey: apiKey } : {}),
        ...(googleApiKey ? { googleApiKey } : {}),
        ...(openRouterApiKey ? { openRouterApiKey } : {}),
        ...(model ? { model } : {})
      }, 40000);
      if (result && result.ok) {
        if (Array.isArray(result.models)) {
          appSettings = { ...appSettings, availableModels: result.models };
          renderModelOptions();
          if (
            result.models.length > 0
            && (!model || result.selectedModelAvailable === false)
          ) {
            elements.modelInput.value = result.models[0];
            modelDirty = true;
          }
        }
        const count = Number.isFinite(result.modelCount) ? result.modelCount : 0;
        if (result.warning && result.models && result.models.length > 0) {
          showToast(`${result.warning} Selected ${result.models[0]}. Save settings to use it.`);
        } else if (result.warning) {
          showToast(result.warning);
        } else {
          const providerName = elements.providerInput.value === 'google'
            ? 'Google AI' : elements.providerInput.value === 'openrouter' ? 'OpenRouter' : 'Groq';
          showToast(`Connected to ${providerName}. ${count} model${count === 1 ? '' : 's'} visible.`, 'success');
        }
      }
    } catch (error) {
      showToast(error.message || 'Could not test the provider connection.', 'error');
    } finally {
      testingConnection = false;
      elements.testBtn.disabled = false;
      elements.testBtn.textContent = 'Test connection';
    }
  }

  async function removeApiKey() {
    if (!appSettings.hasApiKey) return;
    const providerName = appSettings.provider === 'google'
      ? 'Google AI' : appSettings.provider === 'openrouter' ? 'OpenRouter' : 'Groq';
    if (!window.confirm(`Remove the saved ${providerName} API key from this extension?`)) return;
    try {
      const result = await request('removeApiKey', { provider: appSettings.provider }, 15000);
      if (result && result.settings) {
        appSettings = { ...appSettings, ...result.settings };
      } else {
        appSettings = { ...appSettings, hasApiKey: false };
      }
      elements.apiKey.value = '';
      renderSettings();
      updateSetupHint();
      updateConnectionLabel();
      elements.settingsScroll.scrollTop = 0;
      showToast('API key removed.', 'success');
    } catch (error) {
      showToast(error.message || 'Could not remove the API key.', 'error');
    }
  }

  async function undoLastEdit() {
    if (!activeTabId) {
      showToast('No active tab is available.', 'error');
      return;
    }
    elements.undoBtn.disabled = true;
    try {
      const result = await request('undo', { tabId: activeTabId }, 40000);
      const restored = result && result.workspace;
      const count = restored && Number.isFinite(restored.blockCount) ? restored.blockCount : null;
      showToast(
        count === null ? 'Workspace edit undone.' : `Workspace restored (${count} block${count === 1 ? '' : 's'}).`,
        'success'
      );
      await refreshStatus();
    } catch (error) {
      showToast(error.message || 'Could not undo the last AI edit.', 'error');
      renderWorkspaceStatus();
    }
  }

  async function newChat() {
    if (!activeTabId) return;
    if (chatState && chatState.running) {
      showToast('Stop the current request first.', 'error');
      return;
    }
    const hasMessages = chatState && Array.isArray(chatState.messages) && chatState.messages.length > 0;
    if (hasMessages && !window.confirm('Start a new chat? This tab\'s current conversation will be cleared.')) {
      return;
    }
    try {
      await request('newChat', { tabId: activeTabId }, 15000);
      chatState = { ...(chatState || {}), messages: [], running: false, activity: '' };
      renderAll();
      showToast('New chat started.', 'success');
    } catch (error) {
      showToast(error.message || 'Could not start a new chat.', 'error');
    }
  }

  async function openSidePanel() {
    try {
      const currentWindow = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: currentWindow.id });
      showToast('Opened in the side panel.', 'success');
    } catch {
      showToast('Could not open the side panel. Use the browser\'s side-panel button.', 'error');
    }
  }

  function bindEvents() {
    elements.providerInput.addEventListener('change', () => {
      const provider = elements.providerInput.value;
      appSettings = { ...appSettings, provider };
      appSettings.availableModels = [];
      if (!modelDirty) {
        elements.modelInput.value = provider === 'google'
          ? 'gemini-3.8-flash'
          : DEFAULT_MODEL;
      }
      renderSettings();
    });
    elements.settingsBtn.addEventListener('click', openSettings);
    elements.setupKeyBtn.addEventListener('click', openSettings);
    elements.closeSettingsBtn.addEventListener('click', closeSettings);
    elements.doneSettingsBtn.addEventListener('click', closeSettings);

    elements.apiKey.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void saveSettings();
      }
    });

    elements.modelInput.addEventListener('input', () => {
      modelDirty = true;
    });

    elements.modelInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void saveSettings();
      }
    });

    elements.toggleKeyBtn.addEventListener('click', () => {
      const showing = elements.apiKey.type === 'text';
      elements.apiKey.type = showing ? 'password' : 'text';
      elements.toggleKeyBtn.textContent = showing ? 'Show' : 'Hide';
    });

    elements.saveSettingsBtn.addEventListener('click', () => {
      void saveSettings();
    });
    elements.testBtn.addEventListener('click', () => {
      void testConnection();
    });
    elements.removeKeyBtn.addEventListener('click', () => {
      void removeApiKey();
    });
    elements.openPanelBtn.addEventListener('click', () => {
      void openSidePanel();
    });
    elements.panelBtn.addEventListener('click', () => {
      void openSidePanel();
    });

    elements.workspaceChip.addEventListener('click', () => {
      void refreshStatus();
    });
    elements.undoBtn.addEventListener('click', () => {
      void undoLastEdit();
    });
    elements.newChatBtn.addEventListener('click', () => {
      void newChat();
    });

    elements.composer.addEventListener('submit', (event) => {
      event.preventDefault();
      void submitPrompt();
    });

    elements.prompt.addEventListener('input', () => {
      resizePrompt();
      renderComposerState();
    });

    elements.prompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void submitPrompt();
      }
    });

    elements.stopBtn.addEventListener('click', async () => {
      if (!activeTabId) return;
      try {
        await request('cancel', { tabId: activeTabId }, 10000);
      } catch (error) {
        showToast(error.message || 'Could not stop the request.', 'error');
      }
    });

    elements.noticeClose.addEventListener('click', setNoticeHidden);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && settingsOpen) {
        closeSettings();
      }
    });

    document.querySelectorAll('.quick-prompt').forEach((button) => {
      button.addEventListener('click', () => {
        const prompt = button.getAttribute('data-prompt');
        if (!prompt) return;
        elements.prompt.value = prompt;
        resizePrompt();
        renderComposerState();
        elements.prompt.focus();
      });
    });

    if (chrome.tabs && chrome.tabs.onActivated) {
      chrome.tabs.onActivated.addListener(() => {
        void refreshActiveTab(true);
      });
    }

    if (chrome.tabs && chrome.tabs.onUpdated) {
      chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (tabId === activeTabId && changeInfo.status === 'complete') {
          void refreshStatus();
        }
      });
    }

    window.addEventListener('unload', () => {
      rejectAllPending(new Error('The page closed.'));
      if (port) {
        try {
          port.disconnect();
        } catch {
          // Ignore.
        }
      }
    });
  }

  async function init() {
    bindEvents();
    connectPort();
    await refreshActiveTab();
    resizePrompt();
  }

  void init();
})();
