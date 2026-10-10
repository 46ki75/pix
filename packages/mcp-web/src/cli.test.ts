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

beforeAll(async () => {
  await exec("mise", ["run", "--silent", "mcp-web:build"], { cwd: root });
});

it("runs help/version from compiled JavaScript and rejects unsupported arguments", async () => {
  const help = await exec(process.execPath, [cli, "--help"]);
  expect(help.stdout).toContain("Expose websearch and webfetch");
  expect(help.stdout).toContain("comma-separated");
  expect(help.stdout).toContain("none");
  expect(help.stderr).toBe("");
  expect((await exec(process.execPath, [cli, "--version"])).stdout.trim()).toBe(
    SERVER_VERSION,
  );
  await expect(
    exec(process.execPath, [cli, "--invalid"]),
  ).rejects.toMatchObject({
    code: 1,
    stdout: "",
    stderr: expect.stringContaining("Unsupported arguments"),
  });
});

it.each(["tavily", "none"])(
  "serves both tools over stdio with provider selection %s",
  async (selection) => {
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
      args: [cli],
      env: { PIX_WEBSEARCH_PROVIDER: selection },
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
