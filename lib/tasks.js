import { randomBytes } from 'node:crypto';
import { signTask } from './auth.js';
import { fireRoutine } from './routine.js';
import { addEvent, countMessages, getEvents, getTask, listTasks, pushMessage, saveTask, takeMessages } from './store.js';

export const STATUSES = ['queued', 'running', 'needs_input', 'done', 'failed'];
export const FINAL = new Set(['done', 'failed']);
// No report for this long while running → flag the task as possibly stuck.
const STALE_MINUTES = Number(process.env.STALE_MINUTES || 20);
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 60);

export function newTaskId() {
  return `task_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

export function reportUrl(baseUrl, taskId) {
  return `${baseUrl}/report/${taskId}?sig=${signTask(taskId)}`;
}

// The text appended to the routine session: the task itself plus the protocol that
// lets check_routine_task see progress and lets the user talk to the session.
// The routine token cannot read sessions, so the session pushes its progress to us
// and picks up user messages from the responses.
export function buildRoutineText({ taskId, title, prompt, url, context }) {
  return [
    `# Orchestrator task ${taskId}${title ? `: ${title}` : ''}`,
    '',
    ...(context ? ['## Context from the previous task', context, ''] : []),
    '## Task',
    prompt,
    '',
    '## Orchestrator protocol (required)',
    'A user follows this task through an orchestrator that only sees what you report. Report URL for this task:',
    `REPORT_URL='${url}'`,
    '',
    'Send a report (JSON with "status" and "message"; add "result" on the final one):',
    '```',
    `curl -sS -X POST "$REPORT_URL" -H 'Content-Type: application/json' -d '{"status":"running","message":"Started: <short plan>"}'`,
    '```',
    'When to report:',
    '- right away, before you start (status "running", short plan);',
    '- after every meaningful step, and at least every ~5 minutes of work (status "running": what is done, what is next);',
    '- when blocked on a decision only the user can make (status "needs_input", the exact question) — then wait for the answer as described below;',
    '- at the very end, exactly once (status "done" with the result: what changed, branch/PR/deploy links, how it was verified; or "failed" with the reason).',
    'Statuses: running, needs_input, done, failed. Keep messages under 2000 chars; for text with quotes use `-d @- <<\'JSON\'` ... `JSON`.',
    '',
    'Messages from the user: every report response is JSON with a "messages" array. Treat each message as a new instruction from the user and act on it (acknowledge it in your next report). You can also check for messages without reporting:',
    '```',
    'curl -sS "$REPORT_URL"',
    '```',
    '- After a "needs_input" report, poll that URL every 30 seconds (up to 30 minutes) until a message arrives, then continue. If none arrives, make the safest reasonable choice, say so in a report, and continue.',
    '- Before the final "done" report, check for messages once more and handle them first.',
    'If a report request fails, keep working and retry with the next report.',
  ].join('\n');
}

export async function startTask({ prompt, title, baseUrl, parent }) {
  const id = newTaskId();
  const now = new Date().toISOString();
  const url = reportUrl(baseUrl, id);
  const context = parent
    ? [
        `This continues task ${parent.id} "${parent.title}" (status ${parent.status}, session ${parent.session_url || 'unknown'}).`,
        `Original task:\n${parent.prompt.slice(0, 6000)}`,
        `Last report:\n${parent.last_message || '(none)'}`,
        parent.result ? `Result:\n${typeof parent.result === 'string' ? parent.result.slice(0, 6000) : JSON.stringify(parent.result).slice(0, 6000)}` : '',
      ].filter(Boolean).join('\n\n')
    : null;
  const text = buildRoutineText({ taskId: id, title, prompt, url, context });
  const task = {
    id,
    title: title || prompt.split('\n')[0].slice(0, 80),
    prompt,
    status: 'queued',
    last_message: null,
    result: null,
    session_id: null,
    session_url: null,
    created_at: now,
    updated_at: now,
    last_report_at: null,
    reports: 0,
    parent_id: parent?.id || null,
  };
  await saveTask(task);
  try {
    const fired = await fireRoutine(text);
    Object.assign(task, fired, { updated_at: new Date().toISOString() });
    await saveTask(task);
    await addEvent(id, { at: task.updated_at, status: 'queued', message: 'Routine fired; waiting for the session to report.' });
  } catch (err) {
    Object.assign(task, { status: 'failed', last_message: err.message, updated_at: new Date().toISOString() });
    await saveTask(task);
    await addEvent(id, { at: task.updated_at, status: 'failed', message: err.message });
    throw err;
  }
  return task;
}

