using Xandrite.Library.Scanning;
using static Xandrite.Library.Tests.TempLibrary;

namespace Xandrite.Library.Tests;

/// <summary>Models inside archives, and split-archive names. Ported from test/zip.test.js and test/archive.test.js.</summary>
public class ArchiveTests
{
    private static readonly char S = Path.DirectorySeparatorChar;

    [Fact]
    public async Task ModelsInsideAZipAreFoundHashedFromTheirContentAndShownUnderTheZip()
    {
        using var lib = new TempLibrary();
        lib.WriteZip("kit.zip", new Dictionary<string, string>
        {
            ["parts/leg.stl"] = "solid leg",
            ["arm.3mf"] = "pk arm",
            ["readme.txt"] = "not a model",
            ["__MACOSX/parts/._leg.stl"] = "junk",
            ["inner.zip"] = "nested",
        });
        var summary = await lib.Scan();
        Assert.Equal(0, summary.Errors);
        Assert.Equal(1, summary.Archives);
        Assert.Equal(1, summary.NestedArchives);
        var leg = lib.Present().Single(r => r.Name == "leg.stl");
        Assert.Equal(Sha("solid leg"), leg.Sha256);
        Assert.Equal("kit.zip", leg.ArchiveName);
        Assert.Equal("parts/leg.stl", leg.Entry);
        Assert.Equal(lib.At("kit.zip") + S + "parts" + S + "leg.stl", leg.Path);
        Assert.Equal(2, lib.Present().Count);
    }

    [Fact]
    public async Task TheSameModelLooseAndInsideAZipIsOneModelWithTwoLocations()
    {
        using var lib = new TempLibrary();
        lib.Write("leg.stl", "solid leg");
        lib.WriteZip("kit.zip", new Dictionary<string, string> { ["leg.stl"] = "solid leg" });
        await lib.Scan();
        Assert.Equal(new LibraryStats(2, 1, 0, 1), lib.Db.GetStats());
    }

    [Fact]
    public async Task AnUnchangedZipIsNotOpenedAgain()
    {
        using var lib = new TempLibrary();
        lib.WriteZip("kit.zip", new Dictionary<string, string> { ["a.stl"] = "solid a", ["b.stl"] = "solid b" });
        await lib.Scan();
        var again = await lib.Scan();
        Assert.Equal(2, again.Found);
        Assert.Equal(2, again.Reused);
        Assert.Equal(0, again.Hashed);
    }

    [Fact]
    public async Task AChangedZipOnlyReadsWhatChangedAndRemovedEntriesBecomeMissing()
    {
        using var lib = new TempLibrary();
        lib.WriteZip("kit.zip", new Dictionary<string, string> { ["a.stl"] = "solid a", ["b.stl"] = "solid b" });
        await lib.Scan();
        lib.WriteZip("kit.zip", new Dictionary<string, string> { ["a.stl"] = "solid a", ["c.stl"] = "solid c" });
        File.SetLastWriteTimeUtc(lib.At("kit.zip"), DateTime.UtcNow.AddMinutes(1));
        var summary = await lib.Scan();
        Assert.Equal(1, summary.Hashed);    // only c.stl
        Assert.Equal(1, summary.Reused);    // a.stl: same size and CRC-32
        Assert.Equal(1, summary.Missing);   // b.stl
    }

    [Fact]
    public async Task ADeletedZipMakesItsModelsMissingAndAnUnreadableZipKeepsItsRecords()
    {
        using var lib = new TempLibrary();
        lib.WriteZip("good.zip", new Dictionary<string, string> { ["a.stl"] = "solid a" });
        lib.WriteZip("soon-broken.zip", new Dictionary<string, string> { ["b.stl"] = "solid b" });
        await lib.Scan();

        lib.Delete("good.zip");
        File.WriteAllText(lib.At("soon-broken.zip"), "this is no longer a zip");
        var summary = await lib.Scan();
        Assert.Equal(1, summary.Errors);
        Assert.Contains("could not read this archive", summary.Problems.Single().Message);
        var rows = lib.All();
        Assert.True(rows.Single(r => r.Name == "a.stl").Missing);
        Assert.False(rows.Single(r => r.Name == "b.stl").Missing);
    }

    [Fact]
    public async Task TurningArchiveScanningOffLeavesZipsAloneAndTheirModelsGoMissing()
    {
        using var lib = new TempLibrary();
        lib.WriteZip("kit.zip", new Dictionary<string, string> { ["a.stl"] = "solid a" });
        await lib.Scan();
        var summary = await lib.Scan(includeArchives: false);
        Assert.Equal(1, summary.Missing);
    }

    [Fact]
    public async Task OversizedEntriesAreReportedAndSkippedAndTooManyEntriesAreRefused()
    {
        using var lib = new TempLibrary();
        lib.WriteZip("kit.zip", new Dictionary<string, string> { ["big.stl"] = new string('x', 100), ["small.stl"] = "s" });
        var summary = await lib.Scan(limits: new ArchiveLimits { MaxEntryBytes = 50 });
        Assert.Contains(summary.Problems, p => p.Message.StartsWith("too large to read from a zip"));
        Assert.Equal(new[] { "small.stl" }, lib.Present().Select(r => r.Name));

        using var lib2 = new TempLibrary();
        lib2.WriteZip("many.zip", new Dictionary<string, string> { ["a.stl"] = "a", ["b.stl"] = "b", ["c.stl"] = "c" });
        var refused = await lib2.Scan(limits: new ArchiveLimits { MaxEntries = 2 });
        Assert.Contains("too many entries", refused.Problems.Single().Message);
    }

