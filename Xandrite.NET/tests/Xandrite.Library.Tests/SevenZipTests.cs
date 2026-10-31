using System.Text;
using Xandrite.Library.Scanning;
using Xandrite.Library.SevenZip;
using static Xandrite.Library.Tests.TempLibrary;

namespace Xandrite.Library.Tests;

/// <summary>
/// .7z and .rar archives, read with 7-Zip's library. Ported from the Electron app's test/archive.test.js.
///
/// The archives are in Fixtures/archives (made with 7-Zip 23.01 and RAR 7.00). Every model in them is one of:
///   models/leg.stl       "solid leg\n" (dated 2024-01-02 03:04:05 UTC)
///   models/sub/arm.3mf   "pk arm"
///   models/big.stl       6000 random bytes
/// 7z.dll is copied next to the tests on Windows; elsewhere XANDRITE_7Z_LIB must name a 7z.so. Without either, these
/// tests have nothing to test and pass without checking.
/// </summary>
public class SevenZipTests
{
    private static readonly char S = Path.DirectorySeparatorChar;
    private const string Leg = "solid leg\n";

    private static string Fixture(string name) => Path.Combine(AppContext.BaseDirectory, "Fixtures", "archives", name);

    private static void Copy(TempLibrary lib, params string[] names)
    {
        foreach (var name in names) File.Copy(Fixture(name), lib.At(name));
    }

    private static bool Available => SevenZipArchiveReader.IsAvailable;

    [Fact]
    public async Task ModelsInsideASolid7zAreFoundAndHashedLikeLooseFiles()
    {
        if (!Available) return;
        using var lib = new TempLibrary();
        Copy(lib, "solid.7z");
        var summary = await lib.Scan();

        Assert.Equal(0, summary.Errors);
        Assert.Equal(1, summary.Archives);
        Assert.Equal(1, summary.NestedArchives);          // inner.zip, skipped
        var rows = lib.Present();
        Assert.Equal(new[] { "arm.3mf", "big.stl", "leg.stl" }, rows.Select(r => r.Name).Order());   // readme and .hidden left out
        var leg = rows.Single(r => r.Name == "leg.stl");
        Assert.Equal(Sha(Leg), leg.Sha256);
        Assert.Equal("solid.7z", leg.ArchiveName);
        Assert.Equal("models/leg.stl", leg.Entry);
        Assert.Equal(lib.At("solid.7z") + S + "models" + S + "leg.stl", leg.Path);
        Assert.Equal(new DateTimeOffset(2024, 1, 2, 3, 4, 5, TimeSpan.Zero).ToUnixTimeMilliseconds(), leg.ModifiedMs);
        Assert.Equal(0x4365931CL, lib.Db.Locked(c => c.Scalar("SELECT crc32 FROM locations WHERE entry = 'models/leg.stl'")));
    }

    [Fact]
    public async Task TheSameModelLooseAndInsideA7zIsOneModel()
    {
        if (!Available) return;
        using var lib = new TempLibrary();
        lib.Write("leg.stl", Leg);
        Copy(lib, "nonsolid.7z");
        await lib.Scan();
        var legs = lib.Present().Where(r => r.Name == "leg.stl").ToList();
        Assert.Equal(2, legs.Count);
        Assert.Single(legs.Select(r => r.Sha256).Distinct());
    }

    [Fact]
    public async Task AnUnchangedArchiveIsNotOpenedAgainAndAChangedOneOnlyReadsWhatChanged()
    {
        if (!Available) return;
        using var lib = new TempLibrary();
        Copy(lib, "solid.7z");
        await lib.Scan();

        var again = await lib.Scan();
        Assert.Equal(3, again.Reused);
        Assert.Equal(0, again.Hashed);

        File.SetLastWriteTimeUtc(lib.At("solid.7z"), DateTime.UtcNow.AddMinutes(1));   // looks changed: opened, but nothing re-hashed
        var touched = await lib.Scan();
        Assert.Equal(3, touched.Reused);
        Assert.Equal(0, touched.Hashed);
    }

    [Fact]
    public async Task ADeletedArchiveMakesItsModelsMissing()
    {
        if (!Available) return;
        using var lib = new TempLibrary();
        Copy(lib, "set.rar");
        await lib.Scan();
        lib.Delete("set.rar");
        Assert.Equal(3, (await lib.Scan()).Missing);
    }

    [Fact]
    public async Task ARar5ArchiveIsRead()
    {
        if (!Available) return;
        using var lib = new TempLibrary();
        Copy(lib, "set.rar");
        var summary = await lib.Scan();
        Assert.Equal(0, summary.Errors);
        var leg = lib.Present().Single(r => r.Name == "leg.stl");
        Assert.Equal(Sha(Leg), leg.Sha256);
        Assert.Equal("set.rar", leg.ArchiveName);
    }

    [Fact]
    public async Task SplitAndMultiVolumeArchivesAreReadAsOne()
    {
        if (!Available) return;
        using var lib = new TempLibrary();
        Copy(lib, "split.7z.001", "split.7z.002", "split.7z.003", "split.7z.004", "volumes.part1.rar", "volumes.part2.rar", "volumes.part3.rar");
        var summary = await lib.Scan();
        Assert.Equal(0, summary.Errors);
        Assert.Equal(2, summary.Archives);
        var archives = lib.Present().GroupBy(r => r.ArchiveName).ToDictionary(g => g.Key!, g => g.Count());
        Assert.Equal(3, archives["split.7z.001"]);
        Assert.Equal(3, archives["volumes.part1.rar"]);
        Assert.Single(lib.Present().Where(r => r.Name == "big.stl").Select(r => r.Sha256).Distinct());   // whole, across parts
    }

