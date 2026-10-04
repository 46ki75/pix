import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  StdioTransport,
  StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import {
  VERSION,
  type ExtensionContext,
  type McpServerEntry,
  type RegisteredMcpServer,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { createNativeTransport, loadServers } from "./native.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "pix-mcp-prompt-native-test-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return { root, agentDir, cwd };
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function loadContext(
  cwd: string,
  trusted: boolean,
): Pick<ExtensionContext, "cwd" | "isProjectTrusted"> {
  return { cwd, isProjectTrusted: () => trusted };
}

function registered(
  name: string,
  config: RegisteredMcpServer["config"],
  extensionPath = `/extensions/${name}.ts`,
): RegisteredMcpServer {
  return { name, config, extensionPath };
}

function transportContext(
  cwd: string,
  getApiKeyForProvider = vi.fn<
    (provider: string) => Promise<string | undefined>
  >(async () => undefined),
): Pick<ExtensionContext, "cwd" | "modelRegistry"> {
  return {
    cwd,
    modelRegistry: {
      getApiKeyForProvider,
    } as unknown as ExtensionContext["modelRegistry"],
  };
}

test("loads native global and trusted project MCP configuration", async () => {
  expect(VERSION).toBe("1.0.2");
  const { agentDir, cwd } = await sandbox();
  const globalPath = join(agentDir, "mcp.json");
  const projectPath = join(cwd, ".pi", "mcp.json");
  await writeJson(globalPath, {
    autoEnableCodemode: false,
    mcpServers: {
      global: { command: "global-command" },
      shared: { command: "global-shared" },
    },
  });
  await writeJson(projectPath, {
    autoEnableCodemode: true,
    mcpServers: {
      shared: { command: "project-shared" },
      disabled: { command: "disabled-command", enabled: false },
    },
  });

  const untrusted = await loadServers(loadContext(cwd, false), []);
  expect(untrusted.autoEnableCodemode).toBe(false);
  expect(untrusted.errors).toEqual([]);
  expect(untrusted.servers.map((entry) => entry.name)).toEqual([
    "global",
    "shared",
  ]);
  expect(untrusted.servers[1]).toMatchObject({
    source: globalPath,
    scope: "global",
    config: { command: "global-shared" },
  });

  const trusted = await loadServers(loadContext(cwd, true), []);
  expect(trusted.autoEnableCodemode).toBe(true);
  expect(trusted.errors).toEqual([]);
  expect(trusted.servers.map((entry) => entry.name)).toEqual([
    "global",
    "shared",
    "disabled",
  ]);
  expect(trusted.servers[1]).toMatchObject({
    source: projectPath,
    scope: "project",
    config: { command: "project-shared" },
  });
  expect(trusted.servers[2]?.config.enabled).toBe(false);
});

test("applies trusted project state-only overrides while preserving global credentials", async () => {
  const { agentDir, cwd } = await sandbox();
  const globalPath = join(agentDir, "mcp.json");
  const projectPath = join(cwd, ".pi", "mcp.json");
  const config = {
    url: "https://global.example.test/mcp",
    auth: { provider: "fixture-provider" },
    headers: { "X-Fixture": "global-header" },
  };
  await writeJson(globalPath, { mcpServers: { provider: config } });
  await writeJson(projectPath, {
    mcpServers: {
      provider: { enabled: false, exposure: "direct" },
    },
  });

  const untrusted = await loadServers(loadContext(cwd, false), []);
  expect(untrusted.errors).toEqual([]);
  expect(untrusted.servers).toEqual([
    { name: "provider", source: globalPath, scope: "global", config },
  ]);

  const trusted = await loadServers(loadContext(cwd, true), []);
  expect(trusted.errors).toEqual([]);
  expect(trusted.servers).toEqual([
    {
      name: "provider",
      source: globalPath,
      scope: "global",
      override: projectPath,
      config: { ...config, enabled: false, exposure: "direct" },
    },
  ]);
});

test("preserves native errors and lets file entries override registered aliases", async () => {
  const { agentDir, cwd } = await sandbox();
  const projectPath = join(cwd, ".pi", "mcp.json");
  await writeJson(join(agentDir, "mcp.json"), {
    mcpServers: {
      "file-server": { command: "file-command" },
      exact: { command: "file-exact" },
      keep: { command: "global-keep" },
      "disabled-file": { command: "disabled-file", enabled: false },
    },
  });
  await writeJson(projectPath, {
    mcpServers: {
      keep: { command: 42 },
    },
  });
  const registrations = [
    registered("file_server", { command: "registered-alias" }),
    registered("exact", { command: "registered-exact" }),
    registered("extension-only", { command: "registered-command" }),
    registered("disabled-extension", {
      command: "registered-disabled",
      enabled: false,
    }),
  ];

  const loaded = await loadServers(loadContext(cwd, true), registrations);

  expect(loaded.errors).toHaveLength(1);
  expect(loaded.errors[0]).toContain(projectPath);
  expect(loaded.errors[0]).toContain('server "keep"');
  expect(loaded.servers.map((entry) => entry.name)).toEqual([
    "file-server",
    "exact",
    "keep",
    "disabled-file",
    "extension-only",
    "disabled-extension",
  ]);
  expect(loaded.servers.find((entry) => entry.name === "keep")?.config).toEqual(
    { command: "global-keep" },
  );
  expect(
    loaded.servers.find((entry) => entry.name === "extension-only"),
  ).toEqual({
    name: "extension-only",
    config: { command: "registered-command" },
    source: "/extensions/extension-only.ts",
    scope: "extension",
  });
  expect(
    loaded.servers.find((entry) => entry.name === "disabled-file")?.config
      .enabled,
  ).toBe(false);
  expect(
    loaded.servers.find((entry) => entry.name === "disabled-extension")?.config
      .enabled,
  ).toBe(false);
});

test("rejects provider authentication from trusted project configuration", async () => {
  const { agentDir, cwd } = await sandbox();
  await writeJson(join(agentDir, "mcp.json"), {
    mcpServers: {
      provider: {
        url: "https://global.example.test/mcp",
        auth: { provider: "fixture-provider" },
      },
    },
  });
  await writeJson(join(cwd, ".pi", "mcp.json"), {
    mcpServers: {
      provider: {
        url: "https://project.example.test/mcp",
        auth: { provider: "fixture-provider" },
      },
    },
  });

  const loaded = await loadServers(loadContext(cwd, true), []);

  expect(loaded.errors).toEqual([
    expect.stringContaining("auth is only allowed in the global mcp.json"),
  ]);
  expect(loaded.servers).toMatchObject([
    { scope: "global", config: { url: "https://global.example.test/mcp" } },
  ]);
});

test("does not read legacy MCP configuration files", async () => {
  const { agentDir, cwd } = await sandbox();
  await writeJson(join(agentDir, "mcp.json"), {
    mcpServers: { native: { command: "native-command" } },
  });
  await writeJson(join(cwd, ".mcp.json"), {
    mcpServers: { legacy: { command: "legacy-command" } },
  });

  const loaded = await loadServers(loadContext(cwd, true), []);

  expect(loaded.errors).toEqual([]);
  expect(loaded.servers.map((entry) => entry.name)).toEqual(["native"]);
});

test("delegates stdio path, cwd, and environment expansion to Pi", async () => {
  const { cwd } = await sandbox();
  vi.stubEnv("PIX_NATIVE_TOKEN", "expanded-token");
  const entry: McpServerEntry = {
    name: "stdio",
    source: "test",
    scope: "extension",
    config: {
      command: "~/bin/native-server",
      args: ["~/fixture", "literal"],
      cwd: "relative-workdir",
      env: {
        TOKEN: `Bearer \${PIX_NATIVE_TOKEN}`,
        LITERAL: "$$HOME",
      },
    },
  };

  const { transport, settled } = await createNativeTransport(
    entry,
    transportContext(cwd),
  );

  expect(transport).toBeInstanceOf(StdioTransport);
  expect((transport as StdioTransport).options).toEqual({
    command: join(homedir(), "bin", "native-server"),
    args: [join(homedir(), "fixture"), "literal"],
    cwd: resolve(cwd, "relative-workdir"),
    env: { TOKEN: "Bearer expanded-token", LITERAL: "$HOME" },
    stderr: "pipe",
  });
  await expect(settled()).resolves.toBeUndefined();
});

test("delegates HTTP header expansion and Authorization OAuth suppression to Pi", async () => {
  const { cwd } = await sandbox();
  vi.stubEnv("PIX_NATIVE_HTTP_TOKEN", "header-token");
  const entry: McpServerEntry = {
    name: "http",
    source: "test",
    config: {
      url: "https://example.test/mcp",
      headers: {
        authorization: `Bearer \${PIX_NATIVE_HTTP_TOKEN}`,
        "X-Literal": "value",
      },
    },
  };

  const { transport, settled } = await createNativeTransport(
    entry,
    transportContext(cwd),
  );

  expect(transport).toBeInstanceOf(StreamableHttpTransport);
  expect((transport as StreamableHttpTransport).options.headers).toEqual({
    authorization: "Bearer header-token",
    "X-Literal": "value",
  });
  expect(
    (transport as StreamableHttpTransport).options.authProvider,
  ).toBeUndefined();
  await expect(settled()).resolves.toBeUndefined();
});

test("uses model provider credentials without copying them into MCP storage", async () => {
  const { agentDir, cwd } = await sandbox();
  const getApiKeyForProvider = vi.fn(async (provider: string) =>
    provider === "fixture-provider" ? "provider-token" : undefined,
  );
  const entry: McpServerEntry = {
    name: "provider-auth",
    source: "test",
    config: {
      url: "https://example.test/mcp",
      auth: { provider: "fixture-provider" },
    },
  };

  const { transport, settled } = await createNativeTransport(
    entry,
    transportContext(cwd, getApiKeyForProvider),
  );
  const authProvider = (transport as StreamableHttpTransport).options
    .authProvider;

  await expect(authProvider?.token()).resolves.toBe("provider-token");
  expect(getApiKeyForProvider).toHaveBeenCalledExactlyOnceWith(
    "fixture-provider",
  );
  await expect(access(join(agentDir, "mcp-auth.json"))).rejects.toThrow();
  await expect(settled()).resolves.toBeUndefined();
});

test("keeps native OAuth accounts separate by server name and URL", async () => {
  const { agentDir, cwd } = await sandbox();
  const url = "https://oauth.example.test/mcp";
  await writeJson(join(agentDir, "mcp-auth.json"), {
    [`mcp__work_account|${url}`]: {
      serverUrl: url,
      tokens: { access_token: "work-token", token_type: "Bearer" },
    },
    [`mcp__personal|${url}`]: {
      serverUrl: url,
      tokens: { access_token: "personal-token", token_type: "Bearer" },
    },
  });

  for (const [name, serverUrl, token] of [
    ["work-account", url, "work-token"],
    ["work_account", url, "work-token"],
    ["personal", url, "personal-token"],
    ["other", url, undefined],
    ["work-account", "https://other.example.test/mcp", undefined],
  ] as const) {
    const { transport, settled } = await createNativeTransport(
      { name, source: "test", config: { url: serverUrl } },
      transportContext(cwd),
    );
    const authProvider = (transport as StreamableHttpTransport).options
      .authProvider;
    expect(authProvider).toBeDefined();
    await expect(authProvider?.token()).resolves.toBe(token);
    await settled();
  }
});

test("delegates legacy OAuth credential migration to Pi for only the first account", async () => {
  const { agentDir, cwd } = await sandbox();
  const url = "https://oauth.example.test/mcp";
  const authPath = join(agentDir, "mcp-auth.json");
  const state = {
    serverUrl: url,
    tokens: { access_token: "legacy-token", token_type: "Bearer" },
  };
  await writeJson(authPath, { [url]: state });

  for (const [name, token] of [
    ["first", "legacy-token"],
    ["second", undefined],
  ] as const) {
    const { transport, settled } = await createNativeTransport(
      { name, source: "test", config: { url } },
      transportContext(cwd),
    );
    const authProvider = (transport as StreamableHttpTransport).options
      .authProvider;
    await expect(authProvider?.token()).resolves.toBe(token);
    await settled();
  }
  expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
    [`mcp__first|${url}`]: state,
  });
});

