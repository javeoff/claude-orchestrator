// Minimal stateless OAuth 2.1 authorization server for MCP clients (claude.ai
// connectors): dynamic client registration, authorization code + PKCE (S256),
// refresh tokens. The only "user" is the owner, who proves it on the consent page
// by entering MCP_AUTH_TOKEN. Clients, codes and tokens are HMAC-signed blobs.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const CODE_TTL = 5 * 60;
const ACCESS_TTL = 60 * 60 * 24 * 30;
const REFRESH_TTL = 60 * 60 * 24 * 365;

function secret() {
  const s = process.env.OAUTH_SECRET || process.env.REPORT_SECRET || process.env.MCP_AUTH_TOKEN;
  if (!s) throw new Error('Set MCP_AUTH_TOKEN to enable OAuth');
  return s;
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const mac = (typ, body) => createHmac('sha256', secret()).update(`${typ}.${body}`).digest('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function sign(typ, payload, ttlSeconds) {
  const body = b64({ ...payload, exp: ttlSeconds ? Math.floor(Date.now() / 1000) + ttlSeconds : undefined });
  return `${typ}.${body}.${mac(typ, body)}`;
}

export function verify(typ, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== typ || !safeEqual(mac(typ, parts[1]), parts[2])) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (payload.exp && payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export function checkOwnerKey(key) {
  const expected = process.env.MCP_AUTH_TOKEN;
  return Boolean(expected && key) && safeEqual(key, expected);
}

export function isValidAccessToken(token) {
  return Boolean(verify('oat', token));
}

export function protectedResourceMetadata(base) {
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    resource_name: 'Claude Routine Orchestrator',
  };
}

export function authorizationServerMetadata(base) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: ['mcp'],
  };
}

// The client_id itself carries the registered redirect URIs, so nothing is stored.
export function registerClient(meta) {
  const redirectUris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris.filter((u) => typeof u === 'string') : [];
  if (!redirectUris.length) throw new OAuthError('invalid_redirect_uri', 'redirect_uris is required');
  for (const uri of redirectUris) {
    let url;
    try {
      url = new URL(uri);
    } catch {
      throw new OAuthError('invalid_redirect_uri', `Invalid redirect URI: ${uri}`);
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
      throw new OAuthError('invalid_redirect_uri', `Redirect URI must be https: ${uri}`);
    }
  }
  const clientId = sign('ocl', { r: redirectUris, n: meta.client_name || '', i: randomBytes(4).toString('hex') });
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: meta.client_name,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

export class OAuthError extends Error {
  constructor(code, description, status = 400) {
    super(description);
    this.code = code;
    this.status = status;
  }
}

// Validates an authorization request; returns the client's details for the consent page.
export function checkAuthorizeRequest(params) {
  const client = verify('ocl', params.client_id);
  if (!client) throw new OAuthError('invalid_client', 'Unknown client_id. Remove and re-add the connector.');
  if (!client.r.includes(params.redirect_uri)) throw new OAuthError('invalid_request', 'redirect_uri is not registered for this client');
  if (params.response_type !== 'code') throw new OAuthError('unsupported_response_type', 'Only response_type=code is supported');
  if (!params.code_challenge || (params.code_challenge_method || 'plain') !== 'S256') {
    throw new OAuthError('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  }
  return { name: client.n, redirectHost: new URL(params.redirect_uri).host };
}

export function issueCode(params) {
  return sign('ocd', {
    c: params.client_id,
    r: params.redirect_uri,
    p: params.code_challenge,
    j: randomBytes(8).toString('hex'),
  }, CODE_TTL);
}

function tokens(clientId) {
  return {
    access_token: sign('oat', { c: clientId.slice(-16) }, ACCESS_TTL),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL,
    refresh_token: sign('ort', { c: clientId }, REFRESH_TTL),
    scope: 'mcp',
  };
}

// useCode(jti) returns false if the code was already redeemed (replay protection).
export async function exchange(form, useCode) {
  if (form.grant_type === 'authorization_code') {
    const code = verify('ocd', form.code);
    if (!code) throw new OAuthError('invalid_grant', 'Authorization code is invalid or expired');
    if (form.client_id && form.client_id !== code.c) throw new OAuthError('invalid_grant', 'client_id mismatch');
    if (form.redirect_uri && form.redirect_uri !== code.r) throw new OAuthError('invalid_grant', 'redirect_uri mismatch');
    const challenge = createHash('sha256').update(String(form.code_verifier || '')).digest('base64url');
    if (!form.code_verifier || !safeEqual(challenge, code.p)) throw new OAuthError('invalid_grant', 'PKCE verification failed');
    if (!(await useCode(code.j))) throw new OAuthError('invalid_grant', 'Authorization code was already used');
    return tokens(code.c);
  }
  if (form.grant_type === 'refresh_token') {
    const refresh = verify('ort', form.refresh_token);
    if (!refresh) throw new OAuthError('invalid_grant', 'Refresh token is invalid or expired');
    return tokens(refresh.c);
  }
  throw new OAuthError('unsupported_grant_type', `Unsupported grant_type: ${form.grant_type}`);
}
