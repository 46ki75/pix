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
  ["0.87.1", new URL("../package.json", import.meta.url)],
  ["1.4.0", new URL("../../../package.json", import.meta.url)],
] as const;

// Use each host's real catalog so endpoint migrations cannot be hidden by mocks.
// Subprocesses isolate SDK module mappings and use only synthetic credentials.
test.each(hosts)(
  "OpenCode Go report accepts the built-in catalog under Pi %s",
  async (version, manifest) => {
    const sdk = fileURLToPath(
      new URL(
        "./node_modules/@earendil-works/pi-coding-agent/dist/index.js",
        manifest,
      ),
    );
    const directory = await mkdtemp(join(tmpdir(), "pix-opencode-runtime-"));
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
        'opencode-go': { type: 'api_key', key: 'opencode-test-key' }
      }));
      let calls = 0;
      globalThis.fetch = async (url, init) => {
        assert.equal(url, 'https://opencode.ai/zen/go/v1/usage');
        assert.equal(init.method, 'GET');
        assert.equal(init.redirect, 'error');
        assert.deepEqual(init.headers, { Accept: 'application/json', Authorization: 'Bearer opencode-test-key' });
        calls++;
        return Response.json({ usage: {
          rolling: { status: 'ok', percent: 8, resetsAt: '2026-09-29T18:00:00Z' },
          weekly: { status: 'ok', percent: 9, resetsAt: '2026-10-05T00:00:00Z' },
          monthly: { status: 'ok', percent: 10, resetsAt: '2026-10-29T00:00:00Z' }
        }});
      };
      const { discoverAndLoadExtensions, ModelRegistry, ModelRuntime, VERSION } = await import(pathToFileURL(${JSON.stringify(sdk)}).href);
      assert.equal(VERSION, ${JSON.stringify(version)});
      const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false });
      const registry = new ModelRegistry(runtime);
      assert.equal(registry.getProviderAuthStatus('opencode-go').source, 'stored');
      assert.ok(registry.getProvider('opencode-go').getModels().length > 0);
      registry.getProviderAuth = () => { throw new Error('Must not resolve model auth'); };
      const loaded = await discoverAndLoadExtensions([${JSON.stringify(packagePath)}], ${JSON.stringify(directory)}, agentDir);
      assert.deepEqual(loaded.errors, []);
      assert.equal(calls, 0);
      const command = loaded.extensions[0].commands.get('usage');
      assert.ok(command);
      const reports = [];
      await command.handler('opencode', { mode: 'rpc', hasUI: true, modelRegistry: registry, ui: { notify: (text) => reports.push(text) } });
      assert.equal(reports.length, 1);
      assert.ok(reports[0].includes('8%'), reports[0]);
      assert.ok(reports[0].includes('9%'), reports[0]);
      assert.ok(reports[0].includes('10%'), reports[0]);
      assert.equal(calls, 1);
      assert.ok(!reports[0].includes('opencode-test-key'));
      console.log('OpenCode Go runtime check passed');
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
      expect(stdout).toContain("OpenCode Go runtime check passed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
