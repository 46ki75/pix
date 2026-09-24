// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Fixtures contain configuration interpolation, not JavaScript interpolation.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { MAX_TIMEOUT_MS, readConfig } from "./config.ts";

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
async function serverIssue(value: unknown, env: NodeJS.ProcessEnv = {}) {
  const result = await config(value, env);
  expect(result?.servers).toEqual([]);
  expect(result?.issues).toHaveLength(1);
  expect(JSON.stringify(result?.issues)).not.toContain("SECRET");
  return result?.issues[0]?.message;
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
          type: "http",
          url: "https://example.test/mcp",
          headers: { Authorization: `Bearer \${API_TOKEN}` },
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
    timeout: 30000,
    startupTimeoutMs: 30000,
    catalogTimeoutMs: 30000,
  });
  expect(result?.servers[0]).toHaveProperty(
    "cwd",
    join(result?.path ?? "", "../service"),
  );
  expect(result?.servers[1]).toMatchObject({
    type: "http",
    headers: { Authorization: "Bearer secret" },
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
            type: "http",
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
      serverIssue({
        mcpServers: {
          remote: {
            type: "http",
            url: "https://example.test/mcp",
            headers: { [name]: "SECRET" },
          },
        },
      }),
    ).resolves.toMatch(/^Invalid MCP configuration\./);
  },
);

test.each([
  { mcpServers: { a: { command: "node", url: "https://example.test" } } },
  { mcpServers: { a: { type: "http", url: "file:///SECRET" } } },
  {
    mcpServers: {
      a: { type: "http", url: "https://SECRET:password@example.test" },
    },
  },
  {
    mcpServers: { a: { type: "http", url: "https://example.test", oauth: {} } },
  },
  { mcpServers: { a: { command: "node", args: [1] } } },
  { mcpServers: { a: { command: "node", timeoutMs: -1 } } },
  { mcpServers: { "bad.name": { command: "node" } } },
])(
  "reports unsupported or malformed server entries without leaking values",
  async (value) => {
    await expect(serverIssue(value)).resolves.toMatch(
      /^Invalid MCP configuration\./,
    );
  },
);

test.each([
  null,
  [],
  {},
  { mcpServers: [] },
  { mcpServers: {}, imports: ["SECRET"] },
  { mcpServers: {}, $schema: 1 },
  '{"SECRET":',
])("root errors remain fatal and safe", async (value) => {
  const error = await config(value).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/^Invalid MCP configuration\./);
  expect((error as Error).message).not.toContain("SECRET");
});

test("accepts a 16-minute call deadline without lengthening startup or catalog discovery", async () => {
  const result = await config({
    mcpServers: { image: { command: "node", timeout: 960000 } },
  });
  expect(result?.servers[0]).toMatchObject({
    timeout: 960000,
    startupTimeoutMs: 30000,
    catalogTimeoutMs: 30000,
  });
});

test("missing environment variables and missing files have safe diagnostics", async () => {
  await expect(
    serverIssue({
      mcpServers: {
        a: {
          type: "http",
          url: "https://example.test",
          headers: { Authorization: `\${SECRET}` },
        },
      },
    }),
  ).resolves.toContain("unset environment variable");
  expect(
    await readConfig(join(tmpdir(), "pix-mcp-nonexistent", ".mcp.json")),
  ).toBeUndefined();
});

test.each(["timeout", "startupTimeoutMs", "catalogTimeoutMs"])(
  "validates timer-safe boundaries for %s",
  async (field) => {
    for (const value of [1, 120001, 960000, MAX_TIMEOUT_MS]) {
      expect(
        (
          await config({
            mcpServers: { a: { command: "node", [field]: value } },
          })
        )?.servers[0],
      ).toHaveProperty(field, value);
    }
    for (const value of [0, -1, 1.5, "30000", null, MAX_TIMEOUT_MS + 1]) {
      await expect(
        serverIssue({ mcpServers: { a: { command: "node", [field]: value } } }),
      ).resolves.toContain(field);
    }
  },
);

test("requires explicit HTTP type, normalizes its alias, and explains the removed timeout field", async () => {
  await expect(
    serverIssue({ mcpServers: { a: { url: "https://example.test" } } }),
  ).resolves.toContain("explicit type");
  expect(
    (
      await config({
        mcpServers: {
          a: { type: "streamable-http", url: "https://example.test" },
        },
      })
    )?.servers[0]?.type,
  ).toBe("http");
  await expect(
    serverIssue({ mcpServers: { a: { command: "node", timeoutMs: 960000 } } }),
  ).resolves.toContain("Removed; use timeout");
});

test.each([true, false, "SECRET"])(
  "rejects removed approve policy with migration guidance (%s)",
  async (approve) => {
    for (const disabled of [false, true]) {
      const result = await config({
        mcpServers: { a: { command: "node", approve, disabled } },
      });
      expect(result?.servers).toEqual([]);
      expect(result?.issues).toEqual([
        {
          name: "a",
          field: "approve",
          message: expect.stringContaining(
            "Removed; delete approve and use a Pi tool_call extension for permission controls.",
          ),
        },
      ]);
      expect(JSON.stringify(result?.issues)).not.toContain("SECRET");
    }
  },
);

