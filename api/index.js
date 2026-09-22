import { json } from '../lib/http.js';
import { storageKind } from '../lib/store.js';

export function GET() {
  return json({
    name: 'claude-routine-orchestrator',
    mcp_endpoint: '/mcp',
    auth: 'Bearer MCP_AUTH_TOKEN or /mcp?key=MCP_AUTH_TOKEN',
    configured: {
      routine: Boolean(process.env.ROUTINE_URL && process.env.ROUTINE_KEY),
      auth: Boolean(process.env.MCP_AUTH_TOKEN),
      storage: storageKind(),
    },
  });
}
