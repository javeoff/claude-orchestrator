import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

delete process.env.REDIS_URL;
delete process.env.KV_URL;
delete process.env.STORAGE_REDIS_URL;
process.env.MCP_AUTH_TOKEN = 'owner-key';

const oauth = await import('../api/oauth.js');
const mcp = await import('../api/mcp.js');
const B = 'https://orch.test';

const post = (op, body, type = 'application/json') =>
  oauth.POST(new Request(`${B}/api/oauth?op=${op}`, { method: 'POST', headers: { 'content-type': type }, body }));

test('full OAuth flow grants MCP access', async () => {
  const unauth = await mcp.POST(new Request(`${B}/api/mcp`, { method: 'POST', body: '{}' }));
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate'), /resource_metadata="https:\/\/orch\.test\/\.well-known\/oauth-protected-resource"/);

  const meta = await (await oauth.GET(new Request(`${B}/api/oauth?op=metadata`))).json();
  assert.equal(meta.registration_endpoint, `${B}/oauth/register`);

  const redirect = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await post('register', JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect] }));
  assert.equal(reg.status, 201);
  const { client_id } = await reg.json();

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = { response_type: 'code', client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' };

  const page = await oauth.GET(new Request(`${B}/api/oauth?op=authorize&${new URLSearchParams(params)}`));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /claude\.ai/);

  const wrong = await post('authorize', new URLSearchParams({ ...params, key: 'nope' }).toString(), 'application/x-www-form-urlencoded');
  assert.equal(wrong.status, 401);

  const ok = await post('authorize', new URLSearchParams({ ...params, key: 'owner-key' }).toString(), 'application/x-www-form-urlencoded');
  assert.equal(ok.status, 302);
  const loc = new URL(ok.headers.get('location'));
  assert.equal(loc.searchParams.get('state'), 'xyz');
  const code = loc.searchParams.get('code');

  const tokenBody = new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id, redirect_uri: redirect }).toString();
  const badPkce = await post('token', tokenBody.replace(verifier, 'x'.repeat(43)), 'application/x-www-form-urlencoded');
  assert.equal(badPkce.status, 400);
  const tok = await (await post('token', tokenBody, 'application/x-www-form-urlencoded')).json();
  assert.ok(tok.access_token && tok.refresh_token);
  const replay = await post('token', tokenBody, 'application/x-www-form-urlencoded');
  assert.equal((await replay.json()).error, 'invalid_grant');

  const call = (t) => mcp.POST(new Request(`${B}/api/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${t}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }));
  assert.equal((await call(tok.access_token)).status, 200);
  assert.equal((await call(tok.refresh_token)).status, 401);

  const refreshed = await (await post('token', new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token }).toString(), 'application/x-www-form-urlencoded')).json();
  assert.equal((await call(refreshed.access_token)).status, 200);
});

test('rejects unregistered redirect_uri and non-https registration', async () => {
  const reg = await (await post('register', JSON.stringify({ redirect_uris: ['https://good.example/cb'] }))).json();
  const res = await oauth.GET(new Request(`${B}/api/oauth?op=authorize&${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://evil.example/cb', code_challenge: 'x', code_challenge_method: 'S256' })}`));
  assert.equal(res.status, 400);
  assert.equal((await post('register', JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }))).status, 400);
});
