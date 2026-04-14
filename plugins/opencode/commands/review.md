---
description: Run an OpenCode code review against local git state or a GitHub PR
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <id> | --free] [--pr <number>] [--path <path>] [--path <path2>]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), Bash(gh:*), AskUserQuestion
---

Run an OpenCode review through the shared built-in reviewer.

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
  - For PR review (`--pr <N>`), use `gh pr view <N> --json additions,deletions,changedFiles` and base the recommendation on those numbers (large PRs almost always go to background).
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
- Do not strip `--wait` or `--background` yourself.
- Do not add extra review instructions or rewrite the user's intent.
- The companion script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- `/opencode:review` is native-review only. It does not support staged-only review, unstaged-only review, or extra focus text.
- If the user needs custom review instructions or more adversarial framing, they should use `/opencode:adversarial-review`.
- `--model <id>` overrides the saved setup default model and OpenCode's own default model for this single review (e.g. `--model openrouter/anthropic/claude-opus-4-6`). Pass it through verbatim if the user supplied it.
- `--free` tells the companion script to shell out to `opencode models`, filter for first-party `opencode/*` free-tier models (those ending in `:free` or `-free`), and pick one at random for this review. Restricted to the `opencode/*` provider because OpenRouter free-tier models have inconsistent tool-use support, and the review agent needs `read`/`grep`/`glob`/`list`. Pass it through verbatim if the user supplied it. `--free` and `--model` are mutually exclusive — the companion will error if both are given.
- `--pr <number>` reviews a GitHub pull request via `gh pr diff` instead of the local working tree. The cwd must be a git repo whose remote points at the PR's repository, and `gh` must be installed and authenticated. Pass it through verbatim if the user supplied it.
- `--path <path>` reviews a specific file or directory instead of git diff. Can be specified multiple times (`--path src --path lib`). When `--path` is set, the review is assembled from the actual file contents at those paths rather than from `git diff`. This is useful for reviewing specific directories, fixed sets of files, or large untracked/imported code drops. Mutually exclusive with `--pr` (paths take precedence over PR mode).
- **PR reference extraction (REQUIRED)**: if the user's input contains a PR reference like `PR #390`, `pr #390`, `PR 390`, or `pr 390` (e.g. `/opencode:review on PR #390`), you MUST extract the number yourself and pass it as `--pr 390`. Do not pass `PR #390` literally to bash — bash strips unquoted `#NNN` tokens as comments before they reach the companion script. Example: `node ... review --pr 390`, NOT `node ... review on PR #390`.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" review $ARGUMENTS
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.
- If the user's original request asked for the review to be posted/commented/published to the PR, follow the "Optional: post the review to GitHub" section below after returning the review output.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" review $ARGUMENTS`,
  description: "OpenCode review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "OpenCode review started in the background. Check `/opencode:status` for progress."
- When the user later asks to collect the result and the original request asked for a PR post, read the completed `BashOutput`, return the review output, then follow the "Optional: post the review to GitHub" section below.

Optional: post the review to GitHub (only when the user explicitly asked):
- Triggers: the user's slash-command invocation said something like "and post it to the PR", "comment it back", "publish the review", "review on GitHub". A bare `/opencode:review --pr 412` is NOT a request to post. If in doubt, do not post.
- Preconditions: `--pr <N>` was in the arguments AND the user's request explicitly asked for publishing. Never post a review for a `--path` run (paths have no PR to post to).
- What to post:
  - A single GitHub PR review (`event: COMMENT`) containing a clean markdown summary body written in your own voice based on the review output. Do not paste the raw review output verbatim into the body; rewrite it as a digest with a short ship/no-ship line, the handful of material findings, and a closing note.
  - Optionally, for findings where you are confident about the exact file and line, include inline review comments anchored to those lines. Only include an inline comment if the line is part of the PR's unified diff (`gh api repos/{owner}/{repo}/pulls/<N>/files` → `patch` fields). Skip inline anchoring when the review is prose-only or the lines are unclear.
- How to post:
  1. Compose the payload as a single JSON object: `{ "commit_id": "<head SHA>", "event": "COMMENT", "body": "<markdown summary>", "comments": [ { "path": "...", "line": N, "side": "RIGHT", "body": "..." }, ... ] }`. Get the head SHA via `gh pr view <N> --json headRefOid --jq .headRefOid`.
  2. Write the payload to a temp file (`/tmp/opencode-post-<pr>-<random>.json`) using the `Write` tool so you control escaping — do NOT try to build a heredoc inside a Bash call.
  3. Run `gh api -X POST "repos/{owner}/{repo}/pulls/<N>/reviews" --input /tmp/...json` via a single `Bash` call.
  4. Extract `html_url` from the response and append a one-line status to your final turn output: `Review posted to PR #<N>: <url>`.
  5. Delete the temp file with `rm -f /tmp/...json`.
  6. On failure, say `Failed to post review to PR #<N>: <error>` and do not retry.
- The review is always published with `event: "COMMENT"` — never `REQUEST_CHANGES`. This tool is advisory, not gatekeeping.
