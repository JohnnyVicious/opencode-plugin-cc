---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to OpenCode
argument-hint: "[--background] [--worktree] [--resume|--fresh] [--model <provider/model> | --free] [--agent <build|plan>] [what OpenCode should investigate, solve, or continue]"
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
---

Forward this request to the OpenCode companion's `task` runtime via a single Bash call.
The final user-visible response must be the companion's stdout verbatim — no commentary, summary, or paraphrase before or after it.

Raw user request:
$ARGUMENTS

Execution mode:

- Default to foreground: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task ...` and wait for it to finish. The Bash call must run in the foreground — never set `run_in_background: true` on the Bash tool, even when the user asks for `--background`.
- If the request includes `--background`, append `--background` to the `task` invocation. The companion will spawn a detached worker and return a job id immediately; you then return that job id (with the `Check /opencode:status for progress.` line the companion prints) verbatim.
- `--background` is the only execution-mode flag. Strip it from the natural-language task text before forwarding. `--wait` is accepted as a no-op alias for the default (foreground) mode and must also be stripped from the task text — do not forward it to `task`.
- `--model`, `--free`, and `--agent` are runtime-selection flags. Strip them from the task text and forward each to `task` unchanged. `--free` tells the companion to pick a random first-party `opencode/*` free-tier model from `opencode models`; it is restricted to `opencode/*` because OpenRouter free models have inconsistent tool-use support. `--free` is mutually exclusive with `--model`.
- `--worktree` is an isolation flag. Strip it from the task text and forward it to `task`. When present, OpenCode runs in an isolated git worktree instead of editing the working directory in-place.
- `--resume` and `--fresh` are routing controls. Strip them from the task text. `--resume` becomes `--resume-last` on the forwarded `task` call. `--fresh` means do not add `--resume-last`, regardless of how the natural-language request reads.
- If neither `--resume` nor `--fresh` is present, before starting OpenCode, check for a resumable rescue session from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current OpenCode session or start a new one.
- The two choices must be:
  - `Continue current OpenCode session`
  - `Start a new OpenCode session`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current OpenCode session (Recommended)` first.
- Otherwise put `Start a new OpenCode session (Recommended)` first.
- If the user chooses continue, add `--resume-last` to the forwarded `task` call.
- If the user chooses a new session, do not add `--resume-last`.
- If the helper reports `available: false`, do not ask. Forward normally.

Forwarding rules:

- Use exactly one foreground Bash call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task ...`.
- Pass the user's task text as a single positional argument to `task`, after all flags. Preserve it as-is apart from stripping the routing flags listed above.
- If the user is clearly asking to continue prior OpenCode work in this repository (such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper") and `--fresh` is not present, add `--resume-last` even if neither `--resume` nor the resume prompt above produced one.
- Rescue is always write-capable. The companion's `task` runtime defaults to write mode and has no read-only switch. If the user wants a read-only diagnosis, point them at `/opencode:review` or `/opencode:adversarial-review` instead.
- Leave `--agent` unset unless the user explicitly asks for a specific agent (build or plan).
- Leave the model unset unless the user explicitly asks for a specific model or `--free`. `--free` and `--model` are mutually exclusive — if both are present, return nothing and tell the user to pick one.
- Return the stdout of the `task` command exactly as-is.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not inspect the repository, read files, grep, monitor progress, poll `/opencode:status`, fetch `/opencode:result`, call `/opencode:cancel`, summarize output, or do any follow-up work of your own.
- If the Bash call fails or OpenCode cannot be invoked, return the failure stderr verbatim. If the helper reports that OpenCode is missing or unauthenticated, stop and tell the user to run `/opencode:setup`.
- If the user did not supply a request, check for a saved review from `/opencode:review` or `/opencode:adversarial-review`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" last-review
```

  - If stdout is `LAST_REVIEW_AVAILABLE`, use `AskUserQuestion` exactly once with two options:
    - `Fix issues from last review (Recommended)` — prepend the saved review content as context for the rescue task
    - `Describe a new task` — ask what OpenCode should investigate or fix
  - If the user chooses to fix from last review, read the saved review via:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" last-review --content
```

    and include its stdout verbatim in the forwarded task text, prefixed with:

    `The following issues were found in a prior OpenCode review. Please fix them:\n\n`

  - If stdout is `NO_LAST_REVIEW`, ask what OpenCode should investigate or fix.
