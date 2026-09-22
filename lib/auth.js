import { createHmac, timingSafeEqual } from 'node:crypto';

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// MCP clients authenticate with MCP_AUTH_TOKEN, either as a Bearer header or as
// ?key= in the URL (claude.ai custom connectors can only be given a URL).
export function checkMcpAuth(request) {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) return true;
  const header = request.headers.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const key = new URL(request.url).searchParams.get('key') || '';
  return (bearer && safeEqual(bearer, expected)) || (key && safeEqual(key, expected));
}

function reportSecret() {
  const secret = process.env.REPORT_SECRET || process.env.MCP_AUTH_TOKEN || process.env.ROUTINE_KEY;
  if (!secret) throw new Error('Set REPORT_SECRET (or MCP_AUTH_TOKEN) to sign report URLs');
  return secret;
}

// Per-task signature embedded in the report URL handed to the routine session,
// so a session can only report on its own task.
export function signTask(taskId) {
  return createHmac('sha256', reportSecret()).update(taskId).digest('base64url').slice(0, 32);
}

export function checkTaskSignature(taskId, sig) {
  return Boolean(taskId && sig) && safeEqual(signTask(taskId), sig);
}
