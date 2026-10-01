import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { createPromptPicker } from "./prompt-picker.ts";
import { promptKey, type PromptEntry } from "./prompts.ts";

const entries: PromptEntry[] = [
  {
    server: "fixture",
    prompt: {
      name: "conversation",
      description: "Conversation\u001b[31m description\u202Espoof",
    },
  },
  {
    server: "fixture",
    prompt: {
      name: "review",
      title: "Review a topic",
      description: "Review the selected topic.",
    },
  },
];

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

function fixture(signal?: AbortSignal) {
  const requestRender = vi.fn();
  const done = vi.fn<(result: string | undefined) => void>();
  const component = createPromptPicker(
    entries,
    { requestRender } as unknown as TUI,
    theme,
    done,
    signal,
  );
  return { component, done, requestRender };
}

test("shows the focused prompt description and updates it with selection", () => {
  const { component, done, requestRender } = fixture();

  const initial = component.render(80).join("\n");
  expect(initial).toContain("Conversation [31m description spoof");
  expect(initial).not.toContain("\u001b");
  expect(initial).not.toContain("\u202E");
  expect(initial).not.toContain("Review the selected topic.");

  component.handleInput?.("\u001b[B");
  const focused = component.render(80).join("\n");
  expect(focused).toContain("Review a topic");
  expect(focused).toContain("Review the selected topic.");
  expect(focused).not.toContain("Conversation [31m description spoof");
  expect(requestRender).toHaveBeenCalledOnce();

  component.handleInput?.("\r");
  expect(done).toHaveBeenCalledExactlyOnceWith(promptKey("fixture", "review"));
  component.dispose();
});

test("aborting the focused prompt picker cancels it once", () => {
  const controller = new AbortController();
  const { component, done } = fixture(controller.signal);

  controller.abort();
  component.handleInput?.("\r");

  expect(done).toHaveBeenCalledExactlyOnceWith(undefined);
  component.dispose();
});
