import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);
const packagePath = fileURLToPath(new URL("../", import.meta.url));
const hosts = [
  ["package Pi pin", new URL("../package.json", import.meta.url)],
  ["workspace Pi pin", new URL("../../../package.json", import.meta.url)],
] as const;

// Fresh subprocesses isolate both SDK module mappings and the default credential
// reader. Only synthetic auth files and mocked HTTP responses are used.
test.each(hosts)(
  "Copilot report loads with the real registry and store under %s",
  async (_label, manifest) => {
    const sdk = fileURLToPath(
      new URL(
        "./node_modules/@earendil-works/pi-coding-agent/dist/index.js",
        manifest,
      ),
    );
    const directory = await mkdtemp(join(tmpdir(), "pix-copilot-runtime-"));
    try {
      const { stdout } = await exec(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
      import assert from 'node:assert/strict';
      import { mkdir, writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const agentDir = process.env.PI_CODING_AGENT_DIR;
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, 'auth.json'), JSON.stringify({
        'github-copilot': { type: 'oauth', refresh: 'github-test-token', access: 'inference-test-token', expires: Date.now() + 3600000 }
      }));
      let calls = 0;
      globalThis.fetch = async (url, init) => {
        assert.equal(url, 'https://api.github.com/copilot_internal/user');
        assert.equal(init.headers.Authorization, 'token github-test-token');
        assert.equal(init.redirect, 'error');
        calls++;
        return Response.json({ token_based_billing: true, quota_snapshots: {
          premium_interactions: { unlimited: false, entitlement: '1500', quota_remaining: 1080, percent_remaining: 72 }
        }});
      };
      const { discoverAndLoadExtensions, ModelRegistry, ModelRuntime } = await import(pathToFileURL(${JSON.stringify(sdk)}).href);
      const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false });
      const registry = new ModelRegistry(runtime);
      assert.equal(registry.getProviderAuthStatus('github-copilot').source, 'stored');
      registry.getProviderAuth = () => { throw new Error('Must not resolve inference auth'); };
      const loaded = await discoverAndLoadExtensions([${JSON.stringify(packagePath)}], ${JSON.stringify(directory)}, agentDir);
      assert.deepEqual(loaded.errors, []);
      assert.equal(calls, 0);
      const command = loaded.extensions[0].commands.get('usage');
      assert.ok(command);
      const reports = [];
      await command.handler('copilot', { mode: 'rpc', hasUI: true, modelRegistry: registry, ui: { notify: (text) => reports.push(text) } });
      assert.equal(calls, 1);
      assert.equal(reports.length, 1);
      assert.ok(reports[0].includes('420 / 1,500 credits (28%)'), reports[0]);
      assert.ok(!reports[0].includes('test-token'));
      console.log('Copilot runtime check passed');
    `,
        ],
        {
          cwd: directory,
          env: {
            HOME: directory,
            PI_CODING_AGENT_DIR: join(directory, "agent"),
            PI_OFFLINE: "1",
            PI_SKIP_VERSION_CHECK: "1",
            PI_TELEMETRY: "0",
          },
          timeout: 30_000,
        },
      );
      expect(stdout).toContain("Copilot runtime check passed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
