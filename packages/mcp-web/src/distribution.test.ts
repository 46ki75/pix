import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));

it("builds and starts without Pi or sibling workspace packages", async () => {
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  ) as {
    dependencies: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  for (const [name, version] of Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  })) {
    expect(name).not.toMatch(/^@(?:ikuma\.cloud\/pix-|earendil-works\/pi-)/);
    expect(version).not.toMatch(/^(?:workspace|link|file):/);
  }

  const directory = await mkdtemp(join(tmpdir(), "mcp-web-isolated-"));
  try {
    const isolated = join(directory, "packages", "mcp-web");
    await mkdir(isolated, { recursive: true });
    await cp(
      join(root, "tsconfig.base.json"),
      join(directory, "tsconfig.base.json"),
    );
    for (const file of [
      "src",
      "package.json",
      "tsconfig.json",
      "tsconfig.build.json",
    ]) {
      await cp(join(packageRoot, file), join(isolated, file), {
        recursive: true,
        filter: (path) => !path.endsWith(".test.ts"),
      });
    }
    // Link only declared external dependencies, never the workspace node_modules.
    // This keeps source/build imports from silently resolving a sibling package.
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })) {
      const destination = join(isolated, "node_modules", name);
      await mkdir(dirname(destination), { recursive: true });
      await symlink(
        await realpath(join(packageRoot, "node_modules", name)),
        destination,
        "junction",
      );
    }
    const nodeTypes = join(isolated, "node_modules", "@types", "node");
    await mkdir(dirname(nodeTypes), { recursive: true });
    await symlink(
      await realpath(join(root, "node_modules", "@types", "node")),
      nodeTypes,
      "junction",
    );

    await exec(
      "pnpm",
      ["exec", "tsc", "--project", join(isolated, "tsconfig.build.json")],
      { cwd: root },
    );
    const result = await exec(
      process.execPath,
      [join(isolated, "dist", "cli.js"), "--help"],
      {
        cwd: isolated,
        env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
      },
    );
    expect(result.stdout).toContain("Expose websearch and webfetch");
    expect(result.stderr).toBe("");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
