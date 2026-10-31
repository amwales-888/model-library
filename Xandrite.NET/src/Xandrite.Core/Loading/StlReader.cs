using System.Buffers.Binary;
using System.Globalization;
using System.Numerics;
using Xandrite.Geometry;

namespace Xandrite.Loading;

/// <summary>
/// Reads binary and ASCII STL files. Follows three.js's STLLoader, which the JS app used, including its rules for
/// telling the two kinds apart and the "COLOR=" per-face colours some binary files carry (Materialise Magics).
/// The normals stored in the file are ignored: faces are shaded from their own geometry, as the JS app did.
/// </summary>
public static class StlReader
{
    private const int HeaderSize = 80;
    private const int BinaryTriangleSize = 50;

    public static Mesh Read(ReadOnlySpan<byte> data)
    {
        if (data.IsEmpty) throw new ModelFormatException("The file is empty.");

        long declared = data.Length >= 84 ? BinaryPrimitives.ReadUInt32LittleEndian(data.Slice(HeaderSize, 4)) : -1;
        long expected = declared >= 0 ? 84 + declared * BinaryTriangleSize : -1;

        if (expected == data.Length) return ReadBinary(data, declared);
        if (StartsWithSolid(data)) return ReadAscii(data);
        if (expected >= 0 && expected <= data.Length) return ReadBinary(data, declared);   // extra trailing bytes are tolerated
        throw new ModelFormatException("This is not a valid STL file: it is neither binary STL nor ASCII STL.");
    }

    /// <summary>"solid" within the first few bytes (a byte-order mark may come first), as three.js checks.</summary>
    private static bool StartsWithSolid(ReadOnlySpan<byte> data)
    {
        ReadOnlySpan<byte> solid = "solid"u8;
        for (int offset = 0; offset < 5 && offset + solid.Length <= data.Length; offset++)
        {
            if (data.Slice(offset, solid.Length).SequenceEqual(solid)) return true;
        }
        return false;
    }

    private static Mesh ReadBinary(ReadOnlySpan<byte> data, long triangles)
    {
        if (triangles == 0) throw new ModelFormatException("The file contains no triangles.");

        uint defaultColor = Look.MaterialColorPacked;
        bool hasColors = false;
        var header = data[..HeaderSize];
        for (int i = 0; i < HeaderSize - 10; i++)
        {
            if (header.Slice(i, 6).SequenceEqual("COLOR="u8))
            {
                hasColors = true;
                defaultColor = ColorSpace.Pack(new Vector3(header[i + 6] / 255f, header[i + 7] / 255f, header[i + 8] / 255f));
            }
        }

        var builder = new MeshBuilder(triangles) { HasOwnColors = hasColors };
        uint color = Look.MaterialColorPacked;
        for (long t = 0; t < triangles; t++)
        {
            var face = data.Slice((int)(84 + t * BinaryTriangleSize), BinaryTriangleSize);
            var a = ReadVector(face[12..]);
            var b = ReadVector(face[24..]);
            var c = ReadVector(face[36..]);
            if (hasColors)
            {
                ushort packed = BinaryPrimitives.ReadUInt16LittleEndian(face[48..]);
                color = (packed & 0x8000) == 0
                    ? ColorSpace.Pack(new Vector3((packed & 0x1F) / 31f, ((packed >> 5) & 0x1F) / 31f, ((packed >> 10) & 0x1F) / 31f))
                    : defaultColor;
            }
            builder.Add(a, b, c, color);
        }
        return builder.Build();
    }

    private static Vector3 ReadVector(ReadOnlySpan<byte> s) => new(
        BinaryPrimitives.ReadSingleLittleEndian(s),
        BinaryPrimitives.ReadSingleLittleEndian(s[4..]),
        BinaryPrimitives.ReadSingleLittleEndian(s[8..]));

    /// <summary>
    /// ASCII STL: every "facet ... endfacet" block with exactly three "vertex x y z" lines becomes a triangle.
    /// Several "solid" blocks in one file are all read.
    /// </summary>
    private static Mesh ReadAscii(ReadOnlySpan<byte> data)
    {
        var builder = new MeshBuilder(Math.Max(16, data.Length / 250));
        Span<Vector3> corners = stackalloc Vector3[3];
        int cornerCount = 0;
        bool inFacet = false;
        int pos = 0;

        while (NextToken(data, ref pos, out var token))
        {
            if (token.SequenceEqual("facet"u8))
            {
                inFacet = true;
                cornerCount = 0;
            }
            else if (token.SequenceEqual("vertex"u8))
            {
                var v = new Vector3(ReadFloat(data, ref pos), ReadFloat(data, ref pos), ReadFloat(data, ref pos));
                if (inFacet && cornerCount < 3) corners[cornerCount] = v;
                cornerCount++;
            }
            else if (token.SequenceEqual("endfacet"u8))
            {
                if (inFacet && cornerCount == 3) builder.Add(corners[0], corners[1], corners[2], Look.MaterialColorPacked);
                inFacet = false;
            }
        }
        return builder.Build();
    }

    private static float ReadFloat(ReadOnlySpan<byte> data, ref int pos)
    {
        if (!NextToken(data, ref pos, out var token) ||
            !float.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out float value))
        {
            throw new ModelFormatException("This is not a valid STL file: a vertex has a coordinate that is not a number.");
        }
        return value;
    }

    private static bool NextToken(ReadOnlySpan<byte> data, ref int pos, out ReadOnlySpan<byte> token)
    {
        while (pos < data.Length && IsSpace(data[pos])) pos++;
        int start = pos;
        while (pos < data.Length && !IsSpace(data[pos])) pos++;
        token = data[start..pos];
        return !token.IsEmpty;
    }

    private static bool IsSpace(byte b) => b is (byte)' ' or (byte)'\t' or (byte)'\r' or (byte)'\n' or (byte)'\f' or (byte)'\v';
}
