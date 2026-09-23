import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readConfig } from "./config.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function config(value: unknown, env: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pix-mcp-config-"));
  directories.push(directory);
  const path = join(directory, ".mcp.json");
  await writeFile(
    path,
    typeof value === "string" ? value : JSON.stringify(value),
  );
  return readConfig(path, env);
}

test("loads only the selected file and resolves explicit environment variables", async () => {
  const result = await config(
    {
      mcpServers: {
        local: {
          command: "node",
          args: ["server.js"],
          cwd: "service",
          env: { TOKEN: `\${API_TOKEN}` },
        },
        remote: {
          url: "https://example.test/mcp",
          headers: { Authorization: `Bearer \${API_TOKEN}` },
          approve: false,
        },
        disabled: { disabled: true },
      },
    },
    { API_TOKEN: "secret", PRIVATE_HOST_ENV: "not inherited" },
  );
  expect(result?.servers).toHaveLength(2);
  expect(result?.servers[0]).toMatchObject({
    type: "stdio",
    env: { TOKEN: "secret" },
    approve: true,
    timeoutMs: 30000,
  });
  expect(result?.servers[0]).toHaveProperty(
    "cwd",
    join(result?.path ?? "", "../service"),
  );
  expect(result?.servers[1]).toMatchObject({
    type: "http",
    headers: { Authorization: "Bearer secret" },
    approve: false,
  });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_HOST_ENV");
});

test.each(["X.Api-Key", "X+Token", "9-Token", "!Token"])(
  "accepts HTTP token header name %s without applying environment-key rules",
  async (name) => {
    expect(new Headers({ [name]: "fixture" }).get(name)).toBe("fixture");
    const result = await config(
      {
        mcpServers: {
          remote: {
            url: "https://example.test/mcp",
            headers: { [name]: `\${TOKEN}` },
          },
        },
      },
      { TOKEN: "fixture" },
    );
    expect(result?.servers[0]).toMatchObject({
      headers: { [name]: "fixture" },
    });
  },
);

test.each(["Bad Header", "Bad:Header", "Bad\r\nHeader"])(
  "rejects invalid HTTP header name %s without echoing secrets",
  async (name) => {
    await expect(
      config({
        mcpServers: {
          remote: {
            url: "https://example.test/mcp",
            headers: { [name]: "SECRET" },
          },
        },
      }),
    ).rejects.toThrow(/^Invalid MCP configuration\./);
  },
);

test.each([
  { mcpServers: { a: { command: "node", url: "https://example.test" } } },
  { mcpServers: { a: { url: "file:///secret" } } },
  { mcpServers: { a: { url: "https://secret:password@example.test" } } },
  { mcpServers: { a: { url: "https://example.test", oauth: {} } } },
  { mcpServers: { a: { command: "node", args: [1] } } },
  { mcpServers: { a: { command: "node", timeoutMs: -1 } } },
  { mcpServers: { a: { command: "node", approve: "false" } } },
  { mcpServers: { "bad.name": { command: "node" } } },
  { mcpServers: [], imports: ["other"] },
  '{"secret":',
])(
  "rejects unsupported or malformed config without leaking values",
  async (value) => {
    await expect(config(value)).rejects.toThrow(/^Invalid MCP configuration\./);
  },
);

test("missing environment variables and missing files have safe diagnostics", async () => {
  await expect(
    config({
      mcpServers: {
        a: {
          url: "https://example.test",
          headers: { Authorization: `\${SECRET}` },
        },
      },
    }),
  ).rejects.toThrow("unset environment variable");
  expect(
    await readConfig(join(tmpdir(), "pix-mcp-nonexistent", ".mcp.json")),
  ).toBeUndefined();
});
