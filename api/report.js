// Channel between the routine session and the orchestrator:
//   POST {status, message, result?} — progress report; response carries queued user messages.
//   GET — check for user messages without reporting (used while waiting on needs_input).
import { checkTaskSignature } from '../lib/auth.js';
import { json } from '../lib/http.js';
import { applyReport, deliverMessages, getTask } from '../lib/tasks.js';

async function readReport(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const data = JSON.parse(text);
    return typeof data === 'object' && data ? data : { message: String(data) };
  } catch {
    return { message: text };
  }
}

function authorizedTaskId(request) {
  const url = new URL(request.url);
  const taskId = url.searchParams.get('task') || '';
  return checkTaskSignature(taskId, url.searchParams.get('sig') || '') ? taskId : null;
}

const forbidden = () => json({ ok: false, error: 'invalid task or signature' }, 403);

export async function GET(request) {
  const taskId = authorizedTaskId(request);
  if (!taskId) return forbidden();
  const task = await getTask(taskId);
  if (!task) return json({ ok: false, error: 'unknown task' }, 404);
  return json({ ok: true, task_id: task.id, status: task.status, messages: await deliverMessages(taskId) });
}

export async function POST(request) {
  const taskId = authorizedTaskId(request);
  if (!taskId) return forbidden();
  const url = new URL(request.url);
  const report = await readReport(request);
  const status = report.status || url.searchParams.get('status') || 'running';
  const applied = await applyReport(taskId, { ...report, status });
  if (!applied) return json({ ok: false, error: 'unknown task' }, 404);
  return json({ ok: true, task_id: taskId, status: applied.task.status, messages: applied.messages });
}
