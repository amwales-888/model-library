using System.Numerics;
using Xandrite.Geometry;

namespace Xandrite;

/// <summary>
/// Everything that decides how a model looks: lights, material, background and default framing.
/// These are the values from the JS app's renderer/lib/view.js and model-loader.js. The thumbnail renderer and a
/// future viewer both read them from here, so an automatic thumbnail matches the viewer's default view.
///
/// Bump <see cref="RenderVersion"/> whenever anything here, or the shader, changes. Thumbnails recorded with an
/// older version are then drawn again.
/// </summary>
public static class Look
{
    /// <summary>
    /// 1 was the three.js (WebGL) renderer of the Electron app. 2 is the Direct3D 11 renderer: the same lights and
    /// material, but 3MF files are now shaded with the same material as STL files (three.js's 3MF loader used a
    /// different one), so the Electron thumbnails are drawn once more.
    /// </summary>
    public const int RenderVersion = 2;

    /// <summary>Name of the PNG text chunk holding the view settings. Kept from the JS app so old thumbnails still read.</summary>
    public const string StateKeyword = "ModelThumbnailer";

    public const int ThumbnailSize = 512;

    /* ---------- framing ---------- */

    public const float CameraFovDeg = 35f;

    /// <summary>Direction of the default view, from the model towards the camera (a high corner view).</summary>
    public static readonly Vector3 DefaultViewDirection = Vector3.Normalize(new Vector3(1f, 0.8f, 1f));

    /* ---------- background and material ---------- */

    public const uint BackgroundHex = 0xdfe5ea;
    public const uint MaterialColorHex = 0x8aa3b5;
    public static readonly uint MaterialColorPacked = ColorSpace.PackHex(MaterialColorHex);
    public const float Roughness = 0.55f;
    public const float Metalness = 0.05f;

    /* ---------- lights (fixed in the scene, not attached to the camera) ---------- */

    public const uint HemisphereSkyHex = 0xffffff;
    public const uint HemisphereGroundHex = 0x8a96a0;
    public const float HemisphereIntensity = 1.6f;

    /// <summary>A light shining from <see cref="Position"/> towards the origin.</summary>
    public readonly record struct DirectionalLight(Vector3 Position, uint ColorHex, float Intensity)
    {
        /// <summary>Unit vector from a surface towards the light.</summary>
        public Vector3 Direction => Vector3.Normalize(Position);

        public Vector3 Radiance => ColorSpace.HexToLinear(ColorHex) * Intensity;
    }

    public static readonly DirectionalLight KeyLight = new(new Vector3(3, 5, 4), 0xffffff, 2.6f);
    public static readonly DirectionalLight FillLight = new(new Vector3(-4, 2, -3), 0xffffff, 1.0f);
}
