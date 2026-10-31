using System.Numerics;
using Xandrite.Framing;
using Xandrite.Geometry;

namespace Xandrite.Rendering;

/// <summary>
/// Draws meshes into images. The Direct3D 11 renderer implements it; the thumbnail generator (and later the
/// viewer) only talk to this interface.
///
/// An instance is not thread-safe. Use one per worker thread if thumbnails are drawn in parallel.
/// </summary>
public interface IModelRenderer : IDisposable
{
    /// <summary>The graphics adapter in use, for example "NVIDIA GeForce RTX 3060" or "Microsoft Basic Render Driver".</summary>
    string AdapterDescription { get; }

    /// <summary>Copies a mesh to the GPU. Keep the result to draw the same model many times (the viewer will).</summary>
    IGpuMesh Upload(Mesh mesh);

    /// <summary>Draws one image with the lights and material from <see cref="Look"/>.</summary>
    RenderedImage Render(IGpuMesh mesh, in RenderRequest request);

    /// <summary>
    /// Draws into <paramref name="reuse"/> when it is large enough, instead of a new array. The viewer draws many frames
    /// a second while the model is turned; reusing its buffers keeps the garbage collector out of the way.
    /// </summary>
    RenderedImage Render(IGpuMesh mesh, in RenderRequest request, byte[]? reuse) => Render(mesh, request);
}

/// <summary>A mesh living on the GPU.</summary>
public interface IGpuMesh : IDisposable
{
    int TriangleCount { get; }
}

/// <param name="Model">Places the mesh in the scene (see <see cref="ViewMath.OrientAndCentre"/>).</param>
public readonly record struct RenderRequest(Matrix4x4 Model, CameraSetup Camera, int Width, int Height);

/// <summary>An image as 8-bit RGBA, sRGB encoded, rows top to bottom with no padding.</summary>
public sealed class RenderedImage(int width, int height, byte[] rgba)
{
    public int Width { get; } = width;
    public int Height { get; } = height;
    public byte[] Rgba { get; } = rgba;
}

/// <summary>
/// The renderer itself failed (no usable graphics device, the driver was reset...), as opposed to a bad model.
/// The thumbnail queue should pause and make a new renderer, not mark the model as failed.
/// This is the "infrastructure" error of the JS app's render-host.js.
/// </summary>
public sealed class RendererException(string message, bool deviceLost = false, Exception? inner = null) : Exception(message, inner)
{
    public bool DeviceLost { get; } = deviceLost;
}
