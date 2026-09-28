import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_ARGUMENT_BYTES, MAX_RENDERED_PROMPT_BYTES } from "./limits.js";
import { parsePromptFile } from "./parser.js";
import { renderBody, renderPrompt } from "./renderer.js";

const temporaryDirectories: string[] = [];
const variable = (expression: string): string =>
  ["$", "{", expression, "}"].join("");

async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), "mcp-copilot-render-"));
  temporaryDirectories.push(root);
  const directory = join(root, ".github", "prompts");
  await mkdir(directory, { recursive: true });
  const sourcePath = join(directory, "review.prompt.md");
  await writeFile(sourcePath, source);
  const canonicalRoot = await realpath(root);
  const canonicalDirectory = join(canonicalRoot, ".github", "prompts");
  return {
    root: canonicalRoot,
    directory: canonicalDirectory,
    prompt: parsePromptFile(
      source,
      join(canonicalDirectory, "review.prompt.md"),
      canonicalRoot,
    ),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("renderBody", () => {
  it("expands inputs and workspace variables once", async () => {
    const { prompt, root } = await fixture(
      `Review ${variable("input:target:Target")} in ${variable("workspaceFolder")} (${variable("workspaceFolderBasename")}).`,
    );

    expect(renderBody(prompt, { target: variable("workspaceFolder") })).toBe(
      `Review ${variable("workspaceFolder")} in ${root} (${root.split("/").at(-1)}).`,
    );
    expect(renderBody(prompt, { target: variable("input:nested") })).toContain(
      variable("input:nested"),
    );
  });

  it("bounds arguments and the expanded prompt", async () => {
    const { prompt } = await fixture(
      Array.from({ length: 20 }, () => variable("input:value")).join(" "),
    );

    expect(() =>
      renderBody(prompt, { value: "x".repeat(MAX_ARGUMENT_BYTES + 1) }),
    ).toThrow("prompt arguments exceed");
    expect(() =>
      renderBody(prompt, {
        value: "x".repeat(Math.ceil(MAX_RENDERED_PROMPT_BYTES / 10)),
      }),
    ).toThrow("rendered prompt exceeds");
  });

  it("applies the size limit to the final rendered body", async () => {
    const { prompt } = await fixture(
      variable("input:v").repeat(4) + variable("input:e").repeat(1_000),
    );
    const value = "x".repeat(MAX_ARGUMENT_BYTES - 2);

    const rendered = renderBody(prompt, { v: value, e: "" });

    expect(Buffer.byteLength(rendered)).toBe(value.length * 4);
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(
      MAX_RENDERED_PROMPT_BYTES,
    );
  });

  it("rejects missing, unknown, and editor-specific variables", async () => {
    const { prompt } = await fixture(
      `${variable("input:target")} ${variable("selection")}`,
    );

    expect(() => renderBody(prompt, undefined)).toThrow("missing required");
    expect(() => renderBody(prompt, { target: "x", extra: "y" })).toThrow(
      "unknown prompt arguments",
    );
    expect(() => renderBody(prompt, { target: "x" })).toThrow(
      "unsupported prompt variables",
    );
  });
});

describe("renderPrompt", () => {
  it("returns text followed by deduplicated embedded file resources", async () => {
    const { directory, prompt } = await fixture(
      [
        "Use [guide][guide-ref], #file:guide.md, and [site](https://example.com).",
        "",
        "`[code](missing.md)` and `#file:missing.md` are examples.",
        "",
        "```md",
        "[fenced](missing.md) #file:missing.md",
        "```",
        "",
        "[guide-ref]: guide.md",
      ].join("\n"),
    );
    await writeFile(join(directory, "guide.md"), "# Guide\n");

    const result = await renderPrompt(prompt, undefined, {
      allowHomeReferences: false,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({
      role: "user",
      content: { type: "text", text: prompt.body },
    });
    expect(result.messages[1]).toMatchObject({
      role: "user",
      content: {
        type: "resource",
        resource: { mimeType: "text/markdown", text: "# Guide\n" },
      },
    });
  });

  it("ignores #file text inside web links and protocol-relative links", async () => {
    const { prompt } = await fixture(
      "Ignore <https://example.test/#file:secret.md> and [cdn](//example.test/image.png).",
    );

    const result = await renderPrompt(prompt, undefined, {
      allowHomeReferences: false,
    });

    expect(result.messages).toHaveLength(1);
  });

  it("resolves workspace variables in references without expanding inputs", async () => {
    const workspace = variable("workspaceFolder");
    const workspaceName = variable("workspaceFolderBasename");
    const { directory, prompt, root } = await fixture(
      `[guide](${workspace}/docs/guide.md) #file:${workspace}/docs/guide.md #file:${workspaceName}.md`,
    );
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "guide.md"), "Guide");
    await writeFile(join(directory, `${basename(root)}.md`), "Workspace");

    const result = await renderPrompt(prompt, undefined, {
      allowHomeReferences: false,
    });

    expect(result.messages[1]).toMatchObject({
      content: { type: "resource", resource: { text: "Guide" } },
    });
    expect(result.messages[2]).toMatchObject({
      content: { type: "resource", resource: { text: "Workspace" } },
    });

    const input = await fixture(`[guide](${variable("input:path")})`);
    await expect(
      renderPrompt(
        input.prompt,
        { path: "docs/guide.md" },
        { allowHomeReferences: false },
      ),
    ).rejects.toThrow("input and editor variables");
  });

  it("rejects traversal after expanding a workspace variable", async () => {
    const outside = await mkdtemp(join(tmpdir(), "mcp-copilot-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "secret.md"), "secret");
    const { prompt } = await fixture(
      `[secret](${variable("workspaceFolder")}/../${basename(outside)}/secret.md)`,
    );

    await expect(
      renderPrompt(prompt, undefined, { allowHomeReferences: false }),
    ).rejects.toThrow("outside its allowed root");
  });

  it("treats quoted #file values as filesystem paths", async () => {
    const { directory, prompt } = await fixture(
      'Use #file:"foo#bar.md" and #file:"100%.md".',
    );
    await writeFile(join(directory, "foo#bar.md"), "Hash");
    await writeFile(join(directory, "100%.md"), "Percent");

    const result = await renderPrompt(prompt, undefined, {
      allowHomeReferences: false,
    });

    expect(result.messages.slice(1)).toMatchObject([
      { content: { type: "resource", resource: { text: "Hash" } } },
      { content: { type: "resource", resource: { text: "Percent" } } },
    ]);
  });

  it("stops unquoted #file references at sentence punctuation", async () => {
    const { directory, prompt } = await fixture(
      "Use #file:period.md. #file:colon.md: #file:bang.md! #file:question.md?",
    );
    for (const name of ["period", "colon", "bang", "question"]) {
      await writeFile(join(directory, `${name}.md`), name);
    }

    const result = await renderPrompt(prompt, undefined, {
      allowHomeReferences: false,
    });

    expect(
      result.messages
        .slice(1)
        .map((message) =>
          message.content.type === "resource" &&
          "text" in message.content.resource
            ? message.content.resource.text
            : undefined,
        ),
    ).toEqual(["period", "colon", "bang", "question"]);
  });

  it("ignores embedded and escaped #file literals", async () => {
    const { directory, prompt } = await fixture(
      "Literals identifier#file:missing.md and \\#file:missing.md. Use #file:guide.md.",
    );
    await writeFile(join(directory, "guide.md"), "Guide");

    const result = await renderPrompt(prompt, undefined, {
      allowHomeReferences: false,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toMatchObject({
      content: { type: "resource", resource: { text: "Guide" } },
    });
  });

  it("does not interpret prompt argument values as file references", async () => {
    const { directory, prompt } = await fixture(
      `Inspect ${variable("input:target")}.`,
    );
    await writeFile(join(directory, "secret.md"), "secret");

    const result = await renderPrompt(
      prompt,
      { target: "#file:secret.md" },
      { allowHomeReferences: false },
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      content: { type: "text", text: "Inspect #file:secret.md." },
    });
  });

  it("rejects references that escape through traversal or symlinks", async () => {
    const outside = await mkdtemp(join(tmpdir(), "mcp-copilot-outside-"));
    temporaryDirectories.push(outside);
    const target = join(outside, "secret.md");
    await writeFile(target, "secret");

    const traversal = await fixture("Use #file:../../../secret.md");
    await expect(
      renderPrompt(traversal.prompt, undefined, { allowHomeReferences: false }),
    ).rejects.toThrow();

    const linked = await fixture("Use #file:secret.md");
    await symlink(target, join(linked.directory, "secret.md"));
    await expect(
      renderPrompt(linked.prompt, undefined, { allowHomeReferences: false }),
    ).rejects.toThrow("outside its allowed root");
  });

  it("validates arguments before reading referenced files", async () => {
    const { prompt } = await fixture(
      `Use #file:missing.md for ${variable("input:target")}.`,
    );

    await expect(
      renderPrompt(prompt, undefined, { allowHomeReferences: false }),
    ).rejects.toThrow("missing required prompt arguments");
  });

  it("requires explicit permission for home-directory references", async () => {
    const { prompt } = await fixture("Use #file:~/private.md");

    await expect(
      renderPrompt(prompt, undefined, { allowHomeReferences: false }),
    ).rejects.toThrow("--allow-home-references");
  });
});
