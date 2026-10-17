import { lstatSync, mkdirSync } from "node:fs";
import { privateWindowsDirectory, windowsUserId } from "./windows-directory.ts";

export function outputUserId(): string {
  return process.platform === "win32"
    ? windowsUserId()
    : String(process.geteuid?.());
}

// The parent must be trusted: the OS temp directory or a validated private one.
export function privateDirectory(path: string): string {
  if (process.platform === "win32") return privateWindowsDirectory(path);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // mkdir's mode does not protect reused directories. Do not follow symlinks or
  // chmod an existing path: another OS user could have precreated it in /tmp.
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.geteuid?.() ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error(
      `Unsafe background output directory: ${path}; expected an owner-only directory owned by the current user`,
    );
  }
  return path;
}
