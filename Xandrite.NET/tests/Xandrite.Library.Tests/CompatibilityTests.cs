namespace Xandrite.Library.Tests;

/// <summary>
/// Opens Fixtures/electron-library.sqlite, a library written by the Electron app's own src/db.js (under Node, with
/// Windows-style paths), and checks that everything reads back. The separator is given explicitly so the test runs
/// the same on any OS.
/// </summary>
public class CompatibilityTests : IDisposable
{
    private const string Root = @"C:\Users\Angelo\Models";
    private readonly string _file;
    private readonly LibraryDatabase _db;

    public CompatibilityTests()
    {
        _file = Path.Combine(Path.GetTempPath(), "xandrite-compat-" + Guid.NewGuid().ToString("N") + ".sqlite");
        File.Copy(Path.Combine(AppContext.BaseDirectory, "Fixtures", "electron-library.sqlite"), _file);
        _db = new LibraryDatabase(_file, separator: '\\');
    }

    private static string Sha(char c) => new(c, 64);

    [Fact]
    public void RootsSettingsAndStatsReadBack()
    {
        Assert.Equal(new[] { Root, @"D:\Prints" }, _db.GetRoots().Select(r => r.Path).Order());
        Assert.Equal(4, _db.GetRoots().Single(r => r.Path == Root).Files);
        Assert.Equal("0", _db.GetSetting("scanZips"));
        Assert.Equal(new LibraryStats(Files: 4, UniqueModels: 3, Missing: 1, DuplicateGroups: 1), _db.GetStats());
    }

    [Fact]
    public void RowsReadBackWithTheirDetails()
    {
        var rows = _db.List(new ListQuery { Limit = 100 }).Rows;
        var benchy = rows.Single(r => r.Path == Root + @"\Benchy.stl");
        Assert.Equal(1699999999123.4567, benchy.ModifiedMs);   // the REAL column keeps Node's fractional milliseconds
        Assert.Equal(4, benchy.Rating);
        Assert.Equal(ThumbnailState.Ok, benchy.ThumbnailState);
        Assert.Equal("", benchy.Folder);

        var gear = rows.Single(r => r.Name == "gear 10.stl");
        Assert.Equal(Root + @"\Kits\parts.zip", gear.Container);
        Assert.Equal("gears/gear 10.stl", gear.Entry);
        Assert.Equal("parts.zip", gear.ArchiveName);
        Assert.Equal(@"Kits\parts.zip\gears", gear.Folder);
        Assert.Equal(0, gear.Rating);
        Assert.Equal(ThumbnailState.Failed, gear.ThumbnailState);
        Assert.Equal("This is not a valid STL file.", gear.ThumbnailError);

        Assert.True(rows.Single(r => r.Name == "arm.3mf").CustomView);
        Assert.True(rows.Single(r => r.Name == "gone.stl").Missing);
        Assert.Equal(3735928559L, _db.Locked(c => c.Scalar("SELECT crc32 FROM locations WHERE entry IS NOT NULL")));
    }

    [Fact]
    public void FolderFiltersAndTheTreeUseBackslashes()
    {
        Assert.Equal(0, _db.List(new ListQuery { Folder = Root + @"\Kits", Recursive = false }).Total);   // its files are all in subfolders
        Assert.Equal(2, _db.List(new ListQuery { Folder = Root + @"\Kits" }).Total);
        var tree = _db.GetFolderTree().Single(n => n.Path == Root);
        Assert.Equal(4, tree.Count);
        Assert.Equal(new[] { "Copies", "Kits" }, tree.Children.Select(c => c.Name));
        Assert.Equal(Root + @"\Kits\Robot", tree.Children[1].Children.Single(c => c.Name == "Robot").Path);
    }

    [Fact]
    public void TheSavedViewReadsBack()
    {
        var view = _db.GetView(Sha('b'))!;
        Assert.Equal(new[] { 120.5, -40.25, 60 }, view.Position);
        Assert.Equal(new double[] { 1, 2, -3 }, view.Target);
        Assert.Equal(28, view.FovDeg);
        Assert.False(view.ZUp);
    }

    [Fact]
    public void ThumbnailsFromTheElectronRendererAreDueForRedrawing()
    {
        // Render version 1 (three.js) is older than the Direct3D renderer's, so the ok thumbnail is pending again;
        // the failed one stays failed until "Retry failed".
        var jobs = _db.PendingThumbnailJobs(Look.RenderVersion);
        Assert.Equal(new[] { Sha('a'), Sha('b') }, jobs.Select(j => j.Sha256).Order());
        Assert.Equal(new ThumbnailCounts(0, 1, 2), _db.GetThumbnailCounts(Look.RenderVersion));
        Assert.Equal(new ThumbnailCounts(1, 1, 1), _db.GetThumbnailCounts(1));
    }

    [Fact]
    public void WritesFromDotNetLandInTheSameTables()
    {
        _db.SetRating(Sha('b'), 5);
        _db.RecordThumbnail(Sha('b'), ThumbnailState.Ok, Look.RenderVersion, 512);
        Assert.Equal(5, _db.GetRating(Sha('b')));
        Assert.Equal(new ThumbnailCounts(1, 1, 1), _db.GetThumbnailCounts(Look.RenderVersion));
    }

    public void Dispose()
    {
        _db.Dispose();
        foreach (var f in new[] { _file, _file + "-wal", _file + "-shm" }) File.Delete(f);
    }
}
