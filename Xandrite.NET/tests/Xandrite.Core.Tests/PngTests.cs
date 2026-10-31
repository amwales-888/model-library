using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;
using Xandrite.Imaging;

namespace Xandrite.Core.Tests;

public class PngTests
{
    private static byte[] Gradient(int width, int height)
    {
        var rgba = new byte[width * height * 4];
        for (int y = 0; y < height; y++)
            for (int x = 0; x < width; x++)
            {
                int i = (y * width + x) * 4;
                rgba[i] = (byte)(x * 255 / Math.Max(1, width - 1));
                rgba[i + 1] = (byte)(y * 255 / Math.Max(1, height - 1));
                rgba[i + 2] = (byte)((x * 7 + y * 13) & 0xFF);
                rgba[i + 3] = 255;
            }
        return rgba;
    }

    [Theory]
    [InlineData(1, 1)]
    [InlineData(17, 9)]
    [InlineData(128, 128)]
    public void EncodedPixelsDecodeToTheSameValues(int width, int height)
    {
        var rgba = Gradient(width, height);
        var png = PngEncoder.EncodeRgb(rgba, width, height, width * 4);
        var (w, h, rgb) = MiniPngDecoder.DecodeRgb(png);
        Assert.Equal(width, w);
        Assert.Equal(height, h);
        for (int p = 0; p < width * height; p++)
        {
            Assert.Equal(rgba[p * 4], rgb[p * 3]);
            Assert.Equal(rgba[p * 4 + 1], rgb[p * 3 + 1]);
            Assert.Equal(rgba[p * 4 + 2], rgb[p * 3 + 2]);
        }
    }

    [Fact]
    public void EveryChunkHasAValidCrc()
    {
        var png = PngEncoder.EncodeRgb(Gradient(8, 8), 8, 8, 32, [new("ModelThumbnailer", "{\"a\": \"é\"}")]);
        int pos = 8;
        int chunks = 0;
        while (pos < png.Length)
        {
            int length = BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(pos));
            uint crc = BinaryPrimitives.ReadUInt32BigEndian(png.AsSpan(pos + 8 + length));
            Assert.Equal(Crc32.Compute(png.AsSpan(pos + 4, 4 + length)), crc);
            pos += 12 + length;
            chunks++;
        }
        Assert.Equal(4, chunks);   // IHDR, iTXt, IDAT, IEND
    }

    [Fact]
    public void TextWrittenByTheEncoderCanBeReadBack()
    {
        const string text = "{\n  \"name\": \"modèle ✓\"\n}";
        var png = PngEncoder.EncodeRgb(Gradient(4, 4), 4, 4, 16, [new(Look.StateKeyword, text)]);
        Assert.Equal(text, PngText.Read(png, Look.StateKeyword));
        Assert.Null(PngText.Read(png, "SomethingElse"));
    }

    [Fact]
    public void EmbedPutsTheTextStraightAfterTheHeaderLikeTheJsApp()
    {
        var plain = PngEncoder.EncodeRgb(Gradient(4, 4), 4, 4, 16);
        var withText = PngText.Embed(plain, Look.StateKeyword, "hello");
        Assert.Equal("iTXt", Encoding.ASCII.GetString(withText, 33 + 4, 4));
        Assert.Equal("hello", PngText.Read(withText, Look.StateKeyword));
        Assert.Equal(MiniPngDecoder.DecodeRgb(plain).Rgb, MiniPngDecoder.DecodeRgb(withText).Rgb);
    }

    [Fact]
    public void EmbedLeavesOtherDataAlone()
    {
        byte[] notPng = [1, 2, 3];
        Assert.Equal(notPng, PngText.Embed(notPng, "k", "v"));
    }

    /// <summary>Just enough of a PNG reader to check the encoder: 8-bit RGB, not interlaced.</summary>
    private static class MiniPngDecoder
    {
        public static (int Width, int Height, byte[] Rgb) DecodeRgb(byte[] png)
        {
            int pos = 8, width = 0, height = 0;
            using var idat = new MemoryStream();
            while (pos < png.Length)
            {
                int length = BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(pos));
                string type = Encoding.ASCII.GetString(png, pos + 4, 4);
                var data = png.AsSpan(pos + 8, length);
                if (type == "IHDR")
                {
                    width = BinaryPrimitives.ReadInt32BigEndian(data);
                    height = BinaryPrimitives.ReadInt32BigEndian(data[4..]);
                    Assert.Equal(8, data[8]);
                    Assert.Equal(2, data[9]);
                }
                if (type == "IDAT") idat.Write(data);
                pos += 12 + length;
            }

            idat.Position = 0;
            using var zlib = new ZLibStream(idat, CompressionMode.Decompress);
            using var raw = new MemoryStream();
            zlib.CopyTo(raw);
            var bytes = raw.ToArray();

            int stride = width * 3;
            var output = new byte[stride * height];
            for (int y = 0; y < height; y++)
            {
                byte filter = bytes[y * (stride + 1)];
                for (int i = 0; i < stride; i++)
                {
                    int a = i >= 3 ? output[y * stride + i - 3] : 0;
                    int b = y > 0 ? output[(y - 1) * stride + i] : 0;
                    int c = i >= 3 && y > 0 ? output[(y - 1) * stride + i - 3] : 0;
                    int p = a + b - c;
                    int paeth = Math.Abs(p - a) <= Math.Abs(p - b) && Math.Abs(p - a) <= Math.Abs(p - c) ? a : Math.Abs(p - b) <= Math.Abs(p - c) ? b : c;
                    int predicted = filter switch { 0 => 0, 1 => a, 2 => b, 3 => (a + b) >> 1, 4 => paeth, _ => throw new InvalidDataException() };
                    output[y * stride + i] = (byte)(bytes[y * (stride + 1) + 1 + i] + predicted);
                }
            }
            return (width, height, output);
        }
    }
}
