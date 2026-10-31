using static Xandrite.Library.Tests.TempLibrary;

namespace Xandrite.Library.Tests;

/// <summary>Scanning loose files. Ported from the Electron app's test/indexer.test.js.</summary>
public class ScannerTests
{
    [Fact]
    public async Task FirstScanFindsModelFilesHashesThemAndIgnoresEverythingElse()
    {
        using var lib = new TempLibrary();
        lib.Write("a.stl", "solid a");
        lib.Write("sub/b.3MF", "pk b");
        lib.Write("notes.txt", "not a model");
        lib.Write(".hidden/c.stl", "solid c");
        lib.Write("._d.stl", "mac junk");

        var summary = await lib.Scan();
        Assert.Equal(2, summary.Found);
        Assert.Equal(2, summary.Hashed);
        Assert.Equal(2, summary.Added);
        Assert.Equal(0, summary.Errors);
        var rows = lib.Present();
        Assert.Equal(new[] { "a.stl", "b.3MF" }, rows.Select(r => r.Name).Order());
        Assert.Equal(Sha("solid a"), rows.Single(r => r.Name == "a.stl").Sha256);
        Assert.Equal("3mf", rows.Single(r => r.Name == "b.3MF").Format);
        Assert.Equal("sub", rows.Single(r => r.Name == "b.3MF").Folder);
        Assert.NotNull(lib.Db.GetRoots()[0].LastScannedAt);
    }

    [Fact]
    public async Task ARescanWithNothingChangedReadsNoFileContents()
    {
        using var lib = new TempLibrary();
        lib.Write("a.stl", "solid a");
        lib.Write("b.stl", "solid b");
        await lib.Scan();
        var second = await lib.Scan();
        Assert.Equal(2, second.Found);
        Assert.Equal(0, second.Hashed);
        Assert.Equal(2, second.Reused);
        Assert.Equal(0, second.Added);
        Assert.Equal(0, second.Missing);
    }

    [Fact]
    public async Task AMovedFileKeepsItsHashAndIsReportedAsMoved()
    {
        using var lib = new TempLibrary();
        lib.Write("a.stl", "solid a");
        await lib.Scan();
        lib.Move("a.stl", "elsewhere/a.stl");
        var summary = await lib.Scan();
        Assert.Equal(1, summary.Moved);
        Assert.Equal(1, summary.Missing);
        Assert.Equal(1, lib.Db.GetStats().UniqueModels);
        Assert.Equal(Sha("solid a"), lib.Present().Single().Sha256);
    }

    [Fact]
    public async Task ADeletedFileIsMarkedMissingAndComesBackIfItReappears()
    {
        using var lib = new TempLibrary();
        lib.Write("a.stl", "solid a");
        await lib.Scan();
        lib.Delete("a.stl");
        Assert.Equal(1, (await lib.Scan()).Missing);
        Assert.True(lib.All().Single().Missing);
        lib.Write("a.stl", "solid a");
        await lib.Scan();
        Assert.False(lib.All().Single().Missing);
    }

    [Fact]
    public async Task IdenticalFilesInDifferentPlacesAreOneModelWithDuplicateLocations()
    {
        using var lib = new TempLibrary();
        lib.Write("a.stl", "same");
        lib.Write("copy/a.stl", "same");
        var summary = await lib.Scan();
        Assert.Equal(1, summary.DuplicateGroups);
        var stats = lib.Db.GetStats();
        Assert.Equal(2, stats.Files);
        Assert.Equal(1, stats.UniqueModels);
    }

    [Fact]
    public async Task AFileEditedInPlaceIsHashedAgainAndGetsItsNewHash()
    {
        using var lib = new TempLibrary();
        lib.Write("a.stl", "version one", new DateTime(2024, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        await lib.Scan();
        lib.Write("a.stl", "version two!", new DateTime(2024, 1, 2, 0, 0, 0, DateTimeKind.Utc));
        var summary = await lib.Scan();
        Assert.Equal(1, summary.Hashed);
        Assert.Equal(Sha("version two!"), lib.Present().Single().Sha256);
    }

    [Fact]
    public async Task ACancelledScanDoesNotMarkAnythingMissing()
    {
        using var lib = new TempLibrary();
        lib.Write("a.stl", "solid a");
        await lib.Scan();
        lib.Delete("a.stl");
        using var cancel = new CancellationTokenSource();
        cancel.Cancel();
        var summary = await lib.Scan(cancellation: cancel.Token);
        Assert.True(summary.Cancelled);
        Assert.Equal(0, summary.Missing);
        Assert.False(lib.All().Single().Missing);
    }

    [Fact]
    public async Task RootsReportTheirFileCounts()
    {
        using var lib = new TempLibrary();
        lib.Write("a.stl", "a");
        lib.Write("b.stl", "b");
        await lib.Scan();
        Assert.Equal(2, lib.Db.GetRoots().Single().Files);
    }

    [Fact]
    public async Task ScanningSomethingThatIsNotAFolderFailsWithAClearError()
    {
        using var lib = new TempLibrary();
        var e = await Assert.ThrowsAsync<DirectoryNotFoundException>(() =>
            new Scanning.LibraryScanner(lib.Db).ScanAsync(Path.Combine(lib.Root, "nope")));
        Assert.StartsWith("Not a folder", e.Message);
    }

    [Fact]
    public void ModifiedTimesAreComputedTheWayNodeDoes()
    {
        // 2023-11-14 22:13:20.1234567 UTC: Node gives sec * 1000 + nsec / 1e6 = 1700000000000 + 123.4567
        var time = DateTime.UnixEpoch.AddTicks(17_000_000_001_234_567);
        Assert.Equal(1700000000000 + 123456700 / 1e6, Scanning.FileTimes.ToNodeMs(time));
    }
}