test("expands connection strings and unset-only defaults without recursive interpolation", async () => {
  const result = await config(
    {
      $schema: "https://example.invalid/not-fetched.json",
      mcpServers: {
        local: {
          command: "${COMMAND:-node}",
          args: ["${SCRIPT}", "${EMPTY:-fallback}", "${UNSET:-fallback}"],
          cwd: "${DIRECTORY:-service}",
          env: { TOKEN: "${TOKEN}" },
        },
        remote: {
          type: "http",
          url: "${BASE:-https://example.test}/mcp",
          headers: { Authorization: "Bearer ${TOKEN}" },
        },
        disabled: {
          disabled: true,
          command: "${UNSET}",
          timeout: "not validated",
        },
      },
    },
    {
      COMMAND: "custom-node",
      SCRIPT: "server.js",
      EMPTY: "",
      TOKEN: "literal-${SECRET}",
    },
  );
  expect(result?.servers[0]).toMatchObject({
    command: "custom-node",
    args: ["server.js", "", "fallback"],
    env: { TOKEN: "literal-${SECRET}" },
  });
  expect(result?.servers[0]).toHaveProperty(
    "cwd",
    join(result?.path ?? "", "../service"),
  );
  expect(result?.servers[1]).toMatchObject({
    url: "https://example.test/mcp",
    headers: { Authorization: "Bearer literal-${SECRET}" },
  });
});

test.each(["${env:TOKEN}", "${UNCLOSED", "${}", "${TOKEN}", "${toString}"])(
  "fails safely for invalid or unset interpolation %s",
  async (value) => {
    await expect(
      serverIssue({ mcpServers: { a: { command: "node", args: [value] } } }),
    ).resolves.toMatch(/^Invalid MCP configuration\./);
  },
);

test("validates expanded values rather than letting substitution bypass safety checks", async () => {
  for (const server of [
    { command: "${BAD}" },
    { command: "node", args: ["${BAD}"] },
    { command: "node", env: { TOKEN: "${BAD}" } },
    {
      type: "http",
      url: "https://example.test",
      headers: { Authorization: "${HEADER}" },
    },
    { type: "http", url: "${URL}" },
  ])
    await expect(
      serverIssue(
        { mcpServers: { a: server } },
        {
          BAD: "SECRET\0",
          HEADER: "SECRET\r\ninjection",
          URL: "https://SECRET:password@example.test",
        },
      ),
    ).resolves.toMatch(/^Invalid MCP configuration\./);
});

test("published schema agrees with structural parser validation", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../mcp.schema.json", import.meta.url), "utf8"),
  );
  const validate = new Ajv2020({ strict: false }).compile(schema);
  const cases = [
    { command: "node" },
    { type: "stdio", command: "node", args: [""] },
    { type: "http", url: "https://example.test" },
    { type: "streamable-http", url: "https://example.test" },
    { disabled: true },
    { disabled: true, timeout: "ignored" },
    {
      command: "node",
      timeout: 960000,
      startupTimeoutMs: 1,
      catalogTimeoutMs: MAX_TIMEOUT_MS,
    },
    { command: "node", timeout: 0 },
    { command: "node", timeout: MAX_TIMEOUT_MS + 1 },
    { command: "node", timeout: null },
    { command: "node", timeoutMs: 30000 },
    { command: "node", args: null },
    { command: "node", env: null },
    { command: "node", type: null },
    { command: "node", url: "https://example.test" },
    { url: "https://example.test" },
    { type: "http", url: "https://example.test", cwd: "." },
    { command: "node", autoApprove: [] },
    { disabled: true, autoApprove: [] },
    { command: "node", approve: true },
    { command: "node", approve: false },
    { command: "node", approve: "false" },
    { disabled: true, approve: true },
  ];
  for (const server of cases) {
    const value = { mcpServers: { a: server } };
    const accepted = await config(value).then(
      (result) => result?.issues.length === 0,
      () => false,
    );
    expect(validate(value), JSON.stringify(server)).toBe(accepted);
  }
});

test("retains healthy servers beside an invalid configuration entry", async () => {
  const result = await config({
    mcpServers: {
      healthy: { command: "node" },
      invalid: { command: "node", timeout: 0 },
    },
  });
  expect(result?.servers.map((server) => server.name)).toEqual(["healthy"]);
  expect(result?.issues).toEqual([
    {
      name: "invalid",
      field: "timeout",
      message: expect.stringContaining("milliseconds"),
    },
  ]);
});

test("collects entry errors in order and redacts unsafe names, keys, and values", async () => {
  const result = await config({
    mcpServers: {
      healthy: { command: "node" },
      "SECRET\nname": { command: "node" },
      malformed: null,
      unknown: { command: "SECRET", "SECRET-field": true },
      unset: { command: "${SECRET}" },
      disabled: { disabled: true },
      legacy: { command: "SECRET", timeoutMs: 960000 },
      second: { type: "http", url: "https://example.test" },
    },
  });
  expect(result?.servers.map((server) => server.name)).toEqual([
    "healthy",
    "second",
  ]);
  expect(result?.issues.map((issue) => issue.name)).toEqual([
    "Invalid server #2",
    "malformed",
    "unknown",
    "unset",
    "legacy",
  ]);
  expect(JSON.stringify(result?.issues)).not.toContain("SECRET");
  expect(result?.issues.at(-1)?.message).toContain("Removed; use timeout");
});

test("file-size and server-count limits remain fatal before isolation", async () => {
  const definitions = Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [
      `server${index}`,
      { command: "node" },
    ]),
  );
  expect((await config({ mcpServers: definitions }))?.servers).toHaveLength(32);
  await expect(
    config({ mcpServers: { ...definitions, extra: { command: "node" } } }),
  ).rejects.toThrow("At most 32");
  await expect(
    config({ mcpServers: { a: { command: "SECRET".repeat(50000) } } }),
  ).rejects.toThrow("exceeds 256 KiB");
});
