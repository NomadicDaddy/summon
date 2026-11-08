using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

// The same process holds the guards AND performs every content/metadata access.
// Worker termination therefore cannot leave an unguarded reader behind.
public sealed partial class RetentionPathGuard : IDisposable
{
    public string Stage { get; private set; } = "initializing";
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access,
        uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file,
        out FileInformation information);

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
        public System.Runtime.InteropServices.ComTypes.FILETIME Access;
        public System.Runtime.InteropServices.ComTypes.FILETIME Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    private readonly Dictionary<string, SafeFileHandle> handles =
        new Dictionary<string, SafeFileHandle>(StringComparer.OrdinalIgnoreCase);

    public sealed class Entry
    {
        public string path, section, identity;
        public long bytes;
        public double mtimeMs;
        public bool plain;
        public string sha256;
    }

    private static FileInformation Info(SafeFileHandle handle)
    {
        if (!GetFileInformationByHandle(handle, out var info))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return info;
    }

    private static long Size(FileInformation info) => ((long)info.SizeHigh << 32) | info.SizeLow;
    private static string Identity(FileInformation info) =>
        $"{info.Volume}:{info.IndexHigh}:{info.IndexLow}:{info.Creation.dwHighDateTime}:{info.Creation.dwLowDateTime}";
    private static double Mtime(FileInformation info) =>
        DateTime.FromFileTimeUtc(((long)(uint)info.Write.dwHighDateTime << 32) |
            (uint)info.Write.dwLowDateTime).Subtract(DateTime.UnixEpoch).TotalMilliseconds;
    private static bool Plain(FileInformation info) =>
        (info.Attributes & (0x400 | 0x10)) == 0 && info.Links == 1;

    private static byte[] ReadStable(SafeFileHandle handle, FileInformation before)
    {
        if (!Plain(before) || Size(before) > 1000000)
            throw new IOException("Plain input of at most 1000000 bytes required.");
        using var stream = new FileStream(handle, FileAccess.Read);
        var bytes = new byte[(int)Size(before) + 1];
        int length = 0, count;
        while (length < bytes.Length && (count = stream.Read(bytes, length, bytes.Length - length)) != 0)
            length += count;
        var after = Info(handle);
        if (length != Size(before) || Size(after) != Size(before) ||
            Identity(after) != Identity(before) || Mtime(after) != Mtime(before) || !Plain(after))
            throw new IOException("Input changed while reading.");
        Array.Resize(ref bytes, length);
        return bytes;
    }

    // Called only after the caller's public/own check under the held guards.
    public object Observe(string root, bool[] present, string pins, int offset)
    {
        if (present[0] && (Info(handles[Path.GetFullPath(root)]).Attributes & 0x10) == 0)
            throw new IOException("Mailbox root is not a directory.");
        var entries = new List<Entry>();
        var errors = new List<string>();
        int inspected = 0, errorCount = 0;
        bool complete = true;
        string[] sections = present.Length >= 7
            ? new[] { "inbox", "archive", "delivery", "holds", "sent-status", "delivery/pending-read" }
            : new[] { "inbox", "archive", "delivery", "holds" };
        for (int index = 0; index < sections.Length && inspected < 20000; index++)
        {
            if (!present[index + 1]) continue; // Never access a formerly missing path.
            string section = sections[index];
            var directory = handles[Path.GetFullPath(Path.Combine(root, section))];
            if ((Info(directory).Attributes & 0x400) != 0)
                throw new IOException("Retained section became a reparse object.");
            foreach (string name in Names(directory))
            {
                if (inspected == 20000) { complete = false; break; }
                inspected++;
                string relative = section + "/" + name;
                if (section == "delivery" && name == "pending-read" && present.Length >= 7)
                {
                    if (!present[6]) complete = false;
                    continue; // The held child is inventoried as its own section below.
                }
                try
                {
                    using var handle = OpenChild(directory, name);
                    var info = Info(handle);
                    if ((info.Attributes & (0x400 | 0x10)) != 0) complete = false;
                    entries.Add(new Entry { path = relative, section = section, bytes = Size(info),
                        identity = Identity(info), mtimeMs = Mtime(info), plain = Plain(info) });
                }
                catch { complete = false; errorCount++; if (errors.Count < 20) errors.Add(relative); }
            }
        }
        if (inspected == 20000) complete = false;
        entries.Sort((left, right) => StringComparer.Ordinal.Compare(left.path, right.path));
        foreach (var entry in entries.GetRange(Math.Min(offset, entries.Count),
            Math.Min(10, Math.Max(0, entries.Count - offset))))
        {
            if (!entry.plain || entry.bytes > 1000000) continue;
            try
            {
                var directory = handles[Path.GetFullPath(Path.Combine(root, entry.section))];
                using var handle = OpenChild(directory, entry.path.Substring(entry.section.Length + 1), 1);
                var info = Info(handle);
                if (Identity(info) != entry.identity || Size(info) != entry.bytes || Mtime(info) != entry.mtimeMs)
                    continue;
                entry.sha256 = Convert.ToHexString(SHA256.HashData(ReadStable(handle, info))).ToLowerInvariant();
            }
            catch { entry.sha256 = null; }
        }
        string pinBody = null;
        if (!String.IsNullOrEmpty(pins))
        {
            var handle = handles[Path.GetFullPath(pins)];
            pinBody = Convert.ToBase64String(ReadStable(handle, Info(handle)));
        }
        return new { entries, complete, errors, errorCount, inspectedEntries = inspected, pinBody };
    }

    public bool Hold(string input)
    {
        // Reject UNC, device paths, ADS, and Win32-normalized aliases.
        if (input.IndexOf('\0') >= 0 || input.Length > 32000)
            throw new IOException("Unsupported retention path.");
        string path = Path.GetFullPath(input);
        if (path.Length < 3 || path[1] != ':' || path[2] != '\\' ||
            !Char.IsAsciiLetter(path[0]))
            throw new IOException("Only local drive retention paths are supported.");
        foreach (string part in path.Substring(3).Split('\\'))
            if (part.Contains(':') || part != part.TrimEnd(' ', '.'))
                throw new IOException("Unsupported retention path component.");

        var chain = new Stack<string>();
        for (string current = path; current != null; current = Path.GetDirectoryName(current))
        {
            chain.Push(current);
            if (chain.Count > 256) throw new IOException("Retention path is too deep.");
        }
        string parent = null;
        int depth = 0;
        while (chain.Count != 0)
        {
            string current = chain.Pop();
            Stage = "ancestor-open-depth-" + depth++;
            if (handles.TryGetValue(current, out var existing))
            {
                if ((Info(existing).Attributes & 0x400) != 0 ||
                    (chain.Count != 0 && (Info(existing).Attributes & 0x10) == 0))
                    throw new IOException("Retention ancestor is not a directory.");
                parent = current;
                continue;
            }
            // GENERIC_READ (not attributes-only: Windows skips sharing checks
            // for some metadata-only opens), READ|WRITE sharing, no DELETE.
            // FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT.
            SafeFileHandle handle;
            if (parent != null)
            {
                try { handle = OpenChild(handles[parent], Path.GetFileName(current)); }
                catch (RelativeOpenException error) when (error.Status == unchecked((int)0xC0000034) ||
                    error.Status == unchecked((int)0xC000003A))
                { return false; }
            }
            else handle = CreateFileW(current, 0x80000000, 3, IntPtr.Zero, 3,
                0x02200000, IntPtr.Zero);
            if (handle.IsInvalid)
            {
                int error = Marshal.GetLastWin32Error();
                handle.Dispose();
                if (error == 2 || error == 3) return false;
                throw new Win32Exception(error);
            }
            try
            {
                if (!GetFileInformationByHandle(handle, out var info))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                if ((info.Attributes & 0x400) != 0)
                    throw new IOException("Redirected maintenance path refused.");
                if (chain.Count != 0 && (info.Attributes & 0x10) == 0)
                    throw new IOException("Retention ancestor is not a directory.");
                if ((info.Attributes & 0x10) == 0)
                {
                    var strict = OpenChild(handles[parent], Path.GetFileName(current), 1);
                    if (Identity(Info(strict)) != Identity(info))
                    { strict.Dispose(); throw new IOException("Retention input changed."); }
                    handle.Dispose();
                    handle = strict;
                }
                handles.Add(current, handle);
                parent = current;
            }
            catch { handle.Dispose(); throw; }
        }
        return true;
    }

    public void Dispose()
    {
        foreach (var handle in handles.Values) handle.Dispose();
        handles.Clear();
    }
}
