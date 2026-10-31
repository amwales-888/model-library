using System.Globalization;
using System.Text.RegularExpressions;

namespace Xandrite.Library.Scanning;

/// <summary>Something the walk found: a model file, an archive to look inside, or a problem.</summary>
public sealed record WalkItem
{
    public required string Path { get; init; }
    public long Size { get; init; }
    /// <summary>Modified time in milliseconds since 1970, computed exactly as Node.js does (see <see cref="FileTimes"/>).</summary>
    public double MtimeMs { get; init; }
    public bool IsArchive { get; init; }
    /// <summary>For a split archive with a part missing: what is wrong.</summary>
    public string? Incomplete { get; init; }
    /// <summary>How many files make up the archive (1 unless it is split).</summary>
    public int Parts { get; init; } = 1;
    /// <summary>Set when the folder or file could not be read.</summary>
    public string? Error { get; init; }
    public bool IsDirectory { get; init; }
}

/// <summary>
/// Walks a folder tree, as the Electron app's src/scanner.js does: yields every .stl and .3mf file and, if asked, every
/// archive (.zip, .7z, .rar) so its contents can be read. A problem with a folder or file is yielded instead of
/// stopping the walk.
///
/// Hidden files and folders (names starting with ".") are skipped: .git folders, trash folders, and the "._name.stl"
/// files macOS leaves on external drives. Symbolic links and junctions to folders are not followed, so a link that
/// points back up the tree cannot cause an endless loop. (Cloud placeholder files, such as OneDrive's, are read.)
/// </summary>
public static partial class FolderWalker
{
    public static readonly IReadOnlySet<string> ModelExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".stl", ".3mf" };
    public static readonly IReadOnlySet<string> ArchiveExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".zip", ".7z", ".rar" };

    // Split archives. 7-Zip opens a whole set from its first part, so only the first part counts as an archive:
    //   name.7z.001, name.7z.002 ...   name.rar.001 ...   name.part1.rar, name.part2.rar ...   name.rar, name.r00, name.r01 ...
    [GeneratedRegex(@"^(.*\.(?:7z|rar))\.(\d{3,})$", RegexOptions.IgnoreCase)]
    private static partial Regex Numbered();

    [GeneratedRegex(@"^(.*)\.part0*(\d+)\.rar$", RegexOptions.IgnoreCase)]
    private static partial Regex RarPart();

    [GeneratedRegex(@"^(.*)\.[rs]\d\d$", RegexOptions.IgnoreCase)]
    private static partial Regex OldRarVolume();

    internal enum SplitStyle { Numbered, Part }

    internal readonly record struct SplitRole(bool First, string Base, int Number, SplitStyle Style);

    /// <summary>What a file name says about split archives: the first part of a set, a later part, or nothing.</summary>
    internal static SplitRole? GetSplitRole(string name)
    {
        var m = Numbered().Match(name);
        if (m.Success)
        {
            int n = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
            return new SplitRole(n == 1, m.Groups[1].Value, n, SplitStyle.Numbered);
        }
        m = RarPart().Match(name);
        if (m.Success)
        {
            int n = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
            return new SplitRole(n == 1, m.Groups[1].Value, n, SplitStyle.Part);
        }
        return null;
    }

    /// <summary>
    /// The files that make up the archive whose first part is <paramref name="name"/>, found among the names in the
    /// same folder, and what is wrong with the set (a missing part), if anything. A plain archive is a set of one.
    /// </summary>
    internal static (List<string> Files, string? Problem) ArchiveParts(string name, IReadOnlyList<string> names)
    {
        var found = new List<string> { name };
        string? problem = null;
        var role = GetSplitRole(name);
        if (role is { Style: SplitStyle.Numbered } numbered)
        {
            var lower = names.GroupBy(n => n.ToLowerInvariant()).ToDictionary(g => g.Key, g => g.First());
            int width = Numbered().Match(name).Groups[2].Value.Length;
            for (int n = 2; ; n++)
            {
                string next = (numbered.Base + "." + n.ToString(CultureInfo.InvariantCulture).PadLeft(width, '0')).ToLowerInvariant();
                if (!lower.TryGetValue(next, out var actual)) break;
                found.Add(actual);
            }
            int highest = 1;
            foreach (var other in names)
            {
                var m = Numbered().Match(other);
                if (m.Success && string.Equals(m.Groups[1].Value, numbered.Base, StringComparison.OrdinalIgnoreCase))
                    highest = Math.Max(highest, int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture));
            }
            if (highest > found.Count) problem = $"part {found.Count + 1} of this split archive is missing";
        }
        else if (role is { Style: SplitStyle.Part } part)
        {
            var parts = new Dictionary<int, string>();
            foreach (var other in names)
            {
                var m = RarPart().Match(other);
                if (m.Success && string.Equals(m.Groups[1].Value, part.Base, StringComparison.OrdinalIgnoreCase))
                    parts[int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture)] = other;
            }
            for (int n = 2; parts.TryGetValue(n, out var next); n++) found.Add(next);
            int highest = parts.Keys.Max();
            if (highest > found.Count) problem = $"part {found.Count + 1} of this split archive is missing";
        }
        else if (name.EndsWith(".rar", StringComparison.OrdinalIgnoreCase))
        {
            string baseName = name[..^4];
            foreach (var other in names)
            {
                var m = OldRarVolume().Match(other);
                if (m.Success && string.Equals(m.Groups[1].Value, baseName, StringComparison.OrdinalIgnoreCase)) found.Add(other);
            }
            var volumes = found.Skip(1).OrderBy(x => x, StringComparer.CurrentCulture).ToList();
            found = [name, .. volumes];
        }
        return (found, problem);
    }

    /// <summary>Is this the file to open for an archive? Later parts of a split set are not archives of their own.</summary>
    internal static bool IsArchiveEntryPoint(string name) =>
        GetSplitRole(name) is { } role ? role.First : ArchiveExtensions.Contains(System.IO.Path.GetExtension(name));

    private static bool IsModel(string name) => ModelExtensions.Contains(System.IO.Path.GetExtension(name));

    public static IEnumerable<WalkItem> Walk(string root, bool includeArchives, CancellationToken cancellation = default)
    {
        var queue = new List<string> { root };
        for (int i = 0; i < queue.Count; i++)
        {
            if (cancellation.IsCancellationRequested) yield break;
            string dir = queue[i];

            List<FileSystemInfo> entries;
            string? failure = null;
            try
            {
                entries = new DirectoryInfo(dir).EnumerateFileSystemInfos("*", new EnumerationOptions
                {
                    AttributesToSkip = 0,                 // hidden and system files are judged by name below, as in the JS app
                    IgnoreInaccessible = false,
                    RecurseSubdirectories = false,
                    ReturnSpecialDirectories = false,
                }).ToList();
                entries.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.CurrentCulture));
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Security.SecurityException)
            {
                entries = [];
                failure = e.Message;
            }
            if (failure is not null)
            {
                yield return new WalkItem { Path = dir, Error = failure, IsDirectory = true };
                continue;
            }

            var fileNames = entries.Where(e => e is FileInfo).Select(e => e.Name).ToList();
            foreach (var entry in entries)
            {
                if (entry.Name.StartsWith('.')) continue;
                if (entry is DirectoryInfo)
                {
                    if (IsLink(entry)) continue;
                    queue.Add(entry.FullName);
                    continue;
                }
                if (entry is not FileInfo file || IsLink(file)) continue;

                if (includeArchives && GetSplitRole(file.Name) is { First: false } later)
                {
                    // A later part whose first part is not in the folder: the set cannot be opened.
                    bool hasFirst = fileNames.Any(n => GetSplitRole(n) is { First: true } r
                        && string.Equals(r.Base, later.Base, StringComparison.OrdinalIgnoreCase) && r.Style == later.Style);
                    if (!hasFirst) yield return new WalkItem { Path = file.FullName, Error = "the first part of this split archive is missing" };
                    continue;
                }

                bool model = IsModel(file.Name);
                if (!model && !(includeArchives && IsArchiveEntryPoint(file.Name))) continue;

                WalkItem item;
                try
                {
                    if (model)
                    {
                        file.Refresh();
                        item = new WalkItem { Path = file.FullName, Size = file.Length, MtimeMs = FileTimes.ToNodeMs(file.LastWriteTimeUtc) };
                    }
                    else
                    {
                        var (parts, problem) = ArchiveParts(file.Name, fileNames);
                        long size = 0;
                        double mtime = double.MinValue;
                        foreach (var part in parts)
                        {
                            var info = new FileInfo(System.IO.Path.Combine(dir, part));
                            size += info.Length;                                       // a changed or replaced part changes these,
                            mtime = Math.Max(mtime, FileTimes.ToNodeMs(info.LastWriteTimeUtc));   // so the archive is looked at again
                        }
                        item = new WalkItem { Path = file.FullName, Size = size, MtimeMs = mtime, IsArchive = true, Incomplete = problem, Parts = parts.Count };
                    }
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                    item = new WalkItem { Path = file.FullName, Error = e.Message };
                }
                yield return item;
            }
        }
    }

    /// <summary>A symbolic link or junction (followed links could loop). Other reparse points, such as cloud files, are fine.</summary>
    private static bool IsLink(FileSystemInfo entry) =>
        (entry.Attributes & FileAttributes.ReparsePoint) != 0 && entry.LinkTarget is not null;
}

/// <summary>File times as the Electron app stored them.</summary>
public static class FileTimes
{
    /// <summary>
    /// Milliseconds since 1970, worked out the way Node.js does on Windows (libuv splits the file time into seconds and
    /// nanoseconds; Node computes sec * 1000 + nsec / 1e6). Doing the same arithmetic gives the exact same double, so an
    /// unchanged file in a library made by the Electron app is recognised and not read again.
    /// </summary>
    public static double ToNodeMs(DateTime utc)
    {
        long ticks = utc.ToUniversalTime().Ticks - DateTime.UnixEpoch.Ticks;   // 100 ns units since 1970
        long seconds = ticks / TimeSpan.TicksPerSecond;
        long nanoseconds = ticks % TimeSpan.TicksPerSecond * 100;
        return seconds * 1e3 + nanoseconds / 1e6;
    }
}
