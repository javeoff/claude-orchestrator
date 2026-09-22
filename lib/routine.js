// Client for the Claude Code routine "fire" endpoint.
// https://platform.claude.com/docs/en/api/claude-code/routines-fire
const API_BASE = 'https://api.anthropic.com/v1/claude_code/routines';
const BETA = process.env.ROUTINE_BETA || 'experimental-cc-routine-2026-04-01';
const MAX_TEXT = 65536;

// ROUTINE_URL may be the full /fire URL from the routine's API trigger modal,
// or just the trigger id (trig_...).
export function routineFireUrl() {
  const raw = (process.env.ROUTINE_URL || '').trim();
  if (!raw) throw new Error('ROUTINE_URL is not set');
  if (/^trig_[A-Za-z0-9]+$/.test(raw)) return `${API_BASE}/${raw}/fire`;
  const url = raw.replace(/\/+$/, '');
  return url.endsWith('/fire') ? url : `${url}/fire`;
}

export async function fireRoutine(text) {
  const key = process.env.ROUTINE_KEY;
  if (!key) throw new Error('ROUTINE_KEY is not set');
  if (text.length > MAX_TEXT) {
    throw new Error(`Task text is ${text.length} chars; the routine accepts at most ${MAX_TEXT}`);
  }
  const res = await fetch(routineFireUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': BETA,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Routine fire failed: HTTP ${res.status} ${body.slice(0, 500)}`);
  }
  const data = JSON.parse(body);
  return {
    session_id: data.claude_code_session_id,
    session_url: data.claude_code_session_url,
  };
}
