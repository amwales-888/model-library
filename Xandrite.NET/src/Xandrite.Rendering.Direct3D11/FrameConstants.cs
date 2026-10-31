using System.Numerics;
using System.Runtime.InteropServices;
using Xandrite.Geometry;

namespace Xandrite.Rendering.Direct3D11;

/// <summary>
/// The shader's constant buffer (cbuffer Frame in Shaders/Standard.hlsl). The field order and sizes must match it:
/// two matrices then eight float4 values, 256 bytes in all.
/// </summary>
[StructLayout(LayoutKind.Sequential)]
public struct FrameConstants
{
    public Matrix4x4 Model;
    public Matrix4x4 ViewProjection;
    public Vector4 CameraPosition;
    public Vector4 SkyColor;
    public Vector4 GroundColor;
    public Vector4 KeyDirection;
    public Vector4 KeyColor;
    public Vector4 FillDirection;
    public Vector4 FillColor;
    public Vector4 Material;

    public const int SizeInBytes = 256;

    /// <summary>The constants for one image: the request's placement and camera, and the lights and material from <see cref="Look"/>.</summary>
    public static FrameConstants For(in RenderRequest request)
    {
        var camera = request.Camera;
        return new FrameConstants
        {
            Model = request.Model,
            ViewProjection = camera.View * camera.Projection,
            CameraPosition = new Vector4(camera.Position, 1),
            SkyColor = new Vector4(ColorSpace.HexToLinear(Look.HemisphereSkyHex) * Look.HemisphereIntensity, 0),
            GroundColor = new Vector4(ColorSpace.HexToLinear(Look.HemisphereGroundHex) * Look.HemisphereIntensity, 0),
            KeyDirection = new Vector4(Look.KeyLight.Direction, 0),
            KeyColor = new Vector4(Look.KeyLight.Radiance, 0),
            FillDirection = new Vector4(Look.FillLight.Direction, 0),
            FillColor = new Vector4(Look.FillLight.Radiance, 0),
            Material = new Vector4(Look.Roughness, Look.Metalness, 0, 0),
        };
    }
}
