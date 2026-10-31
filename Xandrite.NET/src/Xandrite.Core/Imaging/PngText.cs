using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;

namespace Xandrite.Imaging;

/// <summary>
/// Text stored inside PNG files. Thumbnails carry their view settings in an iTXt chunk named
/// <see cref="Look.StateKeyword"/>, as the JS app's renderer/lib/png-text.js wrote them.
/// </summary>
public static class PngText
{
    private static ReadOnlySpan<byte> Signature => [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    /// <summary>
    /// The body of an uncompressed iTXt chunk: keyword, 0, compression flag 0, method 0, empty language tag + 0,
    /// empty translated keyword + 0, then the UTF-8 text.
    /// </summary>
    internal static byte[] ITxtBody(string keyword, string text)
    {
        if (keyword.Length is < 1 or > 79) throw new ArgumentException("A PNG keyword has 1 to 79 characters.", nameof(keyword));
        byte[] k = Encoding.Latin1.GetBytes(keyword);
        byte[] t = Encoding.UTF8.GetBytes(text);
        var body = new byte[k.Length + 5 + t.Length];
        k.CopyTo(body, 0);
        t.CopyTo(body, k.Length + 5);
        return body;
    }

    /// <summary>
    /// A copy of a PNG with the text added in an iTXt chunk straight after the header chunk, like the JS app's
    /// embedPngText. Data that is not a PNG is returned unchanged.
    /// </summary>
    public static byte[] Embed(ReadOnlySpan<byte> png, string keyword, string text)
    {
        if (png.Length < 33 || !png[..8].SequenceEqual(Signature)) return png.ToArray();
        using var output = new MemoryStream(png.Length + text.Length + 64);
        output.Write(png[..33]);                                   // signature + IHDR chunk
        PngEncoder.WriteChunk(output, "iTXt"u8, ITxtBody(keyword, text));
        output.Write(png[33..]);
        return output.ToArray();
    }

    /// <summary>Finds the text stored under a keyword (iTXt, compressed or not, or tEXt). Null if there is none.</summary>
    public static string? Read(ReadOnlySpan<byte> png, string keyword)
    {
        if (png.Length < 8 || !png[..8].SequenceEqual(Signature)) return null;
        byte[] wanted = Encoding.Latin1.GetBytes(keyword);
        int pos = 8;
        while (pos + 12 <= png.Length)
        {
            int length = BinaryPrimitives.ReadInt32BigEndian(png[pos..]);
            if (length < 0 || pos + 12 + (long)length > png.Length) return null;
            var type = png.Slice(pos + 4, 4);
            var data = png.Slice(pos + 8, length);
            if (type.SequenceEqual("IEND"u8)) return null;

            int zero = data.IndexOf((byte)0);
            if (zero > 0 && data[..zero].SequenceEqual(wanted))
            {
                if (type.SequenceEqual("tEXt"u8)) return Encoding.Latin1.GetString(data[(zero + 1)..]);
                if (type.SequenceEqual("iTXt"u8)) return ReadITxt(data[(zero + 1)..]);
            }
            pos += 12 + length;
        }
        return null;
    }

    private static string? ReadITxt(ReadOnlySpan<byte> rest)
    {
        if (rest.Length < 2) return null;
        bool compressed = rest[0] == 1;
        rest = rest[2..];
        int language = rest.IndexOf((byte)0);
        if (language < 0) return null;
        rest = rest[(language + 1)..];
        int translated = rest.IndexOf((byte)0);
        if (translated < 0) return null;
        rest = rest[(translated + 1)..];
        if (!compressed) return Encoding.UTF8.GetString(rest);

        using var input = new MemoryStream(rest.ToArray());
        using var zlib = new ZLibStream(input, CompressionMode.Decompress);
        using var reader = new StreamReader(zlib, Encoding.UTF8);
        return reader.ReadToEnd();
    }
}
