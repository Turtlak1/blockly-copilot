'use strict';

const http = require('http');
const readline = require('readline');

const port = Number(process.env.GROQ_BLOCKLY_MCP_PORT || 8765);
const token = process.env.GROQ_BLOCKLY_MCP_TOKEN || '';
const pending = [];
const results = new Map();
let nextId = 1;

const tools = [
  {
    name: 'getBlocklyWorkspaceState',
    description: 'Read the Blockly workspace selected in the Blockly Copilot extension.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['summary', 'xml', 'json', 'both'] },
        maxBlocks: { type: 'integer', minimum: 1, maximum: 500 }
      }
    }
  },
  {
    name: 'addBlockToWorkspace',
    description: 'Create a connected Blockly block tree in the selected workspace.',
    inputSchema: { type: 'object' }
  },
  {
    name: 'createVariable',
    description: 'Create a Blockly or Scratch variable.',
    inputSchema: { type: 'object' }
  },
  {
    name: 'createProcedure',
    description: 'Create a Scratch procedure/function.',
    inputSchema: { type: 'object' }
  },
  {
    name: 'editBlockInWorkspace',
    description: 'Edit fields on an existing Blockly block.',
    inputSchema: { type: 'object' }
  },
  {
    name: 'deleteBlockFromWorkspace',
    description: 'Delete one Blockly block.',
    inputSchema: { type: 'object' }
  },
  {
    name: 'clearWorkspace',
    description: 'Clear the Blockly workspace. Requires explicit confirmation.',
    inputSchema: { type: 'object' }
  }
];

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function jsonRpcError(id, code, message, data) {
  write({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function authorized(request) {
  return !token || request.headers['x-groq-blockly-token'] === token;
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function resolveCall(id, body) {
  const result = results.get(id);
  if (!result) return false;
  results.delete(id);
  result.resolve(body);
  return true;
}

const server = http.createServer((request, response) => {
  if (!authorized(request)) {
    sendJson(response, 401, { ok: false, error: 'Unauthorized' });
    return;
  }

  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, { ok: true, pending: pending.length });
    return;
  }

  if (request.method === 'GET' && request.url === '/next') {
    const call = pending.shift();
    sendJson(response, 200, call || null);
    return;
  }

  if (request.method === 'POST' && request.url.startsWith('/result/')) {
    const id = request.url.slice('/result/'.length);
    let text = '';
    request.on('data', (chunk) => { text += chunk; });
    request.on('end', () => {
      try {
        resolveCall(id, JSON.parse(text));
        sendJson(response, 200, { ok: true });
      } catch {
        sendJson(response, 400, { ok: false, error: 'Invalid JSON' });
      }
    });
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found' });
});

server.listen(port, '127.0.0.1', () => {
  process.stderr.write(`Blockly MCP bridge listening on http://127.0.0.1:${port}\n`);
});

async function handleRpc(request) {
  const { id, method, params = {} } = request;
  if (method === 'initialize') {
    return {
      protocolVersion: params.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'blockly-copilot', version: '1.0.0' }
    };
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'tools/list') return { tools };
  if (method === 'tools/call') {
    const name = params.name;
    if (!tools.some((tool) => tool.name === name)) {
      throw new Error(`Unknown Blockly tool: ${name}`);
    }
    const callId = String(nextId++);
    const promise = new Promise((resolve, reject) => {
      results.set(callId, { resolve, reject });
      setTimeout(() => {
        if (!results.has(callId)) return;
        results.delete(callId);
        reject(new Error('The Chrome extension did not respond within 60 seconds.'));
      }, 60000);
    });
    pending.push({ id: callId, name, arguments: params.arguments || {} });
    const result = await promise;
    if (!result || result.ok !== true) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(result && result.error ? result.error : result) }]
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result.result) }]
    };
  }
  if (request.id === undefined) return null;
  throw new Error(`Unsupported MCP method: ${method}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    jsonRpcError(null, -32700, 'Parse error');
    return;
  }
  if (request.id === undefined) {
    try { await handleRpc(request); } catch { /* Notifications have no response. */ }
    return;
  }
  try {
    write({ jsonrpc: '2.0', id: request.id, result: await handleRpc(request) });
  } catch (error) {
    jsonRpcError(request.id, -32602, error.message);
  }
});
