using System.Numerics;
using Xandrite.Geometry;

namespace Xandrite.Loading;

/// <summary>Collects triangles into a growing vertex array.</summary>
internal sealed class MeshBuilder
{
    private MeshVertex[] _vertices;
    private int _count;

    public MeshBuilder(long expectedTriangles = 1024)
    {
        long vertices = Math.Clamp(expectedTriangles, 1, Array.MaxLength / 3) * 3;
        _vertices = new MeshVertex[vertices];
    }

    public int TriangleCount => _count / 3;

    public bool HasOwnColors { get; set; }

    public void Add(Vector3 a, Vector3 b, Vector3 c, uint color) => Add(a, b, c, color, color, color);

    public void Add(Vector3 a, Vector3 b, Vector3 c, uint colorA, uint colorB, uint colorC)
    {
        if (_count + 3 > _vertices.Length) Grow();
        _vertices[_count++] = new MeshVertex(a, colorA);
        _vertices[_count++] = new MeshVertex(b, colorB);
        _vertices[_count++] = new MeshVertex(c, colorC);
    }

    private void Grow()
    {
        long next = Math.Min((long)_vertices.Length * 2, Array.MaxLength / 3 * 3);
        if (next <= _vertices.Length) throw new ModelFormatException("The model has more triangles than can be held in memory.");
        Array.Resize(ref _vertices, (int)next);
    }

    public Mesh Build()
    {
        if (_count == 0) throw new ModelFormatException("The file contains no triangles.");
        return new Mesh(_vertices, _count, HasOwnColors);
    }
}
