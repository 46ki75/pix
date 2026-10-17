using System;
using System.ComponentModel;
using System.Globalization;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;

namespace PixBg
{
    // Keep this source compatible with Windows PowerShell 5.1's C# compiler and .NET Framework.
    public static class WindowsRunner
    {
        private const int ConnectTimeoutMilliseconds = 5000;
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;
        private const int JobObjectExtendedLimitInformation = 9;
        private const uint ExtendedStartupInfoPresent = 0x00080000;
        private const uint CreateNoWindow = 0x08000000;
        private const uint CreateUnicodeEnvironment = 0x00000400;
        private const uint StartfUseStdHandles = 0x00000100;
        private const uint DuplicateSameAccess = 0x00000002;
        private const uint GenericRead = 0x80000000;
        private const uint FileShareRead = 0x00000001;
        private const uint FileShareWrite = 0x00000002;
        private const uint OpenExisting = 3;
        private const uint FileAttributeNormal = 0x00000080;
        private const uint Infinite = 0xffffffff;
        private const uint WaitObject0 = 0;
        private const uint WaitFailed = 0xffffffff;
        private const int ErrorInsufficientBuffer = 122;
        private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);
        private static readonly UIntPtr ProcThreadAttributeHandleList = new UIntPtr(0x00020002u);
        private static readonly UIntPtr ProcThreadAttributeJobList = new UIntPtr(0x0002000du);
        private static readonly Encoding Utf8 = new UTF8Encoding(false);

        // The return value describes the helper, not the shell. The shell's unsigned DWORD exit
        // status travels only in the exit frame; it is never translated to a POSIX signal.
        public static int Run(string shell, string[] args, string cwd, string pipeName)
        {
            NamedPipeClientStream control = null;
            try
            {
                ValidateText(pipeName, "pipe", false);
                if (pipeName.IndexOf('\\') >= 0 || pipeName.IndexOf('/') >= 0)
                {
                    throw new ArgumentException("pipe must be a name, not a pipe path.");
                }

                // This overload defaults to HandleInheritability.None. The HANDLE_LIST below
                // independently excludes this connection, so descendants cannot delay its EOF.
                // https://learn.microsoft.com/en-us/dotnet/api/system.io.pipes.namedpipeclientstream.-ctor
                control = new NamedPipeClientStream(".", pipeName, PipeDirection.Out);
                control.Connect(ConnectTimeoutMilliseconds);
                RunJob(control, shell, args, cwd);
                return 0;
            }
            catch (Exception error)
            {
                // RunJob's finally has already closed the job before a failed launch is reported.
                // If the server has gone away, EOF/helper status is the only available diagnosis.
                TryWriteError(control, error);
                return 1;
            }
            finally
            {
                if (control != null)
                {
                    control.Dispose();
                }
            }
        }

        private static void RunJob(NamedPipeClientStream control, string shell, string[] args, string cwd)
        {
            ValidateText(shell, "shell", false);
            ValidateText(cwd, "cwd", false);
            if (shell.IndexOf('"') >= 0)
            {
                throw new ArgumentException("shell cannot contain a quotation mark.");
            }
            if (args == null)
            {
                throw new ArgumentNullException("args");
            }

            StringBuilder commandLine = BuildCommandLine(shell, args);
            IntPtr job = IntPtr.Zero;
            IntPtr stdout = IntPtr.Zero;
            IntPtr stderr = IntPtr.Zero;
            IntPtr stdin = IntPtr.Zero;
            IntPtr attributes = IntPtr.Zero;
            IntPtr jobList = IntPtr.Zero;
            IntPtr handleList = IntPtr.Zero;
            bool attributesInitialized = false;
            PROCESS_INFORMATION process = new PROCESS_INFORMATION();

            try
            {
                // NULL security attributes make the job handle noninheritable; an unnamed job
                // cannot be reopened by name. Neither breakaway limit is enabled.
                // https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw
                job = CreateJobObjectW(IntPtr.Zero, null);
                if (job == IntPtr.Zero)
                {
                    throw NativeError("CreateJobObjectW");
                }
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
                    (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                {
                    throw NativeError("SetInformationJobObject");
                }

                // Pass the OS handles directly, not through PowerShell's text pipeline. Only our
                // duplicates are owned here; the original GetStdHandle handles belong to the host.
                stdout = DuplicateOutputHandle(-11);
                stderr = DuplicateOutputHandle(-12);
                SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES();
                security.nLength = (uint)Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
                security.bInheritHandle = 1;
                stdin = CreateFileW("NUL", GenericRead, FileShareRead | FileShareWrite,
                    ref security, OpenExisting, FileAttributeNormal, IntPtr.Zero);
                if (stdin == InvalidHandleValue)
                {
                    throw NativeError("CreateFileW(NUL)");
                }

                UIntPtr attributeBytes = UIntPtr.Zero;
                // The first call fails by design and returns the allocation size.
                // https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-initializeprocthreadattributelist
                bool probeSucceeded = InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeBytes);
                int probeError = Marshal.GetLastWin32Error();
                if (probeSucceeded || probeError != ErrorInsufficientBuffer || attributeBytes == UIntPtr.Zero)
                {
                    throw new Win32Exception(probeError, "Could not size the process attribute list.");
                }
                attributes = Marshal.AllocHGlobal(new IntPtr(checked((long)attributeBytes.ToUInt64())));
                if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref attributeBytes))
                {
                    throw NativeError("InitializeProcThreadAttributeList");
                }
                attributesInitialized = true;

