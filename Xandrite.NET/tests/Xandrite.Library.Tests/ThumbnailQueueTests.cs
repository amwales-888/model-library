using Xandrite.Geometry;
using Xandrite.Imaging;
using Xandrite.Library.Thumbnails;
using Xandrite.Rendering;

namespace Xandrite.Library.Tests;

/// <summary>The thumbnail queue, with a stand-in renderer. Ported from the Electron app's test/thumbnail-queue.test.js.</summary>
public class ThumbnailQueueTests
{
    private const string Stl = "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n";

    private sealed class FakeRenderer : IModelRenderer
    {
        public static int Created;
        public static Func<bool> Broken = () => false;

        public FakeRenderer() => Interlocked.Increment(ref Created);

        public string AdapterDescription => "Fake";

        public IGpuMesh Upload(Mesh mesh) => new FakeMesh(mesh.TriangleCount);

        public RenderedImage Render(IGpuMesh mesh, in RenderRequest request)
        {
            if (Broken()) throw new RendererException("The graphics device was lost.", deviceLost: true);
            return new RenderedImage(request.Width, request.Height, new byte[request.Width * request.Height * 4]);
        }

        public void Dispose() { }

        private sealed class FakeMesh(int triangles) : IGpuMesh
        {
            public int TriangleCount { get; } = triangles;
            public void Dispose() { }
        }
    }

    private static async Task<ThumbnailQueue> RunToEnd(TempLibrary lib, int workers = 2)
    {
        var location = new LibraryLocation(lib.Dir);
        var queue = new ThumbnailQueue(lib.Db, location, () => new FakeRenderer(), workers: workers);
        var idle = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        queue.Idle += () => idle.TrySetResult();
        queue.Start();
        await idle.Task.WaitAsync(TimeSpan.FromSeconds(30));
        return queue;
    }

    [Fact]
    public async Task DrawsEveryModelOnceAndSavesThePngWithItsViewSettings()
    {
        FakeRenderer.Broken = () => false;
        using var lib = new TempLibrary();
        lib.Write("a.stl", Stl);
        lib.Write("b.stl", Stl.Replace("solid t", "solid b"));
        lib.Write("bad.stl", "this is not a model");
        await lib.Scan();

        var done = new List<ThumbnailJobDone>();
        var location = new LibraryLocation(lib.Dir);
        await using var queue = new ThumbnailQueue(lib.Db, location, () => new FakeRenderer());
        var idle = new TaskCompletionSource();
        queue.JobDone += d => { lock (done) done.Add(d); };
        queue.Idle += () => idle.TrySetResult();
        queue.Start();
        await idle.Task.WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Equal(2, done.Count(d => d.State == ThumbnailState.Ok));
        var failure = Assert.Single(done, d => d.State == ThumbnailState.Failed);
        Assert.Contains("not a valid STL", failure.Error!);
        var status = queue.GetStatus();
        Assert.Equal(new ThumbnailCounts(2, 1, 0), status.Counts);
        Assert.False(status.Running);

        string sha = TempLibrary.Sha(Stl);
        byte[] png = File.ReadAllBytes(location.ThumbnailPath(sha));
        Assert.Contains("\"name\": \"a.stl\"", PngText.Read(png, Look.StateKeyword)!);
        Assert.Empty(Directory.GetFiles(location.ThumbnailFolder, "*.tmp"));
    }

    [Fact]
    public async Task ADeletedImageIsDrawnAgainAndAFailedModelWaitsForRetry()
    {
        FakeRenderer.Broken = () => false;
        using var lib = new TempLibrary();
        lib.Write("a.stl", Stl);
        lib.Write("bad.stl", "nope");
        await lib.Scan();
        await using (await RunToEnd(lib)) { }

        File.Delete(new LibraryLocation(lib.Dir).ThumbnailPath(TempLibrary.Sha(Stl)));
        await using (var again = await RunToEnd(lib))
        {
            Assert.Equal(1, again.GetStatus().Done);     // the deleted one, not the failed one
            Assert.Equal(0, again.GetStatus().Failed);
        }
        Assert.Equal(1, lib.Db.ResetFailedThumbnails());
        await using (var retry = await RunToEnd(lib)) Assert.Equal(1, retry.GetStatus().Failed);
    }

