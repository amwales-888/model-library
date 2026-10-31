using System.Numerics;
using System.Runtime.InteropServices;

namespace Xandrite.Geometry;

/// <summary>
/// One corner of a triangle, exactly as it is sent to the GPU (16 bytes).
/// Every triangle has its own three vertices (nothing is shared), so each face is shaded flat, as in the JS app.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct MeshVertex
{
    public Vector3 Position;

    /// <summary>Base colour in linear RGB, packed as R | G &lt;&lt; 8 | B &lt;&lt; 16 | A &lt;&lt; 24.</summary>
    public uint Color;

    public MeshVertex(Vector3 position, uint color)
    {
        Position = position;
        Color = color;
    }

    public const int SizeInBytes = 16;
}

/// <summary>
/// A model ready to render: a flat list of triangles in the file's own coordinates (millimetres, Z normally up),
/// with any 3MF build and component transforms already applied.
/// </summary>
public sealed class Mesh
{
    public Mesh(MeshVertex[] vertices, int vertexCount, bool hasOwnColors)
    {
        if (vertexCount % 3 != 0) throw new ArgumentException("The vertex count must be a multiple of three.", nameof(vertexCount));
        if (vertexCount > vertices.Length) throw new ArgumentOutOfRangeException(nameof(vertexCount));
        Vertices = vertices;
        VertexCount = vertexCount;
        HasOwnColors = hasOwnColors;
        Bounds = BoundingBox.Of(vertices.AsSpan(0, vertexCount));
    }

    /// <summary>The vertex array. It can be longer than <see cref="VertexCount"/>; only the first VertexCount are used.</summary>
    public MeshVertex[] Vertices { get; }

    public int VertexCount { get; }

    public int TriangleCount => VertexCount / 3;

    /// <summary>True when the file supplied colours (3MF materials or a coloured binary STL).</summary>
    public bool HasOwnColors { get; }

    public BoundingBox Bounds { get; }

    public ReadOnlySpan<MeshVertex> AsSpan() => Vertices.AsSpan(0, VertexCount);
}

public readonly record struct BoundingBox(Vector3 Min, Vector3 Max)
{
    public Vector3 Size => Max - Min;

    public Vector3 Center => (Min + Max) * 0.5f;

    public static BoundingBox Of(ReadOnlySpan<MeshVertex> vertices)
    {
        if (vertices.IsEmpty) return new BoundingBox(Vector3.Zero, Vector3.Zero);
        var min = new Vector3(float.PositiveInfinity);
        var max = new Vector3(float.NegativeInfinity);
        foreach (ref readonly var v in vertices)
        {
            min = Vector3.Min(min, v.Position);
            max = Vector3.Max(max, v.Position);
        }
        return new BoundingBox(min, max);
    }
}
