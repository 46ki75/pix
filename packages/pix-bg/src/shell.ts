import { win32 } from "node:path";
import {
  getPowerShellConfig,
  getShellConfig,
} from "@earendil-works/pi-coding-agent";
import type { Executor, ShellName } from "./execution.ts";
import { PosixExecutor } from "./posix-execution.ts";
import { WindowsExecutor } from "./windows-execution.ts";

export function powerShellCommand(command: string, shell: string): string {
  // Match Pi's UTF-8 output setup and Windows PowerShell 5.1 native-stderr fix.
  // A standalone semicolon preserves errors for unfinished pipelines; a final
  // backtick must not continue the user's last line into our exit suffix.
  // https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/tools/powershell.ts
  const suffix =
    win32.basename(shell).toLowerCase() === "powershell.exe" &&
    !command.endsWith("`")
      ? '\n;\nif ($?) { exit 0 }\nif (($LASTEXITCODE -eq 0) -and ("$($Error[0].FullyQualifiedErrorId)" -like "NativeCommandError*")) { exit 0 }\nexit 1'
      : "";
  return `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n${command}${suffix}`;
}

export function shellExecutor(name: ShellName): Executor {
  return {
    start(command, cwd, observer) {
      if (name !== "bash" && name !== "powershell")
        throw new Error(`Unsupported background shell: ${String(name)}`);
      if (name === "powershell" && process.platform !== "win32")
        throw new Error(
          "The powershell background shell is only available on Windows",
        );
      // Resolve at launch, not session startup: PowerShell-only sessions must
      // not require Bash, and each task must use the selected command language.
      const shell =
        name === "powershell" ? getPowerShellConfig() : getShellConfig();
      const executor =
        process.platform === "win32"
          ? new WindowsExecutor({ shell })
          : new PosixExecutor({ shell });
      return executor.start(
        name === "powershell"
          ? powerShellCommand(command, shell.shell)
          : command,
        cwd,
        observer,
      );
    },
  };
}
