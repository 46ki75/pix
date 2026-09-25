import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const variants = ["dark", "light"] as const;

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

test.each(variants)(
  "%s has every Pi color role and valid palette references",
  async (variant) => {
    const path = join(packageDir, "themes", `elmethis-${variant}.json`);
    const document = await readJson(path);
    // Read the pinned Pi schema rather than maintaining a second token catalog.
    const schema = await readJson(
      fileURLToPath(
        new URL(
          "modes/interactive/theme/theme-schema.json",
          import.meta.resolve("@earendil-works/pi-coding-agent"),
        ),
      ),
    );

    expect((await lstat(path)).isFile()).toBe(true);
    expect(document.name).toBe(`elmethis-${variant}`);
    expect(Object.keys(document.colors).sort()).toEqual(
      Object.keys(schema.properties.colors.properties).sort(),
    );
    expect(Object.keys(document.vars).length).toBeGreaterThan(0);
    for (const color of Object.values(document.vars)) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(Object.keys(document.export).sort()).toEqual([
      "cardBg",
      "infoBg",
      "pageBg",
    ]);
    for (const reference of [
      ...Object.values(document.colors),
      ...Object.values(document.export),
    ]) {
      expect(typeof reference).toBe("string");
      expect(Object.hasOwn(document.vars, reference as string)).toBe(true);
    }
  },
);

test("both variants share semantic assignments but have distinct backgrounds", async () => {
  const dark = await readJson(join(packageDir, "themes/elmethis-dark.json"));
  const light = await readJson(join(packageDir, "themes/elmethis-light.json"));
  expect(dark.colors).toEqual(light.colors);
  expect(dark.export).toEqual(light.export);
  expect(Object.keys(dark.vars).sort()).toEqual(Object.keys(light.vars).sort());
  expect(dark.vars.elmethisColorSurfaceBase).toBe("#393e46");
  expect(light.vars.elmethisColorSurfaceBase).toBe("#efecea");
});

test("the package exposes only the two standalone themes", async () => {
  const manifest = await readJson(join(packageDir, "package.json"));
  expect(manifest.name).toBe("@ikuma.cloud/pix-theme-elmethis");
  expect(manifest.private).not.toBe(true);
  expect(manifest.publishConfig).toEqual({ access: "public" });
  expect(manifest.keywords).toContain("pi-package");
  expect(manifest.files).toEqual(["themes"]);
  expect(manifest.pi).toEqual({ themes: ["./themes/*.json"] });
  expect(manifest.dependencies).toBeUndefined();
  expect(manifest.peerDependencies).toBeUndefined();
  expect((await readdir(join(packageDir, "themes"))).sort()).toEqual(
    variants.map((variant) => `elmethis-${variant}.json`),
  );
});

test.each(["settings", "cli"] as const)(
  "Pi discovers both themes through %s without extensions",
  async (source) => {
    const directory = await mkdtemp(join(tmpdir(), "pix-theme-elmethis-"));
    try {
      const loader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: join(directory, "agent"),
        settingsManager: SettingsManager.inMemory(
          source === "settings" ? { packages: [packageDir] } : {},
        ),
        additionalExtensionPaths: source === "cli" ? [packageDir] : [],
        noContextFiles: true,
        noSkills: true,
        noPromptTemplates: true,
      });
      await loader.reload();
      const { themes, diagnostics } = loader.getThemes();
      expect(diagnostics).toEqual([]);
      expect(themes.map((theme) => theme.name).sort()).toEqual(
        variants.map((variant) => `elmethis-${variant}`),
      );
      for (const theme of themes) {
        expect(theme.sourcePath).toBe(
          join(packageDir, "themes", `${theme.name}.json`),
        );
        expect(theme.fg("text", "example")).toContain("example");
        expect(theme.bg("userMessageBg", "example")).toContain("example");
      }
      expect(loader.getExtensions().errors).toEqual([]);
      expect(loader.getExtensions().extensions).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