                jobList = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobList, job);
                handleList = Marshal.AllocHGlobal(3 * IntPtr.Size);
                Marshal.WriteIntPtr(handleList, 0, stdin);
                Marshal.WriteIntPtr(handleList, IntPtr.Size, stdout);
                Marshal.WriteIntPtr(handleList, 2 * IntPtr.Size, stderr);

                // JOB_LIST assigns the job as part of CreateProcessW (Windows 10+). Do not
                // replace this with post-creation assignment, even for a suspended process:
                // killing the helper in that gap would leave an uncontained root behind.
                // HANDLE_LIST requires inheritable handles and bInheritHandles=TRUE, but limits
                // inheritance to stdin/stdout/stderr, excluding the job and control pipe.
                // Both lpValue allocations MUST survive until DeleteProcThreadAttributeList.
                // https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
                SetAttribute(attributes, ProcThreadAttributeJobList, jobList, IntPtr.Size);
                SetAttribute(attributes, ProcThreadAttributeHandleList, handleList, 3 * IntPtr.Size);

                STARTUPINFOEX startup = new STARTUPINFOEX();
                startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
                startup.StartupInfo.dwFlags = StartfUseStdHandles;
                startup.StartupInfo.hStdInput = stdin;
                startup.StartupInfo.hStdOutput = stdout;
                startup.StartupInfo.hStdError = stderr;
                startup.lpAttributeList = attributes;

                // Explicit application name prevents executable-path ambiguity. StringBuilder
                // supplies the mutable UTF-16 command line required by CreateProcessW. A NULL
                // environment inherits the helper's environment; cwd is passed without rewriting.
                // https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw
                if (!CreateProcessW(shell, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                    ExtendedStartupInfoPresent | CreateNoWindow | CreateUnicodeEnvironment,
                    IntPtr.Zero, cwd, ref startup, out process))
                {
                    throw NativeError("CreateProcessW");
                }

                WriteFrame(control, "ready");
                // Root-shell-owns-lifetime: never wait for stdout/stderr EOF, since descendants
                // may retain those handles after the root exits. The parent drains the raw pipes.
                uint wait = WaitForSingleObject(process.hProcess, Infinite);
                if (wait == WaitFailed)
                {
                    throw NativeError("WaitForSingleObject");
                }
                if (wait != WaitObject0)
                {
                    throw new InvalidOperationException("Unexpected root-process wait result: " +
                        wait.ToString(CultureInfo.InvariantCulture));
                }
                uint exitCode;
                if (!GetExitCodeProcess(process.hProcess, out exitCode))
                {
                    throw NativeError("GetExitCodeProcess");
                }
                WriteFrame(control, "exit:" + exitCode.ToString(CultureInfo.InvariantCulture));

                // This code is only for remaining descendants; the root's native status above
                // is preserved. Termination is forceful, not a fabricated POSIX signal outcome.
                if (!TerminateJobObject(job, 1))
                {
                    throw NativeError("TerminateJobObject");
                }
            }
            finally
            {
                // Delete before freeing lpValue buffers (UpdateProcThreadAttribute contract).
                if (attributesInitialized)
                {
                    DeleteProcThreadAttributeList(attributes);
                }
                Marshal.FreeHGlobal(attributes);
                Marshal.FreeHGlobal(jobList);
                Marshal.FreeHGlobal(handleList);

                // Closing the LAST job handle kills every remaining member, including on any
                // startup/protocol failure. Never give this handle to a child. Forced helper
                // termination skips finally, but the kernel closes its handles with the same
                // kill-on-close effect. Do not wait on the job handle: its signaled state is not
                // a general-purpose indication that all processes exited.
                // https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
                CloseOwnedHandle(job);
                CloseOwnedHandle(process.hThread);
                CloseOwnedHandle(process.hProcess);
                CloseOwnedHandle(stdin);
                CloseOwnedHandle(stdout);
                CloseOwnedHandle(stderr);
            }
        }

        private static StringBuilder BuildCommandLine(string shell, string[] args)
        {
            // argv[0] follows special CRT rules and is a pathname (quotes are rejected above).
            StringBuilder result = new StringBuilder();
            result.Append('"').Append(shell).Append('"');
            foreach (string argument in args)
            {
                ValidateText(argument, "args entry", true);
                result.Append(' ');
                AppendQuotedArgument(result, argument);
            }
            // CreateProcessW's limit includes the terminating UTF-16 NUL.
            if (result.Length > 32766)
            {
                throw new ArgumentException("The Windows command line exceeds 32,767 UTF-16 code units including NUL.");
            }
            return result;
        }

        private static void AppendQuotedArgument(StringBuilder result, string argument)
        {
            // Always quote, including empty arguments. Backslashes are doubled only before
            // quotes (including the closing delimiter); shell metacharacters are not escaped.
            // https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments
            result.Append('"');
            int backslashes = 0;
            foreach (char character in argument)
            {
                if (character == '\\')
                {
                    backslashes++;
                }
                else if (character == '"')
                {
                    result.Append('\\', backslashes * 2 + 1).Append('"');
                    backslashes = 0;
                }
                else
                {
                    result.Append('\\', backslashes).Append(character);
                    backslashes = 0;
                }
            }
            result.Append('\\', backslashes * 2).Append('"');
        }

        private static void ValidateText(string value, string name, bool allowEmpty)
        {
            if (value == null || (!allowEmpty && value.Length == 0) || value.IndexOf('\0') >= 0)
            {
                throw new ArgumentException(name + " must be " +
                    (allowEmpty ? "a string" : "a nonempty string") + " without NUL characters.");
            }
        }

        private static IntPtr DuplicateOutputHandle(int standardHandle)
        {
            IntPtr original = GetStdHandle(standardHandle);
            if (original == InvalidHandleValue)
            {
                throw NativeError("GetStdHandle");
            }
            if (original == IntPtr.Zero)
            {
                throw new InvalidOperationException("The helper must have redirected stdout and stderr handles.");
            }
            IntPtr currentProcess = GetCurrentProcess();
            IntPtr duplicate;
            if (!DuplicateHandle(currentProcess, original, currentProcess, out duplicate, 0, true, DuplicateSameAccess))
            {
                throw NativeError("DuplicateHandle");
            }
            return duplicate;
        }

        private static void SetAttribute(IntPtr attributes, UIntPtr key, IntPtr value, int bytes)
        {
            if (!UpdateProcThreadAttribute(attributes, 0, key, value, new UIntPtr((uint)bytes),
                IntPtr.Zero, IntPtr.Zero))
            {
                throw NativeError("UpdateProcThreadAttribute");
            }
        }

        private static void WriteFrame(NamedPipeClientStream control, string frame)
        {
            byte[] bytes = Utf8.GetBytes(frame + "\n");
            control.Write(bytes, 0, bytes.Length);
            control.Flush();
        }

        private static void TryWriteError(NamedPipeClientStream control, Exception error)
        {
            try
            {
                if (control != null && control.IsConnected)
                {
                    WriteFrame(control, "error:" + Convert.ToBase64String(Utf8.GetBytes(error.Message)));
                }
            }
            catch (Exception)
            {
                // Never contaminate command stdout/stderr if the control pipe is broken.
            }
        }

        private static Win32Exception NativeError(string operation)
        {
            int code = Marshal.GetLastWin32Error();
            return new Win32Exception(code, operation + " failed (Win32 " +
                code.ToString(CultureInfo.InvariantCulture) + "): " + new Win32Exception(code).Message);
        }

        private static void CloseOwnedHandle(IntPtr handle)
        {
            if (handle != IntPtr.Zero && handle != InvalidHandleValue)
            {
                CloseHandle(handle);
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SECURITY_ATTRIBUTES
        {
            public uint nLength;
            public IntPtr lpSecurityDescriptor;
            public int bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct STARTUPINFO
        {
            public uint cb;
            public IntPtr lpReserved;
            public IntPtr lpDesktop;
            public IntPtr lpTitle;
            public uint dwX;
            public uint dwY;
            public uint dwXSize;
            public uint dwYSize;
            public uint dwXCountChars;
            public uint dwYCountChars;
            public uint dwFillAttribute;
            public uint dwFlags;
            public ushort wShowWindow;
            public ushort cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct STARTUPINFOEX
        {
            public STARTUPINFO StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public uint dwProcessId;
            public uint dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(IntPtr hJob, int jobObjectInformationClass,
            ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInformation, uint cbJobObjectInformationLength);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        private static extern IntPtr GetStdHandle(int nStdHandle);

        [DllImport("kernel32.dll", ExactSpelling = true)]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DuplicateHandle(IntPtr hSourceProcessHandle, IntPtr hSourceHandle,
            IntPtr hTargetProcessHandle, out IntPtr lpTargetHandle, uint dwDesiredAccess,
            [MarshalAs(UnmanagedType.Bool)] bool bInheritHandle, uint dwOptions);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        private static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode,
            ref SECURITY_ATTRIBUTES lpSecurityAttributes, uint dwCreationDisposition,
            uint dwFlagsAndAttributes, IntPtr hTemplateFile);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList,
            uint dwAttributeCount, uint dwFlags, ref UIntPtr lpSize);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags,
            UIntPtr attribute, IntPtr lpValue, UIntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

        [DllImport("kernel32.dll", ExactSpelling = true)]
        private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcessW(string lpApplicationName, [In, Out] StringBuilder lpCommandLine,
            IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, [MarshalAs(UnmanagedType.Bool)] bool bInheritHandles,
            uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
            ref STARTUPINFOEX lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr hObject);
    }
}
