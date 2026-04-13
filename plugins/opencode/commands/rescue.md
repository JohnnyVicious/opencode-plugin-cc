---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the OpenCode rescue subagent
argument-hint: "[--background|--wait] [--worktree] [--resume|--fresh] [--model <provider/model> | --free] [--agent <build|plan>] [what OpenCode should investigate, solve, or continue]"
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
---

Route this request to the `opencode:opencode-rescue` subagent.
The final user-visible response must be OpenCode's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `opencode:opencode-rescue` subagent in the background.
- If the request includes `--wait`, run the `opencode:opencode-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model`, `--free`, and `--agent` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text. If `--model`/`--free` or `--agent` are omitted, companion-level defaults configured by `/opencode:setup` may apply. `--free` tells the companion to pick a random first-party `opencode/*` free-tier model from `opencode models`; it is restricted to `opencode/*` because OpenRouter free models have inconsistent tool-use support. `--free` is mutually exclusive with `--model`.
- `--worktree` is an isolation flag. Preserve it for the forwarded `task` call, but do not treat it as part of the natural-language task text. When present, OpenCode runs in an isolated git worktree instead of editing the working directory in-place.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting OpenCode, check for a resumable rescue session from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current OpenCode session or start a new one.
- The two choices must be:
  - `Continue current OpenCode session`
  - `Start a new OpenCode session`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current OpenCode session (Recommended)` first.
- Otherwise put `Start a new OpenCode session (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new session, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task ...` and return that command's stdout as-is.
- Return the OpenCode companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/opencode:status`, fetch `/opencode:result`, call `/opencode:cancel`, summarize output, or do follow-up work of its own.
- Leave `--agent` unset unless the user explicitly asks for a specific agent (build or plan).
- Leave the model unset unless the user explicitly asks for a specific model or `--free`.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that OpenCode is missing or unauthenticated, stop and tell the user to run `/opencode:setup`.
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
