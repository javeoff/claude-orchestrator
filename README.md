# Claude Routine Orchestrator (MCP)

A remote MCP server on Vercel that runs tasks on a Claude Code cloud routine, lets you follow their progress, and lets you message a task while it runs.

```
MCP client ──► /mcp ──► POST routines/{trig}/fire ──► routine session
     ▲                                                     │
     └── check_routine_task ◄── Redis ◄── /report/{task} ◄──┘  progress reports (curl)
                                  └──► user messages returned in each report response
```

The routine token can only fire the routine. It cannot read the session. So every task's text includes a signed report URL, and the session POSTs its progress there. The response to each report carries any messages the user queued for the session.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `start_routine_task` | Fire the routine with a self-contained task. Returns `task_id` and `session_url`. |
| `check_routine_task` | Status, latest message, timeline, and `next_action`. Call it about every 60s until the task is `done`/`failed`. `wait_seconds` (≤50) long-polls. |
| `send_message_to_routine_task` | Send the session more instructions or answer a `needs_input` question. For a finished task, this starts a follow-up task that carries the previous task's context. |
| `list_routine_tasks` | Recent tasks, or only active ones with `active_only`. |

Statuses: `queued → running → needs_input → done | failed`.

## Environment

| Variable | |
| --- | --- |
| `ROUTINE_URL` | The routine's `/fire` URL or its `trig_…` id |
| `ROUTINE_KEY` | The routine's API token (`sk-ant-oat01-…`) |
| `MCP_AUTH_TOKEN` | Secret for MCP clients: `Authorization: Bearer …` or `/mcp?key=…` |
| `REDIS_URL` | Redis for task state. Without it, state is in memory (fine for local dev, not for production) |
| `REDIS_PREFIX` | Key prefix, default `orch:` |
| `OAUTH_SECRET` | Optional HMAC secret for OAuth clients and tokens, defaults to `MCP_AUTH_TOKEN`. Changing it (or the default) signs everyone out |
| `REPORT_SECRET` | Optional HMAC secret for report URLs, defaults to `MCP_AUTH_TOKEN` |
| `PUBLIC_BASE_URL` | Optional public origin for report URLs, detected from the request by default |

## Connecting

- Claude.ai / Claude Desktop custom connector: URL `https://<deployment>/mcp`, no Client ID. Claude registers itself through OAuth and opens a sign-in page where you enter `MCP_AUTH_TOKEN` once. Or use `https://<deployment>/mcp?key=<MCP_AUTH_TOKEN>`, which needs no sign-in.
- Claude Code: `claude mcp add --transport http orchestrator https://<deployment>/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"`

## Routine setup

- The routine's network access must allow the deployment's domain. Otherwise progress reports never arrive, and `check_routine_task` flags the task as possibly stuck.
- The routine's prompt should tell the session to follow the "Orchestrator protocol" section of the incoming message. The full protocol is sent with every task, so the routine prompt only has to point to it.

## Development

```
npm install
npm test
```
