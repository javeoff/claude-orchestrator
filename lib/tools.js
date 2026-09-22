import { FINAL, countMessages, getEvents, getTask, listTasks, sendMessage, startTask, taskView, waitForChange } from './tasks.js';

export const SERVER_INSTRUCTIONS = `This server runs tasks on a Claude Code cloud routine (a remote Claude session with its own repo checkout) and tracks their progress.

Workflow:
1. start_routine_task — hand off a self-contained task. Returns task_id and session_url immediately; the work happens remotely and takes minutes.
2. check_routine_task — call it REGULARLY for every task you started (about every 60s, or pass wait_seconds to long-poll) until status is "done" or "failed". Relay progress to the user as it comes in. Follow the next_action field.
3. send_message_to_routine_task — talk to the task: extra instructions, corrections, answers to a needs_input question. A running session picks the message up with its next report; a finished task gets a follow-up task that carries its context.
4. list_routine_tasks — all recent tasks and their statuses (use it to resume tracking after a break).

Statuses: queued (fired, session not reported yet) → running → needs_input (waiting for the user's answer) → done | failed.
When the user asks how things are going, call check_routine_task (or list_routine_tasks) first — never answer from memory.`;

const WAIT_MAX = 50;

export const TOOLS = [
  {
    name: 'start_routine_task',
    title: 'Start routine task',
    description:
      'Start a new task on the Claude Code cloud routine. The remote Claude session gets the prompt and works on it autonomously (minutes to an hour). ' +
      'Returns task_id and session_url immediately. After calling this you MUST keep calling check_routine_task with the task_id about every 60 seconds until status is done or failed.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Complete, self-contained instructions for the remote session: goal, repo/files, constraints, what "done" looks like. The session sees nothing else from this conversation.',
        },
        title: { type: 'string', description: 'Short label for the task (optional).' },
      },
      required: ['prompt'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'check_routine_task',
    title: 'Check routine task progress',
    description:
      'Get the current status, latest progress message and timeline of a routine task. Call this regularly (about every 60 seconds) for every task you started, until status is done or failed. ' +
      'Pass wait_seconds (up to 50) to long-poll: the call returns as soon as a new progress report arrives. Always follow the returned next_action.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'task_id returned by start_routine_task.' },
        wait_seconds: {
          type: 'integer',
          minimum: 0,
          maximum: WAIT_MAX,
          description: `Long-poll up to this many seconds for a new report (0 = return immediately). Max ${WAIT_MAX}.`,
        },
        include_timeline: { type: 'boolean', description: 'Include the full list of progress reports (default true).' },
      },
      required: ['task_id'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'send_message_to_routine_task',
    title: 'Send message to routine task',
    description:
      'Send a message from the user to a routine task: extra instructions, a correction, or the answer to a needs_input question. ' +
      'If the task is still active, the remote session receives it with its next progress report (within a few minutes; within ~30s while it waits on needs_input). ' +
      'If the task is already done or failed, a follow-up task is started with the previous task\'s context and its new task_id is returned — monitor that one with check_routine_task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'task_id of the task to talk to.' },
        message: { type: 'string', description: 'The message, written as instructions to the remote session.' },
      },
      required: ['task_id', 'message'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'list_routine_tasks',
    title: 'List routine tasks',
    description: 'List recent routine tasks with their status and latest progress message, newest first. Use it to find task_ids and resume monitoring active tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        active_only: { type: 'boolean', description: 'Only tasks that are not done/failed (default false).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max tasks to return (default 20).' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

function ok(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function fail(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export async function callTool(name, args = {}, ctx) {
  try {
    switch (name) {
      case 'start_routine_task': {
        const prompt = String(args.prompt || '').trim();
        if (!prompt) return fail('prompt is required');
        const task = await startTask({ prompt, title: args.title, baseUrl: ctx.baseUrl });
        return ok(taskView(task));
      }
      case 'check_routine_task': {
        const id = String(args.task_id || '');
        let task = await getTask(id);
        if (!task) return fail(`Unknown task_id "${id}". Use list_routine_tasks to see known tasks.`);
        const wait = Math.max(0, Math.min(WAIT_MAX, Number(args.wait_seconds) || 0));
        if (wait && !FINAL.has(task.status)) task = await waitForChange(id, task.reports || 0, wait);
        const events = args.include_timeline === false ? null : await getEvents(id);
        return ok(taskView(task, events, await countMessages(id)));
      }
      case 'send_message_to_routine_task': {
        const message = String(args.message || '').trim();
        if (!message) return fail('message is required');
        const sent = await sendMessage(String(args.task_id || ''), message, ctx.baseUrl);
        if (!sent) return fail(`Unknown task_id "${args.task_id}". Use list_routine_tasks to see known tasks.`);
        const note = sent.delivered === 'queued'
          ? 'Queued. The session receives it with its next report. Keep calling check_routine_task; the timeline shows when it is delivered.'
          : `The original task had finished, so follow-up task ${sent.task.id} was started with its context. Monitor it with check_routine_task.`;
        return ok({ delivered: sent.delivered, note, ...taskView(sent.task) });
      }
      case 'list_routine_tasks': {
        const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
        let tasks = await listTasks(args.active_only ? 100 : limit);
        if (args.active_only) tasks = tasks.filter((t) => !FINAL.has(t.status)).slice(0, limit);
        return ok({ tasks: tasks.map((t) => taskView(t)) });
      }
      default:
        return null;
    }
  } catch (err) {
    console.error(`tool ${name} failed`, err);
    return fail(`Error: ${err.message}`);
  }
}
