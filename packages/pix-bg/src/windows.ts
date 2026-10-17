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

export function windowsCommandEnvironment(shell: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  if (/(?:^|[\\/])(?:bash|sh)\.exe$/i.test(shell)) {
    // MSYS noglob strips quotes WITHOUT decoding our backslash escapes. Reject
    // glob overrides and quoted option strings (whose token boundaries are
    // runtime-specific) instead of guessing a parser and changing commands.
    // https://github.com/git-for-windows/msys2-runtime/blob/81d9bd3d1c3680aa611ff2e5d1950787ffc95c6a/winsup/cygwin/dcrt0.cc#L155-L169
    const incompatible = Object.entries(environment).some(
      ([key, value]) =>
        key.toUpperCase() === "MSYS" &&
        (value?.includes('"') ||
          /(?:^|[ \t])(?:no|-)?glob(?:[=: \t]|$)/i.test(value ?? "")),
    );
    if (incompatible) {
      throw new Error(
        "Windows background tasks do not support MSYS glob options or quoted MSYS settings; remove those options or quotes from MSYS",
      );
    }
  }
  return environment;
}

export function windowsHelperEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // WinPS launched through Node otherwise inherits incompatible PowerShell 7
  // module paths. The command receives its own original environment snapshot.
  // https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_psmodulepath#starting-windows-powershell-from-powershell-7
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => key.toUpperCase() !== "PSMODULEPATH",
    ),
  );
}
