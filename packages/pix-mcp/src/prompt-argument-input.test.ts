import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, expect, test, vi } from "vitest";
import { createPromptArgumentInput } from "./prompt-argument-input.ts";

beforeAll(() => initTheme("dark", false));

function fixture(signal?: AbortSignal) {
  const requestRender = vi.fn();
  const fg = vi.fn(
    (color: string, text: string) => `<${color}>${text}</${color}>`,
  );
  const done = vi.fn<(value: string | undefined) => void>();
  const component = createPromptArgumentInput(
    { requestRender } as unknown as TUI,
    { fg } as unknown as Theme,
    done,
    {
      label: "topic (required)",
      description: "Topic to review",
      guidance: "Enter a value",
      ...(signal ? { signal } : {}),
    },
  );
  return { component, done, fg, requestRender };
}

test("renders the argument description as dim and guidance as muted", () => {
  const { component, fg } = fixture();

  const rendered = component.render(80).join("\n");
  expect(fg).toHaveBeenCalledWith("dim", "Topic to review");
  expect(fg).toHaveBeenCalledWith("muted", "Enter a value");
  expect(rendered).toContain("<dim>Topic to review</dim>");
  expect(rendered).toContain("<muted>Enter a value</muted>");
  component.dispose();
});

test("submits input and cancels once when aborted", () => {
  const submitted = fixture();
  submitted.component.handleInput("answer");
  submitted.component.handleInput("\r");
  expect(submitted.done).toHaveBeenCalledExactlyOnceWith("answer");
  expect(submitted.requestRender).toHaveBeenCalledTimes(2);
  submitted.component.dispose();

  const controller = new AbortController();
  const aborted = fixture(controller.signal);
  controller.abort();
  aborted.component.handleInput("\r");
  expect(aborted.done).toHaveBeenCalledExactlyOnceWith(undefined);
  aborted.component.dispose();
});
