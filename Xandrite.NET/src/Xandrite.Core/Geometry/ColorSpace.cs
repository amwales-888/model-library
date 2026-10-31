using System.Globalization;
using System.Numerics;

namespace Xandrite.Geometry;

/// <summary>
/// Colour helpers. Like three.js, colours written as hex (#8aa3b5) are sRGB and are converted to linear RGB
/// before lighting. The GPU converts the result back to sRGB when it writes the image.
/// </summary>
public static class ColorSpace
{
    public static float SrgbToLinear(float c) =>
        c < 0.04045f ? c * 0.0773993808f : MathF.Pow(c * 0.9478672986f + 0.0521327014f, 2.4f);

    public static float LinearToSrgb(float c) =>
        c < 0.0031308f ? c * 12.92f : 1.055f * MathF.Pow(c, 0.41666f) - 0.055f;

    /// <summary>0xRRGGBB (sRGB) to linear RGB.</summary>
    public static Vector3 HexToLinear(uint rgb) => new(
        SrgbToLinear(((rgb >> 16) & 0xFF) / 255f),
        SrgbToLinear(((rgb >> 8) & 0xFF) / 255f),
        SrgbToLinear((rgb & 0xFF) / 255f));

    /// <summary>Packs linear RGB (0..1) into a vertex colour.</summary>
    public static uint Pack(Vector3 linear)
    {
        static uint B(float v) => (uint)Math.Clamp((int)MathF.Round(v * 255f), 0, 255);
        return B(linear.X) | (B(linear.Y) << 8) | (B(linear.Z) << 16) | (255u << 24);
    }

    public static uint PackHex(uint rgb) => Pack(HexToLinear(rgb));

    /// <summary>
    /// Reads a 3MF colour, "#RRGGBB" or "#RRGGBBAA" (sRGB), into a packed linear vertex colour.
    /// Returns false if the text is not a colour.
    /// </summary>
    public static bool TryParse3mfColor(ReadOnlySpan<char> text, out uint packed)
    {
        packed = 0;
        text = text.Trim();
        if (text.Length is not (7 or 9) || text[0] != '#') return false;
        if (!uint.TryParse(text.Slice(1, 6), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var rgb)) return false;
        packed = PackHex(rgb);
        return true;
    }
}
