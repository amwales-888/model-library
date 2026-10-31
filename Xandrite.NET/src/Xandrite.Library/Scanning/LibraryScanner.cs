using System.Diagnostics;

namespace Xandrite.Library.Scanning;

public sealed record ScanProgress(int Found, int Hashed, int Reused, int Errors, string? Current);

public sealed record ScanProblem(string Path, string Message);

public sealed record ScanSummary
{
    public required string Root { get; init; }
    public bool Cancelled { get; init; }
    public int Found { get; init; }
    public int Hashed { get; init; }
    /// <summary>Files recognised as unchanged and not read again.</summary>
    public int Reused { get; init; }
    public long Added { get; init; }
    public long Moved { get; init; }
    public int Missing { get; init; }
    /// <summary>True when files were not marked missing because a folder could not be read.</summary>
    public bool MissingSkipped { get; init; }
    public long DuplicateGroups { get; init; }
    public int Archives { get; init; }
    public int NestedArchives { get; init; }
    public int Errors { get; init; }
    /// <summary>The first 50 problems.</summary>
    public IReadOnlyList<ScanProblem> Problems { get; init; } = [];
    public long DurationMs { get; init; }
}

/// <summary>
/// Scans one root folder and brings the database up to date. A port of the Electron app's src/indexer.js.
///
///  - A file whose path, size and modified time match what is stored is NOT read again. That is what makes a rescan
///    of thousands of files take seconds.
///  - Any other file is hashed and stored under its SHA-256. Models inside archives are hashed from their
///    decompressed bytes, so a model has the same SHA-256 loose or zipped.
///  - Files stored before but no longer found are marked missing, not deleted. If their content turns up elsewhere,
///    that is a "moved" file, and the SHA (and so the thumbnail) stays attached.
///  - If the scan is cancelled, or a folder cannot be read, nothing is marked missing.
/// </summary>
public sealed class LibraryScanner(LibraryDatabase db, ModelSource? source = null)
{
    private readonly ModelSource _source = source ?? ModelSource.Default;

    /// <summary>How many files are hashed at the same time.</summary>
    public int Concurrency { get; init; } = 4;

    public ArchiveLimits Limits { get; init; } = ArchiveLimits.Default;

    public Task<ScanSummary> ScanAsync(string root, bool includeArchives = true, Action<ScanProgress>? onProgress = null, CancellationToken cancellation = default) =>
        Task.Run(() => ScanCoreAsync(root, includeArchives, onProgress, cancellation), CancellationToken.None);

    private sealed class Counts
    {
        public int Found, Hashed, Reused, Errors, Archives, Nested, DirectoryErrors;
        public readonly List<ScanProblem> Problems = [];
    }

