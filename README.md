# OpenCode plugin for Claude Code

> **Personal copy**: This repository is a personal copy of
> [tasict/opencode-plugin-cc](https://github.com/tasict/opencode-plugin-cc),
> imported at upstream commit `e751b0160588758fcf5c6244254370eb2c3425aa`.
> It is intentionally not a GitHub fork — there is no upstream remote and no
> automatic sync. Modifications by [JohnnyVicious](https://github.com/JohnnyVicious).
> See `NOTICE` for full attribution.

> **Tribute**: The upstream project is inspired by and pays homage to
> [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) by OpenAI.
> The plugin architecture, command structure, and design patterns are derived from
> the original codex-plugin-cc project, adapted to work with
> [OpenCode](https://github.com/anomalyco/opencode) instead of Codex.

Use OpenCode from inside Claude Code for code reviews or to delegate tasks.

This plugin is for Claude Code users who want an easy way to start using OpenCode from the workflow
they already have.

## What You Get

- `/opencode:review` for a normal read-only OpenCode review
- `/opencode:adversarial-review` for a steerable challenge review
- `/opencode:rescue`, `/opencode:status`, `/opencode:result`, and `/opencode:cancel` to delegate work and manage active jobs
- Optional rescue worktrees so OpenCode can make writable changes in an isolated git worktree before you keep or discard them

## Requirements

- [Claude Code](https://claude.com/claude-code) (CLI, desktop app, or IDE extension)
- [OpenCode](https://github.com/anomalyco/opencode) installed (`npm i -g opencode-ai` or `brew install opencode`)
- A configured AI provider in OpenCode (Claude, OpenAI, Google, etc.)
- Node.js 18.18 or later

## Install

Add the marketplace in Claude Code:

```
/plugin marketplace add JohnnyVicious/opencode-plugin-cc
```

Install the plugin:

```
/plugin install opencode@johnnyvicious-opencode-plugin-cc
```

Reload plugins:

```
/reload-plugins
```

Then verify your setup:

```
/opencode:setup
```

### Set up an AI Provider

If OpenCode is installed but no AI provider is configured, set one up:

```
! opencode providers login
```

To check your configured providers:

```
! opencode providers list
```

### Uninstall

```
/plugin uninstall opencode@johnnyvicious-opencode-plugin-cc
/reload-plugins
```

> **Migrating from the upstream `tasict-opencode-plugin-cc` install?** Run
> `/plugin uninstall opencode@tasict-opencode-plugin-cc` once before the
> install command above so the old marketplace entry is removed.

## Command Mapping (codex-plugin-cc -> opencode-plugin-cc)

| codex-plugin-cc | opencode-plugin-cc | Description |
|---|---|---|
| `/codex:review` | `/opencode:review` | Read-only code review |
| `/codex:adversarial-review` | `/opencode:adversarial-review` | Adversarial challenge review |
| `/codex:rescue` | `/opencode:rescue` | Delegate tasks to external agent |
| `/codex:status` | `/opencode:status` | Show running/recent jobs |
| `/codex:result` | `/opencode:result` | Show finished job output |
| `/codex:cancel` | `/opencode:cancel` | Cancel active background job |
| `/codex:setup` | `/opencode:setup` | Check install/auth, toggle review gate |

## Slash Commands

- `/opencode:review` -- Normal OpenCode code review (read-only). Supports `--base <ref>`, `--pr <number>`, `--path <path>`, `--model <provider/model>`, `--free`, `--wait`, and `--background`.
- `/opencode:adversarial-review` -- Steerable review that challenges implementation and design decisions. Supports `--base <ref>`, `--pr <number>`, `--path <path>`, `--model <provider/model>`, `--free`, `--wait`, `--background`, and custom focus text.
- `/opencode:rescue` -- Delegates a task to OpenCode via the `safe-command.mjs` bridge, which validates flags and feeds the task text through a shell-insulated heredoc. Supports `--model`, `--free`, `--agent`, `--resume`, `--fresh`, `--worktree`, `--wait`, and `--background`. Foreground is the default; `--wait` is an explicit no-op alias for foreground; `--background` detaches a worker and returns a job id you can poll with `/opencode:status`.
- `/opencode:status` -- Shows running/recent OpenCode jobs for the current repo.
- `/opencode:result` -- Shows final output for a finished job, including OpenCode session ID for resuming.
- `/opencode:cancel` -- Cancels an active OpenCode job.
- `/opencode:setup` -- Checks OpenCode install/auth, can enable/disable the review gate hook, and can configure review-gate throttles.

## Review Gate

When enabled via `/opencode:setup --enable-review-gate`, a Stop hook runs a targeted OpenCode review on Claude's response. If issues are found, the stop is blocked so Claude can address them first. Warning: without limits this can create long-running loops and drain usage.

Throttle controls:

```
/opencode:setup --review-gate-max 5
/opencode:setup --review-gate-cooldown 10
/opencode:setup --review-gate-max off
/opencode:setup --review-gate-cooldown off
```

- `--review-gate-max <n|off>` limits how many stop-time reviews can run in one Claude session.
- `--review-gate-cooldown <minutes|off>` enforces a minimum delay between stop-time reviews in the same Claude session.

## Rescue Worktrees

Use `/opencode:rescue --worktree ...` for write-capable tasks you want isolated from the current working tree. OpenCode runs in a disposable `.worktrees/opencode-*` git worktree on an `opencode/*` branch. When the task completes, the output includes keep/discard commands:

- `keep` applies the worktree diff back to the main working tree as staged changes, then removes the temporary worktree and branch.
- `discard` removes the temporary worktree and branch without applying changes.

If applying the patch fails, the worktree is preserved for manual recovery.

## Review-to-Rescue

After a successful `/opencode:review` or `/opencode:adversarial-review`, the rendered review is saved for the current repository. If you run `/opencode:rescue` with no task text, Claude can offer to pass the last review findings back to OpenCode as the rescue task.

## Permission Boundary

OpenCode runs as an independent process with its own permission system, separate from Claude Code's `.claude/settings.json` deny rules. This means:

- A file that Claude Code cannot read or edit (due to a deny rule) **may still be accessible to OpenCode**.
- `/opencode:rescue` is write-capable by default and has full read/write access to the workspace.

If your workspace uses deny rules, the companion will emit a warning when you start a write-capable task so you can make an informed choice. For fully isolated write operations, use `/opencode:rescue --worktree` which runs in a disposable git worktree.

## Troubleshooting

<details>
<summary><strong>Plugin not loading after install (0 plugins)</strong></summary>

1. Confirm the marketplace is registered: `/plugin marketplace list` should include `johnnyvicious-opencode-plugin-cc`. If not, re-run `/plugin marketplace add JohnnyVicious/opencode-plugin-cc`.
2. Re-run `/plugin install opencode@johnnyvicious-opencode-plugin-cc` and then `/reload-plugins`.
3. If still failing, restart Claude Code.
</details>

<details>
<summary><strong>OpenCode commands not working</strong></summary>

1. Verify OpenCode is installed: `! opencode --version`
2. Verify a provider is configured: `! opencode providers list`
3. Run `/opencode:setup` to check the full status.
</details>

## Architecture

Unlike codex-plugin-cc which uses JSON-RPC over stdin/stdout, this plugin communicates with
OpenCode via its HTTP REST API + Server-Sent Events (SSE) for streaming. The server is automatically
started and managed by the companion scripts.

```
codex-plugin-cc                          opencode-plugin-cc
+----------------------+                 +------------------------+
| JSON-RPC over stdio  |                 | HTTP REST + SSE        |
| codex app-server     |      vs.        | opencode serve         |
| Broker multiplexing  |                 | Native HTTP (no broker)|
| codex CLI binary     |                 | opencode CLI binary    |
+----------------------+                 +------------------------+
```

## Project Structure

```
opencode-plugin-cc/
├── .claude-plugin/marketplace.json       # Marketplace registration
├── .github/workflows/ci.yml              # GitHub Actions CI
├── plugins/opencode/
│   ├── .claude-plugin/plugin.json        # Plugin metadata
│   ├── commands/                         # 7 slash commands
│   │   ├── review.md
│   │   ├── adversarial-review.md
│   │   ├── rescue.md
│   │   ├── status.md
│   │   ├── result.md
│   │   ├── cancel.md
│   │   └── setup.md
│   ├── hooks/hooks.json                  # Lifecycle hooks
│   ├── prompts/                          # Prompt templates
│   ├── schemas/                          # Output schemas
│   ├── scripts/                          # Node.js runtime
│   │   ├── opencode-companion.mjs        # CLI entry point
│   │   ├── safe-command.mjs              # Safe slash-command argument bridge
│   │   ├── session-lifecycle-hook.mjs
│   │   ├── stop-review-gate-hook.mjs
│   │   └── lib/                          # Core modules
│   │       ├── opencode-server.mjs       # HTTP API client
│   │       ├── state.mjs                 # Persistent state
│   │       ├── job-control.mjs           # Job management
│   │       ├── tracked-jobs.mjs          # Job lifecycle tracking
│   │       ├── worktree.mjs              # Disposable worktree sessions
│   │       ├── render.mjs                # Output rendering
│   │       ├── prompts.mjs               # Prompt construction
│   │       ├── git.mjs                   # Git utilities
│   │       ├── process.mjs               # Process utilities
│   │       ├── model.mjs                 # Model selection helpers
│   │       ├── review-agent.mjs          # Review agent resolution
│   │       ├── args.mjs                  # Argument parsing
│   │       ├── fs.mjs                    # Filesystem utilities
│   │       └── workspace.mjs             # Workspace detection
│   └── skills/                          # Internal skills
├── tests/                               # Test suite
├── LICENSE                              # Apache License 2.0
├── NOTICE                               # Attribution notice
└── README.md
```

## OpenCode Integration

Wraps the OpenCode HTTP server API. Picks up config from:
- User-level: `~/.config/opencode/config.json`
- Project-level: `.opencode/opencode.jsonc`

## License

Copyright 2026 OpenCode Plugin Contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