test.each(["dcr", "cimd"] as const)(
  "refreshes native OAuth tokens using the configured metadata URL and %s registration",
  async (clientRegistration) => {
    const { agentDir, cwd } = await sandbox();
    const url = "https://oauth.example.test/mcp";
    const resourceMetadataUrl =
      "https://oauth.example.test/.well-known/oauth-protected-resource/mcp";
    const metadataUrl = "https://auth.example.test/custom/metadata";
    const tokenUrl = "https://auth.example.test/token";
    const authPath = join(agentDir, "mcp-auth.json");
    await writeJson(authPath, {
      [`mcp__oauth|${url}`]: {
        serverUrl: url,
        tokens: {
          access_token: "stale-token",
          refresh_token: "refresh-token",
          token_type: "Bearer",
        },
      },
    });
    const { transport, settled } = await createNativeTransport(
      {
        name: "oauth",
        source: "test",
        config: {
          url,
          oauth: {
            ...(clientRegistration === "dcr"
              ? { clientId: "fixture-client" }
              : { clientRegistration }),
            authServerMetadataUrl: metadataUrl,
          },
        },
      },
      transportContext(cwd),
    );
    const authProvider = (transport as StreamableHttpTransport).options
      .authProvider;
    if (!authProvider?.onUnauthorized)
      throw new Error("Missing native OAuth provider");
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const requestedUrl = String(input);
      if (requestedUrl === resourceMetadataUrl) {
        return Response.json({
          resource: url,
          authorization_servers: ["https://wrong-issuer.example.test"],
        });
      }
      if (requestedUrl === metadataUrl) {
        return Response.json({
          issuer: "https://auth.example.test",
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: tokenUrl,
          response_types_supported: ["code"],
          token_endpoint_auth_methods_supported: ["none"],
          client_id_metadata_document_supported: true,
          authorization_response_iss_parameter_supported: true,
        });
      }
      if (requestedUrl === tokenUrl) {
        expect(init?.method).toBe("POST");
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("refresh-token");
        expect(body.get("client_id")).toBe(
          clientRegistration === "dcr"
            ? "fixture-client"
            : "https://pi.dev/oauth/client.json",
        );
        return Response.json({
          access_token: "fresh-token",
          refresh_token: "rotated-refresh-token",
          token_type: "Bearer",
        });
      }
      throw new Error(`Unexpected OAuth request: ${requestedUrl}`);
    });

    await authProvider.onUnauthorized({
      response: new Response(undefined, { status: 401 }),
      serverUrl: new URL(url),
      fetch,
      token: "stale-token",
    });
    await settled();

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      resourceMetadataUrl,
      metadataUrl,
      tokenUrl,
    ]);
    await expect(authProvider.token()).resolves.toBe("fresh-token");
    expect(JSON.parse(await readFile(authPath, "utf8"))).toMatchObject({
      [`mcp__oauth|${url}`]: {
        tokens: {
          access_token: "fresh-token",
          refresh_token: "rotated-refresh-token",
        },
      },
    });
  },
);

