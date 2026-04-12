---
description: Run a steerable adversarial OpenCode review that challenges implementation and design decisions
argument-hint: '[--wait|--background] [--base <ref>] [--model <id> | --free] [--pr <number>] [focus area or custom review instructions]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), Bash(gh:*), AskUserQuestion
---

Run an adversarial OpenCode review through the shared built-in reviewer.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return OpenCode's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - For PR review (`--pr <N>` or a `PR #N` reference in the focus text), use `gh pr view <N> --json additions,deletions,changedFiles` and base the recommendation on those numbers (large PRs almost always go to background).
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait`, `--background`, `--model`, `--free`, or `--pr` yourself.
- Adversarial reviews support custom focus text. Any text after flags is treated as a focus area.
- The companion script handles `--adversarial` internally.
- `--model <id>` overrides OpenCode's default model for this single review (e.g. `--model openrouter/anthropic/claude-opus-4-6`). Pass it through verbatim if the user supplied it.
- `--free` tells the companion script to shell out to `opencode models`, filter for first-party `opencode/*` free-tier models (those ending in `:free` or `-free`), and pick one at random for this review. Restricted to the `opencode/*` provider because OpenRouter free-tier models have inconsistent tool-use support, and the review agent needs `read`/`grep`/`glob`/`list`. Pass it through verbatim if the user supplied it. `--free` and `--model` are mutually exclusive — the companion will error if both are given.
- `--pr <number>` reviews a GitHub pull request via `gh pr diff` instead of the local working tree. The cwd must be a git repo whose remote points at the PR's repository, and `gh` must be installed and authenticated.

PR reference extraction (REQUIRED — read this carefully):
- If the user's input contains a PR reference like `PR #390`, `pr #390`, `PR 390`, or `pr 390`, you MUST extract the number yourself and pass it as `--pr 390`. Then strip the matched PR phrase from whatever you put in the focus text.
- Do **not** rely on the companion script's focus-text auto-detection for PR refs. Bash strips unquoted `#NNN` tokens as comments before they ever reach the companion script (e.g. `bash -c 'node ... adversarial-review on PR #390'` invokes node with argv `["adversarial-review", "on", "PR"]` — the `#390` is gone).
- Example transformation:
  - User input: `/opencode:adversarial-review on PR #390 challenge the caching strategy`
  - Wrong: `node ... adversarial-review on PR #390 challenge the caching strategy` (the `#390` and everything after is silently dropped by bash)
  - Right: `node ... adversarial-review --pr 390 'challenge the caching strategy'`

Focus text quoting (REQUIRED):
- When you invoke the companion script via Bash and the user's focus text contains shell metacharacters (`#`, `*`, `$`, `;`, `&`, `|`, `<`, `>`, parentheses, backticks, etc.), wrap the focus text in **single quotes** so bash passes it through unchanged. Single quotes preserve everything literally except the single-quote character itself.
- If the focus text itself contains a single quote (e.g. `what's wrong here`), use the standard `'\''` escape: `'what'\''s wrong here'`.
- Examples:
  - `/opencode:adversarial-review challenge the design` → `node ... adversarial-review 'challenge the design'`
  - `/opencode:adversarial-review --background look for race conditions in $RUNTIME` → `node ... adversarial-review --background 'look for race conditions in $RUNTIME'`

Foreground flow:
- First, transform `$ARGUMENTS` using the **PR reference extraction** and **Focus text quoting** rules above. Pass through `--wait`, `--background`, `--base`, `--scope`, `--model`, and `--pr` flags as-is; convert any `PR #N` reference in the user's text to `--pr N`; single-quote whatever free-form focus text remains.
- Then run the resulting command (illustrative shape — substitute the actual transformed args):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" adversarial-review <flags> [--pr N] ['<quoted focus text>']
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Apply the same `$ARGUMENTS` transformation as the foreground flow above (PR ref extraction + focus text single-quoting).
- Then launch the resulting command with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" adversarial-review <flags> [--pr N] ['<quoted focus text>']`,
  description: "OpenCode adversarial review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "OpenCode adversarial review started in the background. Check `/opencode:status` for progress."
