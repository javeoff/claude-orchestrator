// OAuth endpoints, routed here by vercel.json rewrites (?op=...):
//   /.well-known/oauth-protected-resource   → op=resource
//   /.well-known/oauth-authorization-server → op=metadata
//   /oauth/register | /oauth/authorize | /oauth/token
import { baseUrl, json } from '../lib/http.js';
import {
  OAuthError,
  authorizationServerMetadata,
  checkAuthorizeRequest,
  checkOwnerKey,
  exchange,
  issueCode,
  protectedResourceMetadata,
  registerClient,
} from '../lib/oauth.js';
import { claimOnce } from '../lib/store.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
};

const AUTHORIZE_PARAMS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'];

function oauthError(err) {
  if (!(err instanceof OAuthError)) {
    console.error('oauth error', err);
    return json({ error: 'server_error', error_description: err.message }, 500, CORS);
  }
  return json({ error: err.code, error_description: err.message }, err.status, { ...CORS, 'Cache-Control': 'no-store' });
}

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function consentPage(params, client, error) {
  const hidden = AUTHORIZE_PARAMS.filter((k) => params[k] !== undefined)
    .map((k) => `<input type="hidden" name="${k}" value="${escape(params[k])}">`)
    .join('');
  return new Response(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Routine Orchestrator</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--fg:#1c1b19;--muted:#6b6862;--line:#dedbd4;--accent:#c96442;--err:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#1c1b19;--card:#262522;--fg:#f0eee9;--muted:#a19e97;--line:#3a3833;--accent:#e08a6a;--err:#f2b8b5}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif;padding:16px}
form{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:18px;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}code{color:var(--fg)}
label{display:block;font-weight:600;margin-bottom:6px}input[type=password]{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
button{margin-top:16px;width:100%;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{color:var(--err);margin:12px 0 0}
</style></head><body>
<form method="post" action="/oauth/authorize">
<h1>Routine Orchestrator</h1>
<p>${escape(client.name || 'MCP client')} запрашивает доступ к запуску задач рутины. После подтверждения вы вернётесь на <code>${escape(client.redirectHost)}</code>.</p>
<label for="key">Ключ доступа (MCP_AUTH_TOKEN)</label>
<input id="key" name="key" type="password" autocomplete="current-password" required autofocus>
${hidden}
${error ? `<p class="err">${escape(error)}</p>` : ''}
<button type="submit">Разрешить доступ</button>
</form></body></html>`, {
    status: error ? 401 : 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' },
  });
}

async function readForm(request) {
  const type = request.headers.get('content-type') || '';
  if (type.includes('application/json')) return request.json();
  return Object.fromEntries(new URLSearchParams(await request.text()));
}

function clientCredentials(request, form) {
  const header = request.headers.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    const [id] = Buffer.from(header.slice(6), 'base64').toString().split(':');
    return { ...form, client_id: form.client_id || decodeURIComponent(id) };
  }
  return form;
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(request) {
  const url = new URL(request.url);
  const base = baseUrl(request);
  const op = url.searchParams.get('op');
  if (op === 'resource') return json(protectedResourceMetadata(base), 200, CORS);
  if (op === 'metadata') return json(authorizationServerMetadata(base), 200, CORS);
  if (op === 'authorize') {
    const params = Object.fromEntries(AUTHORIZE_PARAMS.map((k) => [k, url.searchParams.get(k) ?? undefined]));
    try {
      return consentPage(params, checkAuthorizeRequest(params));
    } catch (err) {
      return oauthError(err);
    }
  }
  return json({ error: 'not_found' }, 404, CORS);
}

export async function POST(request) {
  const op = new URL(request.url).searchParams.get('op');
  try {
    if (op === 'register') {
      return json(registerClient(await request.json()), 201, { ...CORS, 'Cache-Control': 'no-store' });
    }
    if (op === 'authorize') {
      const form = await readForm(request);
      const params = Object.fromEntries(AUTHORIZE_PARAMS.map((k) => [k, form[k]]));
      const client = checkAuthorizeRequest(params);
      if (!checkOwnerKey(form.key)) return consentPage(params, client, 'Неверный ключ.');
      const redirect = new URL(params.redirect_uri);
      redirect.searchParams.set('code', issueCode(params));
      if (params.state) redirect.searchParams.set('state', params.state);
      return new Response(null, { status: 302, headers: { Location: redirect.toString(), 'Cache-Control': 'no-store' } });
    }
    if (op === 'token') {
      const form = clientCredentials(request, await readForm(request));
      const tokens = await exchange(form, (jti) => claimOnce(`code:${jti}`, 600));
      return json(tokens, 200, { ...CORS, 'Cache-Control': 'no-store' });
    }
  } catch (err) {
    return oauthError(err);
  }
  return json({ error: 'not_found' }, 404, CORS);
}
