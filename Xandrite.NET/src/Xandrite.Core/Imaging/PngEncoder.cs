using System.Buffers.Binary;
using System.IO.Compression;

namespace Xandrite.Imaging;

/// <summary>
/// Writes 8-bit RGB PNG files, optionally with UTF-8 text chunks (iTXt) straight after the header, where the JS app
/// put the view settings. Each row gets whichever PNG filter makes it smallest, which keeps thumbnails compact.
/// </summary>
public static class PngEncoder
{
    private static ReadOnlySpan<byte> Signature => [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    /// <param name="rgba">Pixels as RGBA, rows top to bottom, <paramref name="stride"/> bytes apart. Alpha is dropped.</param>
    public static byte[] EncodeRgb(ReadOnlySpan<byte> rgba, int width, int height, int stride, IEnumerable<KeyValuePair<string, string>>? text = null)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(width, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(height, 1);
        if (stride < width * 4 || rgba.Length < stride * (height - 1) + width * 4) throw new ArgumentException("The pixel buffer is too small.", nameof(rgba));

        using var output = new MemoryStream(width * height);
        output.Write(Signature);

        Span<byte> header = stackalloc byte[13];
        BinaryPrimitives.WriteInt32BigEndian(header, width);
        BinaryPrimitives.WriteInt32BigEndian(header[4..], height);
        header[8] = 8;    // bits per channel
        header[9] = 2;    // colour type: RGB
        header[10] = 0;   // deflate
        header[11] = 0;   // adaptive filtering
        header[12] = 0;   // not interlaced
        WriteChunk(output, "IHDR"u8, header);

        if (text is not null)
        {
            foreach (var (keyword, value) in text) WriteChunk(output, "iTXt"u8, PngText.ITxtBody(keyword, value));
        }

        WriteChunk(output, "IDAT"u8, CompressRows(rgba, width, height, stride));
        WriteChunk(output, "IEND"u8, []);
        return output.ToArray();
    }

    internal static void WriteChunk(Stream output, ReadOnlySpan<byte> type, ReadOnlySpan<byte> data)
    {
        Span<byte> buffer = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(buffer, data.Length);
        output.Write(buffer);
        output.Write(type);
        output.Write(data);
        uint crc = Crc32.Update(Crc32.Compute(type), data);
        BinaryPrimitives.WriteUInt32BigEndian(buffer, crc);
        output.Write(buffer);
    }

    private static byte[] CompressRows(ReadOnlySpan<byte> rgba, int width, int height, int stride)
    {
        int rowBytes = width * 3;
        var previous = new byte[rowBytes];
        var current = new byte[rowBytes];
        var candidate = new byte[rowBytes];
        var best = new byte[rowBytes];

        using var compressed = new MemoryStream();
        using (var zlib = new ZLibStream(compressed, CompressionLevel.Optimal, leaveOpen: true))
        {
            for (int y = 0; y < height; y++)
            {
                var source = rgba.Slice(y * stride, width * 4);
                for (int x = 0, i = 0; x < width; x++, i += 3)
                {
                    current[i] = source[x * 4];
                    current[i + 1] = source[x * 4 + 1];
                    current[i + 2] = source[x * 4 + 2];
                }

                // Try the five filters; keep the one with the smallest sum of absolute values (the usual heuristic).
                byte bestFilter = 0;
                long bestScore = long.MaxValue;
                for (byte filter = 0; filter <= 4; filter++)
                {
                    long score = Filter(filter, current, previous, candidate);
                    if (score < bestScore)
                    {
                        bestScore = score;
                        bestFilter = filter;
                        (best, candidate) = (candidate, best);
                    }
                }
                zlib.WriteByte(bestFilter);
                zlib.Write(best);
                (previous, current) = (current, previous);
            }
        }
        return compressed.ToArray();
    }

    private static long Filter(byte type, byte[] row, byte[] above, byte[] output)
    {
        const int bpp = 3;
        long score = 0;
        for (int i = 0; i < row.Length; i++)
        {
            int a = i >= bpp ? row[i - bpp] : 0;
            int b = above[i];
            int c = i >= bpp ? above[i - bpp] : 0;
            int predicted = type switch
            {
                0 => 0,
                1 => a,
                2 => b,
                3 => (a + b) >> 1,
                _ => Paeth(a, b, c),
            };
            byte value = (byte)(row[i] - predicted);
            output[i] = value;
            score += value < 128 ? value : 256 - value;
        }
        return score;
    }

    private static int Paeth(int a, int b, int c)
    {
        int p = a + b - c;
        int pa = Math.Abs(p - a), pb = Math.Abs(p - b), pc = Math.Abs(p - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
}
