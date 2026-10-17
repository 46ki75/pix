# Windows PowerShell 5.1, full language mode. stdout/stderr belong exclusively to the command.
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$pipeName = $null

try {
    # The parent sends one complete UTF-8 JSON document and closes stdin immediately.
    # Read to EOF, not to a line boundary: command arguments can contain newlines.
    $inputUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
    try {
        [Console]::InputEncoding = $inputUtf8
    }
    catch {
        # .NET Framework calls SetConsoleCP even for redirected stdin; a console-less helper
        # can reject the setter. The explicit reader below still decodes the pipe as UTF-8.
        # https://github.com/microsoft/referencesource/blob/main/mscorlib/system/console.cs
        if ($_.Exception.GetBaseException() -isnot [System.IO.IOException]) {
            throw
        }
    }
    $inputReader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $inputUtf8, $false)
    try {
        $json = $inputReader.ReadToEnd()
    }
    finally {
        $inputReader.Dispose()
    }
    $payload = ConvertFrom-Json -InputObject $json -ErrorAction Stop
    if ($null -eq $payload -or $payload -isnot [System.Management.Automation.PSCustomObject]) {
        throw 'The runner payload must be a JSON object.'
    }

    $pipeProperty = $payload.PSObject.Properties['pipe']
    if ($null -eq $pipeProperty -or $pipeProperty.Value -isnot [string] -or
        [string]::IsNullOrEmpty($pipeProperty.Value)) {
        throw 'The runner payload must contain a nonempty pipe name.'
    }
    $pipeName = $pipeProperty.Value
    if ($pipeName.Contains('\') -or $pipeName.Contains('/') -or $pipeName.Contains([char]0)) {
        throw 'pipe must be a name without NUL characters, not a pipe path.'
    }

    foreach ($name in @('shell', 'cwd')) {
        $property = $payload.PSObject.Properties[$name]
        if ($null -eq $property -or $property.Value -isnot [string]) {
            throw "The runner payload field '$name' must be a string."
        }
    }
    $argsProperty = $payload.PSObject.Properties['args']
    if ($null -eq $argsProperty -or $argsProperty.Value -isnot [System.Array]) {
        throw 'The runner payload field args must be an array of strings.'
    }
    foreach ($argument in $argsProperty.Value) {
        if ($argument -isnot [string]) {
            throw 'Every runner args entry must be a string.'
        }
    }
    [string[]] $shellArgs = $argsProperty.Value

    # Escape wildcard syntax in installation paths; no command text is embedded in source code.
    # NamedPipeClientStream lives in the framework's System.Core.dll, not System.dll.
    $sourcePath = [System.Management.Automation.WildcardPattern]::Escape(
        (Join-Path -Path $PSScriptRoot -ChildPath 'windows-runner.cs'))
    Add-Type -Path $sourcePath -ReferencedAssemblies 'System.dll', 'System.Core.dll' `
        -ErrorAction Stop -WarningAction SilentlyContinue | Out-Null
    $helperExitCode = [PixBg.WindowsRunner]::Run($payload.shell, $shellArgs, $payload.cwd, $pipeName)
    exit $helperExitCode
}
catch {
    # Bootstrap/validation errors can happen before the C# runner owns a control connection.
    # Report them there too, never via PowerShell's formatted error stream. Invalid JSON without
    # a recoverable pipe name, or a failed connection, can only be reported by helper status/EOF.
    $message = $_.Exception.Message
    $control = $null
    try {
        if (-not [string]::IsNullOrEmpty($pipeName)) {
            # This overload uses HandleInheritability.None; only the pipe NAME is supplied.
            $control = [System.IO.Pipes.NamedPipeClientStream]::new(
                '.', $pipeName, [System.IO.Pipes.PipeDirection]::Out)
            $control.Connect(5000)
            $utf8 = [System.Text.UTF8Encoding]::new($false)
            $encoded = [Convert]::ToBase64String($utf8.GetBytes($message))
            $frame = $utf8.GetBytes("error:$encoded`n")
            $control.Write($frame, 0, $frame.Length)
            $control.Flush()
        }
    }
    catch {
        # A broken/unavailable control pipe must not contaminate raw command output.
    }
    finally {
        if ($null -ne $control) {
            $control.Dispose()
        }
    }
    exit 1
}
