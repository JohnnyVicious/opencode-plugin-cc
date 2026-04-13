---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to OpenCode
argument-hint: "[--background|--wait] [--worktree] [--resume|--fresh] [--model <provider/model> | --free] [--agent <build|plan>] [what OpenCode should investigate, solve, or continue]"
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
---

Forward this request to the OpenCode companion's `task` runtime through the `safe-command.mjs` bridge.
The final user-visible response must be the bridge's stdout verbatim — no commentary, summary, or paraphrase before or after it.

Raw user request:
$ARGUMENTS

Helper calls the command may make BEFORE the final bridged `task` invocation:

- `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task-resume-candidate --json` — resume-detection helper
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" last-review` — last-review presence check
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" last-review --content` — last-review full text

Each of these is a separate Bash call that runs in the foreground and returns quickly. They are NOT the final task invocation — they are just information probes that inform how you build the final bridged call. Do not background them, and do not forward their output to the user.

Execution mode:

- Default is foreground: the bridged Bash call runs synchronously and the user sees the companion's full output when the task finishes.
- If the request includes `--background`, the companion detaches a worker and the bridge returns a job id immediately (`OpenCode task started in background: <id>` plus a `Check /opencode:status for progress.` line). Return that stdout verbatim.
- The Bash call that runs the bridge must always run in the foreground — never set `run_in_background: true` on the Bash tool, even when the user passes `--background`. Companion-level backgrounding is what `--background` forwards to.
- `--wait` is accepted as a documented no-op alias for the default foreground mode. The bridge strips it.
- `--background` and `--wait` are the only execution-mode flags. Every other flag is forwarded to the companion.

Flag handling (all of these are recognized, validated, and forwarded by `safe-command.mjs`):

- `--background` — companion detaches a worker and returns a job id.
- `--wait` — no-op alias for foreground; bridge strips it.
- `--worktree` — run OpenCode in an isolated git worktree instead of editing the working directory in-place.
- `--resume` (or `--resume-last`) — continue the most recent OpenCode session from this Claude session. The bridge translates `--resume` into the companion-native `--resume-last`.
- `--fresh` — explicit marker that the task must NOT resume. The bridge strips it (the absence of `--resume-last` already conveys "fresh").
- `--model <provider/model-id>` — override OpenCode's default model for this single task. Value must match `[A-Za-z0-9._/:-]+`.
- `--free` — tells the companion to pick a random first-party `opencode/*` free-tier model from `opencode models`. Restricted to `opencode/*` because OpenRouter free models have inconsistent tool-use support.
- `--agent <build|plan>` — override the OpenCode agent. Value must be `build` or `plan`.
- `--free` and `--model` are mutually exclusive — the bridge rejects payloads that include both. If the user supplies both, return the bridge's error verbatim and stop.

Resume detection (runs before the final bridged call, only when neither `--resume` nor `--fresh` is in the raw user request):

- Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task-resume-candidate --json` in the foreground.
- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current OpenCode session or start a new one.
- The two choices must be:
  - `Continue current OpenCode session`
  - `Start a new OpenCode session`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current OpenCode session (Recommended)` first.
- Otherwise put `Start a new OpenCode session (Recommended)` first.
- If the user chooses continue, add `--resume` at the start of the payload you feed to the bridge heredoc.
- If the user chooses a new session, do not add `--resume`.
- If the helper reports `available: false`, do not ask. Proceed without `--resume`.
- If the user is clearly asking to continue prior OpenCode work (such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper") and `--fresh` is not in the raw request, add `--resume` to the payload even when the resume-detection helper was skipped.

Empty-request / last-review branch (runs when the raw user request contains no task text):

- Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" last-review` in the foreground.
- If stdout is `LAST_REVIEW_AVAILABLE`, use `AskUserQuestion` exactly once with two options:
  - `Fix issues from last review (Recommended)` — prepend the saved review content as context for the rescue task
  - `Describe a new task` — ask what OpenCode should investigate or fix
- If the user chooses to fix from last review, read the saved review via `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" last-review --content` and include its stdout verbatim inside the final bridged payload, prefixed with the literal line `The following issues were found in a prior OpenCode review. Please fix them:` followed by a blank line and then the review content.
- If stdout is `NO_LAST_REVIEW`, ask the user what OpenCode should investigate or fix and use their reply as the task text.

Final bridged call (exactly one foreground Bash invocation of `safe-command.mjs`, after any helper calls and user questions above have settled):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/safe-command.mjs" task <<'OPENCODE_TASK'
$ARGUMENTS
OPENCODE_TASK
```

Payload rules:

- The body of the heredoc above is the bridge's stdin. Replace `$ARGUMENTS` with the adjusted payload you have decided on: any recognized flags first, then the natural-language task text. Preserve the user's task text byte-for-byte; do not paraphrase, re-quote, or escape it.
- If you added `--resume` via the resume-detection branch, the first token of the payload must be `--resume`.
- If the user chose "Fix issues from last review", prepend the literal header line and the review content before the task text, inside the same heredoc body.
- Rescue is always write-capable. The companion's `task` runtime defaults to write mode and has no read-only switch. If the user asks for read-only, point them at `/opencode:review` or `/opencode:adversarial-review` instead.
- The single-quoted heredoc delimiter (`<<'OPENCODE_TASK'`) prevents shell expansion of anything inside the body, so apostrophes, quotes, `$()`, backticks, `;`, `&`, `|`, `<`, `>`, and newlines in the task text are all safe. Do not try to escape them yourself.

Return rules:

- Return the bridge stdout exactly as-is.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not inspect the repository, read files, grep, monitor progress, poll `/opencode:status`, fetch `/opencode:result`, call `/opencode:cancel`, summarize output, or do any follow-up work of your own.
- If the bridge rejects the payload (unknown flag, invalid `--model` value, `--free` + `--model`, etc.), return the bridge's stderr verbatim and stop.
- If the helper reports that OpenCode is missing or unauthenticated, stop and tell the user to run `/opencode:setup`.
