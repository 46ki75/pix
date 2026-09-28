import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { createResourcePicker } from "./resource-picker.ts";
import { resourceEntryKey, type ResourceEntry } from "./resources.ts";

const entries: ResourceEntry[] = [
  {
    kind: "resource",
    server: "fixture",
    resource: {
      uri: "fixture://notes",
      name: "Notes",
      description: "Project\u001b[31m notes\u202Espoof",
      mimeType: "text/markdown",
      size: 42,
    },
  },
  {
    kind: "template",
    server: "fixture",
    template: {
      uriTemplate: "fixture://users/{id}",
      name: "User notes",
      title: "Notes for a user",
      description: "Dynamic notes",
      annotations: {
        audience: ["user", "assistant", "user"],
        priority: 0.8,
      },
    },
    variables: ["id"],
  },
];

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

function fixture(signal?: AbortSignal) {
  const requestRender = vi.fn();
  const done = vi.fn<(result: string | undefined) => void>();
  const component = createResourcePicker(
    entries,
    { requestRender } as unknown as TUI,
    theme,
    done,
    signal,
  );
  return { component, done, requestRender };
}

test("shows bounded sanitized resource details and updates focus", () => {
  const { component, done, requestRender } = fixture();

  const initial = component.render(100).join("\n");
  expect(initial).toContain("Project [31m notes spoof");
  expect(initial).toContain("text/markdown");
  expect(initial).toContain("42 bytes");
  expect(initial).not.toContain("\u001b");
  expect(initial).not.toContain("\u202E");

  component.handleInput?.("\u001b[B");
  const focused = component.render(100).join("\n");
  expect(focused).toContain("Notes for a user");
  expect(focused).toContain("fixture://users/{id}");
  expect(focused).toContain("Variables: id");
  expect(focused).toContain("Audience: user, assistant");
  expect(focused).not.toContain("Audience: user, assistant, user");
  expect(requestRender).toHaveBeenCalledOnce();

  component.handleInput?.("\r");
  expect(done).toHaveBeenCalledExactlyOnceWith(resourceEntryKey(entries[1]!));
  component.dispose();
});

test("aborting the focused resource picker cancels it once", () => {
  const controller = new AbortController();
  const { component, done } = fixture(controller.signal);

  controller.abort();
  component.handleInput?.("\r");

  expect(done).toHaveBeenCalledExactlyOnceWith(undefined);
  component.dispose();
});
