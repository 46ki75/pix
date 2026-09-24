import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  completionText,
  outcomeText,
  readTail,
  taskDetail,
  taskList,
} from "./format.ts";
import type { Task } from "./registry.ts";

const task: Task = {
  id: "abc",
  name: "test",
  command: "echo test",
  cwd: "/tmp",
  pid: 12,
  outputPath: "/no/log",
  outputBytes: 0,
  startedAt: 1000,
  endedAt: 2000,
  status: "finished",
  outcome: { kind: "signaled", signal: "SIGKILL", code: 137 },
};

test("signal outcomes never show exit code zero", () => {
  expect(taskDetail(task)).toContain("SIGKILL (exit code 137)");
  expect(taskDetail(task)).not.toContain("exit code 0");
  expect(taskDetail(task)).toContain("1.0s");
  expect(completionText(task)).toContain("/no/log");
});

test("formats all terminal reasons explicitly", () => {
  expect(outcomeText({ kind: "exited", code: 3 })).toBe("exit code 3");
  expect(outcomeText({ kind: "timed_out" })).toBe("timed out");
  expect(outcomeText({ kind: "output_capped" })).toBe("output cap reached");
  expect(outcomeText({ kind: "killed", by: "agent" })).toBe("killed by agent");
  expect(outcomeText({ kind: "failed", message: "disk error" })).toContain(
    "disk error",
  );
  expect(taskList([])).toContain("No background tasks");
  expect(taskList(Array.from({ length: 51 }, () => task))).toContain(
    "newest 50 of 51",
  );
});

test("reads only a bounded tail and limits completion previews", () => {
  const directory = mkdtempSync(join(tmpdir(), "pix-bg-format-"));
  const path = join(directory, "output.log");
  try {
    writeFileSync(path, `${"old\n".repeat(10000)}${"last\n".repeat(30)}`);
    expect(Buffer.byteLength(readTail(path))).toBe(8192);
    const text = completionText({ ...task, outputPath: path });
    expect(text).not.toContain("\nold\n");
    expect(text).toContain("last");
    expect(text.split("\n").length).toBeLessThanOrEqual(16);
    expect(text).toContain(path);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
