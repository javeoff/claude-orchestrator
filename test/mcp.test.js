import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.REDIS_URL;
delete process.env.KV_URL;
delete process.env.STORAGE_REDIS_URL;
process.env.MCP_AUTH_TOKEN = 'secret';
process.env.ROUTINE_URL = 'trig_TEST';
process.env.ROUTINE_KEY = 'sk-test';

const fired = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.anthropic.com/')) {
    fired.push({ url: String(url), init });
    return new Response(JSON.stringify({ type: 'routine_fire', claude_code_session_id: 'session_1', claude_code_session_url: 'https://claude.ai/code/session_1' }));
  }
  return realFetch(url, init);
};

const mcp = await import('../api/mcp.js');
const report = await import('../api/report.js');

async function rpc(method, params, { key = 'secret' } = {}) {
  const res = await mcp.POST(new Request(`https://orch.test/api/mcp?key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }));
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
}

test('rejects bad key', async () => {
  assert.equal((await rpc('tools/list', {}, { key: 'nope' })).status, 401);
});

test('initialize and list tools', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  const { body } = await rpc('tools/list');
  assert.deepEqual(body.result.tools.map((t) => t.name), ['start_routine_task', 'check_routine_task', 'send_message_to_routine_task', 'list_routine_tasks']);
});

test('start → report → check lifecycle', async () => {
  const start = await rpc('tools/call', { name: 'start_routine_task', arguments: { prompt: 'Fix the bug', title: 'bug' } });
  const task = start.body.result.structuredContent;
  assert.equal(task.status, 'queued');
  assert.equal(task.session_url, 'https://claude.ai/code/session_1');
  assert.equal(fired[0].url, 'https://api.anthropic.com/v1/claude_code/routines/trig_TEST/fire');
  assert.equal(fired[0].init.headers.Authorization, 'Bearer sk-test');
  const text = JSON.parse(fired[0].init.body).text;
  const m = text.match(/'(https:\/\/orch\.test\/report\/[^']+)'/);
  assert.ok(m, 'report url embedded');
  const reportUrl = m[1].replace('/report/', '/api/report?task=').replace('?sig=', '&sig=');

  const bad = await report.POST(new Request(reportUrl.replace(/sig=.*/, 'sig=x'), { method: 'POST', body: '{}' }));
  assert.equal(bad.status, 403);

  const r1 = await report.POST(new Request(reportUrl, { method: 'POST', body: JSON.stringify({ status: 'running', message: 'step 1' }) }));
  assert.equal(r1.status, 200);
  let check = (await rpc('tools/call', { name: 'check_routine_task', arguments: { task_id: task.task_id } })).body.result.structuredContent;
  assert.equal(check.status, 'running');
  assert.equal(check.last_message, 'step 1');

  const waiting = rpc('tools/call', { name: 'check_routine_task', arguments: { task_id: task.task_id, wait_seconds: 10 } });
  await report.POST(new Request(reportUrl, { method: 'POST', body: JSON.stringify({ status: 'done', message: 'PR opened', result: 'https://github.com/x/y/pull/1' }) }));
  check = (await waiting).body.result.structuredContent;
  assert.equal(check.status, 'done');
  assert.equal(check.timeline.length, 3);

  await report.POST(new Request(reportUrl, { method: 'POST', body: JSON.stringify({ status: 'running', message: 'late' }) }));
  const list = (await rpc('tools/call', { name: 'list_routine_tasks', arguments: {} })).body.result.structuredContent;
  assert.equal(list.tasks[0].status, 'done');
});

test('notification returns 202', async () => {
  const res = await mcp.POST(new Request('https://orch.test/api/mcp', {
    method: 'POST', headers: { authorization: 'Bearer secret' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }));
  assert.equal(res.status, 202);
});

test('messages: queued for active task, follow-up for finished one', async () => {
  const start = await rpc('tools/call', { name: 'start_routine_task', arguments: { prompt: 'Build feature' } });
  const id = start.body.result.structuredContent.task_id;
  const text = JSON.parse(fired.at(-1).init.body).text;
  const reportUrl = text.match(/REPORT_URL='([^']+)'/)[1].replace('/report/', '/api/report?task=').replace('?sig=', '&sig=');

  const sent = (await rpc('tools/call', { name: 'send_message_to_routine_task', arguments: { task_id: id, message: 'Also add tests' } })).body.result.structuredContent;
  assert.equal(sent.delivered, 'queued');
  let check = (await rpc('tools/call', { name: 'check_routine_task', arguments: { task_id: id } })).body.result.structuredContent;
  assert.equal(check.undelivered_messages, 1);

  const inbox = await (await report.GET(new Request(reportUrl))).json();
  assert.deepEqual(inbox.messages.map((m) => m.text), ['Also add tests']);
  assert.equal((await (await report.GET(new Request(reportUrl))).json()).messages.length, 0);

  await rpc('tools/call', { name: 'send_message_to_routine_task', arguments: { task_id: id, message: 'Use port 3000' } });
  const r = await (await report.POST(new Request(reportUrl, { method: 'POST', body: JSON.stringify({ status: 'done', message: 'ok' }) }))).json();
  assert.deepEqual(r.messages.map((m) => m.text), ['Use port 3000']);

  const follow = (await rpc('tools/call', { name: 'send_message_to_routine_task', arguments: { task_id: id, message: 'Now deploy it' } })).body.result.structuredContent;
  assert.equal(follow.delivered, 'follow_up_task');
  assert.notEqual(follow.task_id, id);
  assert.equal(follow.parent_task_id, id);
  assert.match(JSON.parse(fired.at(-1).init.body).text, /Context from the previous task[\s\S]*Build feature[\s\S]*Now deploy it/);
});
