import { lstatSync, mkdirSync } from "node:fs";

// The parent must be trusted: the OS temp directory or a validated private one.
export function privateDirectory(path: string): string {
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
