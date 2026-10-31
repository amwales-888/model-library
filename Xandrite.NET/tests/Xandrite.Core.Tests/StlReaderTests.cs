using System.Numerics;
using System.Text;
using Xandrite.Geometry;
using Xandrite.Loading;

namespace Xandrite.Core.Tests;

public class StlReaderTests
{
    [Fact]
    public void ReadsABinaryStl()
    {
        var data = TestModels.BinaryStl(TestModels.Box(new Vector3(-1, -2, -3), new Vector3(4, 5, 6)));
        var mesh = StlReader.Read(data);
        Assert.Equal(12, mesh.TriangleCount);
        Assert.Equal(new Vector3(-1, -2, -3), mesh.Bounds.Min);
        Assert.Equal(new Vector3(4, 5, 6), mesh.Bounds.Max);
        Assert.False(mesh.HasOwnColors);
        Assert.Equal(Look.MaterialColorPacked, mesh.Vertices[0].Color);
    }

    [Fact]
    public void ABinaryStlWhoseHeaderStartsWithSolidIsStillBinary()
    {
        // Many exporters write "solid" at the start of a binary header; the exact size decides, as in three.js.
        var data = TestModels.BinaryStl(TestModels.Box(Vector3.Zero, Vector3.One), header: "solid exported by some CAD tool");
        Assert.Equal(12, StlReader.Read(data).TriangleCount);
    }

    [Fact]
    public void ABinaryStlWithTrailingBytesIsAccepted()
    {
        var data = TestModels.BinaryStl(TestModels.Box(Vector3.Zero, Vector3.One)).Concat(new byte[7]).ToArray();
        Assert.Equal(12, StlReader.Read(data).TriangleCount);
    }

    [Fact]
    public void ReadsAnAsciiStl()
    {
        const string text = """
            solid pyramid
              facet normal 0 0 -1
                outer loop
                  vertex 0 0 0
                  vertex 1.5e1 0 0
                  vertex 0 10 0
                endloop
              endfacet
              facet normal 0 0 0
                outer loop
                  vertex 0 0 0
                  vertex 15 0 0
                  vertex 0 0 -7.25
                endloop
              endfacet
            endsolid pyramid
            """;
        var mesh = StlReader.Read(Encoding.ASCII.GetBytes(text));
        Assert.Equal(2, mesh.TriangleCount);
        Assert.Equal(new Vector3(15, 10, 0), mesh.Bounds.Max);
        Assert.Equal(-7.25f, mesh.Bounds.Min.Z);
    }

    [Fact]
    public void ReadsTheAsciiSample()
    {
        var mesh = ModelLoader.LoadFile(TestModels.SamplePath("ascii-pyramid.stl"));
        Assert.Equal(4, mesh.TriangleCount);
    }

    [Fact]
    public void ReadsPerFaceColoursFromAColorHeader()
    {
        // "COLOR=" followed by the default colour; bit 15 clear means the face has its own 5-5-5 colour.
        var header = new byte[80];
        Encoding.ASCII.GetBytes("COLOR=").CopyTo(header, 10);
        header[16] = 255; header[17] = 0; header[18] = 0; header[19] = 255;
        ushort pureBlue = 31 << 10;
        var data = TestModels.BinaryStl(TestModels.Box(Vector3.Zero, Vector3.One), attribute: pureBlue, rawHeader: header);
        var mesh = StlReader.Read(data);
        Assert.True(mesh.HasOwnColors);
        Assert.Equal(ColorSpace.Pack(new Vector3(0, 0, 1)), mesh.Vertices[0].Color);
    }

    [Fact]
    public void AnEmptyFileIsRejected()
    {
        var e = Assert.Throws<ModelFormatException>(() => StlReader.Read([]));
        Assert.Equal("The file is empty.", e.Message);
    }

    [Fact]
    public void SomethingThatIsNotAnStlIsRejected()
    {
        var e = Assert.Throws<ModelFormatException>(() => StlReader.Read(Encoding.ASCII.GetBytes("hello, this is not a model")));
        Assert.Contains("neither binary STL nor ASCII STL", e.Message);
    }

    [Fact]
    public void AnAsciiStlWithNoFacetsHasNoTriangles()
    {
        var e = Assert.Throws<ModelFormatException>(() => StlReader.Read(Encoding.ASCII.GetBytes("solid empty\nendsolid empty\n")));
        Assert.Equal("The file contains no triangles.", e.Message);
    }
}
