using System.IO.Compression;
using System.Numerics;
using System.Text;

namespace Xandrite.Core.Tests;

/// <summary>Small model files built in memory for the tests.</summary>
internal static class TestModels
{
    /// <summary>A binary STL with the given triangles. The header text can be chosen (some exporters start it with "solid").</summary>
    public static byte[] BinaryStl(IReadOnlyList<(Vector3 A, Vector3 B, Vector3 C)> triangles, string header = "binary test", ushort attribute = 0, byte[]? rawHeader = null)
    {
        using var stream = new MemoryStream();
        using var w = new BinaryWriter(stream);
        var h = rawHeader ?? new byte[80];
        if (rawHeader is null) Encoding.ASCII.GetBytes(header).CopyTo(h, 0);
        w.Write(h);
        w.Write((uint)triangles.Count);
        foreach (var (a, b, c) in triangles)
        {
            foreach (var v in new[] { Vector3.Zero, a, b, c }) { w.Write(v.X); w.Write(v.Y); w.Write(v.Z); }
            w.Write(attribute);
        }
        w.Flush();
        return stream.ToArray();
    }

    /// <summary>The twelve triangles of an axis-aligned box.</summary>
    public static List<(Vector3, Vector3, Vector3)> Box(Vector3 min, Vector3 max)
    {
        Vector3 V(int i) => new((i & 1) != 0 ? max.X : min.X, (i & 2) != 0 ? max.Y : min.Y, (i & 4) != 0 ? max.Z : min.Z);
        int[][] faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
        var list = new List<(Vector3, Vector3, Vector3)>();
        foreach (var q in faces)
        {
            list.Add((V(q[0]), V(q[1]), V(q[2])));
            list.Add((V(q[0]), V(q[2]), V(q[3])));
        }
        return list;
    }

    /// <summary>A 3MF package from a set of part name → XML text.</summary>
    public static byte[] Package(params (string Name, string Text)[] parts)
    {
        using var stream = new MemoryStream();
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (name, text) in parts)
            {
                using var s = zip.CreateEntry(name).Open();
                s.Write(Encoding.UTF8.GetBytes(text));
            }
        }
        return stream.ToArray();
    }

    public const string Rels =
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">" +
        "<Relationship Target=\"/3D/3dmodel.model\" Id=\"rel0\" Type=\"http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel\"/></Relationships>";

    public const string CoreNs = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
    public const string Production = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06";
    public const string Materials = "http://schemas.microsoft.com/3dmanufacturing/material/2015/02";

    /// <summary>One triangle (0,0,0) (10,0,0) (0,10,0) as a 3MF mesh element, with optional triangle attributes.</summary>
    public static string TriangleMesh(string triangleAttributes = "") =>
        "<mesh><vertices><vertex x=\"0\" y=\"0\" z=\"0\"/><vertex x=\"10\" y=\"0\" z=\"0\"/><vertex x=\"0\" y=\"10\" z=\"0\"/></vertices>" +
        $"<triangles><triangle v1=\"0\" v2=\"1\" v3=\"2\" {triangleAttributes}/></triangles></mesh>";

    public static string SamplePath(string name) => Path.Combine(AppContext.BaseDirectory, "samples", name);
}
