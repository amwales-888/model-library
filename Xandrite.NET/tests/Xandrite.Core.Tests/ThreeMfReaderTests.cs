using System.Numerics;
using Xandrite.Geometry;
using Xandrite.Loading;
using static Xandrite.Core.Tests.TestModels;

namespace Xandrite.Core.Tests;

public class ThreeMfReaderTests
{
    private static Mesh Load(byte[] package) => ModelLoader.Load(package, "3mf");

    [Fact]
    public void ReadsAMeshFromTheMainModel()
    {
        var mesh = Load(Package(
            ("_rels/.rels", Rels),
            ("3D/3dmodel.model", $"<model xmlns=\"{CoreNs}\"><resources><object id=\"1\">{TriangleMesh()}</object></resources>" +
                                 "<build><item objectid=\"1\" transform=\"1 0 0 0 1 0 0 0 1 5 6 7\"/></build></model>")));
        Assert.Equal(1, mesh.TriangleCount);
        Assert.Equal(new Vector3(5, 6, 7), mesh.Bounds.Min);
        Assert.Equal(new Vector3(15, 16, 7), mesh.Bounds.Max);
    }

    [Fact]
    public void FollowsComponentsStoredInOtherModelFiles()
    {
        // The layout Bambu Studio and PrusaSlicer write: the mesh lives in 3D/Objects/, the main model points at it.
        var mesh = Load(Package(
            ("_rels/.rels", Rels),
            ("3D/3dmodel.model",
                $"<model xmlns=\"{CoreNs}\" xmlns:p=\"{Production}\"><resources>" +
                "<object id=\"9\"><components>" +
                "<component p:path=\"/3D/Objects/object_1.model\" objectid=\"1\" transform=\"2 0 0 0 2 0 0 0 2 0 0 0\"/>" +
                "<component p:path=\"/3D/Objects/object_1.model\" objectid=\"1\" transform=\"1 0 0 0 1 0 0 0 1 100 0 0\"/>" +
                "</components></object></resources>" +
                "<build><item objectid=\"9\" transform=\"1 0 0 0 1 0 0 0 1 0 0 50\"/></build></model>"),
            ("3D/Objects/object_1.model", $"<model xmlns=\"{CoreNs}\"><resources><object id=\"1\">{TriangleMesh()}</object></resources><build/></model>")));

        Assert.Equal(2, mesh.TriangleCount);
        // First copy scaled by 2 (0..20), second moved by 100 (100..110); the build item lifts both by 50.
        Assert.Equal(new Vector3(0, 0, 50), mesh.Bounds.Min);
        Assert.Equal(new Vector3(110, 20, 50), mesh.Bounds.Max);
    }

    [Fact]
    public void KeepsBaseMaterialAndColorGroupColours()
    {
        var mesh = Load(Package(
            ("_rels/.rels", Rels),
            ("3D/3dmodel.model",
                $"<model xmlns=\"{CoreNs}\" xmlns:m=\"{Materials}\"><resources>" +
                "<basematerials id=\"1\"><base name=\"Red\" displaycolor=\"#FF0000\"/><base name=\"Blue\" displaycolor=\"#0000FFFF\"/></basematerials>" +
                "<m:colorgroup id=\"2\"><m:color color=\"#00FF00\"/><m:color color=\"#FFFFFF\"/></m:colorgroup>" +
                $"<object id=\"3\" pid=\"1\" pindex=\"1\">{TriangleMesh()}</object>" +
                $"<object id=\"4\">{TriangleMesh("pid=\"2\" p1=\"0\" p2=\"1\" p3=\"0\"")}</object>" +
                "</resources><build><item objectid=\"3\"/><item objectid=\"4\"/></build></model>")));

        Assert.True(mesh.HasOwnColors);
        uint blue = ColorSpace.PackHex(0x0000FF), green = ColorSpace.PackHex(0x00FF00), white = ColorSpace.PackHex(0xFFFFFF);
        Assert.Equal(blue, mesh.Vertices[0].Color);     // object default pid/pindex
        Assert.Equal(green, mesh.Vertices[3].Color);    // per-corner colours
        Assert.Equal(white, mesh.Vertices[4].Color);
        Assert.Equal(green, mesh.Vertices[5].Color);
    }

    [Fact]
    public void FindsTheMainModelThroughTheRelationships()
    {
        const string rels = "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">" +
                            "<Relationship Target=\"/3D/Elsewhere.model\" Id=\"r\" Type=\"http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel\"/></Relationships>";
        var mesh = Load(Package(
            ("_rels/.rels", rels),
            ("3D/Elsewhere.model", $"<model xmlns=\"{CoreNs}\"><resources><object id=\"1\">{TriangleMesh()}</object></resources><build><item objectid=\"1\"/></build></model>")));
        Assert.Equal(1, mesh.TriangleCount);
    }

    [Fact]
    public void ReadsTheColouredSample()
    {
        var mesh = ModelLoader.LoadFile(SamplePath("coloured-parts.3mf"));
        Assert.Equal(210, mesh.TriangleCount);
        Assert.True(mesh.HasOwnColors);
    }

    [Fact]
    public void AFileThatIsNotAZipIsRejected()
    {
        var e = Assert.Throws<ModelFormatException>(() => Load([1, 2, 3, 4, 5]));
        Assert.StartsWith("This is not a readable 3MF file", e.Message);
    }

    [Fact]
    public void APackageWithoutBuildItemsIsRejected()
    {
        var e = Assert.Throws<ModelFormatException>(() => Load(Package(
            ("_rels/.rels", Rels),
            ("3D/3dmodel.model", $"<model xmlns=\"{CoreNs}\"><resources><object id=\"1\">{TriangleMesh()}</object></resources><build/></model>"))));
        Assert.Equal("This is not a readable 3MF file (the 3MF has no build items).", e.Message);
    }

    [Fact]
    public void AMissingComponentFileIsReported()
    {
        var e = Assert.Throws<ModelFormatException>(() => Load(Package(
            ("_rels/.rels", Rels),
            ("3D/3dmodel.model",
                $"<model xmlns=\"{CoreNs}\" xmlns:p=\"{Production}\"><resources><object id=\"9\"><components>" +
                "<component p:path=\"/3D/Objects/gone.model\" objectid=\"1\"/></components></object></resources>" +
                "<build><item objectid=\"9\"/></build></model>"))));
        Assert.Contains("missing 3D/Objects/gone.model", e.Message);
    }

    [Fact]
    public void ATriangleThatPointsOutsideTheVerticesIsRejected()
    {
        var e = Assert.Throws<ModelFormatException>(() => Load(Package(
            ("_rels/.rels", Rels),
            ("3D/3dmodel.model",
                $"<model xmlns=\"{CoreNs}\"><resources><object id=\"1\"><mesh><vertices><vertex x=\"0\" y=\"0\" z=\"0\"/></vertices>" +
                "<triangles><triangle v1=\"0\" v2=\"1\" v3=\"2\"/></triangles></mesh></object></resources><build><item objectid=\"1\"/></build></model>"))));
        Assert.Contains("points to a vertex that does not exist", e.Message);
    }
}
