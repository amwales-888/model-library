using System.Text;

namespace Xandrite.Library.Tests;

public class ImportAndDownloadTests
{
    [Fact]
    public async Task TheElectronLibraryIsCopiedOnceAndItsFolderIsOnlyRead()
    {
        using var lib = new TempLibrary();
        string electron = Path.Combine(lib.Dir, "electron");
        Directory.CreateDirectory(Path.Combine(electron, "thumbnails"));
        File.Copy(Path.Combine(AppContext.BaseDirectory, "Fixtures", "electron-library.sqlite"), Path.Combine(electron, "library.sqlite"));
        string png = new string('a', 64) + ".png";
        File.WriteAllText(Path.Combine(electron, "thumbnails", png), "old image");
        File.WriteAllText(Path.Combine(electron, "thumbnails", "notes.txt"), "not a thumbnail");
        var before = Directory.GetFiles(electron, "*", SearchOption.AllDirectories).ToDictionary(f => f, File.GetLastWriteTimeUtc);

        var target = new LibraryLocation(Path.Combine(lib.Dir, "Xandrite.NET"));
        Assert.True(ElectronImport.CopyDatabaseIfNew(target, electron));
        Assert.False(ElectronImport.CopyDatabaseIfNew(target, electron));   // only once

        using (var db = new LibraryDatabase(target.DatabaseFile, separator: '\\'))
        {
            Assert.True(ElectronImport.ThumbnailsPending(db));
            Assert.Equal(4, db.GetStats().Files);
            Assert.Equal(1, await ElectronImport.CopyThumbnailsAsync(db, target, electron));
            Assert.False(ElectronImport.ThumbnailsPending(db));
        }
        Assert.Equal("old image", File.ReadAllText(target.ThumbnailPath(new string('a', 64))));
        Assert.False(File.Exists(Path.Combine(target.ThumbnailFolder, "notes.txt")));
        var after = Directory.GetFiles(electron, "*", SearchOption.AllDirectories).ToDictionary(f => f, File.GetLastWriteTimeUtc);
        Assert.Equal(before, after);   // nothing in the Electron folder was changed, added or removed
    }

    [Fact]
    public async Task AnImageAlreadyDrawnHereIsNotOverwrittenByTheImport()
    {
        using var lib = new TempLibrary();
        string electron = Path.Combine(lib.Dir, "electron");
        Directory.CreateDirectory(Path.Combine(electron, "thumbnails"));
        string sha = new('b', 64);
        File.WriteAllText(Path.Combine(electron, "thumbnails", sha + ".png"), "old");
        var target = new LibraryLocation(lib.Dir);
        Directory.CreateDirectory(target.ThumbnailFolder);
        File.WriteAllText(target.ThumbnailPath(sha), "new");
        await ElectronImport.CopyThumbnailsAsync(lib.Db, target, electron);
        Assert.Equal("new", File.ReadAllText(target.ThumbnailPath(sha)));
    }

    [Fact]
    public void TakenNamesGetANumber()
    {
        var taken = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "leg.stl", "leg (2).stl" };
        Assert.Equal("LEG (3).stl", Downloads.UniqueName("LEG.stl", taken));   // the file keeps its own name
        Assert.Equal("arm.stl", Downloads.UniqueName("arm.stl", taken));
        Assert.Equal("arm (2).stl", Downloads.UniqueName("arm.stl", taken));
    }

    [Fact]
    public async Task DownloadCopiesLooseFilesExtractsFromZipsAndNeverOverwrites()
    {
        using var lib = new TempLibrary();
        lib.Write("leg.stl", "solid leg");
        lib.WriteZip("kit.zip", new Dictionary<string, string> { ["parts/arm.stl"] = "solid arm", ["parts/leg.stl"] = "solid other leg" });
        await lib.Scan();
        string destination = Path.Combine(lib.Dir, "out");
        Directory.CreateDirectory(destination);
        File.WriteAllText(Path.Combine(destination, "arm.stl"), "already here");

        var result = await Downloads.CopyAsync(lib.Present(), destination);
        Assert.Equal(3, result.Copied);
        Assert.Empty(result.Failed);
        Assert.Equal(0, result.Changed);
        Assert.Equal("already here", File.ReadAllText(Path.Combine(destination, "arm.stl")));
        Assert.Equal("solid arm", File.ReadAllText(Path.Combine(destination, "arm (2).stl")));
        var legs = new[] { "leg.stl", "leg (2).stl" }.Select(n => File.ReadAllText(Path.Combine(destination, n))).Order();
        Assert.Equal(new[] { "solid leg", "solid other leg" }, legs);
    }

    [Fact]
    public async Task DownloadReportsFilesThatAreGoneOrChanged()
    {
        using var lib = new TempLibrary();
        lib.Write("a.stl", "solid a");
        lib.Write("b.stl", "solid b");
        lib.WriteZip("kit.zip", new Dictionary<string, string> { ["c.stl"] = "solid c" });
        await lib.Scan();
        lib.Delete("a.stl");
        File.WriteAllText(lib.At("b.stl"), "edited after the scan", Encoding.UTF8);
        lib.WriteZip("kit.zip", new Dictionary<string, string> { ["other.stl"] = "x" });
        string destination = Path.Combine(lib.Dir, "out");
        Directory.CreateDirectory(destination);

        var result = await Downloads.CopyAsync(lib.Present(), destination);
        Assert.Equal(1, result.Copied);
        Assert.Equal(1, result.Changed);
        Assert.Equal(2, result.Failed.Count);
        Assert.Contains(result.Failed, f => f.Message == "it is no longer in the archive");
    }
}