    [Fact]
    public async Task AFileThatChangedOrVanishedSinceTheScanIsSkippedNotFailed()
    {
        FakeRenderer.Broken = () => false;
        using var lib = new TempLibrary();
        lib.Write("changed.stl", Stl);
        lib.Write("gone.stl", Stl.Replace("solid t", "solid g"));
        await lib.Scan();
        lib.Write("changed.stl", Stl.Replace("solid t", "solid x"));
        lib.Delete("gone.stl");

        await using var queue = await RunToEnd(lib);
        var status = queue.GetStatus();
        Assert.Equal(2, status.Skipped);
        Assert.Equal(0, status.Failed);
        Assert.Equal(2, status.Counts.Pending);   // still pending: a rescan sorts them out
    }

    [Fact]
    public async Task ABrokenRendererPausesTheQueueInsteadOfFailingEveryModel()
    {
        using var lib = new TempLibrary();
        for (int i = 0; i < 5; i++) lib.Write($"m{i}.stl", Stl.Replace("solid t", "solid " + i));
        await lib.Scan();

        bool broken = true;
        FakeRenderer.Broken = () => broken;
        var location = new LibraryLocation(lib.Dir);
        await using var queue = new ThumbnailQueue(lib.Db, location, () => new FakeRenderer(), workers: 1);
        var blocked = new TaskCompletionSource();
        var idle = new TaskCompletionSource();
        queue.Progress += s => { if (s.Blocked is not null && s.Paused) blocked.TrySetResult(); };
        queue.Idle += () => idle.TrySetResult();
        queue.Start();
        await blocked.Task.WaitAsync(TimeSpan.FromSeconds(30));

        var status = queue.GetStatus();
        Assert.Equal(0, status.Failed);
        Assert.Contains("lost", status.Blocked!);
        Assert.Equal(5, status.Counts.Pending);

        broken = false;
        queue.Resume();
        await idle.Task.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal(new ThumbnailCounts(5, 0, 0), queue.GetStatus().Counts);
        FakeRenderer.Broken = () => false;
    }

    [Fact]
    public async Task ASavedViewIsUsedForTheThumbnail()
    {
        FakeRenderer.Broken = () => false;
        using var lib = new TempLibrary();
        lib.Write("a.stl", Stl);
        await lib.Scan();
        string sha = TempLibrary.Sha(Stl);
        lib.Db.SetView(sha, new SavedView([10, 20, 30], [1, 2, 3], 40, false));

        await using var queue = await RunToEnd(lib);
        string json = PngText.Read(File.ReadAllBytes(new LibraryLocation(lib.Dir).ThumbnailPath(sha)), Look.StateKeyword)!;
        Assert.Contains("\"auto\": false", json);
        Assert.Contains("\"fovDeg\": 40", json);
    }

    [Fact]
    public async Task ModelsInsideZipsAreDrawnToo()
    {
        FakeRenderer.Broken = () => false;
        using var lib = new TempLibrary();
        lib.WriteZip("kit.zip", new Dictionary<string, string> { ["parts/a.stl"] = Stl });
        await lib.Scan();
        await using var queue = await RunToEnd(lib);
        Assert.Equal(1, queue.GetStatus().Done);
    }

    [Fact]
    public async Task ModelsInsideArchivesWithNoReaderAreSkippedNotFailed()
    {
        FakeRenderer.Broken = () => false;
        using var lib = new TempLibrary();
        lib.Write("kit.7z", "7z bytes");
        lib.Db.Locked(c =>
        {
            c.Execute("INSERT INTO models(sha256,size,format,first_seen_at) VALUES ('ab',1,'stl',0)");
            c.Execute("INSERT INTO locations(path,root,sha256,size,mtime_ms,last_seen_scan,added_scan,container,entry) VALUES (?,?,?,?,?,?,?,?,?)",
                Path.Combine(lib.At("kit.7z"), "leg.stl"), lib.Root, "ab", 1, 0, 1, 1, lib.At("kit.7z"), "leg.stl");
        });
        // A model source that only reads zips, as when 7z.dll is missing: the model keeps any old image.
        var location = new LibraryLocation(lib.Dir);
        await using var queue = new ThumbnailQueue(lib.Db, location, () => new FakeRenderer(), new Scanning.ModelSource([new Scanning.ZipArchiveReader()]));
        var idle = new TaskCompletionSource();
        queue.Idle += () => idle.TrySetResult();
        queue.Start();
        await idle.Task.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal(1, queue.GetStatus().Skipped);
        Assert.Equal(0, queue.GetStatus().Counts.Failed);
    }
}
