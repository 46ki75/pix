import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, expect, it } from "vitest";
import { SERVER_VERSION } from "./server.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const apiKeys = {
  EXA_API_KEY: "exa-secret-value",
  PARALLEL_API_KEY: "parallel-secret-value",
  FIRECRAWL_API_KEY: "firecrawl-secret-value",
  TAVILY_API_KEY: "tavily-secret-value",
  TINYFISH_API_KEY: "tinyfish-secret-value",
};

// Preload in the child so tests exercise the compiled CLI without external
// requests. Stable randomness makes automatic/pool selection reproducible.
const searchFixture = `data:text/javascript,${encodeURIComponent(`
  Math.random = () => 0;
  const fixtures = {
    "https://mcp.exa.ai/mcp": ["EXA_API_KEY", "x-api-key", "", ""],
    "https://search.parallel.ai/mcp": ["PARALLEL_API_KEY", "Authorization", "Bearer ", '{"results":[]}'],
    "https://mcp.firecrawl.dev/v2/mcp": ["FIRECRAWL_API_KEY", "Authorization", "Bearer ", '{"success":true,"data":{"web":[]}}'],
    "https://api.tavily.com/search": ["TAVILY_API_KEY", "Authorization", "Bearer ", ""],
    "https://agent.tinyfish.ai/mcp": ["TINYFISH_API_KEY", "X-API-Key", "", '{"results":[]}'],
  };
  globalThis.fetch = async (url, init) => {
    const fixture = fixtures[url];
    if (!fixture) throw new Error("Unexpected provider request");
    const [key, header, prefix, text] = fixture;
    if (new Headers(init.headers).get(header) !== prefix + process.env[key]) {
      throw new Error("Missing fixture credential");
    }
    if (url === "https://api.tavily.com/search") return Response.json({ results: [] });
    return Response.json({
      jsonrpc: "2.0",
      id: JSON.parse(init.body).id,
      result: { content: [{ type: "text", text }] },
    });
  };
`)}`;

beforeAll(async () => {
  await exec("mise", ["run", "--silent", "mcp-web:build"], { cwd: root });
});

it.each(["--help", "-h"])(
  "documents options and environment variables with %s",
  async (flag) => {
    const help = await exec(process.execPath, [cli, flag], {
      env: {
        ...process.env,
        ...apiKeys,
        PIX_WEBSEARCH_PROVIDER: "invalid-secret",
      },
      timeout: 5_000,
    });
    expect(help.stdout).toContain("Expose websearch and webfetch");
    expect(help.stdout).toContain("--provider <selection>");
    expect(help.stdout).toMatch(/env:\s+PIX_WEBSEARCH_PROVIDER/u);
    expect(help.stdout).toContain('default: "auto"');
    expect(help.stdout).toContain("comma-separated");
    expect(help.stdout).toContain("none");
    for (const [key, value] of Object.entries(apiKeys)) {
      expect(help.stdout).toContain(key);
      expect(help.stdout).not.toContain(value);
    }
    expect(help.stdout).not.toContain("invalid-secret");
    expect(help.stderr).toBe("");
  },
);

it.each(["--version", "-v"])(
  "prints only the version with %s",
  async (flag) => {
    const result = await exec(process.execPath, [cli, flag], {
      timeout: 5_000,
    });
    expect(result.stdout).toBe(`${SERVER_VERSION}\n`);
    expect(result.stderr).toBe("");
  },
);

it.each([
  { name: "unknown options", args: ["--invalid"] },
  { name: "positional arguments", args: ["unexpected"] },
  {
    name: "extra arguments after an option",
    args: ["--provider", "none", "unexpected"],
  },
  { name: "missing provider values", args: ["--provider"] },
  {
    name: "control characters in errors",
    args: ["--invalid-\u001b[31m\u0001"],
  },
])("rejects $name on stderr without starting MCP", async ({ args }) => {
  const error: unknown = await exec(process.execPath, [cli, ...args], {
    timeout: 5_000,
  }).catch((error: unknown) => error);
  expect(error).toMatchObject({
    code: 1,
    stdout: "",
    stderr: "[mcp-web] Unsupported arguments. Use --help for usage.\n",
  });
});

it.each(Object.entries(apiKeys))(
  "does not echo rejected credential %s",
  async (key, value) => {
    for (const argument of [
      `--${key.toLowerCase().replaceAll("_", "-")}=${value}`,
      `--${value}`,
    ]) {
      const error: unknown = await exec(process.execPath, [cli, argument], {
        env: { ...process.env, ...apiKeys },
        timeout: 5_000,
      }).catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: 1,
        stdout: "",
        stderr: expect.any(String),
      });
      const { stderr } = error as { stderr: string };
      expect(stderr).not.toContain(value);
    }
  },
);

interface ProviderCase {
  name: string;
  env?: Record<string, string>;
  args?: string[];
  provider?: string;
  error?: string;
}

