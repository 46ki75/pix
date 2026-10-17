param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('identity', 'directory')]
    [string]$Action,
    [string]$Payload
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$identity = $null

function Assert-PlainDirectory([string]$Path) {
    $attributes = [IO.File]::GetAttributes($Path)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        ($attributes -band [IO.FileAttributes]::Directory) -eq 0) {
        throw 'Expected a directory, not a file or reparse point'
    }
}

function Assert-PrivateAcl([string]$Path, [Security.Principal.SecurityIdentifier]$User) {
    $sections = [Security.AccessControl.AccessControlSections]::Owner -bor
        [Security.AccessControl.AccessControlSections]::Access
    $security = [IO.Directory]::GetAccessControl($Path, $sections)
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new(
        $security.GetSecurityDescriptorBinaryForm(), 0)
    if ($null -eq $raw.Owner -or -not $raw.Owner.Equals($User)) {
        throw 'The directory is not owned by the current user SID'
    }

    # A null DACL grants everyone full access. Inspect every raw ACE rather than
    # GetAccessRules(), which does not expose every possible ACE type.
    $required = [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent -bor
        [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected
    if (($raw.ControlFlags -band $required) -ne $required -or
        $null -eq $raw.DiscretionaryAcl) {
        throw 'Expected a protected, non-null directory DACL'
    }
    # Windows PowerShell 5.1 cannot bitwise-OR byte-backed enum instances.
    $inherit = [int][Security.AccessControl.AceFlags]::ContainerInherit -bor
        [int][Security.AccessControl.AceFlags]::ObjectInherit
    $ownerCanInherit = $false
    foreach ($ace in $raw.DiscretionaryAcl) {
        # Deliberately accept only simple, unconditional, fully inheritable
        # grants to this user or SYSTEM. Unknown/conditional/object ACEs and
        # deny ACEs fail closed; no effective-access approximation is used.
        if ($ace -isnot [Security.AccessControl.CommonAce] -or
            $ace.IsCallback -or
            $ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -or
            [int]$ace.AceFlags -ne $inherit -or
            $ace.AccessMask -ne [int][Security.AccessControl.FileSystemRights]::FullControl -or
            ($ace.SecurityIdentifier.Value -ne $User.Value -and
             $ace.SecurityIdentifier.Value -ne 'S-1-5-18')) {
            throw 'Expected only owner-private, inheritable directory access rules'
        }
        if ($ace.SecurityIdentifier.Equals($User)) {
            $ownerCanInherit = $true
        }
    }
    if (-not $ownerCanInherit) {
        throw 'The current user must have inheritable full control'
    }
}

try {
    if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -lt 1) {
        throw 'Windows PowerShell 5.1 is required'
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $user = $identity.User
    if ($null -eq $user) {
        throw 'The current Windows identity has no user SID'
    }
    if ($Action -eq 'identity') {
        [Console]::Out.WriteLine($user.Value)
    } else {
        $utf8 = [Text.UTF8Encoding]::new($false, $true)
        $path = $utf8.GetString([Convert]::FromBase64String($Payload)).Replace('/', '\')

        # Restrict the Win32 namespace so aliases, ADS, UNC/device paths, and
        # .NET's trimming/normalization cannot bypass the checks below.
        if ($path -notmatch '^[A-Za-z]:\\' -or $path.Length -le 3) {
            throw 'Expected an absolute local drive path below an existing parent'
        }
        foreach ($component in $path.Substring(3).Split([char]'\')) {
            if ([string]::IsNullOrEmpty($component) -or
                $component -eq '.' -or $component -eq '..' -or
                $component.EndsWith('.') -or $component.EndsWith(' ') -or
                $component.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
                $component -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])($|\.)') {
                throw 'Unsupported or ambiguous Windows path component'
            }
        }
        $path = [IO.Path]::GetFullPath($path)
        $root = [IO.Path]::GetPathRoot($path)
        $drive = [IO.DriveInfo]::new($root)
        # NTFS on a local fixed drive is the supported security boundary. Do not
        # assume remote, FAT, or other filesystems preserve Windows ACLs.
        if ($drive.DriveType -ne [IO.DriveType]::Fixed -or $drive.DriveFormat -ne 'NTFS') {
            throw 'A local fixed NTFS volume is required for private background logs'
        }
        $parent = [IO.Path]::GetDirectoryName($path)
        $ancestor = $parent
        while ($null -ne $ancestor) {
            Assert-PlainDirectory $ancestor
            $ancestor = [IO.Path]::GetDirectoryName($ancestor)
        }
        # Checking all ancestors also excludes volume mount points: inspecting
        # only the drive letter would not prove the target is on that NTFS volume.
        $exists = $true
        try {
            Assert-PlainDirectory $path
        } catch [IO.FileNotFoundException] {
            $exists = $false
        }
        if (-not $exists) {
            $security = [Security.AccessControl.DirectorySecurity]::new()
            $security.SetOwner($user)
            $security.SetAccessRuleProtection($true, $false)
            $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
                [Security.AccessControl.InheritanceFlags]::ObjectInherit
            $rule = [Security.AccessControl.FileSystemAccessRule]::new(
                $user, [Security.AccessControl.FileSystemRights]::FullControl,
                $inherit, [Security.AccessControl.PropagationFlags]::None,
                [Security.AccessControl.AccessControlType]::Allow)
            $security.AddAccessRule($rule)
            # Microsoft documents this overload as applying security at creation,
            # with no interval in which the new directory has its parent's ACL.
            # It does not alter an existing directory if another creator wins.
            # https://learn.microsoft.com/dotnet/api/system.io.directory.createdirectory?view=netframework-4.8.1#system-io-directory-createdirectory(system-string-system-security-accesscontrol-directorysecurity)
            [void][IO.Directory]::CreateDirectory($path, $security)
        }
        Assert-PlainDirectory $path
        Assert-PrivateAcl $path $user
        [Console]::Out.WriteLine('ok')
    }
} catch {
    [Console]::Error.WriteLine('Unsafe background output directory: ' + $_.Exception.ToString())
    [Console]::Error.WriteLine($_.ScriptStackTrace)
    exit 1
} finally {
    if ($null -ne $identity) {
        $identity.Dispose()
    }
}
