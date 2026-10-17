import { execFileSync } from "node:child_process";
import {
  windowsHelperEnvironment,
  windowsPowerShell,
  windowsScriptArgs,
} from "./windows.ts";

let userId: string | undefined;

function invoke(action: "identity" | "directory", path?: string): string {
  try {
    return execFileSync(
      windowsPowerShell(),
      windowsScriptArgs("windows-directory.ps1", [
        action,
        ...(path === undefined
          ? []
          : [Buffer.from(path, "utf8").toString("base64")]),
      ]),
      {
        encoding: "utf8",
        windowsHide: true,
        env: windowsHelperEnvironment(),
        timeout: 15_000,
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  } catch (cause) {
    throw new Error(
      `Unsafe background output directory${path === undefined ? "" : `: ${path}`}; Windows security validation failed`,
      { cause },
    );
  }
}

export function windowsUserId(): string {
  if (userId !== undefined) return userId;
  const value = invoke("identity");
  if (!/^S-1-\d+(?:-\d+){1,15}$/.test(value)) {
    throw new Error(
      "Unsafe background output directory: Windows did not return a user SID",
    );
  }
  userId = value;
  return value;
}

// As on POSIX, the parent must already exist and be trusted against replacement.
// Only identity is cached: each call must recheck the live owner and entire ACL.
export function privateWindowsDirectory(path: string): string {
  if (invoke("directory", path) !== "ok") {
    throw new Error(
      `Unsafe background output directory: ${path}; Windows did not confirm directory security`,
    );
  }
  return path;
}
