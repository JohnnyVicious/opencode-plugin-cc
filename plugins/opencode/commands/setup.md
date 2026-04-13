---
description: Check whether the local OpenCode CLI is ready, configure defaults, and optionally toggle the stop-time review gate
argument-hint: '[--default-model <provider/model|off>] [--default-agent <build|plan|off>] [--enable-review-gate|--disable-review-gate] [--review-gate-max <n|off>] [--review-gate-cooldown <minutes|off>]'
allowed-tools: Bash(node:*), Bash(npm:*), Bash(brew:*), Bash(curl:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/safe-command.mjs" setup <<'OPENCODE_ARGS'
$ARGUMENTS
OPENCODE_ARGS
```

If the result says OpenCode is unavailable:
- Use `AskUserQuestion` exactly once to ask whether Claude should install OpenCode now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install OpenCode (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g opencode-ai
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/safe-command.mjs" setup <<'OPENCODE_ARGS'
$ARGUMENTS
OPENCODE_ARGS
```

If OpenCode is already installed:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If OpenCode is installed but no provider is configured, guide the user to run `!opencode providers` to set up authentication.
- `--default-model <provider/model>` sets the model used by `/opencode:review`, `/opencode:adversarial-review`, and `/opencode:rescue` when no `--model` or `--free` flag is supplied. Use `--default-model off` to clear it.
- `--default-agent <build|plan>` sets the rescue/task agent used when no `--agent` flag is supplied. Review commands keep using the bundled read-only review agent. Use `--default-agent off` to clear it.
