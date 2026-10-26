(() => {
  'use strict';

  // This script runs in the page's MAIN world. The content script cannot see
  // window.Blockly from its isolated world, so this bridge is the only part of
  // the extension that directly touches the page's Blockly runtime.
  if (window.__groqBlocklyBridgeInstalledV1) return;
  window.__groqBlocklyBridgeInstalledV1 = true;

  const BRIDGE_VERSION = 1;
  const REQUEST_SOURCE = 'groq-blockly-extension';
  const BRIDGE_SOURCE = 'groq-blockly-bridge';

  const MAX_BLOCKS_PER_ADD = 200;
  const MAX_NESTING_DEPTH = 8;
  const MAX_FIELDS = 64;
  const MAX_INPUTS = 32;
  const MAX_FIELD_CHARS = 500;
  const MAX_SUMMARY_CHARS = 50000;
  const MAX_XML_CHARS = 45000;
  const MAX_JSON_CHARS = 45000;
  const MAX_SNAPSHOT_CHARS = 5000000;
  const MAX_SNAPSHOTS = 8;
  const MAX_VARIABLES_IN_SUMMARY = 80;
  const MAX_PROCEDURES_IN_SUMMARY = 80;
  const MAX_VARIABLE_NAME_CHARS = 100;
  const MAX_PROCEDURE_NAME_CHARS = 100;
  const MAX_PROCEDURE_ARGUMENTS = 20;
  const MAX_VARIABLES_PER_ADD = 20;

  const snapshots = new Map();

  class BridgeError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = 'BridgeError';
      this.code = code || 'BLOCKLY_ERROR';
      if (details !== undefined) this.details = details;
    }
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function asSafeString(value, maxLength = 2000) {
    if (value === null || value === undefined) return '';
    let text;
    try {
      text = String(value);
    } catch {
      return '';
    }
    if (text.length > maxLength) text = text.slice(0, maxLength);
    return text;
  }

  function clampInteger(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
  }

  function postToContent(payload) {
    try {
      window.postMessage({ source: BRIDGE_SOURCE, ...payload }, '*');
    } catch {
      // The page may have navigated while a command was in flight.
    }
  }

  function toPublicError(error) {
    if (error instanceof BridgeError) {
      const result = { code: error.code, message: error.message };
      if (error.details !== undefined) result.details = error.details;
      return result;
    }
    return {
      code: 'BLOCKLY_BRIDGE_ERROR',
      message: asSafeString(error && error.message ? error.message : error, 1200) || 'The Blockly bridge failed.'
    };
  }

  const BROWSER_BUILTIN_PROPS = new Set([
    'window', 'self', 'document', 'name', 'location', 'customElements', 'history',
    'navigation', 'locationbar', 'menubar', 'personalbar', 'scrollbars', 'statusbar',
    'toolbar', 'status', 'closed', 'frames', 'length', 'top', 'opener', 'parent',
    'frameElement', 'navigator', 'origin', 'external', 'screen', 'innerWidth',
    'innerHeight', 'scrollX', 'pageXOffset', 'scrollY', 'pageYOffset', 'visualViewport',
    'screenX', 'screenY', 'outerWidth', 'outerHeight', 'devicePixelRatio', 'clientInformation',
    'screenLeft', 'screenTop', 'styleMedia', 'onsearch', 'isSecureContext', 'crossOriginIsolated',
    'performance', 'crypto', 'indexedDB', 'sessionStorage', 'localStorage', 'caches',
    'speechSynthesis', 'cookieStore', 'launchQueue', 'documentPictureInPicture',
    'chrome', 'console', 'event'
  ]);

  function unwrapRef(value) {
    if (!value || typeof value !== 'object') return value;
    try {
      if ('value' in value && value.value && typeof value.value === 'object') {
        return value.value;
      }
      if ('current' in value && value.current && typeof value.current === 'object') {
        return value.current;
      }
    } catch {}
    return value;
  }

  function isWorkspace(value) {
    const ws = unwrapRef(value);
    if (!ws || typeof ws !== 'object') return false;
    try {
      return (
        typeof ws.newBlock === 'function' &&
        typeof ws.getTopBlocks === 'function' &&
        typeof ws.getAllBlocks === 'function'
      );
    } catch {
      return false;
    }
  }

  function isUsableWorkspace(value) {
    const ws = unwrapRef(value);
    if (!isWorkspace(ws)) return false;
    try {
      if (ws.disposed) return false;
      const isFlyout = typeof ws.isFlyout === 'function' ? ws.isFlyout() : Boolean(ws.isFlyout);
      if (isFlyout) return false;
      const isMutator = typeof ws.isMutator === 'function' ? ws.isMutator() : Boolean(ws.isMutator);
      if (isMutator) return false;
      ws.getTopBlocks(false);
      return true;
    } catch {
      return false;
    }
  }

  function isFullBlocklyNamespace(value) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
    try {
      return Boolean(
        (value.Xml && typeof value.Xml.workspaceToDom === 'function') ||
        (value.WorkspaceSvg && typeof value.WorkspaceSvg === 'function') ||
        (value.Blocks && typeof value.Blocks === 'object' && Object.keys(value.Blocks).length > 0) ||
        (typeof value.getMainWorkspace === 'function') ||
        (value.common && typeof value.common.getMainWorkspace === 'function') ||
        (value.common && typeof value.common.getAllWorkspaces === 'function')
      );
    } catch {
      return false;
    }
  }

  function getDomAndFrameworkBridge() {
    const candidateElements = [];
    try {
      const selectors = [
        '#blocklyDiv',
        '.blocklyDiv',
        '.injectionDiv',
        '.blocklySvg',
        '.blocklyWorkspace',
        '.blocklyToolboxDiv',
        '[class*="blockly"]',
        '[id*="blockly"]',
        '[class*="scratch"]'
      ];
      const seen = new Set();
      for (const selector of selectors) {
        const matches = document.querySelectorAll(selector);
        for (const match of matches) {
          if (!seen.has(match)) {
            seen.add(match);
            candidateElements.push(match);
          }
        }
      }
    } catch {
      // Ignore DOM query errors.
    }

    let foundNamespace = null;
    let namespaceSource = null;
    let foundWorkspace = null;
    let workspaceSource = null;
    let foundVm = null;
    let vmSource = null;

    const checkWorkspaceCandidate = (candidate, sourceLabel) => {
      const ws = unwrapRef(candidate);
      if (!foundWorkspace && isUsableWorkspace(ws)) {
        foundWorkspace = ws;
        workspaceSource = sourceLabel;
        return true;
      }
      return false;
    };

    const checkNamespaceCandidate = (candidate, sourceLabel) => {
      if (!foundNamespace && isFullBlocklyNamespace(candidate)) {
        foundNamespace = candidate;
        namespaceSource = sourceLabel;
        return true;
      }
      return false;
    };

    const checkVmCandidate = (candidate, sourceLabel) => {
      if (!foundVm && isScratchVm(candidate)) {
        foundVm = candidate;
        vmSource = sourceLabel;
        return true;
      }
      return false;
    };

    // 1. Direct properties on DOM elements
    const directProps = ['workspace', '__blocklyWorkspace', 'blocklyWorkspace', '_workspace', '__workspace', 'ws'];
    for (const el of candidateElements) {
      try {
        for (const prop of directProps) {
          if (checkWorkspaceCandidate(el[prop], `DOM element: ${prop}`)) break;
        }
        if (!foundWorkspace) {
          for (const key of Object.getOwnPropertyNames(el)) {
            if (checkWorkspaceCandidate(el[key], `DOM property: ${key}`)) break;
          }
        }
      } catch {}
      if (foundWorkspace) break;
    }

    // 2. Vue 3 and Vue 2 Component Inspection
    if (!foundWorkspace || !foundNamespace) {
      for (const el of candidateElements) {
        let currentEl = el;
        for (let up = 0; currentEl && up < 20; up += 1, currentEl = currentEl.parentElement) {
          try {
            // Vue 3
            if (currentEl.__vueParentComponent) {
              let comp = currentEl.__vueParentComponent;
              for (let depth = 0; comp && depth < 20; depth += 1, comp = comp.parent) {
                if (comp.setupState && typeof comp.setupState === 'object') {
                  for (const key of Object.keys(comp.setupState)) {
                    const val = comp.setupState[key];
                    checkWorkspaceCandidate(val, `Vue setupState: ${key}`);
                    checkNamespaceCandidate(val, `Vue setupState: ${key}`);
                  }
                }
                if (comp.ctx && typeof comp.ctx === 'object') {
                  for (const key of ['workspace', 'ws', 'mainWorkspace', 'blocklyWorkspace']) {
                    checkWorkspaceCandidate(comp.ctx[key], `Vue ctx: ${key}`);
                  }
                  checkNamespaceCandidate(comp.ctx.Blockly || comp.ctx.blockly, 'Vue ctx.Blockly');
                }
                if (comp.proxy && typeof comp.proxy === 'object') {
                  for (const key of ['workspace', 'ws', 'mainWorkspace', 'blocklyWorkspace']) {
                    checkWorkspaceCandidate(comp.proxy[key], `Vue proxy: ${key}`);
                  }
                  checkNamespaceCandidate(comp.proxy.Blockly || comp.proxy.blockly, 'Vue proxy.Blockly');
                }
                if (foundWorkspace && foundNamespace) break;
              }
            }

            // Vue 2
            if (currentEl.__vue__) {
              let vm = currentEl.__vue__;
              for (let depth = 0; vm && depth < 20; depth += 1, vm = vm.$parent) {
                for (const key of ['workspace', 'ws', 'mainWorkspace', 'blocklyWorkspace']) {
                  checkWorkspaceCandidate(vm[key], `Vue 2: ${key}`);
                  if (vm.$data) checkWorkspaceCandidate(vm.$data[key], `Vue 2 $data: ${key}`);
                }
                checkNamespaceCandidate(vm.Blockly || vm.blockly, 'Vue 2 Blockly');
                if (foundWorkspace && foundNamespace) break;
              }
            }
          } catch {}
          if (foundWorkspace && foundNamespace) break;
        }
        if (foundWorkspace && foundNamespace) break;
      }
    }

    // 3. React Component Tree Inspection (Fibers)
    if (!foundWorkspace || !foundNamespace || !foundVm) {
      const visitedFibers = new Set();
      for (const el of candidateElements) {
        let currentEl = el;
        let rootFiber = null;

        for (let up = 0; currentEl && up < 20; up += 1, currentEl = currentEl.parentElement) {
          try {
            const fiberKey = Object.keys(currentEl).find(
              (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$') || key.startsWith('__reactContainer$')
            );
            if (fiberKey && currentEl[fiberKey]) {
              rootFiber = currentEl[fiberKey];
              break;
            }
          } catch {}
        }

        let currentFiber = rootFiber;
        for (let depth = 0; currentFiber && depth < 40; depth += 1, currentFiber = currentFiber.return) {
          if (visitedFibers.has(currentFiber)) continue;
          visitedFibers.add(currentFiber);

          try {
            const stateNode = currentFiber.stateNode;
            if (stateNode && typeof stateNode === 'object' && !stateNode.nodeType) {
              const nsKeys = ['ScratchBlocks', 'Blockly', 'blockly', 'scratchBlocks'];
              for (const nsKey of nsKeys) {
                checkNamespaceCandidate(stateNode[nsKey], `React state: ${nsKey}`);
              }
              const wsKeys = ['workspace', 'workspaceSvg', 'mainWorkspace', 'blocklyWorkspace'];
              for (const wsKey of wsKeys) {
                checkWorkspaceCandidate(stateNode[wsKey], `React state: ${wsKey}`);
              }
              checkVmCandidate(stateNode.vm, 'React state: vm');
              if (!foundWorkspace) {
                for (const key of Object.keys(stateNode)) {
                  if (checkWorkspaceCandidate(stateNode[key], `React state: ${key}`)) break;
                }
              }
            }
          } catch {}

          try {
            const props = currentFiber.memoizedProps;
            if (props && typeof props === 'object') {
              for (const nsKey of ['ScratchBlocks', 'Blockly', 'blockly']) {
                checkNamespaceCandidate(props[nsKey], `React prop: ${nsKey}`);
              }
              for (const wsKey of ['workspace', 'workspaceSvg', 'mainWorkspace', 'blocklyWorkspace']) {
                checkWorkspaceCandidate(props[wsKey], `React prop: ${wsKey}`);
              }
              checkVmCandidate(props.vm, 'React prop: vm');
            }
          } catch {}

          try {
            let hook = currentFiber.memoizedState;
            for (let h = 0; hook && h < 30; h += 1, hook = hook.next) {
              if (hook.memoizedState) {
                checkWorkspaceCandidate(hook.memoizedState, 'React hook state');
                checkVmCandidate(hook.memoizedState.vm, 'React hook state: vm');
                if (hook.memoizedState.current) {
                  checkWorkspaceCandidate(hook.memoizedState.current, 'React hook ref');
                  checkVmCandidate(hook.memoizedState.current.vm, 'React hook ref: vm');
                }
              }
              if (foundWorkspace && foundVm) break;
            }
          } catch {}

          if (foundNamespace && foundWorkspace && foundVm) break;
        }

        if (foundNamespace && foundWorkspace && foundVm) break;
      }
    }

    return {
      blockly: foundNamespace,
      blocklySource: namespaceSource,
      workspace: foundWorkspace,
      workspaceSource: workspaceSource,
      vm: foundVm,
      vmSource
    };
  }

  function getScannedGlobals() {
    let foundWorkspace = null;
    let workspaceSource = null;
    let foundNamespace = null;
    let namespaceSource = null;
    let foundVm = null;
    let vmSource = null;

    try {
      const keys = Object.getOwnPropertyNames(window);
      for (const key of keys) {
        if (BROWSER_BUILTIN_PROPS.has(key) || key.startsWith('on') || key.startsWith('webkit')) continue;

        let val;
        try {
          val = window[key];
        } catch {
          continue;
        }
        if (!val) continue;

        const unwrapped = unwrapRef(val);
        if (!foundWorkspace && isUsableWorkspace(unwrapped)) {
          foundWorkspace = unwrapped;
          workspaceSource = `window.${key}`;
        }

        if (!foundNamespace && isFullBlocklyNamespace(val)) {
          foundNamespace = val;
          namespaceSource = `window.${key}`;
        }

        if (!foundVm && isScratchVm(val)) {
          foundVm = val;
          vmSource = `window.${key}`;
        }

        if (typeof val === 'object' && val !== null) {
          try {
            for (const subKey of ['workspace', 'mainWorkspace', 'blocklyWorkspace', 'ws', 'activeWorkspace', 'currentWorkspace']) {
              if (val[subKey]) {
                const subUnwrapped = unwrapRef(val[subKey]);
                if (!foundWorkspace && isUsableWorkspace(subUnwrapped)) {
                  foundWorkspace = subUnwrapped;
                  workspaceSource = `window.${key}.${subKey}`;
                  break;
                }
              }
            }
            if (!foundNamespace) {
              for (const subKey of ['Blockly', 'blockly', 'ScratchBlocks', 'scratchBlocks']) {
                if (val[subKey] && isFullBlocklyNamespace(val[subKey])) {
                  foundNamespace = val[subKey];
                  namespaceSource = `window.${key}.${subKey}`;
                  break;
                }
              }
            }
            if (!foundVm && isScratchVm(val.vm)) {
              foundVm = val.vm;
              vmSource = `window.${key}.vm`;
            }
          } catch {}
        }

        if (foundWorkspace && foundNamespace && foundVm) break;
      }
    } catch {}

    return {
      workspace: foundWorkspace,
      workspaceSource,
      blockly: foundNamespace,
      blocklySource: namespaceSource,
      vm: foundVm,
      vmSource
    };
  }

  function getIframeBridge() {
    try {
      const iframes = document.querySelectorAll('iframe, frame');
      for (const iframe of iframes) {
        try {
          const frameWin = iframe.contentWindow;
          if (!frameWin) continue;
          if (frameWin.Blockly && isFullBlocklyNamespace(frameWin.Blockly)) {
            const ws = getMainWorkspaceCandidate(frameWin.Blockly);
            if (ws) return { workspace: ws.workspace, source: `iframe (${iframe.id || 'embedded'}): ${ws.source}`, blockly: frameWin.Blockly };
          }
          if (frameWin.workspace && isUsableWorkspace(unwrapRef(frameWin.workspace))) {
            return { workspace: unwrapRef(frameWin.workspace), source: `iframe (${iframe.id || 'embedded'}): window.workspace` };
          }
        } catch {}
      }
    } catch {}
    return null;
  }

  function isScratchVm(value) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
    try {
      const target = value.editingTarget;
      return Boolean(
        target &&
        target.blocks &&
        (typeof target.createVariable === 'function' || typeof target.lookupVariableByNameAndType === 'function')
      );
    } catch {
      return false;
    }
  }

  function getScratchVm() {
    try {
      if (isScratchVm(window.vm)) return { vm: window.vm, source: 'window.vm' };
    } catch {}

    const bridge = getDomAndFrameworkBridge();
    if (isScratchVm(bridge.vm)) {
      return { vm: bridge.vm, source: bridge.vmSource || 'component VM' };
    }

    const scanned = getScannedGlobals();
    if (isScratchVm(scanned.vm)) {
      return { vm: scanned.vm, source: scanned.vmSource || 'scanned VM' };
    }

    return null;
  }

  function getBlocklyContext() {
    let value = null;
    let source = null;

    try {
      if (window.Blockly && (typeof window.Blockly === 'object' || typeof window.Blockly === 'function')) {
        if (isFullBlocklyNamespace(window.Blockly)) {
          return { blockly: window.Blockly, source: 'window.Blockly' };
        }
        value = window.Blockly;
        source = 'window.Blockly (incomplete)';
      }
    } catch {}

    try {
      if (window.__groqBlockly && (typeof window.__groqBlockly === 'object' || typeof window.__groqBlockly === 'function')) {
        if (isFullBlocklyNamespace(window.__groqBlockly)) {
          return { blockly: window.__groqBlockly, source: 'window.__groqBlockly' };
        }
        if (!value) {
          value = window.__groqBlockly;
          source = 'window.__groqBlockly (incomplete)';
        }
      }
    } catch {}

    try {
      if (window.blockly && isFullBlocklyNamespace(window.blockly)) {
        return { blockly: window.blockly, source: 'window.blockly' };
      }
    } catch {}

    try {
      if (window.ScratchBlocks && isFullBlocklyNamespace(window.ScratchBlocks)) {
        return { blockly: window.ScratchBlocks, source: 'window.ScratchBlocks' };
      }
    } catch {}

    // Try DOM and component frameworks (Vue 3, Vue 2, React, Svelte)
    const domBridge = getDomAndFrameworkBridge();
    if (domBridge && domBridge.blockly && isFullBlocklyNamespace(domBridge.blockly)) {
      return { blockly: domBridge.blockly, source: domBridge.blocklySource || 'Component state Blockly' };
    }

    // Try scanned globals
    const scanned = getScannedGlobals();
    if (scanned && scanned.blockly && isFullBlocklyNamespace(scanned.blockly)) {
      return { blockly: scanned.blockly, source: scanned.blocklySource || 'Scanned global Blockly' };
    }

    // Try same-origin iframe
    const iframeBridge = getIframeBridge();
    if (iframeBridge && iframeBridge.blockly && isFullBlocklyNamespace(iframeBridge.blockly)) {
      return { blockly: iframeBridge.blockly, source: iframeBridge.source };
    }

    return { blockly: value, source };
  }

  function getExplicitWorkspace() {
    const names = ['__groqBlocklyWorkspace'];
    for (const name of names) {
      try {
        const candidate = unwrapRef(window[name]);
        if (isUsableWorkspace(candidate)) {
          return { workspace: candidate, source: `window.${name}` };
        }
      } catch {}
    }
    return null;
  }

  function getCommonWorkspace() {
    const names = [
      'blocklyWorkspace', 'mainWorkspace', 'workspaceSvg', 'workspace',
      'ws', 'editor', 'mcblockly', 'mcBlockly', 'app', 'activeWorkspace'
    ];
    for (const name of names) {
      try {
        const candidate = unwrapRef(window[name]);
        if (isUsableWorkspace(candidate)) {
          return { workspace: candidate, source: `window.${name}` };
        }
      } catch {}
    }
    return null;
  }

  function getAllWorkspaces(blockly) {
    const found = [];
    const seen = new Set();

    const addOne = (ws) => {
      const unwrapped = unwrapRef(ws);
      if (!unwrapped || seen.has(unwrapped)) return;
      if (!isUsableWorkspace(unwrapped)) return;
      seen.add(unwrapped);
      found.push(unwrapped);
    };

    const addList = (list) => {
      if (!Array.isArray(list)) return;
      for (const item of list) addOne(item);
    };

    if (blockly) {
      try {
        if (blockly.common && typeof blockly.common.getAllWorkspaces === 'function') {
          addList(blockly.common.getAllWorkspaces());
        }
      } catch {}

      try {
        if (blockly.Workspace && typeof blockly.Workspace.getAll === 'function') {
          addList(blockly.Workspace.getAll());
        }
      } catch {}

      try {
        if (blockly.WorkspaceSvg && typeof blockly.WorkspaceSvg.getAll === 'function') {
          addList(blockly.WorkspaceSvg.getAll());
        }
      } catch {}

      try {
        if (blockly.Workspace && blockly.Workspace.WorkspaceDB_) {
          addList(Object.values(blockly.Workspace.WorkspaceDB_));
        }
      } catch {}

      try {
        if (blockly.WorkspaceSvg && blockly.WorkspaceSvg.WorkspaceDB_) {
          addList(Object.values(blockly.WorkspaceSvg.WorkspaceDB_));
        }
      } catch {}
    }

    return found;
  }

  function getMainWorkspaceCandidate(blockly) {
    if (!blockly) return null;

    const getters = [];
    if (typeof blockly.getMainWorkspace === 'function') {
      getters.push({ source: 'Blockly.getMainWorkspace', get: () => blockly.getMainWorkspace() });
    }
    if (blockly.common && typeof blockly.common.getMainWorkspace === 'function') {
      getters.push({ source: 'Blockly.common.getMainWorkspace', get: () => blockly.common.getMainWorkspace() });
    }
    if (blockly.mainWorkspace && isUsableWorkspace(unwrapRef(blockly.mainWorkspace))) {
      getters.push({ source: 'Blockly.mainWorkspace', get: () => unwrapRef(blockly.mainWorkspace) });
    }
    if (blockly.workspace && isUsableWorkspace(unwrapRef(blockly.workspace))) {
      getters.push({ source: 'Blockly.workspace', get: () => unwrapRef(blockly.workspace) });
    }

    for (const getter of getters) {
      try {
        const workspace = unwrapRef(getter.get());
        if (isUsableWorkspace(workspace)) {
          return { workspace, source: getter.source };
        }
      } catch {}
    }
    return null;
  }

  function getWorkspaceRect(workspace) {
    try {
      let element = null;
      if (typeof workspace.getInjectionDiv === 'function') {
        element = workspace.getInjectionDiv();
      } else if (typeof workspace.getParentSvg === 'function') {
        element = workspace.getParentSvg();
      }
      if (!element || typeof element.getBoundingClientRect !== 'function') return null;

      const rect = element.getBoundingClientRect();
      if (!rect || rect.width < 4 || rect.height < 4) return null;

      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;
      return rect;
    } catch {
      return null;
    }
  }

  function scoreWorkspace(workspace) {
    let score = 0;
    try {
      if (workspace.rendered) score += 1e9;
    } catch {
      // Keep the default score.
    }

    const rect = getWorkspaceRect(workspace);
    if (rect) {
      const width = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
      const height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
      score += width * height;
    } else {
      score -= 1e8;
    }

    try {
      if (typeof workspace.getToolbox === 'function' && workspace.getToolbox()) score += 1000;
    } catch {
      // Ignore.
    }
    return score;
  }

  function findWorkspaceNow() {
    // 1. Explicit opt-in
    const explicit = getExplicitWorkspace();
    if (explicit) return explicit;

    // 2. Main workspace from Blockly namespace
    const { blockly } = getBlocklyContext();
    const main = getMainWorkspaceCandidate(blockly);
    if (main) return main;

    // 3. All workspaces from Blockly namespace
    const all = getAllWorkspaces(blockly);
    if (all.length) {
      all.sort((left, right) => scoreWorkspace(right) - scoreWorkspace(left));
      return { workspace: all[0], source: 'Blockly.Workspace.getAll' };
    }

    // 4. Common workspace names on window
    const common = getCommonWorkspace();
    if (common) return common;

    // 5. DOM elements & Component Frameworks (Vue 3, Vue 2, React, Svelte)
    const domBridge = getDomAndFrameworkBridge();
    if (domBridge && domBridge.workspace && isUsableWorkspace(domBridge.workspace)) {
      return { workspace: domBridge.workspace, source: domBridge.workspaceSource || 'Component workspace' };
    }

    // 6. SVG ID lookup
    try {
      const svgGroups = document.querySelectorAll('g.blocklyWorkspace[id]');
      for (const g of svgGroups) {
        if (g.id && blockly) {
          const ws = (blockly.common && typeof blockly.common.getWorkspaceById === 'function' && blockly.common.getWorkspaceById(g.id))
            || (blockly.Workspace && typeof blockly.Workspace.getById === 'function' && blockly.Workspace.getById(g.id))
            || (blockly.WorkspaceSvg && typeof blockly.WorkspaceSvg.getById === 'function' && blockly.WorkspaceSvg.getById(g.id))
            || (blockly.Workspace && blockly.Workspace.WorkspaceDB_ && blockly.Workspace.WorkspaceDB_[g.id])
            || (blockly.WorkspaceSvg && blockly.WorkspaceSvg.WorkspaceDB_ && blockly.WorkspaceSvg.WorkspaceDB_[g.id]);
          if (ws && isUsableWorkspace(ws)) {
            return { workspace: ws, source: 'SVG ID lookup: ' + g.id };
          }
        }
      }
    } catch {}

    // 7. Scanned window globals
    const scanned = getScannedGlobals();
    if (scanned && scanned.workspace && isUsableWorkspace(scanned.workspace)) {
      return { workspace: scanned.workspace, source: scanned.workspaceSource || 'Scanned global workspace' };
    }

    // 8. Same-origin iframe
    const iframeBridge = getIframeBridge();
    if (iframeBridge && iframeBridge.workspace && isUsableWorkspace(iframeBridge.workspace)) {
      return { workspace: iframeBridge.workspace, source: iframeBridge.source };
    }

    return null;
  }

  async function waitForWorkspace(waitMilliseconds = 4000) {
    const deadline = Date.now() + Math.max(0, waitMilliseconds);
    let found = findWorkspaceNow();
    while (!found && Date.now() < deadline) {
      await sleep(200);
      found = findWorkspaceNow();
    }
    return found;
  }

  function findBlocklyDomElement() {
    try {
      return document.querySelector('#blocklyDiv, .blocklyDiv, .injectionDiv, .blocklySvg, .blocklyWorkspace, .blocklyToolboxDiv, [class*="blockly"], [id*="blockly"], [class*="scratch"]');
    } catch {
      return null;
    }
  }

  function getDiagnostics() {
    const { blockly, source } = getBlocklyContext();
    const allWorkspaces = getAllWorkspaces(blockly);
    const explicitWorkspace = getExplicitWorkspace();
    const commonWorkspace = getCommonWorkspace();
    const domElement = findBlocklyDomElement();
    const domBridge = getDomAndFrameworkBridge();
    const scanned = getScannedGlobals();

    const diagnostics = {
      blocklyNamespace: Boolean(blockly && isFullBlocklyNamespace(blockly)),
      blocklyNamespaceSource: source,
      registeredWorkspaces: allWorkspaces.length,
      explicitWorkspace: Boolean(explicitWorkspace),
      commonWorkspace: Boolean(commonWorkspace),
      componentWorkspace: Boolean(domBridge && domBridge.workspace),
      scannedWorkspace: Boolean(scanned && scanned.workspace),
      xmlApiAvailable: Boolean(getXmlApi(blockly)),
      blocklyElementInDom: Boolean(domElement),
      readyState: document.readyState
    };
    diagnostics.hint = buildDiagnosticHint(diagnostics);
    return diagnostics;
  }

  function buildDiagnosticHint(diagnostics) {
    if (diagnostics.registeredWorkspaces > 0) {
      return diagnostics.xmlApiAvailable
        ? 'A Blockly workspace is registered and ready.'
        : 'A Blockly workspace is registered, but the Blockly XML API is not exposed. The workspace can be inspected, but editing is disabled.';
    }
    if (diagnostics.explicitWorkspace || diagnostics.commonWorkspace || diagnostics.componentWorkspace || diagnostics.scannedWorkspace) {
      return diagnostics.xmlApiAvailable
        ? 'A workspace object was found through page components or globals. Editing is available.'
        : 'A workspace object was found, but the Blockly XML API is not exposed. The workspace can be inspected, but editing is disabled.';
    }
    if (diagnostics.blocklyNamespace && diagnostics.blocklyElementInDom) {
      return 'Blockly is exposed, but its workspace has not been registered yet. Wait for the editor to finish loading, then refresh the status.';
    }
    if (diagnostics.blocklyNamespace) {
      return 'Blockly is exposed on the page, but no workspace was found. The editor may not have been created yet.';
    }
    if (diagnostics.blocklyElementInDom) {
      return 'Blockly elements exist in the page DOM, but its JavaScript namespace is not exposed. If you control the page, expose the workspace as window.__groqBlocklyWorkspace (and optionally expose Blockly as window.__groqBlockly) to enable editing.';
    }
    return 'No Blockly workspace was detected. Open a page with a Blockly editor and try again. If the editor is inside a cross-origin iframe, the extension cannot access it.';
  }

  function describeWorkspace(workspace) {
    let id = '';
    let rendered = false;
    let readOnly = false;
    let blockCount = 0;
    let topBlockCount = 0;
    let variableCount = 0;
    let commentCount = 0;

    try {
      id = asSafeString(workspace.id, 200);
    } catch {
      // Ignore.
    }
    try {
      rendered = Boolean(workspace.rendered);
    } catch {
      // Ignore.
    }
    try {
      readOnly = typeof workspace.isReadOnly === 'function'
        ? Boolean(workspace.isReadOnly())
        : Boolean(workspace.options && workspace.options.readOnly);
    } catch {
      // Ignore.
    }
    try {
      const blocks = workspace.getAllBlocks(false);
      blockCount = Array.isArray(blocks) ? blocks.length : 0;
    } catch {
      // Ignore.
    }
    try {
      const topBlocks = workspace.getTopBlocks(false);
      topBlockCount = Array.isArray(topBlocks) ? topBlocks.length : 0;
    } catch {
      // Ignore.
    }
    try {
      const variableMap = workspace.getVariableMap && workspace.getVariableMap();
      const variables = variableMap && variableMap.getAllVariables && variableMap.getAllVariables();
      variableCount = Array.isArray(variables) ? variables.length : 0;
    } catch {
      // Ignore.
    }
    try {
      if (typeof workspace.getTopComments === 'function') {
        const comments = workspace.getTopComments(false);
        commentCount = Array.isArray(comments) ? comments.length : 0;
      }
    } catch {
      // Ignore.
    }

    let workspaceType = rendered ? 'WorkspaceSvg' : 'Workspace';
    try {
      const constructorName = workspace.constructor && workspace.constructor.name;
      if (typeof constructorName === 'string' && /^[A-Za-z][A-Za-z0-9_$]*$/.test(constructorName) && constructorName.length <= 80) {
        workspaceType = constructorName;
      }
    } catch {
      // Ignore.
    }

    return {
      id,
      type: workspaceType,
      rendered,
      readOnly,
      blockCount,
      topBlockCount,
      variableCount,
      commentCount
    };
  }

  function workspaceKey(workspace) {
    try {
      return asSafeString(workspace.id, 200) || 'default-workspace';
    } catch {
      return 'default-workspace';
    }
  }

  function getXmlApi(blockly) {
    if (!blockly || !blockly.Xml) return null;
    if (typeof blockly.Xml.workspaceToDom !== 'function') return null;
    if (typeof blockly.Xml.domToText !== 'function' && typeof blockly.Xml.domToPrettyText !== 'function') return null;
    return blockly.Xml;
  }

  function supportsSnapshots(workspace) {
    void workspace;
    const { blockly } = getBlocklyContext();
    return Boolean(getXmlApi(blockly));
  }

  function ensureSnapshotSupport() {
    const { blockly } = getBlocklyContext();
    const xml = getXmlApi(blockly);
    if (!xml) {
      throw new BridgeError(
        'SNAPSHOT_UNAVAILABLE',
        'This page does not expose the Blockly XML API, so edits cannot be safely snapshotted or undone. Expose Blockly as window.__groqBlockly (and the workspace as window.__groqBlocklyWorkspace) to enable editing.',
        getDiagnostics()
      );
    }
    return { blockly, xml };
  }

  function captureWorkspaceXml(workspace) {
    const { xml } = ensureSnapshotSupport();
    let text;
    try {
      const dom = xml.workspaceToDom(workspace);
      text = typeof xml.domToPrettyText === 'function'
        ? xml.domToPrettyText(dom)
        : xml.domToText(dom);
    } catch (error) {
      throw new BridgeError('SNAPSHOT_FAILED', 'Could not snapshot the workspace before editing.', {
        cause: asSafeString(error && error.message, 500)
      });
    }

    if (typeof text !== 'string') {
      throw new BridgeError('SNAPSHOT_FAILED', 'Blockly returned an invalid workspace snapshot.');
    }
    if (text.length > MAX_SNAPSHOT_CHARS) {
      throw new BridgeError(
        'SNAPSHOT_TOO_LARGE',
        `The workspace is too large to snapshot safely (${text.length.toLocaleString()} characters).`,
        { maxSnapshotChars: MAX_SNAPSHOT_CHARS }
      );
    }
    return text;
  }

  function textToXmlDom(blockly, xmlApi, text) {
    let dom = null;
    try {
      if (blockly.utils && blockly.utils.xml && typeof blockly.utils.xml.textToDom === 'function') {
        dom = blockly.utils.xml.textToDom(text);
      } else if (typeof xmlApi.textToDom === 'function') {
        dom = xmlApi.textToDom(text);
      } else {
        const documentNode = new DOMParser().parseFromString(text, 'text/xml');
        if (documentNode.getElementsByTagName('parsererror').length) {
          throw new Error('Invalid XML.');
        }
        dom = documentNode.documentElement;
      }
    } catch (error) {
      throw new BridgeError('SNAPSHOT_RESTORE_FAILED', 'The saved workspace snapshot could not be parsed.', {
        cause: asSafeString(error && error.message, 500)
      });
    }

    if (!dom) {
      throw new BridgeError('SNAPSHOT_RESTORE_FAILED', 'The saved workspace snapshot was empty.');
    }
    return dom;
  }

  function restoreWorkspaceXml(workspace, xmlText) {
    const { blockly, xml } = ensureSnapshotSupport();
    const dom = textToXmlDom(blockly, xml, xmlText);

    try {
      if (workspace.rendered && typeof xml.clearWorkspaceAndLoadFromXml === 'function') {
        xml.clearWorkspaceAndLoadFromXml(dom, workspace);
      } else {
        if (typeof xml.domToWorkspace !== 'function') {
          throw new Error('Blockly.Xml.domToWorkspace is not available.');
        }
        workspace.clear();
        xml.domToWorkspace(dom, workspace);
      }
      if (typeof workspace.resizeContents === 'function') workspace.resizeContents();
      if (typeof workspace.render === 'function') workspace.render();
    } catch (error) {
      throw new BridgeError('SNAPSHOT_RESTORE_FAILED', 'The workspace snapshot could not be restored.', {
        cause: asSafeString(error && error.message, 700)
      });
    }
  }

  function rememberSnapshot(workspace, xml, label, metadata) {
    const key = workspaceKey(workspace);
    snapshots.set(key, {
      xml,
      label: asSafeString(label, 200),
      at: Date.now(),
      ...(metadata && typeof metadata === 'object' ? metadata : {})
    });

    if (snapshots.size > MAX_SNAPSHOTS) {
      const oldest = Array.from(snapshots.entries()).sort((left, right) => left[1].at - right[1].at)[0];
      if (oldest) snapshots.delete(oldest[0]);
    }
  }

  function assertEditable(workspace) {
    let readOnly = false;
    try {
      readOnly = typeof workspace.isReadOnly === 'function'
        ? Boolean(workspace.isReadOnly())
        : Boolean(workspace.options && workspace.options.readOnly);
    } catch {
      // Assume editable if the check throws.
    }
    if (readOnly) {
      throw new BridgeError('WORKSPACE_READ_ONLY', 'This Blockly workspace is read-only.');
    }
  }

  async function requireWorkspace(waitMilliseconds = 4000) {
    const found = await waitForWorkspace(waitMilliseconds);
    if (!found) {
      const diagnostics = getDiagnostics();
      throw new BridgeError(
        'NO_WORKSPACE',
        'No accessible Blockly workspace was found on this page.',
        diagnostics
      );
    }
    return found;
  }

  function safeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function cappedText(text, maximum) {
    const length = typeof text === 'string' ? text.length : 0;
    const truncated = length > maximum;
    return {
      text: truncated ? text.slice(0, maximum) : text,
      truncated,
      chars: length
    };
  }

  function serializeXml(workspace) {
    const { blockly } = getBlocklyContext();
    const xml = getXmlApi(blockly);
    if (!xml) throw new BridgeError('XML_UNAVAILABLE', 'Blockly XML serialization is not available on this page.');
    const dom = xml.workspaceToDom(workspace);
    const text = typeof xml.domToPrettyText === 'function'
      ? xml.domToPrettyText(dom)
      : xml.domToText(dom);
    return cappedText(text, MAX_XML_CHARS);
  }

  function serializeJson(workspace, summary) {
    const { blockly } = getBlocklyContext();
    const save = blockly && blockly.serialization && blockly.serialization.workspaces
      && blockly.serialization.workspaces.save;
    if (typeof save === 'function') {
      const state = save(workspace);
      const text = JSON.stringify(state);
      return { ...cappedText(text, MAX_JSON_CHARS), format: 'blockly-serialization-v1' };
    }

    return {
      ...cappedText(JSON.stringify({ note: 'Blockly JSON serialization is unavailable; this is a read-only summary fallback.', summary }), MAX_JSON_CHARS),
      format: 'summary-fallback'
    };
  }

  function fieldNamesFor(block) {
    const names = new Set();
    try {
      for (const input of block.inputList || []) {
        for (const field of input.fieldRow || []) {
          if (field && field.name) names.add(field.name);
        }
      }
    } catch {
      // Ignore.
    }
    return Array.from(names).sort().slice(0, 80);
  }

  function inputNamesFor(block) {
    const names = new Set();
    try {
      for (const input of block.inputList || []) {
        if (input && input.name) names.add(input.name);
      }
    } catch {
      // Ignore.
    }
    return Array.from(names).sort().slice(0, 80);
  }

  function registeredBlockTypes() {
    const { blockly } = getBlocklyContext();
    try {
      if (blockly && blockly.Blocks && typeof blockly.Blocks === 'object') {
        return Object.keys(blockly.Blocks).filter((type) => !type.startsWith('_')).sort();
      }
    } catch {
      // Ignore.
    }
    return [];
  }

  function suggestBlockTypes(type) {
    const available = registeredBlockTypes();
    const needle = type.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!needle) return available.slice(0, 12);
    return available
      .map((candidate) => {
        const normalized = candidate.toLowerCase().replace(/[^a-z0-9]/g, '');
        let score = 0;
        if (normalized === needle) score = 100;
        else if (normalized.includes(needle)) score = 60 - Math.abs(normalized.length - needle.length);
        else if (needle.includes(normalized)) score = 40 - Math.abs(normalized.length - needle.length);
        return { candidate, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 10)
      .map((entry) => entry.candidate);
  }

  function validateBlockType(type) {
    const { blockly } = getBlocklyContext();
    let available = [];
    try {
      if (blockly && blockly.Blocks && typeof blockly.Blocks === 'object') {
        available = Object.keys(blockly.Blocks).filter((name) => !name.startsWith('_'));
      }
    } catch {
      available = [];
    }

    if (available.length && !Object.prototype.hasOwnProperty.call(blockly.Blocks, type)) {
      throw new BridgeError('UNKNOWN_BLOCK_TYPE', `The block type "${type}" is not registered in this workspace.`, {
        requestedType: type,
        suggestions: suggestBlockTypes(type)
      });
    }
  }

  function normalizeFieldValue(value, fieldName) {
    if (typeof value === 'string') {
      if (value.length > 10000) {
        throw new BridgeError('INVALID_FIELD_VALUE', `The value for field "${fieldName}" is too long.`);
      }
      return value;
    }
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    throw new BridgeError('INVALID_FIELD_VALUE', `Field "${fieldName}" must be a string, number, or boolean.`);
  }

  function makeBridgeId(prefix) {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `${prefix}_${crypto.randomUUID()}`;
      }
    } catch {
      // Fall through.
    }
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  function normalizeVariableName(value) {
    const name = asSafeString(value, MAX_VARIABLE_NAME_CHARS + 1).trim();
    if (!name) {
      throw new BridgeError('INVALID_VARIABLE_NAME', 'A non-empty variable name is required.');
    }
    if (name.length > MAX_VARIABLE_NAME_CHARS) {
      throw new BridgeError('INVALID_VARIABLE_NAME', `Variable names may be at most ${MAX_VARIABLE_NAME_CHARS} characters.`);
    }
    if (/[\u0000-\u001f\u007f]/.test(name)) {
      throw new BridgeError('INVALID_VARIABLE_NAME', 'Variable names cannot contain control characters.');
    }
    return name;
  }

  function normalizeVariableType(value) {
    if (value === undefined || value === null || value === '') return '';
    const type = asSafeString(value, 80).trim();
    if (type.length > 80) {
      throw new BridgeError('INVALID_VARIABLE_TYPE', 'The variable type is too long.');
    }
    return type;
  }

  function getWorkspaceVariableList(workspace) {
    const result = [];
    try {
      const variableMap = workspace.getVariableMap && workspace.getVariableMap();
      const variables = variableMap && variableMap.getAllVariables && variableMap.getAllVariables();
      if (Array.isArray(variables)) {
        for (const variable of variables) {
          if (!variable) continue;
          result.push({
            id: asSafeString(variable.id, 200),
            name: asSafeString(variable.name, 200),
            type: asSafeString(variable.type, 80)
          });
        }
      }
    } catch {
      // Ignore.
    }
    return result.slice(0, MAX_VARIABLES_IN_SUMMARY);
  }

  function findWorkspaceVariable(workspace, identifier) {
    const value = asSafeString(identifier, 300).trim();
    if (!value) return null;

    try {
      if (typeof workspace.getVariableById === 'function') {
        const variable = workspace.getVariableById(value);
        if (variable) return variable;
      }
    } catch {
      // Ignore.
    }

    try {
      const variableMap = workspace.getVariableMap && workspace.getVariableMap();
      if (variableMap) {
        if (typeof variableMap.getVariableById === 'function') {
          const variable = variableMap.getVariableById(value);
          if (variable) return variable;
        }
        if (typeof variableMap.getVariable === 'function') {
          const variable = variableMap.getVariable(value);
          if (variable) return variable;
        }
      }
    } catch {
      // Ignore.
    }

    try {
      if (typeof workspace.getVariable === 'function') {
        const variable = workspace.getVariable(value);
        if (variable) return variable;
      }
    } catch {
      // Ignore.
    }

    return null;
  }

  function createWorkspaceVariable(workspace, name, type, id) {
    if (workspace && typeof workspace.createVariable === 'function') {
      return workspace.createVariable(name, type, id);
    }
    const variableMap = workspace && typeof workspace.getVariableMap === 'function'
      ? workspace.getVariableMap()
      : null;
    if (variableMap && typeof variableMap.createVariable === 'function') {
      return variableMap.createVariable(name, type, id);
    }
    const { blockly } = getBlocklyContext();
    if (blockly && typeof blockly.Variable === 'function' && variableMap) {
      const variable = new blockly.Variable(name, type, id);
      if (typeof variableMap.add === 'function') {
        variableMap.add(variable);
        return variable;
      }
    }
    throw new BridgeError(
      'VARIABLE_API_UNAVAILABLE',
      'This Blockly build does not expose a supported variable-creation API.'
    );
  }

  function getScratchTarget(vm) {
    if (!vm) return null;
    try {
      if (vm.editingTarget) return vm.editingTarget;
    } catch {
      // Ignore.
    }
    try {
      if (vm.runtime && typeof vm.runtime.getTargetForStage === 'function') {
        return vm.runtime.getTargetForStage();
      }
    } catch {
      // Ignore.
    }
    return null;
  }

  function findScratchVmVariable(vm, name, type) {
    const target = getScratchTarget(vm);
    if (!target) return null;
    const variableType = type === undefined ? '' : type;
    try {
      if (typeof target.lookupVariableByNameAndType === 'function') {
        const variable = target.lookupVariableByNameAndType(name, variableType, false);
        if (variable) return variable;
      }
    } catch {
      // Ignore.
    }
    try {
      if (typeof target.lookupVariableByNameAndType === 'function') {
        const variable = target.lookupVariableByNameAndType(name, variableType);
        if (variable) return variable;
      }
    } catch {
      // Ignore.
    }
    return null;
  }

  function getScratchVmVariableIds(vm) {
    const ids = new Set();
    const targets = [];
    try {
      if (vm && vm.editingTarget) targets.push(vm.editingTarget);
      if (vm && vm.runtime && typeof vm.runtime.getTargetForStage === 'function') {
        const stage = vm.runtime.getTargetForStage();
        if (stage && !targets.includes(stage)) targets.push(stage);
      }
    } catch {
      // Ignore.
    }
    for (const target of targets) {
      try {
        for (const id of Object.keys(target.variables || {})) ids.add(id);
      } catch {
        // Ignore.
      }
    }
    return ids;
  }

  function deleteScratchVmVariable(vm, id) {
    if (!vm || !id) return false;
    const targets = [];
    try {
      if (vm.editingTarget) targets.push(vm.editingTarget);
      if (vm.runtime && typeof vm.runtime.getTargetForStage === 'function') {
        const stage = vm.runtime.getTargetForStage();
        if (stage && !targets.includes(stage)) targets.push(stage);
      }
    } catch {
      // Ignore.
    }
    let deleted = false;
    for (const target of targets) {
      try {
        if (target.variables && Object.prototype.hasOwnProperty.call(target.variables, id)) {
          if (typeof target.deleteVariable === 'function') target.deleteVariable(id);
          else delete target.variables[id];
          deleted = true;
        }
      } catch {
        // Ignore.
      }
    }
    return deleted;
  }

  function ensureScratchVariable(workspace, name, options) {
    const requestedName = normalizeVariableName(name);
    const requestedType = normalizeVariableType(options && options.type);
    const scope = options && options.scope === 'local' ? 'local' : 'global';
    const vmInfo = getScratchVm();
    const vm = vmInfo && vmInfo.vm;
    const target = vm ? getScratchTarget(vm) : null;
    const scratchType = '';

    const existingWorkspace = findWorkspaceVariable(workspace, requestedName);
    const existingVm = vm ? findScratchVmVariable(vm, requestedName, scratchType) : null;

    if (existingWorkspace || existingVm) {
      let id = (existingVm && existingVm.id) || (existingWorkspace && existingWorkspace.id) || '';
      let actualName = (existingVm && existingVm.name) || (existingWorkspace && existingWorkspace.name) || requestedName;
      const actualType = (existingWorkspace && existingWorkspace.type) || (existingVm && existingVm.type) || requestedType;
      let workspaceCreated = false;
      let vmCreated = false;

      if (!findWorkspaceVariable(workspace, id)) {
        try {
          createWorkspaceVariable(workspace, actualName, actualType, id);
          workspaceCreated = true;
        } catch {
          // Ignore; the existing variable may still be usable by name.
        }
      }

      if (vm && target && !existingVm) {
        try {
          if (scope === 'global' && vm.runtime && typeof vm.runtime.createNewGlobalVariable === 'function') {
            const variable = vm.runtime.createNewGlobalVariable(actualName, id, scratchType);
            if (variable) {
              id = variable.id;
              actualName = variable.name;
              vmCreated = true;
            }
          } else if (typeof target.createVariable === 'function') {
            target.createVariable(id, actualName, scratchType);
            const variable = target.variables && target.variables[id];
            if (variable) {
              actualName = variable.name;
              vmCreated = true;
            }
          }
        } catch {
          // Ignore; the workspace variable can still be referenced.
        }
      }

      return {
        id: asSafeString(id, 200),
        name: asSafeString(actualName, 200),
        type: asSafeString(actualType, 80),
        created: false,
        workspaceCreated,
        vmCreated
      };
    }

    let id = makeBridgeId('var');
    let actualName = requestedName;
    let vmCreated = false;
    let workspaceCreated = false;

    if (vm && target) {
      try {
        if (scope === 'global' && vm.runtime && typeof vm.runtime.createNewGlobalVariable === 'function') {
          const variable = vm.runtime.createNewGlobalVariable(requestedName, id, scratchType);
          if (!variable) throw new Error('Scratch did not return the new global variable.');
          id = variable.id;
          actualName = variable.name;
          vmCreated = true;
        } else if (typeof target.createVariable === 'function') {
          target.createVariable(id, requestedName, scratchType);
          const variable = target.variables && target.variables[id];
          if (!variable) throw new Error('Scratch did not return the new local variable.');
          actualName = variable.name;
          vmCreated = true;
        }
      } catch (error) {
        throw new BridgeError('VARIABLE_CREATE_FAILED', `Scratch could not create the variable "${requestedName}".`, {
          cause: asSafeString(error && error.message, 500)
        });
      }
    }

    try {
      const variable = createWorkspaceVariable(workspace, actualName, requestedType, id);
      if (variable) {
        id = asSafeString(variable.id, 200) || id;
        actualName = asSafeString(variable.name, 200) || actualName;
      }
      workspaceCreated = true;
    } catch (error) {
      if (vmCreated) deleteScratchVmVariable(vm, id);
      throw new BridgeError('VARIABLE_CREATE_FAILED', `Blockly could not create the variable "${actualName}".`, {
        cause: asSafeString(error && error.message, 500)
      });
    }

    if (vm && vmCreated) {
      try {
        if (typeof vm.emitWorkspaceUpdate === 'function') vm.emitWorkspaceUpdate();
      } catch {
        // Ignore refresh failures.
      }
      void refreshScratchVariableUi(workspace, vm);
    }

    return {
      id: asSafeString(id, 200),
      name: asSafeString(actualName, 200),
      type: asSafeString(requestedType, 80),
      created: true,
      workspaceCreated,
      vmCreated,
      scope
    };
  }

  async function refreshScratchVariableUi(workspace, vm) {
    const toolbox = workspace && typeof workspace.getToolbox === 'function'
      ? workspace.getToolbox()
      : workspace && (workspace.toolbox_ || workspace.toolbox);
    const refreshers = [
      [workspace, workspace && workspace.refreshToolboxSelection],
      [workspace, workspace && workspace.refreshToolbox],
      [toolbox, toolbox && toolbox.refreshSelection],
      [toolbox, toolbox && toolbox.refreshCategory],
      [toolbox, toolbox && toolbox.refresh]
    ];
    for (const [owner, refresh] of refreshers) {
      if (!owner || typeof refresh !== 'function') continue;
      try {
        refresh.call(owner);
      } catch {
        // Try the next available Blockly/Scratch refresh API.
      }
    }
    forceVariableCategoryReselection(toolbox);
    try {
      if (vm && vm.runtime && typeof vm.runtime.emit === 'function') {
        vm.runtime.emit('PROJECT_CHANGED');
      }
    } catch {
      // The VM event is optional; variable creation already succeeded.
    }
    await sleep(100);
    for (const [owner, refresh] of refreshers.slice(0, 3)) {
      if (!owner || typeof refresh !== 'function') continue;
      try {
        refresh.call(owner);
      } catch {
        // The variable remains created even if the flyout cannot refresh.
      }
    }
    forceVariableCategoryReselection(toolbox);
  }

  function forceVariableCategoryReselection(toolbox) {
    if (!toolbox || typeof toolbox.getToolboxItems !== 'function') return;
    try {
      const items = toolbox.getToolboxItems();
      const variableCategory = (Array.isArray(items) ? items : []).find((item) => {
        if (!item) return false;
        const name = typeof item.getName === 'function' ? item.getName() : item.name_;
        const category = typeof item.getCategoryId === 'function'
          ? item.getCategoryId()
          : item.categoryId_;
        return String(name || '').toLowerCase().includes('variable')
          || String(category || '').toLowerCase().includes('variable');
      });
      if (!variableCategory || typeof toolbox.setSelectedItem !== 'function') return;
      const selected = typeof toolbox.getSelectedItem === 'function'
        ? toolbox.getSelectedItem()
        : null;
      if (selected === variableCategory) toolbox.setSelectedItem(null);
      toolbox.setSelectedItem(variableCategory);
    } catch {
      // Toolbox APIs differ between Blockly and Scratch versions.
    }
  }

  function getWorkspaceVariableIds(workspace) {
    const ids = new Set();
    try {
      const variableMap = workspace.getVariableMap && workspace.getVariableMap();
      const variables = variableMap && variableMap.getAllVariables && variableMap.getAllVariables();
      for (const variable of Array.isArray(variables) ? variables : []) {
        if (variable && variable.id) ids.add(variable.id);
      }
    } catch {
      // Ignore.
    }
    return ids;
  }

  function blockReferencesVariable(block, id) {
    try {
      for (const input of block.inputList || []) {
        for (const field of input.fieldRow || []) {
          if (!field || typeof field.getVariable !== 'function') continue;
          try {
            const variable = field.getVariable();
            if (variable && variable.id === id) return true;
          } catch {
            // Ignore a field that cannot report its variable.
          }
        }
      }
    } catch {
      // Ignore.
    }
    return false;
  }

  function deleteWorkspaceVariableById(workspace, id) {
    try {
      const variableMap = workspace.getVariableMap && workspace.getVariableMap();
      if (variableMap && typeof variableMap.deleteVariable === 'function') {
        const variable = (typeof variableMap.getVariableById === 'function' && variableMap.getVariableById(id)) ||
          (typeof workspace.getVariableById === 'function' && workspace.getVariableById(id));
        if (variable) {
          variableMap.deleteVariable(variable);
          return true;
        }
      }
      if (typeof workspace.deleteVariableById === 'function') {
        workspace.deleteVariableById(id);
        return true;
      }
    } catch {
      // Ignore cleanup failures.
    }
    return false;
  }

  function cleanupAutoCreatedVariables(workspace, context, beforeIds, keepIds) {
    const before = beforeIds instanceof Set ? beforeIds : new Set();
    const keep = keepIds instanceof Set ? keepIds : new Set();
    const currentIds = getWorkspaceVariableIds(workspace);
    const keptSideEffects = [];
    for (const id of currentIds) {
      if (before.has(id) || keep.has(id)) continue;
      let referenced = false;
      for (const block of context.blocks || []) {
        if (blockReferencesVariable(block, id)) {
          referenced = true;
          break;
        }
      }
      if (referenced) {
        keptSideEffects.push(id);
        continue;
      }
      if (deleteWorkspaceVariableById(workspace, id)) {
        if (context.vm) deleteScratchVmVariable(context.vm, id);
      }
    }
    context.autoVariableIds = keptSideEffects;
  }

  function resolveVariableFieldValue(workspace, block, fieldName, value) {
    let field = null;
    try {
      field = block.getField(fieldName);
    } catch {
      field = null;
    }
    if (!field || typeof field.getVariable !== 'function' || typeof value !== 'string' || !value.trim()) {
      return value;
    }
    const variable = findWorkspaceVariable(workspace, value);
    if (variable && variable.id) return asSafeString(variable.id, 200);
    throw new BridgeError('UNKNOWN_VARIABLE', `The variable "${asSafeString(value, 200)}" does not exist in this workspace.`, {
      availableVariables: getWorkspaceVariableList(workspace)
    });
  }

  function setBlockFieldValue(workspace, block, fieldName, fieldValue) {
    const normalizedValue = normalizeFieldValue(fieldValue, fieldName);
    const resolvedValue = resolveVariableFieldValue(workspace, block, fieldName, normalizedValue);
    block.setFieldValue(resolvedValue, fieldName);
  }

  function escapeXmlAttribute(value) {
    return asSafeString(value, 20000)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function normalizeProcedureArgument(argument, index) {
    if (typeof argument === 'string') {
      const name = normalizeVariableName(argument);
      return { name, type: 'string', defaultValue: '' };
    }
    if (!isPlainObject(argument)) {
      throw new BridgeError('INVALID_PROCEDURE_ARGUMENT', `Procedure argument ${index + 1} must be a name or an object.`);
    }
    const name = normalizeVariableName(argument.name);
    const type = argument.type === 'boolean' ? 'boolean' : 'string';
    let defaultValue = '';
    if (type === 'boolean') {
      defaultValue = argument.defaultValue === true || String(argument.defaultValue || '').toLowerCase() === 'true'
        ? 'true'
        : 'false';
    } else if (argument.defaultValue !== undefined && argument.defaultValue !== null) {
      defaultValue = asSafeString(argument.defaultValue, 500);
    }
    return { name, type, defaultValue };
  }

  function normalizeProcedureArguments(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      throw new BridgeError('INVALID_PROCEDURE_ARGUMENTS', 'Procedure arguments must be an array.');
    }
    if (value.length > MAX_PROCEDURE_ARGUMENTS) {
      throw new BridgeError('TOO_MANY_PROCEDURE_ARGUMENTS', `A procedure may have at most ${MAX_PROCEDURE_ARGUMENTS} arguments.`);
    }
    const args = value.map((argument, index) => normalizeProcedureArgument(argument, index));
    const seen = new Set();
    for (const argument of args) {
      if (seen.has(argument.name)) {
        throw new BridgeError('DUPLICATE_PROCEDURE_ARGUMENT', `The procedure argument "${argument.name}" is used more than once.`);
      }
      seen.add(argument.name);
    }
    return args;
  }

  function buildProcedureProccode(name, args) {
    const base = asSafeString(name, MAX_PROCEDURE_NAME_CHARS + 1).trim();
    if (!base) throw new BridgeError('INVALID_PROCEDURE_NAME', 'A non-empty procedure name is required.');
    if (base.length > MAX_PROCEDURE_NAME_CHARS) {
      throw new BridgeError('INVALID_PROCEDURE_NAME', `Procedure names may be at most ${MAX_PROCEDURE_NAME_CHARS} characters.`);
    }
    if (/[\u0000-\u001f\u007f]/.test(base)) {
      throw new BridgeError('INVALID_PROCEDURE_NAME', 'Procedure names cannot contain control characters.');
    }
    return base + args.map((argument) => ` ${argument.type === 'boolean' ? '%b' : '%s'}`).join('');
  }

  function buildProcedureMutationData(name, args) {
    const normalizedArgs = normalizeProcedureArguments(args);
    return {
      proccode: buildProcedureProccode(name, normalizedArgs),
      argumentIds: normalizedArgs.map(() => makeBridgeId('arg')),
      argumentNames: normalizedArgs.map((argument) => argument.name),
      argumentDefaults: normalizedArgs.map((argument) => argument.defaultValue),
      warp: false,
      arguments: normalizedArgs
    };
  }

  function makeMutationElement(attributes) {
    const parts = [];
    for (const [name, value] of Object.entries(attributes)) {
      parts.push(`${name}="${escapeXmlAttribute(value)}"`);
    }
    const text = `<mutation ${parts.join(' ')}></mutation>`;
    const documentNode = new DOMParser().parseFromString(text, 'text/xml');
    if (!documentNode || !documentNode.documentElement || documentNode.getElementsByTagName('parsererror').length) {
      throw new BridgeError('INVALID_PROCEDURE_MUTATION', 'The procedure mutation could not be created.');
    }
    return documentNode.documentElement;
  }

  function getProcedureDefinitionInfo(block) {
    if (!block || typeof block !== 'object') return null;

    if (block.type === 'procedures_definition') {
      let prototype = null;
      try {
        prototype = typeof block.getInputTargetBlock === 'function'
          ? block.getInputTargetBlock('custom_block')
          : null;
      } catch {
        prototype = null;
      }
      if (!prototype) return null;

      let proccode = '';
      try {
        proccode = typeof prototype.getProcCode === 'function' ? prototype.getProcCode() : '';
      } catch {
        proccode = '';
      }

      let argumentIds = [];
      let argumentNames = [];
      let argumentDefaults = [];
      let warp = false;
      try {
        const mutation = typeof prototype.mutationToDom === 'function' ? prototype.mutationToDom() : null;
        if (mutation && mutation.getAttribute) {
          const idsText = mutation.getAttribute('argumentids');
          const namesText = mutation.getAttribute('argumentnames');
          const defaultsText = mutation.getAttribute('argumentdefaults');
          if (idsText) argumentIds = JSON.parse(idsText);
          if (namesText) argumentNames = JSON.parse(namesText);
          if (defaultsText) argumentDefaults = JSON.parse(defaultsText);
          warp = mutation.getAttribute('warp') === 'true';
        }
      } catch {
        // Keep the defaults.
      }

      if (!proccode) {
        proccode = asSafeString(argumentNames[0] || '', 200);
      }
      return {
        name: asSafeString(proccode, 200),
        proccode: asSafeString(proccode, 200),
        blockId: asSafeString(block.id, 200),
        argumentIds: Array.isArray(argumentIds) ? argumentIds.map((id) => asSafeString(id, 200)) : [],
        argumentNames: Array.isArray(argumentNames) ? argumentNames.map((name) => asSafeString(name, 200)) : [],
        argumentDefaults: Array.isArray(argumentDefaults) ? argumentDefaults.map((value) => asSafeString(value, 500)) : [],
        warp
      };
    }

    try {
      if (typeof block.getProcedureDef === 'function') {
        const definition = block.getProcedureDef();
        if (Array.isArray(definition) && definition[0]) {
          return {
            name: asSafeString(definition[0], 200),
            proccode: asSafeString(definition[0], 200),
            blockId: asSafeString(block.id, 200),
            argumentIds: [],
            argumentNames: Array.isArray(definition[1]) ? definition[1].map((name) => asSafeString(name, 200)) : [],
            argumentDefaults: [],
            warp: false
          };
        }
      }
    } catch {
      // Ignore.
    }
    return null;
  }

  function getProcedureDefinitions(workspace) {
    const definitions = [];
    const seen = new Set();
    let blocks = [];
    try {
      blocks = workspace.getAllBlocks(false);
    } catch {
      blocks = [];
    }
    for (const block of Array.isArray(blocks) ? blocks : []) {
      const info = getProcedureDefinitionInfo(block);
      if (!info || seen.has(info.proccode)) continue;
      seen.add(info.proccode);
      definitions.push(info);
      if (definitions.length >= MAX_PROCEDURES_IN_SUMMARY) break;
    }
    return definitions;
  }

  function procedureBaseName(proccode) {
    return asSafeString(proccode, 300)
      .replace(/\s*%[sb](?=\s|$)/g, '')
      .trim();
  }

  function findProcedureDefinition(workspace, nameOrProccode) {
    const value = asSafeString(nameOrProccode, 300).trim();
    if (!value) return null;
    const definitions = getProcedureDefinitions(workspace);
    for (const definition of definitions) {
      if (definition.proccode === value || definition.name === value) return definition;
    }
    for (const definition of definitions) {
      if (procedureBaseName(definition.proccode) === value || procedureBaseName(definition.name) === value) {
        return definition;
      }
    }
    return null;
  }

  function normalizeProcedureReference(value) {
    if (!isPlainObject(value)) {
      throw new BridgeError('INVALID_PROCEDURE_REFERENCE', 'The procedure property must be an object with a name or proccode.');
    }
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    const explicitProccode = typeof value.proccode === 'string' ? value.proccode.trim() : '';
    const args = normalizeProcedureArguments(value.arguments);
    const explicitIds = Array.isArray(value.argumentIds)
      ? value.argumentIds.map((id) => asSafeString(id, 200)).filter(Boolean)
      : [];
    let proccode = explicitProccode;
    if (!proccode && name) proccode = buildProcedureProccode(name, args);
    if (!proccode) {
      throw new BridgeError('INVALID_PROCEDURE_REFERENCE', 'A procedure name or proccode is required.');
    }
    return { name: name || proccode, proccode, args, argumentIds: explicitIds };
  }

  function syncScratchProcedureCallBlock(block, data) {
    if (!block || !data) return;
    const vmInfo = getScratchVm();
    if (!vmInfo || !vmInfo.vm) return;
    const target = getScratchTarget(vmInfo.vm);
    if (!target || !target.blocks || !target.blocks._blocks) return;
    const vmBlock = target.blocks._blocks[block.id];
    if (!vmBlock) return;
    const mutation = vmBlock.mutation && typeof vmBlock.mutation === 'object'
      ? vmBlock.mutation
      : (vmBlock.mutation = { tagName: 'mutation', children: [] });
    mutation.proccode = asSafeString(data.proccode, 200);
    mutation.argumentids = JSON.stringify(Array.isArray(data.argumentIds) ? data.argumentIds : []);
    mutation.warp = 'false';
  }

  function applyProcedureCallMutation(workspace, block, spec, context) {
    if (!spec.procedure) {
      throw new BridgeError('PROCEDURE_REQUIRED', 'A procedures_call block requires a procedure object with a name or proccode.');
    }
    const reference = normalizeProcedureReference(spec.procedure);
    const existing = findProcedureDefinition(workspace, reference.proccode) || findProcedureDefinition(workspace, reference.name);
    const proccode = existing ? existing.proccode : reference.proccode;
    const argumentIds = reference.argumentIds.length
      ? reference.argumentIds
      : (existing && existing.argumentIds.length ? existing.argumentIds : []);
    const mutation = makeMutationElement({
      proccode,
      argumentids: JSON.stringify(argumentIds),
      warp: 'false'
    });
    if (typeof block.domToMutation !== 'function') {
      throw new BridgeError('PROCEDURE_MUTATION_UNSUPPORTED', 'This block does not support procedure mutations.');
    }
    block.domToMutation(mutation);
    const result = {
      proccode,
      argumentIds,
      argumentNames: existing ? existing.argumentNames : reference.args.map((argument) => argument.name),
      argumentNameToId: Object.fromEntries(
        (existing ? existing.argumentNames : reference.args.map((argument) => argument.name))
          .map((name, index) => [name, argumentIds[index] || ''])
      )
    };
    syncScratchProcedureCallBlock(block, result);
    if (context) {
      if (!Array.isArray(context.procedureCalls)) context.procedureCalls = [];
      context.procedureCalls.push({ block, data: result });
    }
    return result;
  }

  function buildProcedureDefinitionXml(name, args, x, y) {
    const data = buildProcedureMutationData(name, args);
    const safeX = Number.isFinite(Number(x)) ? Math.round(Number(x)) : 0;
    const safeY = Number.isFinite(Number(y)) ? Math.round(Number(y)) : 0;
    const mutation = [
      `proccode="${escapeXmlAttribute(data.proccode)}"`,
      `argumentids="${escapeXmlAttribute(JSON.stringify(data.argumentIds))}"`,
      `argumentnames="${escapeXmlAttribute(JSON.stringify(data.argumentNames))}"`,
      `argumentdefaults="${escapeXmlAttribute(JSON.stringify(data.argumentDefaults))}"`,
      'warp="false"'
    ].join(' ');
    return {
      xml: `<xml xmlns="https://developers.google.com/blockly/xml"><block type="procedures_definition" x="${safeX}" y="${safeY}"><statement name="custom_block"><block type="procedures_prototype"><mutation ${mutation}></mutation></block></statement></block></xml>`,
      data
    };
  }

  function removeCreatedScratchVariables(vm, ids) {
    if (!vm || !ids) return;
    for (const id of ids) {
      try {
        deleteScratchVmVariable(vm, id);
      } catch {
        // Ignore rollback failures.
      }
    }
  }

  function connectNestedBlock(parentInput, child, inputName) {
    const candidates = [];
    try {
      if (child.outputConnection) candidates.push(child.outputConnection);
      if (child.previousConnection) candidates.push(child.previousConnection);
    } catch {
      // Ignore.
    }

    const targetConnection = parentInput && parentInput.connection;
    if (!targetConnection) {
      throw new BridgeError('INVALID_INPUT', `Input "${inputName}" cannot accept a block.`);
    }

    const compatible = candidates.find((connection) => {
      try {
        return connection.type === targetConnection.type;
      } catch {
        return false;
      }
    }) || candidates[0];

    if (!compatible) {
      throw new BridgeError('INCOMPATIBLE_BLOCK', `The block supplied for input "${inputName}" has no compatible connection.`);
    }

    try {
      targetConnection.connect(compatible);
    } catch (error) {
      throw new BridgeError('CONNECTION_FAILED', `Could not connect the block into input "${inputName}".`, {
        cause: asSafeString(error && error.message, 700)
      });
    }
  }

  function createBlockTree(workspace, spec, context, depth) {
    if (depth > MAX_NESTING_DEPTH) {
      throw new BridgeError('BLOCK_NESTING_TOO_DEEP', `Block nesting exceeds the maximum depth of ${MAX_NESTING_DEPTH}.`);
    }
    if (!isPlainObject(spec)) {
      throw new BridgeError('INVALID_BLOCK_SPEC', 'Each block specification must be an object.');
    }
    if (context.count >= MAX_BLOCKS_PER_ADD) {
      throw new BridgeError('TOO_MANY_BLOCKS', `A single add request may create at most ${MAX_BLOCKS_PER_ADD} blocks.`);
    }

    const type = typeof spec.type === 'string' ? spec.type.trim() : '';
    if (!type || type.length > 120 || !/^[A-Za-z0-9_.:-]+$/.test(type)) {
      throw new BridgeError('INVALID_BLOCK_TYPE', 'Block type must be a registered type name such as "controls_if".');
    }
    validateBlockType(type);

    let block;
    try {
      block = workspace.newBlock(type);
    } catch (error) {
      throw new BridgeError('BLOCK_CREATE_FAILED', `Could not create block type "${type}".`, {
        cause: asSafeString(error && error.message, 700)
      });
    }
    if (!block) {
      throw new BridgeError('BLOCK_CREATE_FAILED', `Blockly returned no block for type "${type}".`);
    }

    context.count += 1;
    context.blocks.push(block);

    let procedureInfo = null;
    if (spec.procedure !== undefined) {
      if (type !== 'procedures_call') {
        throw new BridgeError('PROCEDURE_REFERENCE_NOT_SUPPORTED', 'The procedure property is only supported on procedures_call blocks. Use createProcedure to create a definition.');
      }
      procedureInfo = applyProcedureCallMutation(workspace, block, spec, context);
    }

    if (spec.fields !== undefined) {
      if (!isPlainObject(spec.fields)) {
        throw new BridgeError('INVALID_FIELDS', 'The fields property must be an object mapping field names to values.');
      }
      const fieldEntries = Object.entries(spec.fields);
      if (fieldEntries.length > MAX_FIELDS) {
        throw new BridgeError('TOO_MANY_FIELDS', `A block may set at most ${MAX_FIELDS} fields.`);
      }
      for (const [fieldName, fieldValue] of fieldEntries) {
        if (!fieldName || fieldName === '__proto__' || fieldName === 'constructor' || fieldName === 'prototype') {
          throw new BridgeError('INVALID_FIELD_NAME', `The field name "${fieldName}" is not allowed.`);
        }
        if (typeof block.getField === 'function' && !block.getField(fieldName)) {
          throw new BridgeError('UNKNOWN_FIELD', `Block type "${type}" has no field named "${fieldName}".`, {
            availableFields: fieldNamesFor(block)
          });
        }
        try {
          setBlockFieldValue(workspace, block, fieldName, fieldValue);
        } catch (error) {
          if (error instanceof BridgeError) throw error;
          throw new BridgeError('FIELD_SET_FAILED', `Could not set field "${fieldName}" on block type "${type}".`, {
            availableFields: fieldNamesFor(block),
            cause: asSafeString(error && error.message, 700)
          });
        }
      }
    }

    if (spec.inputs !== undefined) {
      if (!isPlainObject(spec.inputs)) {
        throw new BridgeError('INVALID_INPUTS', 'The inputs property must be an object mapping input names to nested block specifications.');
      }
      const inputEntries = Object.entries(spec.inputs);
      if (inputEntries.length > MAX_INPUTS) {
        throw new BridgeError('TOO_MANY_INPUTS', `A block may connect at most ${MAX_INPUTS} inputs.`);
      }
      for (const [inputName, childSpec] of inputEntries) {
        if (!inputName || inputName === '__proto__' || inputName === 'constructor' || inputName === 'prototype') {
          throw new BridgeError('INVALID_INPUT_NAME', `The input name "${inputName}" is not allowed.`);
        }
        const actualInputName = procedureInfo && procedureInfo.argumentNameToId && procedureInfo.argumentNameToId[inputName]
          ? procedureInfo.argumentNameToId[inputName]
          : inputName;
        let input = null;
        try {
          input = block.getInput(actualInputName);
        } catch {
          input = null;
        }
        if (!input) {
          throw new BridgeError('UNKNOWN_INPUT', `Block type "${type}" has no input named "${inputName}".`, {
            availableInputs: inputNamesFor(block)
          });
        }
        const child = createBlockTree(workspace, childSpec, context, depth + 1);
        connectNestedBlock(input, child, actualInputName);
      }
    }

    if (spec.next !== undefined) {
      if (!isPlainObject(spec.next)) {
        throw new BridgeError('INVALID_NEXT_BLOCK', 'The next property must contain a block specification object.');
      }
      if (!block.nextConnection) {
        throw new BridgeError('NO_NEXT_CONNECTION', `Block type "${type}" cannot connect a following block.`);
      }
      const nextBlock = createBlockTree(workspace, spec.next, context, depth + 1);
      if (!nextBlock.previousConnection) {
        throw new BridgeError('INCOMPATIBLE_NEXT_BLOCK', 'The following block has no previous connection.');
      }
      try {
        block.nextConnection.connect(nextBlock.previousConnection);
      } catch (error) {
        throw new BridgeError('CONNECTION_FAILED', `Could not connect the next block after "${type}".`, {
          cause: asSafeString(error && error.message, 700)
        });
      }
    }

    return block;
  }

  function initializeAndRender(workspace, topBlock) {
    let descendants = [topBlock];
    try {
      const list = topBlock.getDescendants(false);
      if (Array.isArray(list) && list.length) descendants = list;
    } catch {
      descendants = [topBlock];
    }

    if (workspace.rendered) {
      for (let index = descendants.length - 1; index >= 0; index -= 1) {
        const block = descendants[index];
        try {
          if (typeof block.initSvg === 'function') block.initSvg();
        } catch (error) {
          throw new BridgeError('BLOCK_RENDER_FAILED', 'A new block could not be initialized for rendering.', {
            cause: asSafeString(error && error.message, 700)
          });
        }
      }

      for (let index = descendants.length - 1; index >= 0; index -= 1) {
        const block = descendants[index];
        try {
          if (typeof block.queueRender === 'function') {
            const pending = block.queueRender();
            if (pending && typeof pending.catch === 'function') pending.catch(() => {});
          } else if (typeof block.render === 'function') {
            block.render();
          }
        } catch {
          // A non-critical render failure should not undo a valid block tree.
        }
      }

      try {
        if (typeof topBlock.render === 'function') topBlock.render();
      } catch {
        // Ignore a render failure; the block is still in the model.
      }
    } else {
      for (let index = descendants.length - 1; index >= 0; index -= 1) {
        const block = descendants[index];
        if (typeof block.initModel === 'function') block.initModel();
      }
    }

    try {
      if (typeof workspace.resizeContents === 'function') workspace.resizeContents();
    } catch {
      // Ignore.
    }
  }

  function positionBlock(workspace, block, args) {
    const hasX = Object.prototype.hasOwnProperty.call(args, 'x');
    const hasY = Object.prototype.hasOwnProperty.call(args, 'y');
    let x = hasX ? safeNumber(args.x) : null;
    let y = hasY ? safeNumber(args.y) : null;

    if (hasX && x === null) throw new BridgeError('INVALID_POSITION', 'The x coordinate must be a finite number.');
    if (hasY && y === null) throw new BridgeError('INVALID_POSITION', 'The y coordinate must be a finite number.');

    if (x === null || y === null) {
      let topBlockCount = 0;
      try {
        topBlockCount = workspace.getTopBlocks(false).length;
      } catch {
        topBlockCount = 0;
      }
      const scale = Number.isFinite(workspace.scale) && workspace.scale > 0 ? workspace.scale : 1;
      const scrollX = Number.isFinite(workspace.scrollX) ? workspace.scrollX : 0;
      const scrollY = Number.isFinite(workspace.scrollY) ? workspace.scrollY : 0;
      const offset = (topBlockCount % 8) * 36;
      if (x === null) x = (-scrollX / scale) + 36 + offset;
      if (y === null) y = (-scrollY / scale) + 36 + offset;
    }

    x = Math.max(-1000000, Math.min(1000000, x));
    y = Math.max(-1000000, Math.min(1000000, y));

    const { blockly } = getBlocklyContext();
    let moved = false;
    try {
      if (typeof block.moveTo === 'function' && blockly && blockly.utils && blockly.utils.Coordinate) {
        block.moveTo(new blockly.utils.Coordinate(x, y));
        moved = true;
      }
    } catch {
      moved = false;
    }

    if (!moved && typeof block.moveBy === 'function') {
      try {
        block.moveBy(x, y);
        moved = true;
      } catch {
        moved = false;
      }
    }

    let position = { x, y };
    try {
      if (typeof block.getRelativeToSurfaceXY === 'function') {
        const current = block.getRelativeToSurfaceXY();
        if (current && Number.isFinite(current.x) && Number.isFinite(current.y)) {
          position = { x: Math.round(current.x), y: Math.round(current.y) };
        }
      }
    } catch {
      // Use the requested position.
    }
    return position;
  }

  function cleanupAfterFailedAdd(workspace, context, preXml, previousSnapshot, key) {
    let restored = false;
    try {
      restoreWorkspaceXml(workspace, preXml);
      restored = true;
    } catch {
      for (let index = context.blocks.length - 1; index >= 0; index -= 1) {
        try {
          context.blocks[index].dispose(false);
        } catch {
          // Ignore cleanup failures.
        }
      }
    }

    if (context && context.vm && Array.isArray(context.createdVariableIds) && context.createdVariableIds.length) {
      removeCreatedScratchVariables(context.vm, context.createdVariableIds);
    }
    if (previousSnapshot) snapshots.set(key, previousSnapshot);
    else snapshots.delete(key);
    return restored;
  }

  function getScratchVariableIdsBefore() {
    const vmInfo = getScratchVm();
    return vmInfo && vmInfo.vm ? Array.from(getScratchVmVariableIds(vmInfo.vm)) : null;
  }

  function removeNewScratchVariablesAfterUndo(snapshot) {
    if (!snapshot) return;
    const vmInfo = getScratchVm();
    if (!vmInfo || !vmInfo.vm) return;
    let created = [];
    if (Array.isArray(snapshot.scratchCreatedVariableIds)) {
      created = snapshot.scratchCreatedVariableIds;
    } else if (Array.isArray(snapshot.scratchVariableIdsBefore)) {
      const before = new Set(snapshot.scratchVariableIdsBefore);
      const current = getScratchVmVariableIds(vmInfo.vm);
      created = Array.from(current).filter((id) => !before.has(id));
    }
    removeCreatedScratchVariables(vmInfo.vm, created);
  }

  function syncWorkspaceVariablesFromScratchVm(workspace) {
    const vmInfo = getScratchVm();
    if (!vmInfo || !vmInfo.vm) return;
    const targets = [];
    try {
      if (vmInfo.vm.editingTarget) targets.push(vmInfo.vm.editingTarget);
      if (vmInfo.vm.runtime && typeof vmInfo.vm.runtime.getTargetForStage === 'function') {
        const stage = vmInfo.vm.runtime.getTargetForStage();
        if (stage && !targets.includes(stage)) targets.push(stage);
      }
    } catch {
      return;
    }
    for (const target of targets) {
      let variables = {};
      try {
        variables = target.variables || {};
      } catch {
        variables = {};
      }
      for (const id of Object.keys(variables)) {
        const variable = variables[id];
        if (!variable || !variable.name) continue;
        if (findWorkspaceVariable(workspace, id)) continue;
        if (findWorkspaceVariable(workspace, variable.name)) continue;
        try {
          createWorkspaceVariable(workspace, variable.name, variable.type || '', id);
        } catch {
          // Ignore a variable that Blockly will not accept.
        }
      }
    }
  }

  async function addBlock(args) {
    if (!isPlainObject(args)) {
      throw new BridgeError('INVALID_ARGUMENT', 'addBlock expects an object containing a block type.');
    }
    if (Array.isArray(args.blocks)) {
      if (args.type !== undefined) {
        throw new BridgeError('INVALID_ARGUMENT', 'Use either type or blocks, not both.');
      }
      if (!args.blocks.length) {
        throw new BridgeError('INVALID_BLOCKS', 'The blocks array must contain at least one block specification.');
      }
      const blockSpecs = args.blocks.map((spec) => {
        if (!isPlainObject(spec) || typeof spec.type !== 'string' || !spec.type.trim()) {
          throw new BridgeError('INVALID_BLOCK', 'Each blocks entry must contain a block type.');
        }
        return spec;
      });
      const root = JSON.parse(JSON.stringify(blockSpecs[0]));
      let tail = root;
      for (let index = 1; index < blockSpecs.length; index += 1) {
        const next = JSON.parse(JSON.stringify(blockSpecs[index]));
        if (tail.next) {
          let nestedTail = tail.next;
          while (nestedTail.next) nestedTail = nestedTail.next;
          nestedTail.next = next;
        } else {
          tail.next = next;
        }
        tail = next;
      }
      args = { ...args, ...root };
      delete args.blocks;
    }
    const type = typeof args.type === 'string' ? args.type.trim() : '';
    if (!type) throw new BridgeError('INVALID_BLOCK_TYPE', 'A block type is required.');

    const variables = args.variables === undefined ? [] : args.variables;
    if (!Array.isArray(variables)) {
      throw new BridgeError('INVALID_VARIABLES', 'The variables property must be an array of variable names or variable objects.');
    }
    if (variables.length > MAX_VARIABLES_PER_ADD) {
      throw new BridgeError('TOO_MANY_VARIABLES', `A single add request may create at most ${MAX_VARIABLES_PER_ADD} variables.`);
    }

    const found = await requireWorkspace(4000);
    const workspace = found.workspace;
    assertEditable(workspace);

    const key = workspaceKey(workspace);
    const previousSnapshot = snapshots.get(key) || null;
    const preXml = captureWorkspaceXml(workspace);
    const vmInfo = getScratchVm();
    const context = {
      count: 0,
      blocks: [],
      vm: vmInfo && vmInfo.vm ? vmInfo.vm : null,
      createdVariableIds: []
    };
    const scratchVariableIdsBefore = getScratchVariableIdsBefore();
    const beforeVariableIds = getWorkspaceVariableIds(workspace);
    const createdVariables = [];
    let topBlock = null;

    try {
      for (const variableSpec of variables) {
        let name;
        let variableType;
        let scope;
        if (typeof variableSpec === 'string') {
          name = variableSpec;
        } else if (isPlainObject(variableSpec)) {
          name = variableSpec.name;
          variableType = variableSpec.type;
          scope = variableSpec.scope;
        } else {
          throw new BridgeError('INVALID_VARIABLE', 'Each entry in variables must be a variable name or an object with a name.');
        }
        const info = ensureScratchVariable(workspace, name, { type: variableType, scope });
        if (info.created) {
          context.createdVariableIds.push(info.id);
          createdVariables.push(info);
        }
      }

      topBlock = createBlockTree(workspace, args, context, 0);
      initializeAndRender(workspace, topBlock);
      const position = positionBlock(workspace, topBlock, args);
      if (context.procedureCalls && context.procedureCalls.length) {
        // Scratch's render pipeline can refresh its VM block copy asynchronously.
        // Let that settle, then apply the procedure mutation to the VM copy.
        await sleep(80);
        for (const callInfo of context.procedureCalls) {
          syncScratchProcedureCallBlock(callInfo.block, callInfo.data);
        }
      }
      cleanupAutoCreatedVariables(workspace, context, beforeVariableIds, new Set(context.createdVariableIds));
      const descriptor = describeWorkspace(workspace);
      rememberSnapshot(workspace, preXml, `Before adding ${type}`, {
        scratchVariableIdsBefore,
        scratchCreatedVariableIds: context.createdVariableIds.concat(context.autoVariableIds || [])
      });

      return {
        added: true,
        blockId: asSafeString(topBlock.id, 200),
        type: asSafeString(topBlock.type || type, 200),
        createdBlocks: context.count,
        createdVariables,
        position,
        workspace: descriptor,
        canUndo: true
      };
    } catch (error) {
      const cleanupSucceeded = cleanupAfterFailedAdd(workspace, context, preXml, previousSnapshot, key);
      if (error instanceof BridgeError) {
        if (!cleanupSucceeded) {
          error.message += ' The partial edit could not be rolled back completely.';
        }
        throw error;
      }
      throw new BridgeError('ADD_BLOCK_FAILED', 'The block could not be added.', {
        cause: asSafeString(error && error.message, 700),
        rolledBack: cleanupSucceeded
      });
    }
  }

  async function createVariable(args) {
    if (!isPlainObject(args)) {
      throw new BridgeError('INVALID_ARGUMENT', 'createVariable expects an object with a name.');
    }
    const requestedName = normalizeVariableName(args.name);

    const found = await requireWorkspace(4000);
    const workspace = found.workspace;
    assertEditable(workspace);

    const key = workspaceKey(workspace);
    const previousSnapshot = snapshots.get(key) || null;
    const preXml = captureWorkspaceXml(workspace);
    const vmInfo = getScratchVm();
    const context = {
      count: 0,
      blocks: [],
      vm: vmInfo && vmInfo.vm ? vmInfo.vm : null,
      createdVariableIds: []
    };
    const scratchVariableIdsBefore = getScratchVariableIdsBefore();

    try {
      const info = ensureScratchVariable(workspace, requestedName, {
        type: args.type,
        scope: args.scope
      });
      if (info.created) context.createdVariableIds.push(info.id);
      const changed = Boolean(info.created || info.workspaceCreated || info.vmCreated);
      if (changed) {
        rememberSnapshot(workspace, preXml, `Before creating variable ${info.name}`, {
          scratchVariableIdsBefore,
          scratchCreatedVariableIds: context.createdVariableIds.slice()
        });
        await refreshScratchVariableUi(workspace, context.vm);
      }
      return {
        created: Boolean(info.created),
        id: info.id,
        name: info.name,
        type: info.type,
        scope: info.scope || (args.scope === 'local' ? 'local' : 'global'),
        workspace: describeWorkspace(workspace),
        canUndo: changed || Boolean(previousSnapshot)
      };
    } catch (error) {
      const cleanupSucceeded = cleanupAfterFailedAdd(workspace, context, preXml, previousSnapshot, key);
      if (error instanceof BridgeError) {
        if (!cleanupSucceeded) error.message += ' The partial edit could not be rolled back completely.';
        throw error;
      }
      throw new BridgeError('VARIABLE_CREATE_FAILED', 'The variable could not be created.', {
        cause: asSafeString(error && error.message, 700),
        rolledBack: cleanupSucceeded
      });
    }
  }

  async function createProcedure(args) {
    if (!isPlainObject(args)) {
      throw new BridgeError('INVALID_ARGUMENT', 'createProcedure expects an object with a name.');
    }
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) throw new BridgeError('INVALID_PROCEDURE_NAME', 'A procedure name is required.');

    const procedureArguments = normalizeProcedureArguments(args.arguments);
    const generated = buildProcedureDefinitionXml(name, procedureArguments, args.x, args.y);

    const found = await requireWorkspace(4000);
    const workspace = found.workspace;
    assertEditable(workspace);

    const key = workspaceKey(workspace);
    const previousSnapshot = snapshots.get(key) || null;
    const existing = findProcedureDefinition(workspace, generated.data.proccode);
    if (existing) {
      return {
        created: false,
        name: existing.name,
        proccode: existing.proccode,
        definitionBlockId: existing.blockId,
        argumentIds: existing.argumentIds,
        argumentNames: existing.argumentNames,
        workspace: describeWorkspace(workspace),
        canUndo: Boolean(previousSnapshot),
        message: 'A procedure with this name and argument list already exists.'
      };
    }

    const preXml = captureWorkspaceXml(workspace);
    const vmInfo = getScratchVm();
    const context = {
      count: 0,
      blocks: [],
      vm: vmInfo && vmInfo.vm ? vmInfo.vm : null,
      createdVariableIds: []
    };
    const scratchVariableIdsBefore = getScratchVariableIdsBefore();
    const beforeVariableIds = getWorkspaceVariableIds(workspace);
    const beforeBlockIds = new Set();
    try {
      for (const block of workspace.getAllBlocks(false) || []) {
        if (block && block.id) beforeBlockIds.add(block.id);
      }
    } catch {
      // Ignore.
    }

    try {
      const { blockly } = getBlocklyContext();
      const { xml: xmlApi } = ensureSnapshotSupport();
      const dom = textToXmlDom(blockly, xmlApi, generated.xml);
      const createdBlocks = xmlApi.domToWorkspace(dom, workspace);
      let definition = Array.isArray(createdBlocks)
        ? createdBlocks.find((block) => block && block.type === 'procedures_definition')
        : null;
      if (!definition) {
        try {
          definition = (workspace.getAllBlocks(false) || []).find(
            (block) => block && block.type === 'procedures_definition' && block.id && !beforeBlockIds.has(block.id)
          ) || null;
        } catch {
          definition = null;
        }
      }
      if (!definition) {
        throw new BridgeError('PROCEDURE_CREATE_FAILED', 'The procedure definition was not created by Blockly.');
      }

      const position = positionBlock(workspace, definition, args);
      let bodyBlock = null;
      if (args.body !== undefined && args.body !== null) {
        if (!isPlainObject(args.body)) {
          throw new BridgeError('INVALID_PROCEDURE_BODY', 'The procedure body must be a block specification object.');
        }
        bodyBlock = createBlockTree(workspace, args.body, context, 0);
        if (!bodyBlock.previousConnection) {
          throw new BridgeError('INCOMPATIBLE_PROCEDURE_BODY', 'The first procedure body block must have a previous connection.');
        }
        if (!definition.nextConnection) {
          throw new BridgeError('INCOMPATIBLE_PROCEDURE_BODY', 'This procedure definition cannot accept a body.');
        }
        initializeAndRender(workspace, bodyBlock);
        try {
          definition.nextConnection.connect(bodyBlock.previousConnection);
        } catch (error) {
          throw new BridgeError('CONNECTION_FAILED', 'The procedure body could not be connected to the definition.', {
            cause: asSafeString(error && error.message, 700)
          });
        }
      }

      let callBlock = null;
      if (args.createCall === true) {
        const callArgs = {
          type: 'procedures_call',
          procedure: {
            proccode: generated.data.proccode,
            argumentIds: generated.data.argumentIds
          },
          x: args.callX,
          y: args.callY
        };
        callBlock = createBlockTree(workspace, callArgs, context, 0);
        initializeAndRender(workspace, callBlock);
        positionBlock(workspace, callBlock, callArgs);
      }

      try {
        if (typeof definition.render === 'function') definition.render();
        if (typeof workspace.resizeContents === 'function') workspace.resizeContents();
      } catch {
        // Ignore non-critical render failures.
      }

      if (context.procedureCalls && context.procedureCalls.length) {
        await sleep(80);
        for (const callInfo of context.procedureCalls) {
          syncScratchProcedureCallBlock(callInfo.block, callInfo.data);
        }
      }
      cleanupAutoCreatedVariables(workspace, context, beforeVariableIds, new Set());

      rememberSnapshot(workspace, preXml, `Before creating procedure ${generated.data.proccode}`, {
        scratchVariableIdsBefore,
        scratchCreatedVariableIds: context.createdVariableIds.concat(context.autoVariableIds || [])
      });

      return {
        created: true,
        name: generated.data.proccode,
        proccode: generated.data.proccode,
        definitionBlockId: asSafeString(definition.id, 200),
        bodyBlockId: bodyBlock ? asSafeString(bodyBlock.id, 200) : '',
        callBlockId: callBlock ? asSafeString(callBlock.id, 200) : '',
        argumentIds: generated.data.argumentIds,
        argumentNames: generated.data.argumentNames,
        position,
        workspace: describeWorkspace(workspace),
        canUndo: true
      };
    } catch (error) {
      const cleanupSucceeded = cleanupAfterFailedAdd(workspace, context, preXml, previousSnapshot, key);
      if (error instanceof BridgeError) {
        if (!cleanupSucceeded) error.message += ' The partial edit could not be rolled back completely.';
        throw error;
      }
      throw new BridgeError('PROCEDURE_CREATE_FAILED', 'The procedure could not be created.', {
        cause: asSafeString(error && error.message, 700),
        rolledBack: cleanupSucceeded
      });
    }
  }

  async function editBlock(args) {
    if (!isPlainObject(args)) {
      throw new BridgeError('INVALID_ARGUMENT', 'editBlock expects an object with blockId and fields.');
    }
    const blockId = typeof args.blockId === 'string' ? args.blockId.trim() : '';
    if (!blockId) throw new BridgeError('INVALID_ARGUMENT', 'editBlock requires a blockId string.');

    const found = await requireWorkspace(4000);
    const workspace = found.workspace;
    assertEditable(workspace);

    const block = (
      (typeof workspace.getBlockById === 'function' && workspace.getBlockById(blockId)) ||
      (typeof workspace.getById === 'function' && workspace.getById(blockId)) ||
      (workspace.blockDB_ && workspace.blockDB_[blockId]) ||
      null
    );
    if (!block) {
      throw new BridgeError('BLOCK_NOT_FOUND', `No block with id "${asSafeString(blockId, 200)}" found in the workspace.`);
    }

    const key = workspaceKey(workspace);
    const previousSnapshot = snapshots.get(key) || null;
    const preXml = captureWorkspaceXml(workspace);

    const fieldsToSet = isPlainObject(args.fields) ? args.fields : {};
    const fieldNames = Object.keys(fieldsToSet);
    if (fieldNames.length > MAX_FIELDS) {
      throw new BridgeError('TOO_MANY_FIELDS', `A single edit may set at most ${MAX_FIELDS} fields.`);
    }

    const changed = [];
    try {
      for (const fieldName of fieldNames) {
        const rawValue = fieldsToSet[fieldName];
        try {
          if (rawValue === null || rawValue === undefined) {
            block.setFieldValue('', fieldName);
          } else {
            setBlockFieldValue(workspace, block, fieldName, rawValue);
          }
          changed.push(fieldName);
        } catch (fieldError) {
          if (fieldError instanceof BridgeError) throw fieldError;
          throw new BridgeError('FIELD_SET_FAILED', `Could not set field "${asSafeString(fieldName, 80)}" on block "${asSafeString(blockId, 200)}".`, {
            cause: asSafeString(fieldError && fieldError.message, 300)
          });
        }
      }

      if (workspace.rendered) {
        try { block.render(); } catch { /* Non-fatal render refresh failure. */ }
      }

      rememberSnapshot(workspace, preXml, `Before editing block ${blockId}`);
      return {
        edited: true,
        blockId: asSafeString(block.id, 200),
        type: asSafeString(block.type, 200),
        changedFields: changed,
        canUndo: true
      };
    } catch (error) {
      // Roll back on failure.
      try {
        restoreWorkspaceXml(workspace, preXml);
        if (previousSnapshot) snapshots.set(key, previousSnapshot);
        else snapshots.delete(key);
      } catch {
        // Ignore rollback failure.
      }
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('EDIT_BLOCK_FAILED', 'The block could not be edited.', {
        cause: asSafeString(error && error.message, 700)
      });
    }
  }

  async function deleteBlock(args) {
    if (!isPlainObject(args)) {
      throw new BridgeError('INVALID_ARGUMENT', 'deleteBlock expects an object with blockId.');
    }
    const blockId = typeof args.blockId === 'string' ? args.blockId.trim() : '';
    if (!blockId) throw new BridgeError('INVALID_ARGUMENT', 'deleteBlock requires a blockId string.');

    const found = await requireWorkspace(4000);
    const workspace = found.workspace;
    assertEditable(workspace);

    const block = (
      (typeof workspace.getBlockById === 'function' && workspace.getBlockById(blockId)) ||
      (typeof workspace.getById === 'function' && workspace.getById(blockId)) ||
      (workspace.blockDB_ && workspace.blockDB_[blockId]) ||
      null
    );
    if (!block) {
      throw new BridgeError('BLOCK_NOT_FOUND', `No block with id "${asSafeString(blockId, 200)}" found in the workspace.`);
    }

    const key = workspaceKey(workspace);
    const previousSnapshot = snapshots.get(key) || null;
    const preXml = captureWorkspaceXml(workspace);
    const blockType = asSafeString(block.type, 200);

    try {
      // healStack reconnects parent/child stacks around the removed block if possible.
      block.dispose(/* healStack */ true);
      if (workspace.rendered && typeof workspace.resizeContents === 'function') {
        workspace.resizeContents();
      }
      rememberSnapshot(workspace, preXml, `Before deleting block ${blockId}`);
      return {
        deleted: true,
        blockId: asSafeString(blockId, 200),
        type: blockType,
        canUndo: true
      };
    } catch (error) {
      try {
        restoreWorkspaceXml(workspace, preXml);
        if (previousSnapshot) snapshots.set(key, previousSnapshot);
        else snapshots.delete(key);
      } catch {
        // Ignore rollback failure.
      }
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('DELETE_BLOCK_FAILED', 'The block could not be deleted.', {
        cause: asSafeString(error && error.message, 700)
      });
    }
  }

  async function clearWorkspace(args) {
    if (!isPlainObject(args)) {
      throw new BridgeError('INVALID_ARGUMENT', 'clearWorkspace expects an object with a confirm flag.');
    }
    if (args.confirm !== true) {
      throw new BridgeError(
        'CONFIRMATION_REQUIRED',
        'Clearing the workspace is destructive. Call clearWorkspace again with confirm: true only after the user explicitly asks to delete everything.'
      );
    }

    const found = await requireWorkspace(4000);
    const workspace = found.workspace;
    assertEditable(workspace);

    const key = workspaceKey(workspace);
    const previousSnapshot = snapshots.get(key) || null;
    const before = describeWorkspace(workspace);
    if (before.blockCount === 0 && before.variableCount === 0 && before.commentCount === 0) {
      return {
        cleared: false,
        removedBlocks: 0,
        removedVariables: 0,
        removedComments: 0,
        workspace: before,
        canUndo: Boolean(previousSnapshot),
        message: 'The workspace was already empty.'
      };
    }

    const preXml = captureWorkspaceXml(workspace);
    try {
      workspace.clear();
      if (typeof workspace.resizeContents === 'function') workspace.resizeContents();
      rememberSnapshot(workspace, preXml, 'Before clearing the workspace');
      return {
        cleared: true,
        removedBlocks: before.blockCount,
        removedTopBlocks: before.topBlockCount,
        removedVariables: before.variableCount,
        removedComments: before.commentCount,
        workspace: describeWorkspace(workspace),
        canUndo: true
      };
    } catch (error) {
      let restored = false;
      try {
        restoreWorkspaceXml(workspace, preXml);
        restored = true;
      } catch {
        restored = false;
      }
      if (previousSnapshot) snapshots.set(key, previousSnapshot);
      else snapshots.delete(key);
      throw new BridgeError('CLEAR_FAILED', 'The workspace could not be cleared and was restored.', {
        cause: asSafeString(error && error.message, 700),
        restored
      });
    }
  }

  async function undoLastMutation() {
    const found = await requireWorkspace(4000);
    const workspace = found.workspace;
    assertEditable(workspace);
    const key = workspaceKey(workspace);
    const snapshot = snapshots.get(key);
    if (!snapshot) {
      throw new BridgeError('NO_UNDO', 'There is no AI edit to undo on this workspace.');
    }

    restoreWorkspaceXml(workspace, snapshot.xml);
    removeNewScratchVariablesAfterUndo(snapshot);
    syncWorkspaceVariablesFromScratchVm(workspace);
    snapshots.delete(key);
    return {
      restored: true,
      label: snapshot.label,
      ageMs: Math.max(0, Date.now() - snapshot.at),
      workspace: describeWorkspace(workspace),
      canUndo: false
    };
  }

  async function getWorkspaceStatus(waitMilliseconds = 2000) {
    const found = await waitForWorkspace(waitMilliseconds);
    const diagnostics = getDiagnostics();
    if (!found) {
      return {
        found: false,
        diagnostics,
        hint: diagnostics.hint
      };
    }

    const descriptor = describeWorkspace(found.workspace);
    const canEdit = supportsSnapshots(found.workspace) && !descriptor.readOnly;
    return {
      found: true,
      workspace: descriptor,
      source: found.source,
      canEdit,
      canUndo: snapshots.has(workspaceKey(found.workspace)),
      diagnostics,
      hint: canEdit
        ? 'Ready to inspect and edit.'
        : descriptor.readOnly
          ? 'This workspace is read-only. It can be inspected, but not edited.'
          : 'This workspace can be inspected, but safe editing requires the Blockly XML API to be exposed.'
    };
  }

  function summarizeBlock(block, depth, budget, seen) {
    if (!block || typeof block !== 'object') return null;
    if (budget.remaining <= 0 || budget.chars >= MAX_SUMMARY_CHARS) {
      budget.truncated = true;
      return null;
    }

    let id = '';
    try {
      id = asSafeString(block.id, 200);
    } catch {
      id = '';
    }
    if (id && seen.has(id)) {
      return { type: '__cycle__', id };
    }
    if (id) seen.add(id);

    budget.remaining -= 1;
    budget.chars += 32;

    const node = {
      type: asSafeString(block.type || 'unknown', 160)
    };
    if (id) node.id = id;

    const fields = {};
    let fieldsTruncated = false;
    try {
      for (const input of block.inputList || []) {
        for (const field of input.fieldRow || []) {
          if (!field || !field.name) continue;
          let value;
          try {
            value = block.getFieldValue(field.name);
          } catch {
            continue;
          }
          if (value === undefined || value === null) continue;
          let text = asSafeString(value, MAX_FIELD_CHARS + 1);
          if (text.length > MAX_FIELD_CHARS) {
            text = `${text.slice(0, MAX_FIELD_CHARS)}...`;
            fieldsTruncated = true;
          }
          fields[field.name] = text;
          budget.chars += field.name.length + text.length + 8;
        }
      }
    } catch {
      // Ignore field failures.
    }
    if (Object.keys(fields).length) node.fields = fields;
    if (fieldsTruncated) node.fieldsTruncated = true;

    try {
      if (block.disabled) node.disabled = true;
      if (block.collapsed) node.collapsed = true;
    } catch {
      // Ignore.
    }

    try {
      if (typeof block.getCommentText === 'function') {
        const comment = block.getCommentText();
        if (comment) node.comment = asSafeString(comment, 500);
      }
    } catch {
      // Ignore.
    }

    if (depth < MAX_NESTING_DEPTH + 2) {
      const inputs = {};
      for (const input of block.inputList || []) {
        if (!input || !input.connection || !input.name) continue;
        let child = null;
        try {
          child = typeof input.connection.targetBlock === 'function'
            ? input.connection.targetBlock()
            : null;
        } catch {
          child = null;
        }
        if (!child) continue;
        const childNode = summarizeBlock(child, depth + 1, budget, seen);
        if (childNode) {
          inputs[input.name] = childNode;
          budget.chars += input.name.length + 12;
        }
        if (budget.chars >= MAX_SUMMARY_CHARS) {
          budget.truncated = true;
          break;
        }
      }
      if (Object.keys(inputs).length) node.inputs = inputs;

      let nextBlock = null;
      try {
        nextBlock = block.nextConnection && typeof block.nextConnection.targetBlock === 'function'
          ? block.nextConnection.targetBlock()
          : null;
      } catch {
        nextBlock = null;
      }
      if (nextBlock && budget.chars < MAX_SUMMARY_CHARS) {
        const nextNode = summarizeBlock(nextBlock, depth + 1, budget, seen);
        if (nextNode) node.next = nextNode;
      }
    }

    return node;
  }

  function buildSummary(workspace, maxBlocks) {
    let topBlocks = [];
    try {
      topBlocks = workspace.getTopBlocks(true);
    } catch {
      topBlocks = [];
    }

    let blockCount = 0;
    try {
      blockCount = workspace.getAllBlocks(false).length;
    } catch {
      blockCount = 0;
    }

    const budget = {
      remaining: maxBlocks,
      chars: 0,
      truncated: blockCount > maxBlocks
    };
    const seen = new Set();
    const summarizedTopBlocks = [];

    for (let index = 0; index < topBlocks.length; index += 1) {
      if (budget.remaining <= 0 || budget.chars >= MAX_SUMMARY_CHARS) {
        budget.truncated = true;
        break;
      }
      const topBlock = topBlocks[index];
      const node = summarizeBlock(topBlock, 0, budget, seen);
      if (!node) {
        budget.truncated = true;
        break;
      }
      try {
        if (typeof topBlock.getRelativeToSurfaceXY === 'function') {
          const position = topBlock.getRelativeToSurfaceXY();
          if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
            node.x = Math.round(position.x);
            node.y = Math.round(position.y);
          }
        }
      } catch {
        // Ignore.
      }
      summarizedTopBlocks.push(node);
    }

    const variables = getWorkspaceVariableList(workspace);
    const procedures = getProcedureDefinitions(workspace);
    return {
      blockCount,
      topBlockCount: topBlocks.length,
      maxBlocks,
      variables,
      variableCount: variables.length,
      procedures,
      procedureCount: procedures.length,
      topBlocks: summarizedTopBlocks,
      comments: summarizeWorkspaceComments(workspace),
      truncated: budget.truncated,
      charsApprox: budget.chars
    };
  }

  function summarizeWorkspaceComments(workspace) {
    const comments = [];
    try {
      if (typeof workspace.getTopComments !== 'function') return comments;
      const topComments = workspace.getTopComments(false);
      if (!Array.isArray(topComments)) return comments;
      for (const comment of topComments.slice(0, 20)) {
        const item = {
          text: asSafeString(comment.getText && comment.getText(), 500)
        };
        try {
          const id = comment.id;
          if (id) item.id = asSafeString(id, 200);
        } catch {
          // Ignore.
        }
        try {
          if (typeof comment.getRelativeToSurfaceXY === 'function') {
            const position = comment.getRelativeToSurfaceXY();
            if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
              item.x = Math.round(position.x);
              item.y = Math.round(position.y);
            }
          }
        } catch {
          // Ignore.
        }
        comments.push(item);
      }
    } catch {
      // Ignore comments if this Blockly version does not expose them.
    }
    return comments;
  }

  function collectToolboxTypes(workspace) {
    const types = new Set();
    let source = 'none';

    const addType = (value) => {
      if (typeof value !== 'string') return;
      const type = value.trim();
      if (!type || type.startsWith('_')) return;
      types.add(type);
    };

    const visitXml = (element) => {
      if (!element || element.nodeType !== 1) return;
      try {
        if ((element.tagName === 'block' || element.tagName === 'shadow') && element.getAttribute('type')) {
          addType(element.getAttribute('type'));
        }
        const nodes = element.querySelectorAll('block[type], shadow[type]');
        for (const node of nodes) addType(node.getAttribute('type'));
      } catch {
        // Ignore malformed toolboxes.
      }
    };

    const visitJson = (node) => {
      if (!node) return;
      if (typeof node === 'string') return;
      if (Array.isArray(node)) {
        for (const child of node) visitJson(child);
        return;
      }
      if (typeof node !== 'object') return;

      if ((node.kind === 'block' || node.kind === 'shadow') && typeof node.type === 'string') {
        addType(node.type);
      } else if (!node.kind && typeof node.type === 'string' && !node.contents) {
        addType(node.type);
      }

      if (Array.isArray(node.contents)) visitJson(node.contents);
      if (node.inputs && typeof node.inputs === 'object') {
        for (const value of Object.values(node.inputs)) {
          if (value && typeof value === 'object' && value.shadow) visitJson(value.shadow);
        }
      }
    };

    try {
      let toolbox = workspace.options && workspace.options.toolbox;
      if (!toolbox && typeof workspace.getToolbox === 'function') {
        const toolboxObject = workspace.getToolbox();
        if (toolboxObject) {
          toolbox = toolboxObject.toolboxDef_ || toolboxObject.toolboxDef || null;
        }
      }

      if (typeof toolbox === 'string' && toolbox.trim()) {
        if (toolbox.trim().startsWith('<')) {
          const documentNode = new DOMParser().parseFromString(toolbox, 'text/xml');
          visitXml(documentNode.documentElement);
          source = 'toolbox-xml';
        }
      } else if (toolbox && toolbox.nodeType === 1) {
        visitXml(toolbox);
        source = 'toolbox-xml';
      } else if (toolbox && typeof toolbox === 'object') {
        visitJson(toolbox);
        if (types.size) source = 'toolbox-json';
      }
    } catch {
      // Fall back to the registry below.
    }

    if (!types.size) {
      const registered = registeredBlockTypes();
      for (const type of registered) addType(type);
      source = registered.length ? 'registered-blocks' : 'none';
    }

    const allTypes = Array.from(types).sort();
    const limited = allTypes.slice(0, 300);
    return {
      types: limited,
      source,
      total: allTypes.length,
      truncated: allTypes.length > limited.length
    };
  }

  function connectionKind(connection) {
    if (!connection) return 'none';
    const type = connection.type;
    if (type === 1) return 'value-input';
    if (type === 2) return 'value-output';
    if (type === 3) return 'statement-input';
    if (type === 4) return 'statement-previous';
    return 'connection';
  }

  function connectionChecks(connection) {
    try {
      if (connection && typeof connection.getCheck === 'function') {
        const checks = connection.getCheck();
        return Array.isArray(checks) ? checks.slice(0, 20) : [];
      }
    } catch {
      // Ignore unavailable connection checks.
    }
    return [];
  }

  function describeBlockDefinition(workspace, type) {
    let block = null;
    try {
      block = workspace.newBlock(type);
      if (!block) return null;
      const fields = [];
      const inputs = [];
      for (const input of block.inputList || []) {
        if (!input) continue;
        const inputFields = [];
        const labels = [];
        for (const field of input.fieldRow || []) {
          if (!field) continue;
          let fieldText = '';
          try {
            fieldText = asSafeString(
              typeof field.getText === 'function' ? field.getText() : '',
              MAX_FIELD_CHARS
            );
          } catch {
            fieldText = '';
          }
          if (!field.name) {
            if (fieldText) labels.push(fieldText);
            continue;
          }
          const item = {
            name: asSafeString(field.name, 120),
            value: asSafeString(typeof block.getFieldValue === 'function'
              ? block.getFieldValue(field.name)
              : '', MAX_FIELD_CHARS)
          };
          try {
            item.text = fieldText || item.value;
            item.kind = field.constructor && field.constructor.name
              ? asSafeString(field.constructor.name, 100)
              : 'field';
          } catch {
            item.text = item.value;
            item.kind = 'field';
          }
          try {
            if (typeof field.getOptions === 'function') {
              const options = field.getOptions(false);
              if (Array.isArray(options) && options.length) {
                item.options = options.slice(0, 40).map((option) => Array.isArray(option)
                  ? [asSafeString(option[0], 160), asSafeString(option[1], 160)]
                  : asSafeString(option, 160));
              }
            }
          } catch {
            // Some custom fields do not expose options before rendering.
          }
          fields.push(item);
          inputFields.push(item);
        }
        if (input.name || input.connection || inputFields.length) {
          const inputInfo = {
            name: asSafeString(input.name || '', 120),
            kind: connectionKind(input.connection),
            checks: connectionChecks(input.connection)
          };
          if (inputFields.length) inputInfo.fields = inputFields;
          if (labels.length) inputInfo.labels = labels;
          inputs.push(inputInfo);
        }
      }
      const definition = {
        type,
        fields,
        inputs,
        previous: Boolean(block.previousConnection),
        next: Boolean(block.nextConnection),
        output: Boolean(block.outputConnection)
      };
      try {
        if (typeof block.toString === 'function') {
          definition.exampleText = asSafeString(block.toString(30), 500);
        }
      } catch {
        // Some custom blocks cannot render text before insertion.
      }
      try {
        if (typeof block.getTooltip === 'function') {
          const tooltip = block.getTooltip();
          if (typeof tooltip === 'string' && tooltip.trim()) {
            definition.tooltip = asSafeString(tooltip, 800);
          }
        }
      } catch {
        // Ignore custom tooltip failures.
      }
      return definition;
    } catch {
      return null;
    } finally {
      if (block) {
        try {
          block.dispose(false);
        } catch {
          // Ignore cleanup failures for a temporary inspection block.
        }
      }
    }
  }

  function collectBlockCatalog(workspace, toolboxInfo) {
    const types = toolboxInfo && Array.isArray(toolboxInfo.types)
      ? toolboxInfo.types
      : registeredBlockTypes();
    const catalog = [];
    for (const type of types.slice(0, 220)) {
      const definition = describeBlockDefinition(workspace, type);
      if (definition) catalog.push(definition);
    }
    return {
      blocks: catalog,
      total: types.length,
      included: catalog.length,
      truncated: types.length > 220
    };
  }

  async function getState(args) {
    const options = isPlainObject(args) ? args : {};
    const format = typeof options.format === 'string' ? options.format : 'summary';
    if (!['summary', 'xml', 'json', 'both'].includes(format)) {
      throw new BridgeError('INVALID_FORMAT', 'format must be one of: summary, xml, json, both.');
    }
    const maxBlocks = clampInteger(options.maxBlocks, 1, 500, 200);

    const found = await requireWorkspace(4000);
    const workspace = found.workspace;
    const descriptor = describeWorkspace(workspace);
    const summary = buildSummary(workspace, maxBlocks);
    const toolboxTypes = collectToolboxTypes(workspace);
    const warnings = [];

    const result = {
      found: true,
      workspace: descriptor,
      format,
      toolboxTypes,
      blockCatalog: collectBlockCatalog(workspace, toolboxTypes),
      summary,
      canUndo: snapshots.has(workspaceKey(workspace)),
      diagnostics: getDiagnostics(),
      warnings
    };

    if (format === 'xml' || format === 'both') {
      try {
        result.xml = serializeXml(workspace);
      } catch (error) {
        warnings.push({
          code: error instanceof BridgeError ? error.code : 'XML_UNAVAILABLE',
          message: asSafeString(error && error.message, 700)
        });
      }
    }

    if (format === 'json' || format === 'both') {
      try {
        result.json = serializeJson(workspace, summary);
      } catch (error) {
        warnings.push({
          code: error instanceof BridgeError ? error.code : 'JSON_UNAVAILABLE',
          message: asSafeString(error && error.message, 700)
        });
      }
    }

    return result;
  }

  async function handleCommand(command, args) {
    switch (command) {
      case 'status':
        return getWorkspaceStatus(2000);
      case 'getState':
        return getState(args);
      case 'addBlock':
        return addBlock(args);
      case 'createVariable':
        return createVariable(args);
      case 'createProcedure':
        return createProcedure(args);
      case 'editBlock':
        return editBlock(args);
      case 'deleteBlock':
        return deleteBlock(args);
      case 'clearWorkspace':
        return clearWorkspace(args);
      case 'undo':
        return undoLastMutation();
      default:
        throw new BridgeError('UNKNOWN_COMMAND', `Unknown Blockly bridge command: ${asSafeString(command, 120)}`);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== REQUEST_SOURCE) return;

    if (data.type === 'PING') {
      postToContent({ type: 'PONG', version: BRIDGE_VERSION, ready: true });
      return;
    }

    if (data.type !== 'TOOL_REQUEST') return;
    if (typeof data.id !== 'string' || !data.id) return;

    const requestId = data.id;
    const command = typeof data.command === 'string' ? data.command : '';
    const args = data.args === undefined ? {} : data.args;

    Promise.resolve()
      .then(() => handleCommand(command, args))
      .then((result) => {
        postToContent({ type: 'TOOL_RESULT', id: requestId, ok: true, result });
      })
      .catch((error) => {
        postToContent({ type: 'TOOL_RESULT', id: requestId, ok: false, error: toPublicError(error) });
      });
  });

  postToContent({ type: 'READY', version: BRIDGE_VERSION, ready: true });
})();
