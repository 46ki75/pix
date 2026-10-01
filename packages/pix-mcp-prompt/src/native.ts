import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { McpTransport } from "@earendil-works/pi-mcp";
import {
  getAgentDir,
  getPackageDir,
  VERSION,
  type ExtensionContext,
  type LoadedMcpConfig,
  type McpServerEntry,
  type RegisteredMcpServer,
} from "@earendil-works/pi-coding-agent";

const SUPPORTED_PI_VERSION = "0.99.2";

interface NativeAuthProvider {
  token(): Promise<string | undefined>;
  settled(): Promise<void>;
}

interface NativeOAuthSettings {
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  callbackPort?: number | undefined;
  callbackUrl?: string | undefined;
  scope?: string | undefined;
  clientName?: string | undefined;
}

interface NativeHelpers {
  loadMcpConfig(options: {
    agentDir: string;
    cwd: string;
    projectTrusted: boolean;
  }): LoadedMcpConfig;
  createDefaultTransport(
    entry: McpServerEntry,
    cwd: string,
    authProvider: NativeAuthProvider | undefined,
  ): McpTransport;
  McpOAuthCredentialStore: new () => {
    forServer(serverUrl: string): unknown;
  };
  createMcpAuthProvider(options: {
    serverUrl: string;
    store: unknown;
    settings: () => NativeOAuthSettings;
    onChallenge: (challenge: unknown) => void;
  }): NativeAuthProvider;
  resolveConfigValueOrThrow(
    config: string,
    description: string,
    env?: Record<string, string>,
  ): string;
}

let nativeHelpersPromise: Promise<NativeHelpers> | undefined;

async function nativeHelpers(): Promise<NativeHelpers> {
  if (VERSION !== SUPPORTED_PI_VERSION) {
    throw new Error(
      `pix-mcp-prompt native MCP compatibility error: expected @earendil-works/pi-coding-agent ${SUPPORTED_PI_VERSION}, found ${VERSION}`,
    );
  }

  // Pi does not export these helpers from its package API. Keep their unstable paths and
  // signatures behind this single, version-pinned adapter rather than copying native behavior.
  nativeHelpersPromise ??= (async () => {
    const internalUrl = (path: string) =>
      pathToFileURL(resolve(getPackageDir(), path)).href;
    const [config, runtime, oauth, configValue] = await Promise.all([
      import(
        /* @vite-ignore */ internalUrl("dist/extensions/mcp/config.js")
      ) as Promise<{
        loadMcpConfig: NativeHelpers["loadMcpConfig"];
      }>,
      import(
        /* @vite-ignore */ internalUrl("dist/extensions/mcp/runtime.js")
      ) as Promise<{
        createDefaultTransport: NativeHelpers["createDefaultTransport"];
      }>,
      import(
        /* @vite-ignore */ internalUrl("dist/extensions/mcp/oauth.js")
      ) as Promise<{
        McpOAuthCredentialStore: NativeHelpers["McpOAuthCredentialStore"];
        createMcpAuthProvider: NativeHelpers["createMcpAuthProvider"];
      }>,
      import(
        /* @vite-ignore */ internalUrl("dist/core/resolve-config-value.js")
      ) as Promise<{
        resolveConfigValueOrThrow: NativeHelpers["resolveConfigValueOrThrow"];
      }>,
    ]);

    return {
      loadMcpConfig: config.loadMcpConfig,
      createDefaultTransport: runtime.createDefaultTransport,
      McpOAuthCredentialStore: oauth.McpOAuthCredentialStore,
      createMcpAuthProvider: oauth.createMcpAuthProvider,
      resolveConfigValueOrThrow: configValue.resolveConfigValueOrThrow,
    };
  })();

  return nativeHelpersPromise;
}

function namespace(name: string): string {
  return name.replaceAll("-", "_");
}

export async function loadServers(
  ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
  registered: RegisteredMcpServer[],
): Promise<LoadedMcpConfig> {
  const { loadMcpConfig } = await nativeHelpers();
  const loaded = loadMcpConfig({
    agentDir: getAgentDir(),
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
  });
  const configuredNamespaces = new Set(
    loaded.servers.map((entry) => namespace(entry.name)),
  );
  const extensionServers: McpServerEntry[] = registered
    .filter((server) => !configuredNamespaces.has(namespace(server.name)))
    .map(({ name, config, extensionPath }) => ({
      name,
      config,
      source: extensionPath,
      scope: "extension",
    }));

  return {
    ...loaded,
    servers: [...loaded.servers, ...extensionServers],
  };
}

function usesOAuth(entry: McpServerEntry): boolean {
  if (!("url" in entry.config) || entry.config.auth) return false;
  return !Object.keys(entry.config.headers ?? {}).some(
    (header) => header.toLowerCase() === "authorization",
  );
}

export async function createNativeTransport(
  entry: McpServerEntry,
  ctx: Pick<ExtensionContext, "cwd" | "modelRegistry">,
): Promise<{ transport: McpTransport; settled: () => Promise<void> }> {
  const helpers = await nativeHelpers();
  let authProvider: NativeAuthProvider | undefined;

  if (usesOAuth(entry) && "url" in entry.config) {
    const credentials = new helpers.McpOAuthCredentialStore();
    const oauth = entry.config.oauth;
    authProvider = helpers.createMcpAuthProvider({
      serverUrl: entry.config.url,
      store: credentials.forServer(entry.config.url),
      settings: () => ({
        clientId: oauth?.clientId,
        clientSecret:
          oauth?.clientSecret === undefined
            ? undefined
            : helpers.resolveConfigValueOrThrow(
                oauth.clientSecret,
                `MCP server "${entry.name}" oauth.clientSecret`,
              ),
        callbackPort: oauth?.callbackPort,
        callbackUrl: oauth?.callbackUrl,
        scope: oauth?.scope,
        clientName: oauth?.clientName,
      }),
      // Browser authorization is deliberately owned by Pi's explicit MCP login flow.
      onChallenge: () => {},
    });
  } else if ("url" in entry.config && entry.config.auth) {
    const provider = entry.config.auth.provider;
    authProvider = {
      token: () => ctx.modelRegistry.getApiKeyForProvider(provider),
      settled: async () => {},
    };
  }

  return {
    transport: helpers.createDefaultTransport(entry, ctx.cwd, authProvider),
    settled: async () => {
      await authProvider?.settled();
    },
  };
}
