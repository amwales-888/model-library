using System.Numerics;
using System.Text.Encodings.Web;
using System.Text.Json;
using Xandrite.Framing;

namespace Xandrite.Thumbnails;

/// <summary>The file a thumbnail was made from, as recorded inside the PNG.</summary>
public sealed record ThumbnailFileInfo(string Name, string Format, long SizeBytes, string Sha256);

/// <summary>
/// The view settings stored inside each thumbnail PNG: everything needed to draw the same image again.
/// Same fields, order and layout as buildViewState in the JS app's renderer/lib/view.js.
/// </summary>
public static class ViewState
{
    private static readonly JsonWriterOptions Options = new()
    {
        Indented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,   // keep file names readable, as JSON.stringify does
    };

    public static string Build(CameraSetup camera, bool zUp, int sizePx, bool auto, ThumbnailFileInfo? file)
    {
        var position = camera.Position;
        var target = camera.Target;
        double distance = Vector3.Distance(position, target);
        if (!(distance > 0)) distance = 1;

        using var buffer = new MemoryStream();
        using (var w = new Utf8JsonWriter(buffer, Options))
        {
            w.WriteStartObject();
            w.WriteString("app", "Model Thumbnailer");
            w.WriteNumber("renderVersion", Look.RenderVersion);
            w.WriteBoolean("auto", auto);
            if (file is null)
            {
                w.WriteNull("file");
            }
            else
            {
                w.WriteStartObject("file");
                w.WriteString("name", file.Name);
                w.WriteString("format", file.Format.ToUpperInvariant());
                w.WriteNumber("sizeBytes", file.SizeBytes);
                w.WriteString("sha256", file.Sha256);
                w.WriteEndObject();
            }

            w.WriteStartObject("camera");
            WriteVector(w, "position", position);
            WriteVector(w, "target", target);
            w.WriteStartArray("up");
            w.WriteNumberValue(0);
            w.WriteNumberValue(1);
            w.WriteNumberValue(0);
            w.WriteEndArray();
            WriteNumber(w, "fovDeg", camera.FovDeg);
            WriteNumber(w, "distance", distance);
            WriteNumber(w, "azimuthDeg", Math.Atan2(position.X - target.X, position.Z - target.Z) * 180 / Math.PI);
            WriteNumber(w, "elevationDeg", Math.Asin(Math.Clamp((position.Y - target.Y) / distance, -1, 1)) * 180 / Math.PI);
            w.WriteEndObject();

            w.WriteBoolean("zUp", zUp);
            w.WriteStartObject("thumbnail");
            w.WriteNumber("sizePx", sizePx);
            w.WriteString("background", "#" + Look.BackgroundHex.ToString("x6"));
            w.WriteEndObject();
            w.WriteString("space", "Y-up. The model is centred on its bounding-box centre at the origin. If zUp is true, the file Z axis was rotated to point up.");
            w.WriteEndObject();
        }
        return System.Text.Encoding.UTF8.GetString(buffer.ToArray());
    }

    /// <summary>Rounds to 3 decimal places the way the JS app's r3 does (Math.round: halves go up).</summary>
    public static double R3(double v)
    {
        double r = Math.Floor(v * 1000 + 0.5) / 1000;
        return r == 0 ? 0 : r;   // no "-0"; JSON.stringify writes 0
    }

    private static void WriteNumber(Utf8JsonWriter w, string name, double value) => w.WriteNumber(name, R3(value));

    private static void WriteVector(Utf8JsonWriter w, string name, Vector3 v)
    {
        w.WriteStartArray(name);
        w.WriteNumberValue(R3(v.X));
        w.WriteNumberValue(R3(v.Y));
        w.WriteNumberValue(R3(v.Z));
        w.WriteEndArray();
    }

    /// <summary>Reads a stored view back from a thumbnail's view settings. Null if the text is not usable.</summary>
    public static StoredView? ParseStoredView(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var camera = root.GetProperty("camera");
            return new StoredView(
                ReadVector(camera.GetProperty("position")),
                ReadVector(camera.GetProperty("target")),
                camera.GetProperty("fovDeg").GetSingle(),
                root.TryGetProperty("zUp", out var z) && z.ValueKind == JsonValueKind.True);
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException or FormatException or IndexOutOfRangeException)
        {
            return null;
        }
    }

    private static Vector3 ReadVector(JsonElement e) => new(e[0].GetSingle(), e[1].GetSingle(), e[2].GetSingle());
}
