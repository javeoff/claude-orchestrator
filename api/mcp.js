// Stateless MCP server over Streamable HTTP (JSON responses, no SSE stream).
import { checkMcpAuth } from '../lib/auth.js';
import { baseUrl, json } from '../lib/http.js';
import { SERVER_INSTRUCTIONS, TOOLS, callTool } from '../lib/tools.js';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'claude-routine-orchestrator', title: 'Claude Routine Orchestrator', version: '1.0.0' };

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function handleMessage(msg, ctx) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg?.id, -32600, 'Invalid Request');
  }
  const isNotification = msg.id === undefined || msg.id === null;
  if (isNotification) return null;
  const result = (r) => ({ jsonrpc: '2.0', id: msg.id, result: r });

  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params?.protocolVersion;
      return result({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: TOOLS });
    case 'tools/call': {
      const out = await callTool(msg.params?.name, msg.params?.arguments || {}, ctx);
      if (!out) return rpcError(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
      return result(out);
    }
    case 'resources/list':
      return result({ resources: [] });
    case 'prompts/list':
      return result({ prompts: [] });
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function POST(request) {
  if (!checkMcpAuth(request)) {
    return json(rpcError(null, -32001, 'Unauthorized: pass MCP_AUTH_TOKEN as Bearer token or ?key='), 401, {
      'WWW-Authenticate': 'Bearer',
    });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json(rpcError(null, -32700, 'Parse error'), 400);
  }
  const ctx = { baseUrl: baseUrl(request) };
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map((m) => handleMessage(m, ctx)))).filter(Boolean);
    return responses.length ? json(responses) : new Response(null, { status: 202 });
  }
  const response = await handleMessage(body, ctx);
  return response ? json(response) : new Response(null, { status: 202 });
}

// No server-initiated stream and no sessions: GET/DELETE are not supported.
export function GET() {
  return json(rpcError(null, -32000, 'Method not allowed: use POST'), 405, { Allow: 'POST' });
}

export function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: 'POST' } });
}