export async function applyReport(taskId, { status, message, result }) {
  const task = await getTask(taskId);
  if (!task) return null;
  const at = new Date().toISOString();
  const next = STATUSES.includes(status) ? status : 'running';
  const text = String(message ?? '').slice(0, 4000);
  // A late "running" report must not reopen a finished task.
  if (!FINAL.has(task.status) || FINAL.has(next)) task.status = next;
  task.last_message = text || task.last_message;
  if (result !== undefined) task.result = typeof result === 'string' ? result.slice(0, 8000) : result;
  task.updated_at = at;
  task.last_report_at = at;
  task.reports = (task.reports || 0) + 1;
  await saveTask(task);
  await addEvent(taskId, { at, status: next, message: text });
  return { task, messages: await deliverMessages(taskId) };
}

// Hands queued user messages to the session and records the delivery.
export async function deliverMessages(taskId) {
  const messages = await takeMessages(taskId);
  if (messages.length) {
    await addEvent(taskId, {
      at: new Date().toISOString(),
      status: 'delivered',
      message: `${messages.length} user message(s) delivered to the session`,
    });
  }
  return messages;
}

// User → session message. Active task: queued until the session's next report or
// inbox check. Finished task: its session has ended, so start a follow-up task.
export async function sendMessage(taskId, message, baseUrl) {
  const task = await getTask(taskId);
  if (!task) return null;
  if (FINAL.has(task.status)) {
    const followUp = await startTask({ prompt: message, title: `Follow-up: ${task.title}`.slice(0, 80), baseUrl, parent: task });
    await addEvent(taskId, { at: new Date().toISOString(), status: 'follow_up', message: `Follow-up task ${followUp.id} started` });
    return { delivered: 'follow_up_task', task: followUp };
  }
  const at = new Date().toISOString();
  await pushMessage(taskId, { at, text: message });
  await addEvent(taskId, { at, status: 'user_message', message });
  return { delivered: 'queued', task };
}

function minutesSince(iso) {
  return iso ? Math.round((Date.now() - Date.parse(iso)) / 60000) : null;
}

export function nextAction(task) {
  const quiet = minutesSince(task.last_report_at || task.created_at);
  switch (task.status) {
    case 'done':
      return 'Finished. Report result/last_message to the user and stop polling. For more work on the same topic use send_message_to_routine_task — it starts a follow-up task with this context.';
    case 'failed':
      return 'Failed. Tell the user why (see last_message and session_url). Stop polling this task.';
    case 'needs_input':
      return `The session is waiting for an answer to the question in last_message. Ask the user and pass their answer with send_message_to_routine_task (the session polls for it). Then keep checking every ~${POLL_SECONDS}s.`;
    default:
      if (quiet >= STALE_MINUTES) {
        return `No report for ${quiet} min — possibly stuck, or the routine environment cannot reach this server (network allowlist). Check session_url; keep polling every ~${POLL_SECONDS * 2}s.`;
      }
      return `In progress. Call check_routine_task again in ~${POLL_SECONDS}s (or pass wait_seconds to long-poll) until status is done or failed.`;
  }
}

export function taskView(task, events, pendingMessages) {
  const view = {
    task_id: task.id,
    title: task.title,
    status: task.status,
    last_message: task.last_message,
    result: task.result,
    session_url: task.session_url,
    started_minutes_ago: minutesSince(task.created_at),
    last_report_minutes_ago: minutesSince(task.last_report_at),
    reports: task.reports || 0,
    parent_task_id: task.parent_id || undefined,
    next_action: nextAction(task),
  };
  if (pendingMessages) view.undelivered_messages = pendingMessages;
  if (events) view.timeline = events.map((e) => `${e.at} [${e.status}] ${e.message}`);
  return view;
}

export async function waitForChange(taskId, sinceReports, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  let task = await getTask(taskId);
  while (task && !FINAL.has(task.status) && (task.reports || 0) <= sinceReports && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    task = await getTask(taskId);
  }
  return task;
}

export { countMessages, getTask, getEvents, listTasks };
