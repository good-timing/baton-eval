# baton-eval

Runs your MCP server's agent tests for Baton auto mode. The Baton Console decides what to test; `baton-eval` runs it on your machine and reports back.

For each step the Console hands out, `baton-eval`:

1. Starts your server with `BATON_DSN` set to its **test** DSN, `BATON_CANDIDATE` set to the step's change and `BATON_TASK` set to the task's id.
2. Runs each task with Claude Code (`claude -p`), with no user settings, no built-in tools, and only your server.
3. Makes the task's check call to your server, with `BATON_DISABLED=1` so it sends no events.
4. Sends the agent's reply and the check's result to the Console, whose judge scores the run `pass`, `fail` or `short`.

**What leaves your machine:** each task's prompt, the agent's final reply, and the check's arguments and result, each cut to 20,000 characters. The rest of the task file stays with you.

`baton-eval` scores a run itself when it already knows the outcome:

- `short`, `crashed`: the agent or the server failed to start, or the agent stopped with an error or ran past its 10-minute limit.
- `short`, `check_failed`: the check call failed, or `answer` found nothing in its result, or only blank values.
- `short`, `not_loaded`: the change didn't load. This marks the rest of the step `short` and ends the experiment.
- `fail`, `dollar_cap`: the run hit its dollar cap.

The judge scores a run `short`, `cant_tell` when it can't decide.

If the experiment's first run crashed, `run` stops there, so a broken setup doesn't pay for every run.

## Needs

- Node 20 or later, and Claude Code signed in (`claude`).
- A server that reads its DSN from `BATON_DSN` and installs Baton with `settings="console"` (Python) or `settings: "console"` (TypeScript). A DSN written in the server's code wins over the variable, and test traffic then goes to prod. Without that setting the change is ignored and every step is `short`.
- A Baton SDK that understands `BATON_CANDIDATE`: Python 1.3.0 or later, or `@goodtiming/baton-sdk` 1.2.0 or later. An SDK that also reads `BATON_TASK` tags each test event with its task.
- macOS or Linux: the server starts through `/bin/sh`.

## Set up

```sh
echo "$TEST_DSN" | npx baton-eval init --server my-server --tasks evals/tasks.jsonl --model claude-sonnet-5-5 -- uv run my-server
```

`init` writes `baton-eval.toml`, which is safe to commit. If the task file marks no task `held_out`, `init` marks 1 in 5 of them (at least 1, once there are 2) for you to review. It saves the test DSN to `~/.config/baton-eval/credentials` with mode 600. It reads the DSN from `BATON_EVAL_DSN` or stdin, never from the command line. DSNs are saved by server name, so `init` won't replace a different DSN saved for the same name, such as one for another workspace, unless you pass `--replace-dsn`.

`baton-eval.toml`:

```toml
server = "my-server"            # the last part of the DSN
tasks = "evals/tasks.jsonl"
budget_sessions = 400           # optional

[start]
command = "uv"
args = ["run", "my-server"]
cwd = "."                       # optional, relative to this file
env = { LOG_LEVEL = "warn" }    # optional; on the server's command line, so no secrets; not BATON_DSN, BATON_CANDIDATE, BATON_TASK or BATON_DISABLED

[agent]
model = "claude-sonnet-5-5"     # every run uses this model
max_budget_usd = 1              # per run

[placeholders]                  # filled into {name} in the tasks
server = "My Server"
```

`[start]` can't use `${NAME}`: Claude Code fills it in for the agent's server, but not for the check's. Write the value out instead.

## Tasks

One JSON object per line:

```json
{"id": "top-friction-last-week", "prompt": "Which tool on {server} caused the most friction last week?", "check": {"tool": "top_friction_by_tool", "args": {"window_days": 7}, "answer": "rows[0].label"}}
```

- `prompt`: what the agent is asked, up to 4,000 characters once placeholders are filled.
- `check.tool` and `check.args`: the call `baton-eval` makes after the agent stops. The judge reads the reply against its result.
- `answer` (optional): the path to the value the reply should give, such as `rows[0].label` or `rows[:3].label` for any of the first three. It points the judge at that value. If the path finds nothing, or only blank values such as `""` or null, the run is `short`.
- `held_out`: tasks read only at the experiment's final step. If no task has `held_out` at `run`, the Console picks some and `run` writes the pick back to the file for you to review. Any `held_out`, even `false`, counts as your pick: then only tasks marked `true` are held out, and with none the Console can't confirm a change.
- `tools` (optional): the tools the task should use. It defaults to `[check.tool]`.

## Run

```sh
npx baton-eval run
```

It starts an experiment, runs every step the Console hands out, and stops when the Console says it's done or the budget is spent.
