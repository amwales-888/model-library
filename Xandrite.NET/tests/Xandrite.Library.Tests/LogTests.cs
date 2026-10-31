using System.Text.RegularExpressions;
using Xandrite.Geometry;
using Xandrite.Library.Logging;
using Xandrite.Library.Thumbnails;
using Xandrite.Rendering;
using static Xandrite.Library.Tests.TempLibrary;

namespace Xandrite.Library.Tests;

/// <summary>The log file. Ported from the Electron app's test/logger.test.js.</summary>
public class LogTests
{
    [Fact]
    public void LinesCarryALocalTimestampWithOffsetALevelAnEventAndFields()
    {
        Assert.Matches(@"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$", FileLog.Timestamp(DateTimeOffset.Now));
        string line = FileLog.FormatLine("WARN", "problem",
            [("path", "/models/my file.stl"), ("message", "bad \"quote\"\nsecond line"), ("n", 3), ("nothing", null), ("ok", true), ("ms", 1.5)],
            new DateTimeOffset(2026, 10, 28, 16, 49, 12, 345, TimeSpan.FromHours(1)));
        Assert.Equal("2026-10-28T16:49:12.345+01:00 WARN  problem path=\"/models/my file.stl\" message=\"bad \\\"quote\\\"\\nsecond line\" n=3 nothing=- ok=true ms=1.5", line);
        Assert.DoesNotContain('\n', line);   // one event, one line
        Assert.Equal(@"C:\Models\a.stl", FileLog.FormatValue(@"C:\Models\a.stl"));   // plain paths stay readable
    }

    [Fact]
    public void TheLogWritesTheFileAndRollsItOverAtTheSizeLimit()
    {
        using var lib = new TempLibrary();
        string file = Path.Combine(lib.Dir, "logs", "x.log");
        using (var log = new FileLog(file, maxBytes: 600, keep: 2, flushMs: 10_000))
        {
            for (int i = 0; i < 40; i++) log.Info("tick", ("i", i), ("padding", "abcdefghijklmnopqrstuvwxyz"));
        }
        var names = Directory.GetFiles(Path.GetDirectoryName(file)!).Select(Path.GetFileName).Order().ToList();
        Assert.Equal(new[] { "x.log", "x.log.1", "x.log.2" }, names);   // never more than `keep` old files
        Assert.Contains("i=39", File.ReadAllText(file));                 // the newest line is in the current file
        Assert.True(new FileInfo(file).Length <= 600);
    }

    [Fact]
    public void ALogThatCannotBeMadeThrowsAtTheStartAndOneThatStopsWorkingNeverThrows()
    {
        using var lib = new TempLibrary();
        File.WriteAllText(Path.Combine(lib.Dir, "blocker"), "a file where the folder should be");
        Assert.ThrowsAny<IOException>(() => new FileLog(Path.Combine(lib.Dir, "blocker", "x.log")));   // the app falls back to no log

        string file = Path.Combine(lib.Dir, "ok", "x.log");
        using var log = new FileLog(file);
        log.Info("first");
        log.Flush();
        Directory.Delete(Path.GetDirectoryName(file)!, recursive: true);
        File.WriteAllText(Path.Combine(lib.Dir, "ok"), "the folder is now a file");
        log.Info("second");
        log.Flush();   // cannot write: gives up quietly
        log.Info("third");
        log.Flush();
    }

    private static List<string> Lines(string file) => File.ReadAllLines(file).ToList();

    [Fact]
    public async Task AScanLogsItsStartEveryFileHashedProblemsAndTheEndWithTheTimeTaken()
    {
        using var lib = new TempLibrary();
        string file = Path.Combine(lib.Dir, "logs", "xandrite.log");
        using var log = new FileLog(file);
        lib.Write("a.stl", "solid a");
        lib.Write("sub/b.stl", "solid b");
        lib.Write("broken.zip", "not really a zip");
        var scanner = new Scanning.LibraryScanner(lib.Db) { Log = log };
        await scanner.ScanAsync(lib.Root);
        await scanner.ScanAsync(lib.Root);
        log.Flush();

        var lines = Lines(file);
        Assert.Equal(2, lines.Count(l => l.Contains(" scan.start ")));
        var hashed = lines.Where(l => l.Contains(" INFO  hash ")).ToList();
        Assert.Equal(2, hashed.Count);
        Assert.Contains(hashed, l => l.Contains("path=" + FileLog.FormatValue(lib.At("a.stl"))) && l.Contains("sha256=" + Sha("solid a")) && Regex.IsMatch(l, @"ms=\d+"));
        Assert.Contains(lines, l => l.Contains(" WARN  problem ") && l.Contains("broken.zip"));
        var ends = lines.Where(l => l.Contains(" scan.end ")).ToList();
        Assert.Matches(@"duration_ms=\d+", ends[0]);
        Assert.Contains(" WARN  scan.end ", ends[0]);   // it had an error, so it is a warning
        Assert.Contains("hashed=2", ends[0]);
        Assert.Contains("unchanged=2", ends[1]);
    }

    private sealed class FakeRenderer : IModelRenderer
    {
        public string AdapterDescription => "Fake";
        public IGpuMesh Upload(Mesh mesh) => new FakeMesh();
        public RenderedImage Render(IGpuMesh mesh, in RenderRequest request) => new(request.Width, request.Height, new byte[request.Width * request.Height * 4]);
        public void Dispose() { }
        private sealed class FakeMesh : IGpuMesh { public int TriangleCount => 1; public void Dispose() { } }
    }

    [Fact]
    public async Task TheThumbnailQueueLogsEachThumbnailWithItsTimeFailuresAndTheTotals()
    {
        using var lib = new TempLibrary();
        string file = Path.Combine(lib.Dir, "logs", "xandrite.log");
        using var log = new FileLog(file);
        lib.Write("good.stl", "solid g\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid g\n");
        lib.Write("bad.stl", "cannot parse this");
        await lib.Scan();

        await using (var queue = new ThumbnailQueue(lib.Db, new LibraryLocation(lib.Dir), () => new FakeRenderer(), workers: 1) { Log = log })
        {
            var idle = new TaskCompletionSource();
            queue.Idle += () => idle.TrySetResult();
            queue.Start();
            await idle.Task.WaitAsync(TimeSpan.FromSeconds(30));
        }
        log.Flush();

        string text = File.ReadAllText(file);
        Assert.Matches(@" INFO  thumbs\.start pending=2", text);
        // A path with spaces or other characters (Windows temp folders such as RUNNER~1) is written in quotes.
        Assert.Matches(@" INFO  thumb\.ok path=[^\n]*?good\.stl""? sha256=[0-9a-f]{64} ms=\d+ read_ms=\d+", text);
        Assert.Matches(@" WARN  thumb\.fail path=[^\n]*?bad\.stl""? sha256=[0-9a-f]{64} ms=\d+ message=""This is not a valid STL", text);
        Assert.Matches(@" WARN  thumbs\.end duration_ms=\d+ made=1 failed=1", text);
    }
}
