using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using Xandrite.Library.Scanning;

namespace Xandrite.Library.Tests;

/// <summary>A library in a temporary folder: model files on disk, a database next to them, and a scanner.</summary>
internal sealed class TempLibrary : IDisposable
{
    public TempLibrary()
    {
        Dir = Path.Combine(Path.GetTempPath(), "xandrite-test-" + Guid.NewGuid().ToString("N"));
        Root = Path.Combine(Dir, "models");
        Directory.CreateDirectory(Root);
        Db = new LibraryDatabase(Path.Combine(Dir, "library.sqlite"));
        Db.AddRoot(Root);
    }

    public string Dir { get; }
    public string Root { get; }
    public LibraryDatabase Db { get; }

    public string At(string relative) => Path.Combine(Root, relative.Replace('/', Path.DirectorySeparatorChar));

    public string Write(string relative, string content, DateTime? modified = null)
    {
        string path = At(relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
        if (modified is { } m) File.SetLastWriteTimeUtc(path, m);
        return path;
    }

    /// <summary>Writes a zip holding the given entries (name → text).</summary>
    public string WriteZip(string relative, IDictionary<string, string> entries)
    {
        string path = At(relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.Delete(path);
        using (var zip = ZipFile.Open(path, ZipArchiveMode.Create))
        {
            foreach (var (name, text) in entries)
            {
                var entry = zip.CreateEntry(name);
                entry.LastWriteTime = new DateTimeOffset(2024, 1, 2, 3, 4, 6, TimeSpan.Zero);
                using var s = entry.Open();
                s.Write(Encoding.UTF8.GetBytes(text));
            }
        }
        return path;
    }

    public void Delete(string relative) => File.Delete(At(relative));

    public void Move(string from, string to)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(At(to))!);
        File.Move(At(from), At(to));
    }

    public Task<ScanSummary> Scan(bool includeArchives = true, CancellationToken cancellation = default, ArchiveLimits? limits = null) =>
        new LibraryScanner(Db) { Limits = limits ?? ArchiveLimits.Default }.ScanAsync(Root, includeArchives, null, cancellation);

    public IReadOnlyList<LocationRow> All() => Db.List(new ListQuery { Limit = 10_000 }).Rows;

    public IReadOnlyList<LocationRow> Present() => Db.List(new ListQuery { Limit = 10_000, IncludeMissing = false }).Rows;

    public static string Sha(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));

    public void Dispose()
    {
        Db.Dispose();
        try { Directory.Delete(Dir, recursive: true); } catch (IOException) { }
    }
}
