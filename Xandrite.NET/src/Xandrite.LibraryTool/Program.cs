using System.Diagnostics;
using Xandrite;
using Xandrite.Library;
using Xandrite.Library.Scanning;
using Xandrite.Library.Sqlite;

// xandrite-lib: look at or build a library from the command line.
//
//   xandrite-lib info [library.sqlite]               Summary of a library. Works on a temporary copy, never the original.
//   xandrite-lib scan <folder>... --db <file.sqlite> Adds the folders to that library and scans them.

const string Usage = """
    Usage:
      xandrite-lib info [library.sqlite]
          Shows what is in a library. Without a file, the Electron app's library is used
          (%APPDATA%\xandrite\library.sqlite). It reads a temporary copy, so the original is never changed.

      xandrite-lib scan <folder>... --db <library.sqlite> [--no-archives]
          Adds the folders to that library (created if needed) and scans them. Run it twice to see a rescan.
    """;

try
{
    return args switch
    {
        ["info"] => Info(DefaultLibrary()),
        ["info", var file] => Info(file),
        ["scan", .. var rest] => await Scan(rest),
        ["-h" or "--help" or "/?"] => Help(0),
        _ => Help(2),
    };
}
catch (Exception e) when (e is IOException or SqliteException or DllNotFoundException or UnauthorizedAccessException)
{
    Console.Error.WriteLine(e.Message);
    return 1;
}

static int Help(int code)
{
    (code == 0 ? Console.Out : Console.Error).WriteLine(Usage);
    return code;
}

static string DefaultLibrary() =>
    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "xandrite", "library.sqlite");

static int Info(string file)
{
    if (!File.Exists(file))
    {
        Console.Error.WriteLine("No library at " + file);
        return 1;
    }

    // Copy the database (and its write-ahead log, which may hold recent changes) and open the copy.
    string temp = Path.Combine(Path.GetTempPath(), "xandrite-info-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(temp);
    string copy = Path.Combine(temp, "library.sqlite");
    foreach (var suffix in new[] { "", "-wal" })
    {
        if (File.Exists(file + suffix))
        {
            using var source = new FileStream(file + suffix, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var target = File.Create(copy + suffix);
            source.CopyTo(target);
        }
    }

    try
    {
        using var db = new LibraryDatabase(copy);
        Console.WriteLine($"Library   {file}");
        Console.WriteLine($"SQLite    {SqliteConnection.Version}");
        var stats = db.GetStats();
        Console.WriteLine($"Files     {stats.Files:N0} present, {stats.Missing:N0} missing, {stats.UniqueModels:N0} distinct models, {stats.DuplicateGroups:N0} with copies");
        var current = db.GetThumbnailCounts(Look.RenderVersion);
        var electron = db.GetThumbnailCounts(1);
        Console.WriteLine($"Thumbnails for this renderer (version {Look.RenderVersion}): {current.Ok:N0} done, {current.Failed:N0} failed, {current.Pending:N0} to draw");
        Console.WriteLine($"           as the Electron app saw them (version 1): {electron.Ok:N0} done, {electron.Failed:N0} failed, {electron.Pending:N0} to draw");
        long rated = db.Locked(c => c.Scalar("SELECT COUNT(*) FROM ratings"));
        long views = db.Locked(c => c.Scalar("SELECT COUNT(*) FROM views"));
        long archived = db.Locked(c => c.Scalar("SELECT COUNT(*) FROM locations WHERE container IS NOT NULL AND missing = 0"));
        Console.WriteLine($"Ratings   {rated:N0}    Saved views {views:N0}    Models inside archives {archived:N0}");
        Console.WriteLine("Folders:");
        foreach (var root in db.GetRoots())
        {
            string when = root.LastScannedAt is { } t ? DateTimeOffset.FromUnixTimeMilliseconds(t).LocalDateTime.ToString("g") : "never";
            Console.WriteLine($"  {root.Path}  ({root.Files:N0} files, last scanned {when})");
        }
        var newest = db.List(new ListQuery { Sort = SortOrder.Added, Limit = 5, IncludeMissing = false }).Rows;
        if (newest.Count > 0)
        {
            Console.WriteLine("Most recently added:");
            foreach (var row in newest) Console.WriteLine($"  {row.Name}  {(row.ArchiveName is { } a ? "(in " + a + ") " : "")}{row.Size:N0} bytes");
        }
        return 0;
    }
    finally
    {
        try { Directory.Delete(temp, recursive: true); } catch (IOException) { }
    }
}

static async Task<int> Scan(string[] rest)
{
    string? dbFile = null;
    bool archives = true;
    var folders = new List<string>();
    for (int i = 0; i < rest.Length; i++)
    {
        switch (rest[i])
        {
            case "--db" when i + 1 < rest.Length: dbFile = rest[++i]; break;
            case "--no-archives": archives = false; break;
            default: folders.Add(Path.GetFullPath(rest[i])); break;
        }
    }
    if (dbFile is null || folders.Count == 0) return Help(2);
    if (Path.GetFullPath(dbFile).Equals(Path.GetFullPath(DefaultLibrary()), StringComparison.OrdinalIgnoreCase))
    {
        Console.Error.WriteLine("Not scanning into the Electron app's own library. Give another --db file (or a copy).");
        return 2;
    }

    using var db = new LibraryDatabase(dbFile);
    var scanner = new LibraryScanner(db);
    var lastShown = Stopwatch.StartNew();
    foreach (var folder in folders)
    {
        db.AddRoot(folder);
        var summary = await scanner.ScanAsync(folder, archives, p =>
        {
            if (lastShown.ElapsedMilliseconds < 250) return;
            lastShown.Restart();
            Console.Write($"\r  {p.Found:N0} found, {p.Hashed:N0} read, {p.Reused:N0} unchanged, {p.Errors:N0} problems   ");
        });
        Console.WriteLine($"\r{folder}");
        Console.WriteLine($"  {summary.Found:N0} found: {summary.Hashed:N0} read, {summary.Reused:N0} unchanged. " +
                          $"{summary.Added:N0} new, {summary.Moved:N0} moved, {summary.Missing:N0} missing, {summary.DuplicateGroups:N0} with copies, " +
                          $"{summary.Archives:N0} archives. {summary.DurationMs / 1000.0:0.0} s");
        foreach (var problem in summary.Problems) Console.WriteLine($"  problem: {problem.Path}: {problem.Message}");
        if (summary.Errors > summary.Problems.Count) Console.WriteLine($"  ... and {summary.Errors - summary.Problems.Count:N0} more problems");
    }
    return 0;
}