const providerCases: ProviderCase[] = [
  { name: "unset environment defaults to auto", provider: "exa" },
  {
    name: "blank environment defaults to auto",
    env: { PIX_WEBSEARCH_PROVIDER: " \t " },
    provider: "exa",
  },
  {
    name: "explicit auto",
    env: { PIX_WEBSEARCH_PROVIDER: "auto" },
    provider: "exa",
  },
  {
    name: "fixed environment provider",
    env: { PIX_WEBSEARCH_PROVIDER: "tavily" },
    provider: "tavily",
  },
  {
    name: "environment pool",
    env: { PIX_WEBSEARCH_PROVIDER: " tinyfish , parallel " },
    provider: "parallel",
  },
  {
    name: "duplicate providers",
    env: { PIX_WEBSEARCH_PROVIDER: "tavily,tavily" },
    provider: "tavily",
  },
  {
    name: "disabled environment",
    env: { PIX_WEBSEARCH_PROVIDER: "none" },
    error: "Web search is disabled",
  },
  {
    name: "CLI overrides disabled environment",
    env: { PIX_WEBSEARCH_PROVIDER: "none" },
    args: ["--provider", "tavily"],
    provider: "tavily",
  },
  {
    name: "CLI pool overrides invalid environment",
    env: { PIX_WEBSEARCH_PROVIDER: "invalid-secret" },
    args: ["--provider", " tinyfish , parallel "],
    provider: "parallel",
  },
  {
    name: "CLI disables an environment provider",
    env: { PIX_WEBSEARCH_PROVIDER: "tavily" },
    args: ["--provider", "none"],
    error: "Web search is disabled",
  },
  {
    name: "blank CLI overrides environment with auto",
    env: { PIX_WEBSEARCH_PROVIDER: "none" },
    args: ["--provider", ""],
    provider: "exa",
  },
  {
    name: "whitespace CLI overrides environment with auto",
    env: { PIX_WEBSEARCH_PROVIDER: "none" },
    args: ["--provider", " \t "],
    provider: "exa",
  },
  {
    name: "invalid environment remains a tool error",
    env: { PIX_WEBSEARCH_PROVIDER: "invalid-secret" },
    error: "PIX_WEBSEARCH_PROVIDER must be",
  },
  {
    name: "invalid CLI remains a tool error",
    env: { PIX_WEBSEARCH_PROVIDER: "none" },
    args: ["--provider", "invalid-secret"],
    error: "PIX_WEBSEARCH_PROVIDER must be",
  },
  {
    name: "malformed pool remains a tool error",
    args: ["--provider", "auto,tavily"],
    error: "PIX_WEBSEARCH_PROVIDER must be",
  },
  ...["exa", "parallel", "firecrawl", "tavily", "tinyfish"].map((provider) => ({
    name: `CLI provider ${provider}`,
    args: [`--provider=${provider}`],
    provider,
  })),
];

it.each(providerCases)(
  "applies provider selection: $name",
  async ({ env, args, provider, error }) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", searchFixture, cli, ...(args ?? [])],
      env: { ...apiKeys, ...env },
      stderr: "pipe",
    });
    const client = new Client({ name: "provider-cli-test", version: "1.0.0" });
    let stderr = "";
    transport.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "websearch",
        arguments: { query: "query" },
      });
      if (error) {
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([
          { type: "text", text: expect.stringContaining(error) },
        ]);
        expect(JSON.stringify(result)).not.toContain("invalid-secret");
      } else {
        expect(result.isError).not.toBe(true);
        expect(result._meta?.["cloud.ikuma/mcp-web"]).toMatchObject({
          provider,
          results: [],
        });
      }
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        ["websearch", "webfetch"],
      );
      expect(stderr).toBe("");
    } finally {
      await client.close();
      await transport.close();
    }
  },
);

it.each([
  { selection: "tavily", args: [] },
  { selection: "none", args: [] },
  { selection: "none", args: ["--provider", "none"] },
])(
  "serves both tools over stdio with provider selection $selection and args $args",
  async ({ selection, args }) => {
    const http = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end('<h1>Local fixture</h1><p><a href="/next">Next</a></p>');
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture port");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, ...args],
      env: { PIX_WEBSEARCH_PROVIDER: args.length ? "tavily" : selection },
      stderr: "pipe",
    });
    const client = new Client({ name: "built-cli-test", version: "1.0.0" });
    let stderr = "";
    transport.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        ["websearch", "webfetch"],
      );
      const url = `http://127.0.0.1:${address.port}/guide`;
      const result = await client.callTool({
        name: "webfetch",
        arguments: { url },
      });
      expect(result.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining(
            `# Local fixture\n\n[Next](http://127.0.0.1:${address.port}/next)`,
          ),
        },
      ]);
      const invalid = await client.callTool({
        name: "websearch",
        arguments: { query: selection === "none" ? "query" : "" },
      });
      expect(invalid.isError).toBe(true);
      if (selection === "none") {
        expect(invalid.content).toEqual([
          {
            type: "text",
            text: expect.stringContaining("Web search is disabled"),
          },
        ]);
      }
      expect(stderr).toBe("");
    } finally {
      await client.close();
      await transport.close();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

it("exits cleanly when stdin closes without a client", async () => {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [cli],
      { timeout: 5_000 },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else if (stdout || stderr) reject(new Error("Unexpected CLI output"));
        else resolve();
      },
    );
    child.stdin?.end();
  });
});
