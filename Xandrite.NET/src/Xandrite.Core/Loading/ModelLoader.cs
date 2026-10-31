using System.Runtime.InteropServices;
using Xandrite.Geometry;

namespace Xandrite.Loading;

/// <summary>Turns the bytes of an .stl or .3mf file into a <see cref="Mesh"/>.</summary>
public static class ModelLoader
{
    public static readonly IReadOnlySet<string> Extensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "stl", "3mf" };

    /// <param name="data">The whole file.</param>
    /// <param name="ext">"stl" or "3mf" (a leading dot is allowed, case does not matter).</param>
    public static Mesh Load(ReadOnlyMemory<byte> data, string ext)
    {
        switch (ext.TrimStart('.').ToLowerInvariant())
        {
            case "stl":
                return StlReader.Read(data.Span);
            case "3mf":
                using (var stream = AsStream(data)) return ThreeMfReader.Read(stream);
            default:
                throw new ModelFormatException("Unsupported file type: " + ext);
        }
    }

    public static Mesh LoadFile(string path) => Load(File.ReadAllBytes(path), Path.GetExtension(path));

    private static MemoryStream AsStream(ReadOnlyMemory<byte> data) =>
        MemoryMarshal.TryGetArray(data, out var segment) && segment.Array is not null
            ? new MemoryStream(segment.Array, segment.Offset, segment.Count, writable: false)
            : new MemoryStream(data.ToArray(), writable: false);
}
