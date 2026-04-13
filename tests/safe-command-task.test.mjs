// Unit tests for safe-command.mjs `task` bridge parsing.
//
// Only exercises the pure argv-building layer (`buildForwardArgs`), not
// the full spawn chain. The bridge's security contract is: given raw
// stdin text, it (1) rejects unknown flags, (2) validates value-flags,
// (3) translates routing aliases, and (4) forwards everything else as a
// single verbatim task-text positional argument. If the output argv
// matches expectations for a given input, the bridge is safe — no shell
// layer exists between here and opencode-companion.mjs.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildForwardArgs } from "../plugins/opencode/scripts/safe-command.mjs";

function task(input) {
  return buildForwardArgs("task", input);
}

describe("safe-command task bridge — happy paths", () => {
  it("forwards plain task text as a single positional arg", () => {
    assert.deepEqual(task("fix the bug in src/foo.js"), ["task", "fix the bug in src/foo.js"]);
  });

  it("peels --background off the front and keeps task text literal", () => {
    assert.deepEqual(
      task("--background investigate why sessions leak"),
      ["task", "--background", "investigate why sessions leak"]
    );
  });

  it("peels multiple boolean flags in order", () => {
    assert.deepEqual(
      task("--background --worktree --free do the thing"),
      ["task", "--background", "--worktree", "--free", "do the thing"]
    );
  });

  it("translates --resume to --resume-last", () => {
    assert.deepEqual(
      task("--resume keep going"),
      ["task", "--resume-last", "keep going"]
    );
  });

  it("accepts --resume-last directly and emits it once", () => {
    assert.deepEqual(
      task("--resume-last continue from where we left off"),
      ["task", "--resume-last", "continue from where we left off"]
    );
  });

  it("strips --wait (no-op alias for foreground)", () => {
    assert.deepEqual(
      task("--wait diagnose this"),
      ["task", "diagnose this"]
    );
  });

  it("strips --fresh (routing marker — absence of --resume-last already conveys 'fresh')", () => {
    assert.deepEqual(
      task("--fresh start clean"),
      ["task", "start clean"]
    );
  });

  it("forwards --model value after basic validation", () => {
    assert.deepEqual(
      task("--model openrouter/anthropic/claude-haiku-4.5 fix the bug"),
      ["task", "--model", "openrouter/anthropic/claude-haiku-4.5", "fix the bug"]
    );
  });

  it("forwards --agent build and --agent plan", () => {
    assert.deepEqual(
      task("--agent build implement feature"),
      ["task", "--agent", "build", "implement feature"]
    );
    assert.deepEqual(
      task("--agent plan outline the approach"),
      ["task", "--agent", "plan", "outline the approach"]
    );
  });

  it("combines many flags and preserves task text literally", () => {
    assert.deepEqual(
      task("--background --worktree --resume --model provider/model-x --agent build refactor the worker"),
      [
        "task",
        "--background",
        "--worktree",
        "--resume-last",
        "--model",
        "provider/model-x",
        "--agent",
        "build",
        "refactor the worker",
      ]
    );
  });
});

describe("safe-command task bridge — task text is shell-insulated", () => {
  it("passes apostrophes through literally", () => {
    assert.deepEqual(
      task("--background what's broken here"),
      ["task", "--background", "what's broken here"]
    );
  });

  it("passes shell metacharacters through literally as one string", () => {
    const taskText = "fix `rm -rf /tmp/x`; echo $(whoami) > /etc/passwd | tee /dev/null & \"oops\"";
    assert.deepEqual(task(taskText), ["task", taskText]);
  });

  it("passes newlines through literally", () => {
    const taskText = "line one\nline two\nline three";
    assert.deepEqual(task(taskText), ["task", taskText]);
  });

  it("passes leading task text that contains quotes without tokenizing", () => {
    const taskText = `he said "this is broken" and she said 'also broken'`;
    assert.deepEqual(task(taskText), ["task", taskText]);
  });

  it("preserves internal whitespace in task text after the first non-flag token", () => {
    assert.deepEqual(
      task("--worktree  fix    spacing   here"),
      ["task", "--worktree", "fix    spacing   here"]
    );
  });

  it("does not re-tokenize dashes in the middle of task text", () => {
    assert.deepEqual(
      task("check --verbose flag handling in the cli"),
      ["task", "check --verbose flag handling in the cli"]
    );
  });

  it("handles task text that starts with a hyphen after a known flag", () => {
    // `-x` isn't a recognized flag (not `--`-prefixed) so it becomes
    // part of the task text verbatim.
    assert.deepEqual(
      task("--background -x is not a flag, keep it in the task text"),
      ["task", "--background", "-x is not a flag, keep it in the task text"]
    );
  });
});

describe("safe-command task bridge — rejection paths", () => {
  it("rejects unknown double-dash flags", () => {
    assert.throws(
      () => task("--evil-flag do something"),
      /Unsupported rescue flag: --evil-flag/
    );
  });

  it("rejects --model without a value", () => {
    assert.throws(() => task("--model"), /--model requires a value/);
  });

  it("rejects --model with an invalid value", () => {
    assert.throws(
      () => task("--model bad;value do things"),
      /--model value must match/
    );
  });

  it("rejects --agent without a value", () => {
    assert.throws(() => task("--agent"), /--agent requires a value/);
  });

  it("rejects --agent with a disallowed value", () => {
    assert.throws(
      () => task("--agent evil run unsafe things"),
      /--agent value must be 'build' or 'plan'/
    );
  });

  it("rejects --free combined with --model", () => {
    assert.throws(
      () => task("--free --model provider/model fix it"),
      /--free and --model are mutually exclusive/
    );
    assert.throws(
      () => task("--model provider/model --free fix it"),
      /--free and --model are mutually exclusive/
    );
  });

  it("returns just the subcommand when stdin is empty", () => {
    // A completely empty payload is allowed at the bridge layer.
    // opencode-companion.mjs's handleTask is responsible for rejecting
    // no-task-text invocations; that's covered by its own tests.
    assert.deepEqual(task(""), ["task"]);
  });
});

describe("safe-command task bridge — command dispatch", () => {
  it("still rejects unknown top-level subcommands", () => {
    assert.throws(
      () => buildForwardArgs("not-a-command", ""),
      /Unsupported safe command: not-a-command/
    );
  });
});
