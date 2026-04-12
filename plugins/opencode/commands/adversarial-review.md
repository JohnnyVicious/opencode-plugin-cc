---
description: Run a steerable adversarial OpenCode review that challenges implementation and design decisions
argument-hint: '[--wait|--background] [--base <ref>] [--model <id>] [--pr <number>] [focus area or custom review instructions]'
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
- Do not strip `--wait`, `--background`, `--model`, or `--pr` yourself.
- Adversarial reviews support custom focus text. Any text after flags is treated as a focus area.
- The companion script handles `--adversarial` internally.
- `--model <id>` overrides OpenCode's default model for this single review (e.g. `--model openrouter/anthropic/claude-opus-4-6`). Pass it through verbatim if the user supplied it.
- `--pr <number>` reviews a GitHub pull request via `gh pr diff` instead of the local working tree. The cwd must be a git repo whose remote points at the PR's repository, and `gh` must be installed and authenticated.
- If the user mentions a PR reference in the focus text (e.g. `on PR #390`), the companion script auto-detects it and strips the matched substring from the focus. You do not need to do anything special — just pass the user's text through verbatim. Prefer the explicit `--pr` flag for new commands.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" adversarial-review $ARGUMENTS
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" adversarial-review $ARGUMENTS`,
  description: "OpenCode adversarial review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "OpenCode adversarial review started in the background. Check `/opencode:status` for progress."
