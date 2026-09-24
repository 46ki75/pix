import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function isOutside(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

export function formatDirectory(cwd: string): string {
  const home = homedir();
  const path = home ? relative(home, cwd) : undefined;
  const display =
    path === undefined || isOutside(path)
      ? cwd
      : path === ""
        ? "~"
        : `~${sep}${path}`;
  return ` ${display}`;
}

export async function resolveLocation(
  cwd: string,
  exec: ExtensionAPI["exec"],
): Promise<string> {
  try {
    // Ask Git rather than checking for a .git directory: worktrees use a .git file.
    const result = await exec("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeout: 1_000,
    });
    if (result.code === 0 && !result.killed && result.stdout) {
      // Git reports physical paths; normalize cwd too when reached through a symlink.
      const [root, current] = await Promise.all([
        realpath(result.stdout.replace(/\r?\n$/, "")),
        realpath(cwd),
      ]);
      const path = relative(root, current);
      if (!isOutside(path)) {
        return ` ${join(basename(root) || root, path)
          .split(sep)
          .join("/")}`;
      }
    }
  } catch {
    // Missing Git, inaccessible paths, and failed probes must not prevent startup.
  }
  return formatDirectory(cwd);
}
