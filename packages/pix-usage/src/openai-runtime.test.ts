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
  ["1.3.0", new URL("../../../package.json", import.meta.url)],
] as const;

// Subprocesses isolate Pi's module mappings, environment, and credential store.
test.each(hosts)(
  "keeps new OpenAI and legacy Codex logins separate under Pi %s",
  async (version, manifest) => {
    const sdk = fileURLToPath(
      new URL(
        "./node_modules/@earendil-works/pi-coding-agent/dist/index.js",
        manifest,
      ),
    );
    const directory = await mkdtemp(join(tmpdir(), "pix-openai-runtime-"));
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
      const jwt = (claims) => 'header.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.sig';
      const directToken = jwt({
        aud: 'https://api.openai.com/v1',
        scope: 'chatgpt.tokens.use.direct resource.invoke',
        'https://api.openai.com/auth': { per_user_salt: 'test-salt', encrypted_auth_metadata: 'opaque-test-metadata' }
      });
      const legacyToken = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'legacy-test-account' } });
      await writeFile(join(agentDir, 'auth.json'), JSON.stringify({
        openai: { type: 'oauth', access: directToken, refresh: 'direct-refresh', expires: Date.now() + 3600000, clientId: 'test-client', scopes: ['chatgpt.tokens.use.direct'] },
        'openai-codex': { type: 'oauth', access: legacyToken, refresh: 'legacy-refresh', expires: Date.now() + 3600000, accountId: 'legacy-test-account' }
      }));
      let calls = 0;
      globalThis.fetch = async (url, init) => {
        assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
        assert.equal(init.headers.Authorization, 'Bearer ' + legacyToken);
        assert.equal(init.headers['chatgpt-account-id'], 'legacy-test-account');
        assert.equal(init.redirect, 'error');
        calls++;
        return Response.json({ rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 } } });
      };
      const { discoverAndLoadExtensions, ModelRegistry, ModelRuntime } = await import(pathToFileURL(${JSON.stringify(sdk)}).href);
      const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, allowModelNetwork: false });
      const registry = new ModelRegistry(runtime);
      if (${JSON.stringify(version)} === '1.3.0') {
        assert.ok(registry.getProvider('openai').auth.oauth, 'New host must support Sign in with ChatGPT');
      }
      const originalAuth = registry.getProviderAuth.bind(registry);
      const authCalls = [];
      registry.getProviderAuth = (id) => {
        authCalls.push(id);
        assert.equal(id, 'openai-codex', 'Must not resolve or refresh new OpenAI auth');
        return originalAuth(id);
      };
      const loaded = await discoverAndLoadExtensions([${JSON.stringify(packagePath)}], ${JSON.stringify(directory)}, agentDir);
      assert.deepEqual(loaded.errors, []);
      const extension = loaded.extensions[0];
      const command = extension.commands.get('usage');
      assert.ok(command);
      const reports = [];
      const ctx = { mode: 'rpc', hasUI: true, modelRegistry: registry, ui: { notify: (text) => reports.push(text) } };
      await command.handler('openai', ctx);
      assert.ok(reports[0].includes('OpenAI'));
      assert.ok(reports[0].includes('https://chatgpt.com/settings/usage'));
      assert.ok(!reports[0].includes('/login openai-codex'));
      assert.equal(calls, 0);
      assert.deepEqual(authCalls, []);
      const notices = [];
      let widget;
      const tuiCtx = {
        ...ctx,
        mode: 'tui',
        model: { provider: 'openai', id: 'test-model' },
        ui: {
          notify: (text, severity) => notices.push({ text, severity }),
          setWidget: (_key, factory) => {
            widget?.dispose?.();
            widget = factory?.({ requestRender() {} });
          }
        }
      };
      const emit = async (name) => {
        for (const handler of extension.handlers.get(name) ?? []) await handler({ type: name }, tuiCtx);
      };
      await emit('session_start');
      assert.deepEqual(widget.render(120), []);
      assert.deepEqual(notices, []);
      tuiCtx.model = { provider: 'custom-provider', id: 'test-model' };
      await emit('model_select');
      assert.deepEqual(widget.render(120), []);
      assert.ok(notices[0].text.includes('not implemented'));
      assert.equal(notices[0].severity, 'warning');
      tuiCtx.model = { provider: 'openai', id: 'test-model' };
      await emit('model_select');
      assert.deepEqual(widget.render(120), []);
      assert.ok(notices[1].text.includes('not supported'));
      assert.ok(notices[1].text.includes('https://chatgpt.com/settings/usage'));
      assert.equal(notices[1].severity, 'warning');
      tuiCtx.model = { provider: 'openai', id: 'another-test-model' };
      await emit('model_select');
      await emit('turn_end');
      assert.equal(notices.length, 2);
      assert.equal(calls, 0);
      assert.deepEqual(authCalls, []);
      await emit('session_shutdown');
      assert.equal(widget, undefined);
      await command.handler('codex', ctx);
      assert.equal(calls, 1);
      assert.deepEqual(authCalls, ['openai-codex']);
      assert.ok(reports[1].includes('25%'), reports[1]);
      for (const report of reports) {
        assert.ok(!report.includes(directToken));
        assert.ok(!report.includes(legacyToken));
        assert.ok(!report.includes('opaque-test-metadata'));
        assert.ok(!report.includes('legacy-test-account'));
      }
      console.log('OpenAI runtime check passed');
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
      expect(stdout).toContain("OpenAI runtime check passed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
