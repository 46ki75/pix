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

export function windowsHelperEnvironment(): NodeJS.ProcessEnv {
  // WinPS launched through Node otherwise inherits incompatible PowerShell 7
  // module paths. The command receives its own original environment snapshot.
  // https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_psmodulepath#starting-windows-powershell-from-powershell-7
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toUpperCase() !== "PSMODULEPATH",
    ),
  );
}