test("uses Pi's native OAuth store and propagates secret resolution errors", async () => {
  const { agentDir, cwd } = await sandbox();
  vi.stubEnv("PIX_NATIVE_OAUTH_SECRET", undefined);
  const url = "https://oauth.example.test/mcp";
  await writeJson(join(agentDir, "mcp-auth.json"), {
    [url]: {
      serverUrl: url,
      tokens: {
        access_token: "stale-access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
      },
    },
  });
  const entry: McpServerEntry = {
    name: "oauth",
    source: "test",
    config: {
      url,
      oauth: {
        clientId: "fixture-client",
        clientSecret: `\${PIX_NATIVE_OAUTH_SECRET}`,
      },
    },
  };

  const { transport, settled } = await createNativeTransport(
    entry,
    transportContext(cwd),
  );
  const authProvider = (transport as StreamableHttpTransport).options
    .authProvider;
  if (!authProvider?.onUnauthorized)
    throw new Error("Native OAuth provider was not installed");
  const fetch = vi.fn<typeof globalThis.fetch>();

  await expect(
    authProvider.onUnauthorized({
      response: new Response(undefined, { status: 401 }),
      serverUrl: new URL(url),
      fetch,
      token: "stale-access-token",
    }),
  ).rejects.toThrow(
    'Failed to resolve MCP server "oauth" oauth.clientSecret from environment variable: PIX_NATIVE_OAUTH_SECRET',
  );
  expect(fetch).not.toHaveBeenCalled();
  await expect(settled()).resolves.toBeUndefined();
});
