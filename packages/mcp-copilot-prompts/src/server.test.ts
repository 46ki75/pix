import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ListRootsRequestSchema,
  PromptListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalizeRoot } from "./roots.js";
import { CopilotPromptServer } from "./server.js";

const temporaryDirectories: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
const variable = (expression: string): string =>
  ["$", "{", expression, "}"].join("");

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "mcp-copilot-server-"));
  temporaryDirectories.push(path);
  return realpath(path);
}

async function writePrompt(
  root: string,
  filename: string,
  source: string,
): Promise<void> {
  const directory = join(root, ".github", "prompts");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, filename), source);
}

function promptListChanged(client: Client): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("prompt list notification timed out")),
      3_000,
    );
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

interface ConnectionOptions {
  explicitRoot?: string;
  fallbackRoot: string;
  clientRoots?: () => string[] | Promise<string[]>;
  watch?: boolean;
}

async function connect(options: ConnectionOptions) {
  const fallbackRoot = await canonicalizeRoot({ path: options.fallbackRoot });
  const explicitRoots = options.explicitRoot
    ? [await canonicalizeRoot({ path: options.explicitRoot })]
    : [];
  const service = await CopilotPromptServer.create({
    explicitRoots,
    fallbackRoot,
    allowHomeReferences: false,
    ...(options.watch === undefined ? {} : { watch: options.watch }),
  });
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    options.clientRoots
      ? { capabilities: { roots: { listChanged: true } } }
      : { capabilities: {} },
  );
  if (options.clientRoots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: ((await options.clientRoots?.()) ?? []).map((path) => ({
        uri: pathToFileURL(path).href,
      })),
    }));
  }
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await service.server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await service.close();
  });
  return { client, service };
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("CopilotPromptServer", () => {
  it("lists and renders Copilot prompt files", async () => {
    const root = await temporaryDirectory();
    await writePrompt(
      root,
      "review.prompt.md",
      [
        "---",
        "name: review-api",
        "description: Review an API",
        "argument-hint: API name",
        "agent: agent",
        "model: test-model",
        "tools: [search/codebase]",
        "---",
        `Review ${variable("input:api:API name")} in ${variable("workspaceFolderBasename")}.`,
      ].join("\n"),
    );
    const { client } = await connect({
      explicitRoot: root,
      fallbackRoot: root,
      watch: false,
    });

    const listed = await client.listPrompts();
    expect(listed.prompts).toHaveLength(1);
    expect(listed.prompts[0]).toMatchObject({
      name: "review-api",
      description: "Review an API",
      arguments: [{ name: "api", required: true, description: "API name" }],
      _meta: {
        "cloud.ikuma/mcp-copilot-prompts": {
          argumentHint: "API name",
          agent: "agent",
          model: "test-model",
          tools: ["search/codebase"],
        },
      },
    });

    const result = await client.getPrompt({
      name: "review-api",
      arguments: { api: "billing" },
    });
    expect(result.messages[0]).toMatchObject({
      content: { type: "text", text: /Review billing in mcp-copilot-server-/ },
    });
  });

  it("uses the working directory when the client has no roots capability", async () => {
    const fallback = await temporaryDirectory();
    await writePrompt(fallback, "fallback.prompt.md", "Fallback prompt");
    const { client } = await connect({ fallbackRoot: fallback, watch: false });

    const listed = await client.listPrompts();

    expect(listed.prompts.map((prompt) => prompt.name)).toEqual(["fallback"]);
  });

  it("uses MCP roots when explicit roots are absent", async () => {
    const fallback = await temporaryDirectory();
    const project = await temporaryDirectory();
    const replacement = await temporaryDirectory();
    await writePrompt(project, "project.prompt.md", "Project prompt");
    await writePrompt(replacement, "replacement.prompt.md", "Replacement");
    let roots = [project];
    const { client } = await connect({
      fallbackRoot: fallback,
      clientRoots: () => roots,
      watch: false,
    });

    expect(
      (await client.listPrompts()).prompts.map((prompt) => prompt.name),
    ).toEqual(["project"]);

    const changed = new Promise<void>((resolve) => {
      client.setNotificationHandler(PromptListChangedNotificationSchema, () =>
        resolve(),
      );
    });
    roots = [replacement];
    await client.sendRootsListChanged();
    await changed;

    expect(
      (await client.listPrompts()).prompts.map((prompt) => prompt.name),
    ).toEqual(["replacement"]);
  });

  it("coalesces bursts of roots-change notifications", async () => {
    const fallback = await temporaryDirectory();
    const requests: Array<(roots: string[]) => void> = [];
    let requestCount = 0;
    const { client } = await connect({
      fallbackRoot: fallback,
      clientRoots: () => {
        requestCount++;
        return new Promise<string[]>((resolve) => requests.push(resolve));
      },
      watch: false,
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    requests.shift()?.([]);
    await client.listPrompts();

    const notifications = Array.from({ length: 5 }, () =>
      client.sendRootsListChanged(),
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    requests.shift()?.([]);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    requests.shift()?.([]);
    await Promise.all(notifications);

    expect(requestCount).toBe(3);
  });

  it("closes cleanly while a roots request is pending", async () => {
    const fallback = await temporaryDirectory();
    let finishRequest: ((roots: string[]) => void) | undefined;
    const { service } = await connect({
      fallbackRoot: fallback,
      clientRoots: () =>
        new Promise<string[]>((resolve) => {
          finishRequest = resolve;
        }),
      watch: false,
    });
    await vi.waitFor(() => expect(finishRequest).toBeTypeOf("function"));

    const closing = service.close();
    finishRequest?.([]);

    await expect(closing).resolves.toBeUndefined();
  });

  it("fails closed when a roots-capable client cannot return roots", async () => {
    const fallback = await temporaryDirectory();
    await writePrompt(fallback, "fallback.prompt.md", "Fallback prompt");
    const { client } = await connect({
      fallbackRoot: fallback,
      clientRoots: () => {
        throw new Error("roots unavailable");
      },
      watch: false,
    });

    const listed = await client.listPrompts();

    expect(listed.prompts).toEqual([]);
  });

  it("paginates and rejects cursors from an older catalog", async () => {
    const root = await temporaryDirectory();
    await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        writePrompt(
          root,
          `${String(index).padStart(3, "0")}.prompt.md`,
          "Prompt",
        ),
      ),
    );
    const { client } = await connect({
      explicitRoot: root,
      fallbackRoot: root,
      watch: false,
    });

    const first = await client.listPrompts();
    expect(first.prompts).toHaveLength(100);
    expect(first.nextCursor).toBeTypeOf("string");
    const second = await client.listPrompts({ cursor: first.nextCursor });
    expect(second.prompts).toHaveLength(1);

    await writePrompt(root, "new.prompt.md", "New");
    await expect(
      client.listPrompts({ cursor: first.nextCursor }),
    ).rejects.toThrow("catalog changed");
  });

  it("notifies the client when a missing prompt directory is created", async () => {
    const root = await temporaryDirectory();
    const { client } = await connect({
      explicitRoot: root,
      fallbackRoot: root,
    });
    expect((await client.listPrompts()).prompts).toEqual([]);
    const changed = promptListChanged(client);

    await writePrompt(root, "one.prompt.md", "One");
    await changed;
    const listed = await client.listPrompts();

    expect(listed.prompts.map((prompt) => prompt.name)).toEqual(["one"]);
  });

  it("watches a prompt file through an in-root symlink", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, ".github", "prompts");
    const target = join(root, "target.prompt.md");
    await mkdir(directory, { recursive: true });
    await writeFile(target, "Before");
    await writeFile(join(directory, "guide.md"), "Guide");
    await symlink(target, join(directory, "alias.prompt.md"));
    const { client } = await connect({
      explicitRoot: root,
      fallbackRoot: root,
    });
    const listed = await client.listPrompts();
    expect(listed.prompts.map((prompt) => prompt.name)).toEqual(["alias"]);
    expect(listed.prompts[0]).toMatchObject({
      _meta: {
        "cloud.ikuma/mcp-copilot-prompts": {
          source: ".github/prompts/alias.prompt.md",
        },
      },
    });
    const changed = promptListChanged(client);

    await writeFile(target, "After [guide](guide.md)");
    await changed;

    const result = await client.getPrompt({ name: "alias" });
    expect(result.messages[0]).toMatchObject({
      content: { type: "text", text: "After [guide](guide.md)" },
    });
    expect(result.messages[1]).toMatchObject({
      content: { type: "resource", resource: { text: "Guide" } },
    });
  });

  it("continues watching a deleted symlinked prompt target", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, ".github", "prompts");
    const targetDirectory = join(root, "ignored", "deep");
    const target = join(targetDirectory, "target.prompt.md");
    await mkdir(directory, { recursive: true });
    await mkdir(targetDirectory, { recursive: true });
    await writeFile(target, "Before");
    await symlink(target, join(directory, "alias.prompt.md"));
    const { client } = await connect({
      explicitRoot: root,
      fallbackRoot: root,
    });
    expect((await client.listPrompts()).prompts).toHaveLength(1);
    const removed = promptListChanged(client);

    await unlink(target);
    await removed;
    expect((await client.listPrompts()).prompts).toEqual([]);
    const restored = promptListChanged(client);

    await writeFile(target, "Restored");
    await restored;
    expect(
      (await client.listPrompts()).prompts.map((prompt) => prompt.name),
    ).toEqual(["alias"]);
  });

  it("watches the target of a malformed symlinked prompt", async () => {
    const root = await temporaryDirectory();
    const directory = join(root, ".github", "prompts");
    const target = join(root, "target.prompt.md");
    await mkdir(directory, { recursive: true });
    await writeFile(target, "---\nname: [\n---\nBad");
    await symlink(target, join(directory, "alias.prompt.md"));
    const { client } = await connect({
      explicitRoot: root,
      fallbackRoot: root,
    });
    expect((await client.listPrompts()).prompts).toEqual([]);
    const changed = promptListChanged(client);

    await writeFile(target, "Fixed");
    await changed;

    expect(
      (await client.listPrompts()).prompts.map((prompt) => prompt.name),
    ).toEqual(["alias"]);
  });

  it("watches a missing prompt directory beneath an in-root symlink", async () => {
    const root = await temporaryDirectory();
    const targetDirectory = join(root, "shared-github");
    await mkdir(targetDirectory);
    await symlink(targetDirectory, join(root, ".github"));
    const { client } = await connect({
      explicitRoot: root,
      fallbackRoot: root,
    });
    expect((await client.listPrompts()).prompts).toEqual([]);
    // Let the post-ready catch-up pass finish so only the watcher can observe
    // creation through the symlinked ancestor.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const changed = promptListChanged(client);

    await mkdir(join(targetDirectory, "prompts"));
    await writeFile(
      join(targetDirectory, "prompts", "shared.prompt.md"),
      "Shared",
    );
    await changed;

    expect(
      (await client.listPrompts()).prompts.map((prompt) => prompt.name),
    ).toEqual(["shared"]);
  });

  it("continues watching a deleted symlinked prompt directory", async () => {
    const root = await temporaryDirectory();
    const targetDirectory = join(root, "shared-prompts");
    await mkdir(join(root, ".github"), { recursive: true });
    await mkdir(targetDirectory);
    await writeFile(join(targetDirectory, "shared.prompt.md"), "Before");
    await symlink(targetDirectory, join(root, ".github", "prompts"));
    const { client } = await connect({
      explicitRoot: root,
      fallbackRoot: root,
    });
    expect((await client.listPrompts()).prompts).toHaveLength(1);
    const removed = promptListChanged(client);

    await rm(targetDirectory, { recursive: true });
    await removed;
    expect((await client.listPrompts()).prompts).toEqual([]);
    const restored = promptListChanged(client);

    await mkdir(targetDirectory);
    await writeFile(join(targetDirectory, "shared.prompt.md"), "Restored");
    await restored;
    expect(
      (await client.listPrompts()).prompts.map((prompt) => prompt.name),
    ).toEqual(["shared"]);
  });

  it("watches an in-root symlinked prompt directory", async () => {
    const root = await temporaryDirectory();
    const targetDirectory = join(root, "shared-prompts");
    const target = join(targetDirectory, "shared.prompt.md");
    await mkdir(join(root, ".github"), { recursive: true });
    await mkdir(targetDirectory);
    await writeFile(target, "Before");
    await symlink(targetDirectory, join(root, ".github", "prompts"));
    const { client } = await connect({
      explicitRoot: root,
      fallbackRoot: root,
    });
    expect(
      (await client.listPrompts()).prompts.map((prompt) => prompt.name),
    ).toEqual(["shared"]);
    const changed = promptListChanged(client);

    await writeFile(target, "After");
    await changed;

    const result = await client.getPrompt({ name: "shared" });
    expect(result.messages[0]).toMatchObject({
      content: { type: "text", text: "After" },
    });
  });
});