    [Fact]
    public async Task AZipWithAnUnsafeFileNameIsReportedNotCrashedOn()
    {
        using var lib = new TempLibrary();
        lib.WriteZip("kit.zip", new Dictionary<string, string> { ["../escape.stl"] = "x", ["ok.stl"] = "ok" });
        var summary = await lib.Scan();
        Assert.Contains(summary.Problems, p => p.Message == "unsafe file name in the zip");
        Assert.Equal(new[] { "ok.stl" }, lib.Present().Select(r => r.Name));
    }

    [Fact]
    public async Task AModelInsideAZipCanBeReadBackAndAMissingZipOrEntryIsReportedAsGone()
    {
        using var lib = new TempLibrary();
        lib.WriteZip("kit.zip", new Dictionary<string, string> { ["parts/leg.stl"] = "solid leg" });
        await lib.Scan();
        var row = lib.Present().Single();
        var location = lib.Db.GetLocation(row.Path)!;
        byte[] bytes = await ModelSource.Default.ReadAsync(location);
        Assert.Equal("solid leg", System.Text.Encoding.UTF8.GetString(bytes));

        await Assert.ThrowsAsync<ModelGoneException>(() => ModelSource.Default.ReadAsync(location with { Entry = "parts/gone.stl" }));
        lib.Delete("kit.zip");
        await Assert.ThrowsAsync<ModelGoneException>(() => ModelSource.Default.ReadAsync(location));
        await Assert.ThrowsAsync<ModelGoneException>(() => ModelSource.Default.ReadAsync(new ModelLocation(lib.At("nothing.stl"))));
    }

    [Fact]
    public async Task AnArchiveThatCannotBeReadIsReportedAndItsModelsAreKept()
    {
        using var lib = new TempLibrary();
        lib.Write("kit.7z", "7z archive bytes");
        // As if the Electron app had read it before: one model inside, last seen at an earlier scan.
        lib.Db.Locked(c =>
        {
            c.Execute("INSERT INTO models(sha256,size,format,first_seen_at) VALUES ('ab',1,'stl',0)");
            c.Execute("INSERT INTO locations(path,root,sha256,size,mtime_ms,last_seen_scan,added_scan,container,entry) VALUES (?,?,?,?,?,?,?,?,?)",
                lib.At("kit.7z") + S + "leg.stl", lib.Root, "ab", 1, 0, 1, 1, lib.At("kit.7z"), "leg.stl");
        });
        var summary = await lib.Scan();
        Assert.StartsWith("could not read this archive", summary.Problems.Single().Message);   // not a real .7z
        Assert.Equal(0, summary.Missing);
        Assert.False(lib.All().Single().Missing);
    }

    [Fact]
    public void RarSetsAreRecognisedNewStylePartsAndOldStyleVolumes()
    {
        using var lib = new TempLibrary();
        foreach (var name in new[] { "a.part1.rar", "a.part2.rar", "a.part3.rar", "b.rar", "b.r00", "b.r01", "c.rar", "d.part1.rar", "d.part3.rar", "e.part2.rar" })
            lib.Write(name, name.Length > 8 ? "xxxxxxxx" : "yy");
        var items = FolderWalker.Walk(lib.Root, includeArchives: true).ToDictionary(i => Path.GetFileName(i.Path));

        Assert.Equal(new[] { "a.part1.rar", "b.rar", "c.rar", "d.part1.rar", "e.part2.rar" }, items.Keys.Order(StringComparer.Ordinal));
        Assert.Equal(3, items["a.part1.rar"].Parts);
        Assert.Null(items["a.part1.rar"].Incomplete);
        Assert.Equal(3, items["b.rar"].Parts);
        Assert.Equal(1, items["c.rar"].Parts);
        Assert.Matches("part 2 .* missing", items["d.part1.rar"].Incomplete!);
        Assert.Matches("first part .* missing", items["e.part2.rar"].Error!);
        Assert.Equal(8 * 3, items["a.part1.rar"].Size);   // the size is the sum over the parts
    }

    [Fact]
    public void LaterPartsOfASplitArchiveAreNotTreatedAsArchives()
    {
        using var lib = new TempLibrary();
        foreach (var name in new[] { "a.part1.rar", "a.part2.rar", "a.part10.rar", "b.rar", "c.7z.001", "c.7z.002" }) lib.Write(name, "x");
        var seen = FolderWalker.Walk(lib.Root, includeArchives: true).Select(i => Path.GetFileName(i.Path)).Order(StringComparer.Ordinal);
        Assert.Equal(new[] { "a.part1.rar", "b.rar", "c.7z.001" }, seen);
    }
}