    [Fact]
    public async Task ASplitArchiveWithAPartMissingIsReportedAndItsModelsKept()
    {
        if (!Available) return;
        using var lib = new TempLibrary();
        Copy(lib, "split.7z.001", "split.7z.002", "split.7z.003", "split.7z.004");
        await lib.Scan();
        lib.Delete("split.7z.003");
        var summary = await lib.Scan();
        Assert.Contains(summary.Problems, p => p.Message.Contains("part 3 of this split archive is missing"));
        Assert.Equal(0, summary.Missing);
        Assert.Equal(3, lib.Present().Count);
    }

    [Fact]
    public async Task PasswordProtectedArchivesAreReported()
    {
        if (!Available) return;
        using var lib = new TempLibrary();
        Copy(lib, "protected-headers.7z", "protected-files.7z");
        var summary = await lib.Scan();
        Assert.Equal(2, summary.Errors);
        Assert.All(summary.Problems, p => Assert.Contains("password-protected", p.Message));
        Assert.Empty(lib.Present());
    }

    [Fact]
    public async Task ADamagedEntryIsCaughtByItsChecksumAndTheOthersAreStillRead()
    {
        if (!Available) return;
        using var lib = new TempLibrary();
        Copy(lib, "damaged.7z");
        var summary = await lib.Scan();
        var problem = Assert.Single(summary.Problems);
        Assert.EndsWith("big.stl", problem.Path);
        Assert.Contains("checksum", problem.Message);
        Assert.Equal(new[] { "arm.3mf", "leg.stl" }, lib.Present().Select(r => r.Name).Order());
    }

    [Fact]
    public async Task ABrokenFileNamedLikeAnArchiveIsReportedAndDoesNotStopTheScan()
    {
        if (!Available) return;
        using var lib = new TempLibrary();
        lib.Write("broken.7z", "this is not an archive");
        lib.Write("ok.stl", Leg);
        var summary = await lib.Scan();
        Assert.Contains("not a valid archive, or damaged", summary.Problems.Single().Message);
        Assert.Equal("ok.stl", lib.Present().Single().Name);
    }

    [Fact]
    public async Task AModelInsideAnArchiveCanBeReadBackAndAMissingEntryIsReportedAsGone()
    {
        if (!Available) return;
        using var lib = new TempLibrary();
        Copy(lib, "solid.7z", "volumes.part1.rar", "volumes.part2.rar", "volumes.part3.rar");
        await lib.Scan();
        foreach (var row in lib.Present().Where(r => r.Name == "leg.stl"))
        {
            var location = lib.Db.GetLocation(row.Path)!;
            Assert.Equal(Leg, Encoding.UTF8.GetString(await ModelSource.Default.ReadAsync(location)));
            await Assert.ThrowsAsync<ModelGoneException>(() => ModelSource.Default.ReadAsync(location with { Entry = "models/gone.stl" }));
        }
        lib.Delete("solid.7z");
        var gone = lib.Db.GetLocation(lib.Present().First(r => r.ArchiveName == "solid.7z").Path)!;
        await Assert.ThrowsAsync<ModelGoneException>(() => ModelSource.Default.ReadAsync(gone));
    }

    [Fact]
    public async Task DownloadExtractsFromArchivesInOnePass()
    {
        if (!Available) return;
        using var lib = new TempLibrary();
        Copy(lib, "solid.7z", "set.rar");
        await lib.Scan();
        string destination = Path.Combine(lib.Dir, "out");
        Directory.CreateDirectory(destination);
        var result = await Downloads.CopyAsync(lib.Present().Where(r => r.Name != "big.stl").ToList(), destination);
        Assert.Equal(4, result.Copied);
        Assert.Empty(result.Failed);
        Assert.Equal(Leg, File.ReadAllText(Path.Combine(destination, "leg.stl")));
        Assert.Equal(Leg, File.ReadAllText(Path.Combine(destination, "leg (2).stl")));
    }

    [Fact]
    public async Task LimitsApplyToArchivesToo()
    {
        if (!Available) return;
        using var lib = new TempLibrary();
        Copy(lib, "nonsolid.7z");
        var summary = await lib.Scan(limits: new ArchiveLimits { MaxEntryBytes = 1000 });
        Assert.Contains(summary.Problems, p => p.Path.EndsWith("big.stl") && p.Message.StartsWith("too large to read from an archive"));
        Assert.Equal(2, lib.Present().Count);

        using var lib2 = new TempLibrary();
        Copy(lib2, "nonsolid.7z");
        var refused = await lib2.Scan(limits: new ArchiveLimits { MaxEntries = 2 });
        Assert.Contains("too many entries", refused.Problems.Single().Message);
    }

    [Fact]
    public void ArchivesAreRecognisedByName()
    {
        var reader = new SevenZipArchiveReader();
        Assert.True(reader.CanRead("a.7z"));
        Assert.True(reader.CanRead("a.RAR"));
        Assert.True(reader.CanRead("a.7z.001"));
        Assert.True(reader.CanRead("a.part1.rar"));
        Assert.False(reader.CanRead("a.7z.002"));
        Assert.False(reader.CanRead("a.part2.rar"));
        Assert.False(reader.CanRead("a.zip"));
    }
}
