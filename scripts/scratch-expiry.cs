using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// Scratch expiry for one store. This worker holds the scratch root's whole ancestor chain and
// every folder it lists, opens each child relative to its held parent without following reparse
// points, lists folders through their held handles, and deletes only through a handle it has
// checked. No path is resolved by name a second time, so nothing outside scratch is reachable.
public sealed class ScratchExpiry : IDisposable
{
    public string Stage { get; private set; } = "initializing";
    // Test seam only: called with (point, relative path); returning false stops the run.
    public Func<string, string, bool> Pause;
    public Action<string, string> OnSkip;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access,
        uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file,
        out FileInformation information);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle file,
        int informationClass, IntPtr buffer, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle file,
        int informationClass, out BasicInformation buffer, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle file,
        int informationClass, ref byte deleteFile, uint size);
    [DllImport("ntdll.dll")]
    private static extern int NtCreateFile(out SafeFileHandle file, uint access,
        ref ObjectAttributes attributes, out IoStatus status, IntPtr allocationSize,
        uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
        public System.Runtime.InteropServices.ComTypes.FILETIME Access;
        public System.Runtime.InteropServices.ComTypes.FILETIME Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicInformation
    {
        public long Creation, Access, Write, Change;
        public uint Attributes, Padding;
    }
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

    // What one handle says about its object; the whole record must match before a delete.
    private struct Snapshot
    {
        public uint Volume, IndexHigh, IndexLow, Attributes, Links;
        public long Size, Write, Change;
        public bool Directory => (Attributes & 0x10) != 0;
        public bool Reparse => (Attributes & 0x400) != 0;
        public bool Same(Snapshot other) =>
            Volume == other.Volume && IndexHigh == other.IndexHigh && IndexLow == other.IndexLow;
        public bool Unchanged(Snapshot other) => Same(other) && Attributes == other.Attributes &&
            Size == other.Size && Write == other.Write && Change == other.Change;
    }

    public sealed class Skip { public string path, reason; }

    private const uint ReadAttributes = 0x80, Synchronize = 0x100000, Delete = 0x10000;
    private const uint GenericRead = 0x120089; // FILE_GENERIC_READ, includes FILE_LIST_DIRECTORY
    private const uint ShareReadWrite = 3, ShareAll = 7;
    // FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT; plus FILE_DIRECTORY_FILE (1) or
    // FILE_NON_DIRECTORY_FILE (0x40) where the expected type is known.
    private const uint OpenOptions = 0x00200020;
    private const int SampleLimit = 20, DepthLimit = 256;

    private readonly long cutoff;
    private readonly List<SafeFileHandle> chain = new List<SafeFileHandle>();
    private SafeFileHandle root;
    private int removedFiles, removedDirectories, disappeared, skipped;
    private readonly List<Skip> sample = new List<Skip>();

    public ScratchExpiry(long cutoffTicks) { cutoff = cutoffTicks; }

    private static Snapshot Read(SafeFileHandle handle)
    {
        if (!GetFileInformationByHandle(handle, out var info) ||
            !GetFileInformationByHandleEx(handle, 0, out var basic, (uint)Marshal.SizeOf<BasicInformation>()))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return new Snapshot { Volume = info.Volume, IndexHigh = info.IndexHigh, IndexLow = info.IndexLow,
            Attributes = info.Attributes, Links = info.Links,
            Size = ((long)info.SizeHigh << 32) | info.SizeLow, Write = basic.Write, Change = basic.Change };
    }

    // One relative component, opened through its held parent with OBJ_DONT_REPARSE and
    // FILE_OPEN_REPARSE_POINT: a link at this name is opened as itself, never followed.
    private static int OpenChild(SafeFileHandle directory, string name, uint access, uint share,
        uint options, out SafeFileHandle handle)
    {
        handle = null;
        if (String.IsNullOrEmpty(name) || name.Length > 255 || name == "." || name == ".." ||
            name.IndexOfAny(new[] { '\\', '/', ':', '\0' }) >= 0)
            throw new IOException("Invalid relative scratch component.");
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
                Attributes = 0x1040 }; // OBJ_DONT_REPARSE | OBJ_CASE_INSENSITIVE
            int status = NtCreateFile(out var opened, access, ref attributes, out _, IntPtr.Zero, 0,
                share, 1, options, IntPtr.Zero, 0); // FILE_OPEN
            if (status >= 0) handle = opened;
            else opened?.Dispose();
            return status;
        }
        finally
        {
            if (retained) directory.DangerousRelease();
            Marshal.FreeHGlobal(unicode);
            Marshal.FreeHGlobal(text);
        }
    }

    private static bool Missing(int status) => status == unchecked((int)0xC0000034) ||
        status == unchecked((int)0xC000003A) || status == unchecked((int)0xC0000056);
    private static bool Redirected(int status) => status == unchecked((int)0xC000050B) ||
        status == unchecked((int)0x8000002D);

    /// Opens the drive root and then every component down to scratch, holding each with read and
    /// write sharing but no delete sharing, so none can be renamed, replaced or redirected while
    /// this worker runs. Returns "present", "absent" or "redirected" (also not a folder).
    public string Hold(string input)
    {
        Stage = "hold";
        if (input.IndexOf('\0') >= 0 || input.Length > 32000) return "redirected";
        string path = Path.GetFullPath(input);
        if (path.Length < 4 || path[1] != ':' || path[2] != '\\' || !Char.IsAsciiLetter(path[0]))
            return "redirected"; // Local drive paths only: no UNC, device or relative forms.
        string[] parts = path.Substring(3).TrimEnd('\\').Split('\\');
        foreach (string part in parts)
            if (part.Length == 0 || part.Contains(':') || part != part.TrimEnd(' ', '.'))
                return "redirected";
        var drive = CreateFileW(path.Substring(0, 3), 0x80000000, ShareReadWrite, IntPtr.Zero, 3,
            0x02200000, IntPtr.Zero); // GENERIC_READ; BACKUP_SEMANTICS | OPEN_REPARSE_POINT
        if (drive.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            drive.Dispose();
            throw new Win32Exception(error);
        }
        chain.Add(drive);
        foreach (string part in parts)
        {
            int status = OpenChild(chain[chain.Count - 1], part, GenericRead, ShareReadWrite,
                OpenOptions, out var handle);
            if (Missing(status)) return "absent";
            if (Redirected(status) || status == unchecked((int)0xC0000103)) return "redirected";
            if (status < 0) throw new Win32Exception(status);
            chain.Add(handle);
            var held = Read(handle);
            if (held.Reparse || !held.Directory) return "redirected";
        }
        root = chain[chain.Count - 1];
        return "present";
    }

    public void Run()
    {
        if (root == null) throw new InvalidOperationException("Scratch root is not held.");
        Walk(root, "", 0);
    }

    private void Skipped(string path, string reason)
    {
        skipped++;
        if (sample.Count < SampleLimit) sample.Add(new Skip { path = path, reason = reason });
        OnSkip?.Invoke(path, reason);
    }

    private void Stop(string point, string path)
    {
        if (Pause != null && !Pause(point, path)) throw new OperationCanceledException("Expiry stopped.");
    }

    // The folder at `directory` is held for the whole call: its children resolve inside it.
    private void Walk(SafeFileHandle directory, string relative, int depth)
    {
        Stage = "list";
        if (relative.Length != 0) Stop("list", relative);
        List<string> names;
        try { names = new List<string>(Names(directory)); }
        catch (Exception) when (relative.Length != 0)
        {
            Skipped(relative, "folder could not be read");
            return;
        }
        foreach (string name in names)
        {
            string path = relative.Length == 0 ? name : relative + "\\" + name;
            try { Entry(directory, name, path, depth); }
            catch (Win32Exception) { Skipped(path, "could not be read"); }
        }
    }

    private void Entry(SafeFileHandle directory, string name, string path, int depth)
    {
        Stage = "inspect";
        int status = OpenChild(directory, name, ReadAttributes | Synchronize, ShareAll,
            OpenOptions, out var probe);
        if (Missing(status)) { disappeared++; return; }
        if (Redirected(status)) { Skipped(path, "link, junction or reparse point, not followed"); return; }
        if (status < 0) { Skipped(path, "could not be read"); return; }
        Snapshot seen;
        using (probe) seen = Read(probe);
        if (seen.Reparse) { Skipped(path, "link, junction or reparse point, not followed"); return; }
        if (seen.Directory) { Folder(directory, name, path, depth, seen); return; }
        if (seen.Write >= cutoff) return;
        if (seen.Links != 1) { Skipped(path, "has other hard links, not removed"); return; }
        Stop("remove", path);
        Tally(path, Remove(directory, name, path, seen), false);
    }

    private void Folder(SafeFileHandle parent, string name, string path, int depth, Snapshot seen)
    {
        if (depth + 1 >= DepthLimit) { Skipped(path, "too deep, not followed"); return; }
        int status = OpenChild(parent, name, GenericRead, ShareReadWrite, OpenOptions | 1, out var held);
        if (Missing(status)) { disappeared++; return; }
        if (status < 0) { Skipped(path, "folder could not be read"); return; }
        Snapshot after;
        using (held)
        {
            var now = Read(held);
            if (now.Reparse || !now.Directory || !now.Same(seen))
            {
                Skipped(path, "changed during expiry");
                return;
            }
            Walk(held, path, depth + 1);
            // Member homes and shared stay even when empty: Summon advertises them in every prompt.
            if (depth == 0 || seen.Write >= cutoff) return;
            after = Read(held);
        }
        Stop("remove", path);
        Tally(path, Remove(parent, name, path, after), true);
    }

    private void Tally(string path, string result, bool directory)
    {
        if (result == "removed") { if (directory) removedDirectories++; else removedFiles++; }
        else if (result == "gone") disappeared++;
        else if (result == "in-use") Skipped(path, "in use or not permitted");
        else if (result == "reparse") Skipped(path, "reparse point, not followed or removed");
        else if (result == "changed") Skipped(path, "changed during expiry");
        else if (result == "failed") Skipped(path, "could not be removed");
    }

    // Exclusive open, full comparison with the expected record, then delete-on-close through that
    // handle. Folders compare against their record taken after their own contents were handled, so
    // a folder touched by anyone else since then is kept.
    private string Remove(SafeFileHandle parent, string name, string path, Snapshot expected)
    {
        Stage = "remove";
        uint options = OpenOptions | (expected.Directory ? 1u : 0x40u);
        int status = OpenChild(parent, name, Delete | ReadAttributes | Synchronize, 0, options,
            out var handle);
        if (Missing(status)) return "gone";
        if (Redirected(status)) return "reparse";
        if (status == unchecked((int)0xC0000043) || status == unchecked((int)0xC0000022)) return "in-use";
        if (status == unchecked((int)0xC0000103) || status == unchecked((int)0xC00000BA)) return "changed";
        if (status < 0) return "failed";
        using (handle)
        {
            var now = Read(handle);
            if (now.Reparse) return "reparse";
            if (!now.Unchanged(expected)) return "changed";
            Stage = "dispose";
            Stop("dispose", path);
            byte delete = 1;
            if (!SetFileInformationByHandle(handle, 4, ref delete, 1)) // FileDispositionInfo
            {
                int error = Marshal.GetLastWin32Error();
                if (error == 145) return "not-empty";
                return error == 5 ? "in-use" : "failed";
            }
        }
        // Closing performed the delete. Confirm the checked object no longer has this name.
        status = OpenChild(parent, name, ReadAttributes | Synchronize, ShareAll, OpenOptions, out var check);
        if (Missing(status)) return "removed";
        if (status < 0) return "failed";
        using (check) return Read(check).Same(expected) ? "failed" : "removed";
    }

    public object Report() => new { removedFiles, removedDirectories, disappeared, skipped, sample };

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

    public void Dispose()
    {
        for (int index = chain.Count - 1; index >= 0; index--) chain[index].Dispose();
        chain.Clear();
        root = null;
    }
}
