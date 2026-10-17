import { win32 } from "node:path";
import { fileURLToPath } from "node:url";

export function windowsPowerShell(): string {
  return win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

export function windowsScriptArgs(name: string, args: string[]): string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    fileURLToPath(new URL(name, import.meta.url)),
    ...args,
  ];
}
