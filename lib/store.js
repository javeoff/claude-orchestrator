// Task storage: Redis when REDIS_URL is set, in-memory otherwise (local dev only —
// serverless instances do not share memory, so production needs Redis).
import { createClient } from 'redis';

const PREFIX = process.env.REDIS_PREFIX || 'orch:';
const TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_EVENTS = 200;

let clientPromise = null;

function redisUrl() {
  return process.env.REDIS_URL || process.env.KV_URL || process.env.STORAGE_REDIS_URL || '';
}

async function redis() {
  if (!redisUrl()) return null;
  if (!clientPromise) {
    const client = createClient({ url: redisUrl() });
    client.on('error', (err) => console.error('redis error', err.message));
    clientPromise = client.connect().then(() => client).catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

const mem = { tasks: new Map(), events: new Map(), inbox: new Map() };

const taskKey = (id) => `${PREFIX}task:${id}`;
const eventsKey = (id) => `${PREFIX}events:${id}`;
const indexKey = `${PREFIX}tasks`;

export function storageKind() {
  return redisUrl() ? 'redis' : 'memory';
}

export async function saveTask(task) {
  const r = await redis();
  if (!r) {
    mem.tasks.set(task.id, task);
    return;
  }
  await r.multi()
    .set(taskKey(task.id), JSON.stringify(task), { EX: TTL_SECONDS })
    .zAdd(indexKey, { score: Date.parse(task.created_at), value: task.id })
    .exec();
}

export async function getTask(id) {
  const r = await redis();
  if (!r) return mem.tasks.get(id) || null;
  const raw = await r.get(taskKey(id));
  return raw ? JSON.parse(raw) : null;
}

export async function listTasks(limit = 20) {
  const r = await redis();
  if (!r) {
    return [...mem.tasks.values()]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }
  const ids = await r.zRange(indexKey, 0, limit - 1, { REV: true });
  if (!ids.length) return [];
  const raws = await r.mGet(ids.map(taskKey));
  const stale = ids.filter((_, i) => !raws[i]);
  if (stale.length) await r.zRem(indexKey, stale);
  return raws.filter(Boolean).map((raw) => JSON.parse(raw));
}

export async function addEvent(id, event) {
  const r = await redis();
  if (!r) {
    const list = mem.events.get(id) || [];
    list.push(event);
    mem.events.set(id, list.slice(-MAX_EVENTS));
    return;
  }
  await r.multi()
    .rPush(eventsKey(id), JSON.stringify(event))
    .lTrim(eventsKey(id), -MAX_EVENTS, -1)
    .expire(eventsKey(id), TTL_SECONDS)
    .exec();
}

export async function getEvents(id) {
  const r = await redis();
  if (!r) return mem.events.get(id) || [];
  const raws = await r.lRange(eventsKey(id), 0, -1);
  return raws.map((raw) => JSON.parse(raw));
}

const inboxKey = (id) => `${PREFIX}inbox:${id}`;

// Mailbox of user messages waiting to be picked up by the routine session.
export async function pushMessage(id, message) {
  const r = await redis();
  if (!r) {
    mem.inbox.set(id, [...(mem.inbox.get(id) || []), message]);
    return;
  }
  await r.multi().rPush(inboxKey(id), JSON.stringify(message)).expire(inboxKey(id), TTL_SECONDS).exec();
}

export async function takeMessages(id) {
  const r = await redis();
  if (!r) {
    const list = mem.inbox.get(id) || [];
    mem.inbox.delete(id);
    return list;
  }
  const [raws] = await r.multi().lRange(inboxKey(id), 0, -1).del(inboxKey(id)).exec();
  return raws.map((raw) => JSON.parse(raw));
}

export async function countMessages(id) {
  const r = await redis();
  if (!r) return mem.inbox.get(id)?.length || 0;
  return r.lLen(inboxKey(id));
}
