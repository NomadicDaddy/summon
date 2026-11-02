using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public sealed partial class RetentionPathGuard
{
    private sealed class RelativeOpenException : IOException
    {
        public int Status { get; }
        public RelativeOpenException(int status) : base("Relative retention open refused: " + status)
        { Status = status; HResult = status; }
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file,
        StringBuilder buffer, uint size, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle file,
        int informationClass, IntPtr buffer, uint size);
    [DllImport("ntdll.dll")]
    private static extern int NtCreateFile(out SafeFileHandle file, uint access,
        ref ObjectAttributes attributes, out IoStatus status, IntPtr allocationSize,
        uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeName { public ushort Length, MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ObjectAttributes
    {
        public uint Length;
        public IntPtr RootDirectory, ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor, SecurityQualityOfService;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatus { public IntPtr Status; public UIntPtr Information; }

    private static SafeFileHandle OpenChild(SafeFileHandle directory, string name, uint share = 3)
    {
        if (String.IsNullOrEmpty(name) || name.Length > 255 || name == "." || name == ".." ||
            name.IndexOfAny(new[] { '\\', '/', ':', '\0' }) >= 0)
            throw new IOException("Invalid relative retention component.");
        IntPtr text = Marshal.StringToHGlobalUni(name);
        IntPtr unicode = Marshal.AllocHGlobal(Marshal.SizeOf<UnicodeName>());
        bool retained = false;
        try
        {
            directory.DangerousAddRef(ref retained);
            var value = new UnicodeName { Length = (ushort)(name.Length * 2),
                MaximumLength = (ushort)(name.Length * 2 + 2), Buffer = text };
            Marshal.StructureToPtr(value, unicode, false);
            var attributes = new ObjectAttributes { Length = (uint)Marshal.SizeOf<ObjectAttributes>(),
                RootDirectory = directory.DangerousGetHandle(), ObjectName = unicode,
                Attributes = 0x1000 }; // OBJ_DONT_REPARSE, one relative component only
            // FILE_GENERIC_READ; FILE_OPEN; synchronous IO and final-object no-follow.
            int status = NtCreateFile(out var handle, 0x120089, ref attributes, out _,
                IntPtr.Zero, 0, share, 1, 0x00200020, IntPtr.Zero, 0);
            if (status >= 0) return handle;
            handle?.Dispose();
            throw new RelativeOpenException(status);
        }
        finally
        {
            if (retained) directory.DangerousRelease();
            Marshal.FreeHGlobal(unicode);
            Marshal.FreeHGlobal(text);
        }
    }

    public string Canonical(string input)
    {
        if (!handles.TryGetValue(Path.GetFullPath(input), out var handle)) return null;
        var buffer = new StringBuilder(32768);
        uint count = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
        if (count == 0 || count >= buffer.Capacity)
            throw new IOException("Cannot establish normalized retention location.");
        string path = buffer.ToString();
        if (!path.StartsWith("\\\\?\\", StringComparison.Ordinal) || path.Length < 7 || path[5] != ':')
            throw new IOException("Unsupported normalized retention location.");
        return path.Substring(4);
    }

    private static IEnumerable<string> Names(SafeFileHandle directory)
    {
        const int size = 65536;
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            bool restart = true;
            for (;;)
            {
                // FileIdBothDirectoryRestartInfo=11; subsequent FileIdBothDirectoryInfo=10.
                if (!GetFileInformationByHandleEx(directory, restart ? 11 : 10, buffer, size))
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error == 18) yield break; // ERROR_NO_MORE_FILES
                    throw new Win32Exception(error);
                }
                restart = false;
                int offset = 0;
                for (;;)
                {
                    if (offset < 0 || offset > size - 104)
                        throw new IOException("Invalid directory information extent.");
                    int length = Marshal.ReadInt32(buffer, offset + 60);
                    int next = Marshal.ReadInt32(buffer, offset);
                    if (length < 0 || length > 510 || length % 2 != 0 || offset + 104 + length > size)
                        throw new IOException("Invalid directory name extent.");
                    string name = Marshal.PtrToStringUni(IntPtr.Add(buffer, offset + 104), length / 2);
                    if (name != "." && name != "..") yield return name;
                    if (next == 0) break;
                    if (next < 104 + length || next % 8 != 0)
                        throw new IOException("Invalid directory continuation extent.");
                    offset = checked(offset + next);
                }
            }
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
}
