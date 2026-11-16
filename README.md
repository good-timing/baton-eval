# baton-eval

Runs your MCP server's agent tests for Baton auto mode. The Baton Console decides what to test; `baton-eval` runs it on your machine and reports back.

For each step the Console hands out, `baton-eval`:

1. Starts your server with `BATON_DSN` set to its **test** DSN and `BATON_CANDIDATE` set to the step's change.
2. Runs each task with Claude Code (`claude -p`), with no user settings, no built-in tools, and only your server.
3. Checks the agent's reply against its own call to your server, made with `BATON_DISABLED=1` so it sends no events, and sends `pass`, `fail` or `short` to the Console.

A run is `short` when it can't be scored: the agent or the server failed to start, the agent stopped with an error or ran past its 10-minute limit, the check call failed or found nothing it can look for, or the change didn't load. A run that hits its dollar cap is a `fail`.

If the experiment's first run is `short` because the agent or the server failed, `run` stops there, so a broken setup doesn't pay for every run.

## Needs

- Node 20 or later, and Claude Code signed in (`claude`).
- A server that reads its DSN from `BATON_DSN` and installs Baton with `settings="console"`. A DSN written in the server's code wins over the variable, and test traffic then goes to prod. Without `settings="console"` the change is ignored and every step is `short`.
- A Baton SDK that understands `BATON_CANDIDATE` (Python 1.3.0 or later).
- macOS or Linux: the server starts through `/bin/sh`.

## Set up

```sh
echo "$TEST_DSN" | npx baton-eval init --server my-server --tasks evals/tasks.jsonl --model claude-sonnet-5-5 -- uv run my-server
```

`init` writes `baton-eval.toml`, which is safe to commit, and saves the test DSN to `~/.config/baton-eval/credentials` with mode 600. It reads the DSN from `BATON_EVAL_DSN` or stdin, never from the command line. DSNs are saved by server name, so `init` won't replace a different DSN saved for the same name, such as one for another workspace, unless you pass `--replace-dsn`.

`baton-eval.toml`:

```toml
server = "my-server"            # the last part of the DSN
tasks = "evals/tasks.jsonl"
budget_sessions = 400           # optional

[start]
command = "uv"
args = ["run", "my-server"]
cwd = "."                       # optional, relative to this file
env = { LOG_LEVEL = "warn" }    # optional; on the server's command line, so no secrets; not BATON_DSN, BATON_CANDIDATE or BATON_DISABLED

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
{"id": "top-friction-last-week", "prompt": "Which tool on {server} caused the most friction last week?", "check": {"tool": "top_friction_by_tool", "args": {"window_days": 7}, "reply_contains": "rows[0].label"}}
```

- `check.tool` and `check.args`: the call `baton-eval` makes after the agent stops.
- `reply_contains`: one value from that call's result that the reply must contain. `reply_contains_any`: any of several, as in `rows[:3].label`. The match ignores case and spacing, and needs whole words: `run` doesn't match `running`. Punctuation other than `_` ends a word, so `v2` matches `v2.1`. Only text with a letter in it is looked for: a number, a date or true/false can be worded too many ways, so it scores `short`, even in a `reply_contains_any` list. Blank and missing values are skipped. Other text, such as `250ms` or `Nov 16`, is matched as written. A check that finds nothing to look for scores `short`, never `pass`.
- `held_out`: tasks read only at the experiment's final step. If no task has `held_out`, the Console picks some and `run` writes the pick back to the file for you to review. Any `held_out`, even `false`, counts as your pick: then only tasks marked `true` are held out, and with none the Console can't confirm a change.
- `tools` (optional): the tools the task should use. It defaults to `[check.tool]`.

## Run

```sh
npx baton-eval run
```

It starts an experiment, runs every step the Console hands out, and stops when the Console says it's done or the budget is spent.
