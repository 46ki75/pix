import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import type { Registry, Task } from "./registry.ts";
import { OutputView, TaskUI } from "./ui.ts";

const task: Task = {
  id: "abc",
  name: "界 test",
  command: "sleep 30",
  cwd: "/tmp",
  pid: 1,
  outputPath: "/missing",
  outputBytes: 0,
  startedAt: 0,
  status: "running",
};

test("viewer fits narrow widths, scrolls, refreshes, and releases its timer", () => {
  vi.useFakeTimers();
  const directory = mkdtempSync(join(tmpdir(), "pix-bg-ui-"));
  const outputPath = join(directory, "output.log");
  writeFileSync(
    outputPath,
    Array.from({ length: 100 }, (_, i) => `line ${i} 界`).join("\n"),
  );
  const current = { ...task, outputPath };
  const render = vi.fn();
  const done = vi.fn();
  const view = new OutputView(
    () => current,
    { fg: (_color, text) => text },
    () => 10,
    render,
    done,
  );
  try {
    for (const width of [1, 12, 80]) {
      const lines = view.render(width);
      expect(lines.length).toBeLessThanOrEqual(10);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    expect(view.render(80).join("\n")).toContain("line 99");
    view.handleInput("\x1b[H");
    expect(view.render(80).join("\n")).toContain("line 0");
    view.handleInput("\x1b[F");
    writeFileSync(outputPath, "updated output");
    vi.advanceTimersByTime(1000);
    expect(view.render(80).join("\n")).toContain("updated output");
    view.handleInput("\x1b");
    expect(done).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    const count = render.mock.calls.length;
    vi.advanceTimersByTime(2000);
    expect(render).toHaveBeenCalledTimes(count);
  } finally {
    view.dispose();
    vi.useRealTimers();
    rmSync(directory, { recursive: true });
  }
});

test("task menu confirms user kills and clears its footer", async () => {
  const stop = vi.fn(async () => task);
  const registry = {
    list: () => [task],
    get: () => task,
    stop,
  } as unknown as Registry;
  const select = vi
    .fn()
    .mockImplementationOnce(async (_title, labels: string[]) => labels[0])
    .mockResolvedValueOnce("Kill")
    .mockResolvedValueOnce(undefined);
  const ctx = {
    ui: {
      select,
      confirm: vi.fn(async () => true),
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
  } as unknown as ExtensionCommandContext;
  const ui = new TaskUI(registry, ctx);
  await ui.show(ctx);
  expect(stop).toHaveBeenCalledWith("abc", "user");
  expect(ctx.ui.confirm).toHaveBeenCalledTimes(1);
  expect(ctx.ui.setStatus).toHaveBeenCalledWith("pix-bg", "bg: 1 running");
  ui.dispose();
  ui.dispose();
  expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("pix-bg", undefined);
});

test("canceling confirmation leaves the task alone", async () => {
  const stop = vi.fn();
  const registry = {
    list: () => [task],
    get: () => task,
    stop,
  } as unknown as Registry;
  const ctx = {
    ui: {
      select: vi
        .fn()
        .mockImplementationOnce(async (_title, labels: string[]) => labels[0])
        .mockResolvedValueOnce("Kill")
        .mockResolvedValueOnce(undefined),
      confirm: vi.fn(async () => false),
      setStatus: vi.fn(),
    },
  } as unknown as ExtensionCommandContext;
  const ui = new TaskUI(registry, ctx);
  await ui.show(ctx);
  expect(stop).not.toHaveBeenCalled();
  ui.dispose();
});