    private async Task<ScanSummary> ScanCoreAsync(string root, bool includeArchives, Action<ScanProgress>? onProgress, CancellationToken cancellation)
    {
        if (!Directory.Exists(root)) throw new DirectoryNotFoundException("Not a folder: " + root);

        var clock = Stopwatch.StartNew();
        // The scan's id is its start time, as in the JS app, but always later than any earlier scan, so two scans in the
        // same millisecond cannot be confused (which would spoil the "new" and "missing" counts).
        long scanId = Math.Max(db.Now(), db.Locked(c => c.Scalar("SELECT COALESCE(MAX(last_seen_scan), 0) FROM locations")) + 1);
        var counts = new Counts();

        void Report(string? current)
        {
            if (onProgress is null) return;
            ScanProgress progress;
            lock (counts) progress = new ScanProgress(counts.Found, counts.Hashed, counts.Reused, counts.Errors, current);
            onProgress(progress);
        }
        void Problem(string path, string message, bool directory = false)
        {
            lock (counts)
            {
                counts.Errors++;
                if (directory) counts.DirectoryErrors++;
                if (counts.Problems.Count < 50) counts.Problems.Add(new ScanProblem(path, message));
            }
        }
        void Count(Action<Counts> change)
        {
            lock (counts) change(counts);
        }

        const string MarkSeen = "UPDATE locations SET last_seen_scan = ?, missing = 0 WHERE path = ?";
        const string InsertModel = "INSERT OR IGNORE INTO models(sha256, size, format, first_seen_at) VALUES (?, ?, ?, ?)";
        const string UpsertLocation = """
            INSERT INTO locations(path, root, sha256, size, mtime_ms, last_seen_scan, added_scan, missing, container, entry, crc32)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
              sha256 = excluded.sha256, size = excluded.size, mtime_ms = excluded.mtime_ms,
              last_seen_scan = excluded.last_seen_scan, missing = 0,
              container = excluded.container, entry = excluded.entry, crc32 = excluded.crc32
            """;
        const string MarkContainerSeen = "UPDATE locations SET last_seen_scan = ? WHERE container = ? AND missing = 0";
        const string SaveContainer = """
            INSERT INTO containers(path, root, size, mtime_ms, last_seen_scan) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET root = excluded.root, size = excluded.size, mtime_ms = excluded.mtime_ms, last_seen_scan = excluded.last_seen_scan
            """;
        const string TouchContainer = "UPDATE containers SET last_seen_scan = ? WHERE path = ?";

        void Store(string path, string sha, long size, string format, double mtimeMs, string? container, string? entry, long? crc) =>
            db.Locked(c =>
            {
                c.Execute(InsertModel, sha, size, format, db.Now());
                c.Execute(UpsertLocation, path, root, sha, size, mtimeMs, scanId, scanId, container, entry, crc);
            });

        async Task HashAndStore(WalkItem item)
        {
            try
            {
                string sha = await Hashing.HashFileAsync(item.Path, cancellation);
                Store(item.Path, sha, item.Size, Path.GetExtension(item.Path)[1..].ToLowerInvariant(), item.MtimeMs, null, null, null);
                Count(c => c.Hashed++);
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
            {
                return;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // A file that could not be read (locked, permission denied) keeps its old record instead of going missing.
                db.Locked(c => c.Execute(MarkSeen, scanId, item.Path));
                Problem(item.Path, e.Message);
            }
            Report(item.Path);
        }

        // Every model entry is hashed from its decompressed bytes. Entries whose size and checksum are unchanged are not
        // read again. (The JS app also compared entry dates; .NET reads zip dates slightly differently, and the CRC-32
        // already tells whether the content changed.)
        async Task ScanArchive(WalkItem item, IArchiveReader reader)
        {
            bool clean = true;
            try
            {
                int nested = await reader.EachModelEntryAsync(item.Path,
                    async entry =>
                    {
                        Count(c => c.Found++);
                        string virtualPath = ArchiveEntryNames.VirtualPath(item.Path, entry.EntryName);
                        var known = db.Locked(c => c.QueryFirst("SELECT size, crc32 FROM locations WHERE path = ?",
                            r => (Size: r.GetInt64(0), Crc: r.GetInt64OrNull(1)), virtualPath));
                        if (known.Crc is { } crc && known.Size == entry.Size && crc == entry.Crc32)
                        {
                            db.Locked(c => c.Execute(MarkSeen, scanId, virtualPath));
                            Count(c => c.Reused++);
                            Report(virtualPath);
                            return;
                        }
                        try
                        {
                            string sha;
                            await using (var stream = entry.Open()) sha = await Hashing.HashStreamAsync(stream, cancellation);
                            Store(virtualPath, sha, entry.Size, entry.Format, entry.MtimeMs, item.Path, entry.EntryName, entry.Crc32);
                            Count(c => c.Hashed++);
                        }
                        catch (Exception e) when (e is IOException or InvalidDataException)
                        {
                            clean = false;
                            db.Locked(c => c.Execute(MarkSeen, scanId, virtualPath));   // keep any old record instead of marking it missing
                            Problem(virtualPath, e.Message);
                        }
                        Report(virtualPath);
                    },
                    (entryName, message) => Problem(ArchiveEntryNames.VirtualPath(item.Path, entryName), message),
                    Limits, cancellation);
                Count(c => { c.Nested += nested; c.Archives++; });
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
            {
                return;
            }
            catch (Exception e) when (e is IOException or InvalidDataException or UnauthorizedAccessException or NotSupportedException)
            {
                clean = false;
                db.Locked(c => c.Execute(MarkContainerSeen, scanId, item.Path));   // an unreadable archive keeps its old records
                Problem(item.Path, "could not read this archive: " + e.Message);
            }
            // A clean read is remembered, so an unchanged archive is not opened again; otherwise it is looked at next scan.
            db.Locked(c => c.Execute(clean ? SaveContainer : TouchContainer, clean ? [item.Path, root, item.Size, item.MtimeMs, scanId] : [scanId, item.Path]));
            Report(item.Path);
        }

        var inflight = new List<Task>();
        async Task Launch(Task job)
        {
            inflight.Add(job);
            if (inflight.Count >= Concurrency)
            {
                var done = await Task.WhenAny(inflight);
                inflight.Remove(done);
                await done;
            }
        }

        foreach (var item in FolderWalker.Walk(root, includeArchives, cancellation))
        {
            if (item.Error is not null)
            {
                Problem(item.Path, item.Error, item.IsDirectory);
                Report(item.Path);
                continue;
            }

            if (item.IsArchive)
            {
                if (item.Incomplete is not null)
                {
                    db.Locked(c => c.Execute(MarkContainerSeen, scanId, item.Path));   // keep what is known about an incomplete set
                    Problem(item.Path, "could not read this archive: " + item.Incomplete);
                    Report(item.Path);
                    continue;
                }
                var reader = _source.ReaderFor(item.Path);
                if (reader is null)
                {
                    // .7z and .rar: reading them needs 7-Zip, which is not wired in yet. Keep their models as they are.
                    db.Locked(c => c.Execute(MarkContainerSeen, scanId, item.Path));
                    Problem(item.Path, "could not read this archive: reading " + Path.GetExtension(item.Path) + " archives is not available yet");
                    Report(item.Path);
                    continue;
                }
                var stored = db.Locked(c => c.QueryFirst("SELECT size, mtime_ms FROM containers WHERE path = ?",
                    r => (Size: r.GetInt64(0), Mtime: r.GetDouble(1), Known: true), item.Path));
                if (stored.Known && stored.Size == item.Size && stored.Mtime == item.MtimeMs)
                {
                    int n = db.Locked(c =>
                    {
                        int changed = c.Execute(MarkContainerSeen, scanId, item.Path);
                        c.Execute(TouchContainer, scanId, item.Path);
                        return changed;
                    });
                    Count(c => { c.Found += n; c.Reused += n; c.Archives++; });
                    Report(item.Path);
                    continue;
                }
                await Launch(ScanArchive(item, reader));
                continue;
            }

            Count(c => c.Found++);
            var known = db.Locked(c => c.QueryFirst("SELECT size, mtime_ms FROM locations WHERE path = ?",
                r => (Size: r.GetInt64(0), Mtime: r.GetDouble(1), Known: true), item.Path));
            if (known.Known && known.Size == item.Size && known.Mtime == item.MtimeMs)
            {
                db.Locked(c => c.Execute(MarkSeen, scanId, item.Path));
                Count(c => c.Reused++);
                Report(item.Path);
                continue;
            }
            await Launch(HashAndStore(item));
        }
        await Task.WhenAll(inflight);

        bool cancelled = cancellation.IsCancellationRequested;
        int missing = 0;
        return db.Locked(c =>
        {
            // Only mark files missing after a complete, clean scan; a partial scan would make files look deleted.
            if (!cancelled && counts.DirectoryErrors == 0)
            {
                missing = c.Execute("UPDATE locations SET missing = 1 WHERE root = ? AND last_seen_scan <> ? AND missing = 0", root, scanId);
                c.Execute("DELETE FROM containers WHERE root = ? AND last_seen_scan <> ?", root, scanId);   // archives that are gone
            }
            if (!cancelled) c.Execute("UPDATE roots SET last_scanned_at = ? WHERE path = ?", db.Now(), root);

            long added = c.Scalar("SELECT COUNT(*) FROM locations WHERE root = ? AND added_scan = ?", root, scanId);
            // A "moved" file is new at this scan, and the same content has a location that is now missing.
            long moved = c.Scalar("""
                SELECT COUNT(DISTINCT n.sha256)
                FROM locations n JOIN locations o ON o.sha256 = n.sha256 AND o.path <> n.path
                WHERE n.root = ? AND n.added_scan = ? AND o.missing = 1
                """, root, scanId);
            long duplicates = c.Scalar("SELECT COUNT(*) FROM (SELECT 1 FROM locations WHERE root = ? AND missing = 0 GROUP BY sha256 HAVING COUNT(*) > 1)", root);

            lock (counts)
            {
                return new ScanSummary
                {
                    Root = root,
                    Cancelled = cancelled,
                    Found = counts.Found,
                    Hashed = counts.Hashed,
                    Reused = counts.Reused,
                    Added = added,
                    Moved = moved,
                    Missing = missing,
                    MissingSkipped = !cancelled && counts.DirectoryErrors > 0,
                    DuplicateGroups = duplicates,
                    Archives = counts.Archives,
                    NestedArchives = counts.Nested,
                    Errors = counts.Errors,
                    Problems = counts.Problems.ToList(),
                    DurationMs = clock.ElapsedMilliseconds,
                };
            }
        });
    }
}
