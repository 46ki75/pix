import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { windowsPowerShell, windowsScriptArgs } from "./windows.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFileSync: vi.fn(original.execFileSync) };
});

const sid = "S-1-5-21-101-202-303-1001";
const unsafe = "Unsafe background output directory";
const directories: string[] = [];
const nativeTest = test.runIf(process.platform === "win32");

beforeEach(() => {
  vi.resetModules();
  vi.mocked(execFileSync).mockReset();
});

afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "pix-bg-windows-directory-"));
  directories.push(path);
  return path;
}

test("passes paths only as base64 UTF-8 data to the package script", async () => {
  const { privateWindowsDirectory } = await import("./windows-directory.ts");
  const path = "C:\\trusted\\雪 ' ; $(whoami) [logs] & %TEMP%";
  vi.mocked(execFileSync).mockReturnValueOnce("ok\r\n");
  expect(privateWindowsDirectory(path)).toBe(path);
  expect(execFileSync).toHaveBeenCalledExactlyOnceWith(
    windowsPowerShell(),
    windowsScriptArgs("windows-directory.ps1", [
      "directory",
      Buffer.from(path, "utf8").toString("base64"),
    ]),
    expect.objectContaining({
      encoding: "utf8",
      windowsHide: true,
      timeout: expect.any(Number),
      maxBuffer: expect.any(Number),
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
});

test("caches only the SID, never directory validation", async () => {
  const { privateWindowsDirectory, windowsUserId } =
    await import("./windows-directory.ts");
  vi.mocked(execFileSync)
    .mockReturnValueOnce(`${sid}\r\n`)
    .mockReturnValueOnce("ok\r\n")
    .mockReturnValueOnce("ok\r\n");
  expect(windowsUserId()).toBe(sid);
  expect(windowsUserId()).toBe(sid);
  privateWindowsDirectory("C:\\trusted\\logs");
  privateWindowsDirectory("C:\\trusted\\logs");
  expect(execFileSync).toHaveBeenCalledTimes(3);
  expect(vi.mocked(execFileSync).mock.calls[0]?.[1]).toEqual(
    windowsScriptArgs("windows-directory.ps1", ["identity"]),
  );
});

test("rejects malformed identity output without caching it", async () => {
  const { windowsUserId } = await import("./windows-directory.ts");
  vi.mocked(execFileSync)
    .mockReturnValueOnce("DOMAIN\\user\r\n")
    .mockReturnValueOnce(`${sid}\r\n`);
  expect(windowsUserId).toThrow(unsafe);
  expect(windowsUserId()).toBe(sid);
  expect(execFileSync).toHaveBeenCalledTimes(2);
});

test("reports invocation failures and requires successful validation output", async () => {
  const { privateWindowsDirectory, windowsUserId } =
    await import("./windows-directory.ts");
  vi.mocked(execFileSync).mockImplementationOnce(() => {
    throw new Error("PowerShell unavailable");
  });
  expect(() => privateWindowsDirectory("C:\\trusted\\logs")).toThrow(unsafe);
  vi.mocked(execFileSync).mockReturnValueOnce("");
  expect(() => privateWindowsDirectory("C:\\trusted\\logs")).toThrow(unsafe);
  vi.mocked(execFileSync).mockImplementationOnce(() => {
    throw new Error("Identity unavailable");
  });
  expect(windowsUserId).toThrow(unsafe);
});

// These fixture scripts never interpolate a path into PowerShell source. They use
// the same trusted executable and -File boundary as production, not PATH or cmd.
function powershell<T>(parent: string, source: string, path: string): T {
  const script = join(parent, "acl-fixture.ps1");
  writeFileSync(
    script,
    `param([string]$Payload)\n$ErrorActionPreference = 'Stop'\n` +
      `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))\n` +
      source,
    "utf8",
  );
  return JSON.parse(
    execFileSync(
      windowsPowerShell(),
      windowsScriptArgs(pathToFileURL(script).href, [
        Buffer.from(path, "utf8").toString("base64"),
      ]),
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      },
    ).trim(),
  ) as T;
}

interface Acl {
  owner: string;
  protected: boolean;
  sddl: string;
  rules: {
    sid: string;
    rights: number;
    inherited: boolean;
    inheritance: number;
    propagation: number;
    type: number;
  }[];
}

function acl(parent: string, path: string): Acl {
  return powershell<Acl>(
    parent,
    `$acl = Get-Acl -LiteralPath $path
@{
  owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  protected = $acl.AreAccessRulesProtected
  sddl = $acl.Sddl
  rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
    @{
      sid = $_.IdentityReference.Value
      rights = [int]$_.FileSystemRights
      inherited = $_.IsInherited
      inheritance = [int]$_.InheritanceFlags
      propagation = [int]$_.PropagationFlags
      type = [int]$_.AccessControlType
    }
  })
} | ConvertTo-Json -Depth 4 -Compress`,
    path,
  );
}

nativeTest(
  "creates and reuses an owner-private directory with retained content and inheritable ACLs",
  async () => {
    const { privateWindowsDirectory, windowsUserId } =
      await import("./windows-directory.ts");
    const parent = root();
    const path = join(parent, "雪 ' ; $(whoami) [logs] & %TEMP%");
    expect(privateWindowsDirectory(path)).toBe(path);
    const file = join(path, "retained.log");
    writeFileSync(file, "retained");
    const before = acl(parent, path);
    expect(before.owner).toBe(windowsUserId());
    expect(before.protected).toBe(true);
    expect(before.rules).toEqual([
      {
        sid: windowsUserId(),
        rights: 0x1f01ff,
        inherited: false,
        inheritance: 3,
        propagation: 0,
        type: 0,
      },
    ]);
    expect(privateWindowsDirectory(path)).toBe(path);
    expect(readFileSync(file, "utf8")).toBe("retained");
    expect(acl(parent, path).sddl).toBe(before.sddl);

    const fileAcl = acl(parent, file);
    expect(fileAcl.protected).toBe(false);
    expect(fileAcl.rules.length).toBeGreaterThan(0);
    for (const rule of fileAcl.rules) {
      expect([windowsUserId(), "S-1-5-18"]).toContain(rule.sid);
      expect(rule.type).toBe(0);
      expect(rule.inherited).toBe(true);
      expect(rule.rights).toBe(0x1f01ff);
      expect(rule.propagation).toBe(0);
    }
    const child = join(path, "child");
    privateWindowsDirectory(child);
    expect(acl(parent, child).protected).toBe(true);
  },
  30_000,
);

nativeTest(
  "accepts an optional inheritable SYSTEM grant without changing the ACL",
  async () => {
    const { privateWindowsDirectory } = await import("./windows-directory.ts");
    const parent = root();
    const path = privateWindowsDirectory(join(parent, "logs"));
    powershell(
      parent,
      `$acl = [IO.Directory]::GetAccessControl($path)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
  [Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
  [Security.AccessControl.FileSystemRights]::FullControl,
  [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow))
[IO.Directory]::SetAccessControl($path, $acl)
$true | ConvertTo-Json`,
      path,
    );
    const before = acl(parent, path);
    expect(before.rules).toHaveLength(2);
    expect(privateWindowsDirectory(path)).toBe(path);
    expect(acl(parent, path).sddl).toBe(before.sddl);
  },
  30_000,
);

nativeTest(
  "rejects an owner-only ACL that cannot protect inherited logs without repairing it",
  async () => {
    const { privateWindowsDirectory } = await import("./windows-directory.ts");
    const parent = root();
    const path = privateWindowsDirectory(join(parent, "logs"));
    powershell(
      parent,
      `$acl = [IO.Directory]::GetAccessControl($path)
$acl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
  [Security.Principal.WindowsIdentity]::GetCurrent().User,
  [Security.AccessControl.FileSystemRights]::FullControl,
  [Security.AccessControl.InheritanceFlags]::None,
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow))
[IO.Directory]::SetAccessControl($path, $acl)
$true | ConvertTo-Json`,
      path,
    );
    const before = acl(parent, path);
    expect(before.rules[0]?.inheritance).toBe(0);
    expect(() => privateWindowsDirectory(path)).toThrow(unsafe);
    expect(acl(parent, path).sddl).toBe(before.sddl);
  },
  30_000,
);

nativeTest(
  "rejects a permissive existing directory without changing its ACL or content",
  async () => {
    const { privateWindowsDirectory } = await import("./windows-directory.ts");
    const parent = root();
    const path = privateWindowsDirectory(join(parent, "logs"));
    const file = join(path, "retained.log");
    writeFileSync(file, "retained");
    powershell(
      parent,
      `$acl = [IO.Directory]::GetAccessControl($path)
$everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
  $everyone, [Security.AccessControl.FileSystemRights]::ReadAndExecute,
  [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow))
[IO.Directory]::SetAccessControl($path, $acl)
$true | ConvertTo-Json`,
      path,
    );
    const before = acl(parent, path).sddl;
    expect(() => privateWindowsDirectory(path)).toThrow(unsafe);
    expect(acl(parent, path).sddl).toBe(before);
    expect(readFileSync(file, "utf8")).toBe("retained");
  },
  30_000,
);

nativeTest(
  "rejects a null DACL without replacing it with a private ACL",
  async () => {
    const { privateWindowsDirectory } = await import("./windows-directory.ts");
    const parent = root();
    const path = privateWindowsDirectory(join(parent, "logs"));
    const isNull = powershell<boolean>(
      parent,
      `$acl = [IO.Directory]::GetAccessControl($path)
$acl.SetSecurityDescriptorSddlForm('D:PNO_ACCESS_CONTROL',
  [Security.AccessControl.AccessControlSections]::Access)
[IO.Directory]::SetAccessControl($path, $acl)
$actual = [IO.Directory]::GetAccessControl($path)
$raw = [Security.AccessControl.RawSecurityDescriptor]::new(
  $actual.GetSecurityDescriptorBinaryForm(), 0)
($null -eq $raw.DiscretionaryAcl) | ConvertTo-Json`,
      path,
    );
    expect(isNull).toBe(true);
    const before = acl(parent, path).sddl;
    expect(() => privateWindowsDirectory(path)).toThrow(unsafe);
    expect(acl(parent, path).sddl).toBe(before);
  },
  30_000,
);

nativeTest(
  "rechecks ACLs after successful reuse rather than caching directory trust",
  async () => {
    const { privateWindowsDirectory } = await import("./windows-directory.ts");
    const parent = root();
    const path = privateWindowsDirectory(join(parent, "logs"));
    privateWindowsDirectory(path);
    powershell(
      parent,
      `$acl = [IO.Directory]::GetAccessControl($path)
$acl.SetAccessRuleProtection($false, $true)
[IO.Directory]::SetAccessControl($path, $acl)
$true | ConvertTo-Json`,
      path,
    );
    const before = acl(parent, path).sddl;
    expect(() => privateWindowsDirectory(path)).toThrow(unsafe);
    expect(acl(parent, path).sddl).toBe(before);
  },
  30_000,
);

nativeTest(
  "rejects a junction and never changes its target",
  async () => {
    const { privateWindowsDirectory } = await import("./windows-directory.ts");
    const parent = root();
    const target = privateWindowsDirectory(join(parent, "target"));
    const file = join(target, "retained.log");
    writeFileSync(file, "retained");
    const before = acl(parent, target).sddl;
    const path = join(parent, "junction");
    symlinkSync(target, path, "junction");
    expect(() => privateWindowsDirectory(path)).toThrow(unsafe);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(acl(parent, target).sddl).toBe(before);
    expect(readFileSync(file, "utf8")).toBe("retained");
    expect(() => privateWindowsDirectory(join(path, "child"))).toThrow(unsafe);
    expect(() => lstatSync(join(target, "child"))).toThrow();
  },
  30_000,
);

nativeTest(
  "rejects regular files without changing their contents",
  async () => {
    const { privateWindowsDirectory } = await import("./windows-directory.ts");
    const parent = root();
    const path = join(parent, "logs");
    writeFileSync(path, "retained");
    const before = acl(parent, path).sddl;
    expect(() => privateWindowsDirectory(path)).toThrow(unsafe);
    expect(readFileSync(path, "utf8")).toBe("retained");
    expect(acl(parent, path).sddl).toBe(before);
  },
  30_000,
);

nativeTest(
  "requires an existing trusted parent and rejects ambiguous or remote paths",
  async () => {
    const { privateWindowsDirectory } = await import("./windows-directory.ts");
    const parent = root();
    const missing = join(parent, "missing");
    const paths = [
      join(missing, "logs"),
      join(parent, "logs."),
      join(parent, "logs "),
      join(parent, "logs:stream"),
      "relative-logs",
      "C:drive-relative-logs",
      "\\\\localhost\\C$\\pix-bg-logs",
      `\\\\?\\${join(parent, "logs")}`,
    ];
    for (const path of paths)
      expect(() => privateWindowsDirectory(path)).toThrow(unsafe);
    expect(() => lstatSync(missing)).toThrow();
  },
  30_000,
);

nativeTest(
  "rejects a foreign owner when the token can assign one",
  async ({ skip }) => {
    const { privateWindowsDirectory } = await import("./windows-directory.ts");
    const parent = root();
    const path = privateWindowsDirectory(join(parent, "logs"));
    const assigned = powershell<boolean>(
      parent,
      `try {
  $acl = [IO.Directory]::GetAccessControl($path)
  $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
  [IO.Directory]::SetAccessControl($path, $acl)
  $true | ConvertTo-Json
} catch [UnauthorizedAccessException] {
  $false | ConvertTo-Json
} catch [InvalidOperationException] {
  # .NET maps ERROR_INVALID_OWNER to InvalidOperationException for tokens that
  # cannot assign the Administrators group as owner.
  $false | ConvertTo-Json
}`,
      path,
    );
    if (!assigned) skip("The current token cannot assign another owner");
    const before = acl(parent, path);
    expect(before.owner).toBe("S-1-5-32-544");
    expect(() => privateWindowsDirectory(path)).toThrow(unsafe);
    expect(acl(parent, path).sddl).toBe(before.sddl);
  },
  30_000,
);
