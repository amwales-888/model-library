using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using Xandrite.Geometry;
using Xandrite.Rendering.Direct3D11.Interop;
using static Xandrite.Rendering.Direct3D11.Interop.Constants;

namespace Xandrite.Rendering.Direct3D11;

/// <param name="ForceSoftware">Use WARP (software rendering) even when a GPU is available. Slower, but identical everywhere.</param>
/// <param name="DebugLayer">Ask for the Direct3D debug layer (needs Windows' optional "Graphics Tools" feature). Ignored if missing.</param>
/// <param name="SampleCount">Multisample anti-aliasing samples per pixel. three.js's default "antialias: true" is 4.</param>
public sealed record D3D11RendererOptions(bool ForceSoftware = false, bool DebugLayer = false, int SampleCount = 4);

/// <summary>
/// Draws models off screen with Direct3D 11 and reads the image back. Nothing is shown on screen and no window is
/// needed, so it can run on any thread (but one call at a time per instance).
/// </summary>
[SupportedOSPlatform("windows")]
public sealed unsafe class D3D11Renderer : IModelRenderer
{
    /// <summary>Vertices per vertex buffer: one million triangles, 48 MB, safely under Direct3D's 128 MB minimum resource limit.</summary>
    internal const int VerticesPerChunk = 3 * 1_048_576;

    /// <summary>Meshes larger than this are streamed through one reusable buffer instead of being kept on the GPU.</summary>
    private const long StreamThresholdBytes = 768L * 1024 * 1024;

    private readonly ComObject _device;
    private readonly ComObject _context;
    private readonly ComObject _vertexShader;
    private readonly ComObject _pixelShader;
    private readonly ComObject _inputLayout;
    private readonly ComObject _rasterizer;
    private readonly ComObject _constantBuffer;
    private RenderTargets? _targets;
    private ComObject? _streamBuffer;
    private bool _disposed;

    public string AdapterDescription { get; }

    /// <summary>True when drawing with WARP rather than a GPU.</summary>
    public bool IsSoftware { get; }

    public int SampleCount { get; }

    /// <summary>
    /// Makes a renderer on the GPU, or with WARP if there is no usable GPU (or <see cref="D3D11RendererOptions.ForceSoftware"/>).
    /// </summary>
    /// <exception cref="RendererException">Direct3D 11 is not available at all.</exception>
    public static D3D11Renderer Create(D3D11RendererOptions? options = null)
    {
        options ??= new D3D11RendererOptions();
        if (!options.ForceSoftware)
        {
            try
            {
                return new D3D11Renderer(D3D_DRIVER_TYPE_HARDWARE, options);
            }
            catch (RendererException)
            {
                // No usable GPU (common in virtual machines and some remote sessions): fall back to WARP below.
            }
        }
        return new D3D11Renderer(D3D_DRIVER_TYPE_WARP, options);
    }

    private D3D11Renderer(int driverType, D3D11RendererOptions options)
    {
        IsSoftware = driverType == D3D_DRIVER_TYPE_WARP;
        (_device, _context) = CreateDevice(driverType, options.DebugLayer);
        try
        {
            nint device = _device.Pointer;
            AdapterDescription = ReadAdapterDescription(device);
            SampleCount = PickSampleCount(device, options.SampleCount);

            string source = LoadShaderSource();
            byte[] vsCode = Compile(source, "VSMain", "vs_4_0");
            byte[] psCode = Compile(source, "PSMain", "ps_4_0");

            nint p;
            fixed (byte* code = vsCode)
            {
                Com.Check(Com.CreateVertexShader(device, code, (nuint)vsCode.Length, &p), "create the vertex shader");
                _vertexShader = new ComObject(p);

                fixed (byte* position = "POSITION"u8, color = "COLOR"u8)
                {
                    var elements = stackalloc D3D11_INPUT_ELEMENT_DESC[2];
                    elements[0] = new D3D11_INPUT_ELEMENT_DESC { SemanticName = position, Format = DXGI_FORMAT_R32G32B32_FLOAT, AlignedByteOffset = 0, InputSlotClass = D3D11_INPUT_PER_VERTEX_DATA };
                    elements[1] = new D3D11_INPUT_ELEMENT_DESC { SemanticName = color, Format = DXGI_FORMAT_R8G8B8A8_UNORM, AlignedByteOffset = 12, InputSlotClass = D3D11_INPUT_PER_VERTEX_DATA };
                    Com.Check(Com.CreateInputLayout(device, elements, 2, code, (nuint)vsCode.Length, &p), "create the vertex layout");
                    _inputLayout = new ComObject(p);
                }
            }
            fixed (byte* code = psCode)
            {
                Com.Check(Com.CreatePixelShader(device, code, (nuint)psCode.Length, &p), "create the pixel shader");
                _pixelShader = new ComObject(p);
            }

            // Both sides of every face are drawn (three.js DoubleSide); the shader turns each face towards the camera.
            var raster = new D3D11_RASTERIZER_DESC
            {
                FillMode = D3D11_FILL_SOLID,
                CullMode = D3D11_CULL_NONE,
                DepthClipEnable = 1,
                MultisampleEnable = SampleCount > 1 ? 1 : 0,
            };
            Com.Check(Com.CreateRasterizerState(device, &raster, &p), "create the rasteriser state");
            _rasterizer = new ComObject(p);

            var cb = new D3D11_BUFFER_DESC { ByteWidth = FrameConstants.SizeInBytes, Usage = D3D11_USAGE_DEFAULT, BindFlags = D3D11_BIND_CONSTANT_BUFFER };
            Com.Check(Com.CreateBuffer(device, &cb, null, &p), "create the constant buffer");
            _constantBuffer = new ComObject(p);
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    /* ---------- set-up ---------- */

    private static (ComObject Device, ComObject Context) CreateDevice(int driverType, bool debugLayer)
    {
        int* levels = stackalloc int[] { D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0 };
        nint device = 0, context = 0;
        int level = 0;
        int hr;
        try
        {
            hr = debugLayer
                ? NativeMethods.D3D11CreateDevice(0, driverType, 0, D3D11_CREATE_DEVICE_DEBUG, levels, 3, D3D11_SDK_VERSION, &device, &level, &context)
                : -1;
            if (hr < 0)   // no debug layer requested, or it is not installed
                hr = NativeMethods.D3D11CreateDevice(0, driverType, 0, 0, levels, 3, D3D11_SDK_VERSION, &device, &level, &context);
        }
        catch (DllNotFoundException e)
        {
            throw new RendererException("Direct3D 11 is not available on this system.", inner: e);
        }
        string kind = driverType == D3D_DRIVER_TYPE_WARP ? "the software (WARP) renderer" : "a graphics device";
        Com.Check(hr, "start " + kind);
        return (new ComObject(device), new ComObject(context));
    }

    private static string ReadAdapterDescription(nint device)
    {
        nint dxgiDevice = 0, adapter = 0;
        try
        {
            Guid iid = IID_IDXGIDevice;
            if (Com.QueryInterface(device, &iid, &dxgiDevice) < 0 || Com.GetAdapter(dxgiDevice, &adapter) < 0) return "Unknown adapter";
            DXGI_ADAPTER_DESC desc;
            if (Com.GetDesc(adapter, &desc) < 0) return "Unknown adapter";
            return new string(desc.Description).TrimEnd('\0');
        }
        finally
        {
            if (adapter != 0) Com.Release(adapter);
            if (dxgiDevice != 0) Com.Release(dxgiDevice);
        }
    }

    private static int PickSampleCount(nint device, int wanted)
    {
        for (int count = Math.Clamp(wanted, 1, 8); count > 1; count /= 2)
        {
            uint quality = 0;
            if (Com.CheckMultisampleQualityLevels(device, DXGI_FORMAT_R8G8B8A8_UNORM_SRGB, (uint)count, &quality) >= 0 && quality > 0) return count;
        }
        return 1;
    }

    /// <summary>The HLSL source of the model shader, embedded in this assembly.</summary>
    public static string LoadShaderSource()
    {
        using var stream = typeof(D3D11Renderer).Assembly.GetManifestResourceStream("Xandrite.Shaders.Standard.hlsl")
            ?? throw new RendererException("The shader source is missing from the renderer assembly.");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private static byte[] Compile(string source, string entryPoint, string profile)
    {
        byte[] src = Encoding.UTF8.GetBytes(source);
        byte[] name = "Standard.hlsl\0"u8.ToArray();
        byte[] entry = Encoding.ASCII.GetBytes(entryPoint + "\0");
        byte[] target = Encoding.ASCII.GetBytes(profile + "\0");
        nint code = 0, errors = 0;
        try
        {
            int hr;
            fixed (byte* s = src, n = name, e = entry, t = target)
            {
                try
                {
                    hr = NativeMethods.D3DCompile(s, (nuint)src.Length, n, null, 0, e, t,
                        D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &code, &errors);
                }
                catch (DllNotFoundException ex)
                {
                    throw new RendererException("The Direct3D shader compiler (d3dcompiler_47.dll) is not available.", inner: ex);
                }
            }
            if (hr < 0 || code == 0)
            {
                string message = errors != 0 ? Marshal.PtrToStringAnsi((nint)Com.GetBufferPointer(errors), (int)Com.GetBufferSize(errors)) : "no details";
                throw new RendererException($"The {entryPoint} shader did not compile: {message.Trim()}");
            }
            return new ReadOnlySpan<byte>(Com.GetBufferPointer(code), checked((int)Com.GetBufferSize(code))).ToArray();
        }
        finally
        {
            if (code != 0) Com.Release(code);
            if (errors != 0) Com.Release(errors);
        }
    }

    /* ---------- meshes ---------- */

    public IGpuMesh Upload(Mesh mesh)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        long bytes = (long)mesh.VertexCount * MeshVertex.SizeInBytes;
        if (bytes > StreamThresholdBytes) return new D3D11Mesh(mesh);   // drawn piece by piece, see DrawStreamed

        var chunks = new List<(ComObject Buffer, int Vertices)>();
        try
        {
            fixed (MeshVertex* all = mesh.Vertices)
            {
                for (int start = 0; start < mesh.VertexCount; start += VerticesPerChunk)
                {
                    int count = Math.Min(VerticesPerChunk, mesh.VertexCount - start);
                    var desc = new D3D11_BUFFER_DESC { ByteWidth = (uint)(count * MeshVertex.SizeInBytes), Usage = D3D11_USAGE_IMMUTABLE, BindFlags = D3D11_BIND_VERTEX_BUFFER };
                    var data = new D3D11_SUBRESOURCE_DATA { pSysMem = all + start };
                    nint buffer;
                    Com.Check(Com.CreateBuffer(_device.Pointer, &desc, &data, &buffer), "copy the model to the graphics card");
                    chunks.Add((new ComObject(buffer), count));
                }
            }
        }
        catch
        {
            foreach (var chunk in chunks) chunk.Buffer.Dispose();
            throw;
        }
        return new D3D11Mesh(chunks, mesh.TriangleCount);
    }

    private void DrawStreamed(Mesh mesh)
    {
        nint context = _context.Pointer;
        if (_streamBuffer is null)
        {
            var desc = new D3D11_BUFFER_DESC
            {
                ByteWidth = (uint)(VerticesPerChunk * MeshVertex.SizeInBytes),
                Usage = D3D11_USAGE_DYNAMIC,
                BindFlags = D3D11_BIND_VERTEX_BUFFER,
                CPUAccessFlags = D3D11_CPU_ACCESS_WRITE,
            };
            nint buffer;
            Com.Check(Com.CreateBuffer(_device.Pointer, &desc, null, &buffer), "create the streaming buffer");
            _streamBuffer = new ComObject(buffer);
        }

        nint stream = _streamBuffer.Pointer;
        fixed (MeshVertex* all = mesh.Vertices)
        {
            for (int start = 0; start < mesh.VertexCount; start += VerticesPerChunk)
            {
                int count = Math.Min(VerticesPerChunk, mesh.VertexCount - start);
                D3D11_MAPPED_SUBRESOURCE mapped;
                Com.Check(Com.Map(context, stream, 0, D3D11_MAP_WRITE_DISCARD, &mapped), "fill the streaming buffer");
                long bytes = (long)count * MeshVertex.SizeInBytes;
                Buffer.MemoryCopy(all + start, mapped.pData, bytes, bytes);
                Com.Unmap(context, stream, 0);
                Com.IASetVertexBuffer(context, stream, MeshVertex.SizeInBytes);
                Com.Draw(context, (uint)count, 0);
            }
        }
    }

    /* ---------- drawing ---------- */

    public RenderedImage Render(IGpuMesh mesh, in RenderRequest request) => Render(mesh, request, null);

    public RenderedImage Render(IGpuMesh mesh, in RenderRequest request, byte[]? reuse)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (mesh is not D3D11Mesh gpuMesh) throw new ArgumentException("The mesh was not uploaded by this renderer.", nameof(mesh));
        ArgumentOutOfRangeException.ThrowIfLessThan(request.Width, 1);
        ArgumentOutOfRangeException.ThrowIfLessThan(request.Height, 1);

        var targets = EnsureTargets(request.Width, request.Height);
        nint context = _context.Pointer;

        var constants = FrameConstants.For(request);
        nint cb = _constantBuffer.Pointer;
        Com.UpdateSubresource(context, cb, &constants);

        Com.OMSetRenderTargets(context, targets.ColorView.Pointer, targets.DepthView.Pointer);
        var viewport = new D3D11_VIEWPORT { Width = request.Width, Height = request.Height, MaxDepth = 1 };
        Com.RSSetViewport(context, &viewport);
        Com.RSSetState(context, _rasterizer.Pointer);
        Com.IASetInputLayout(context, _inputLayout.Pointer);
        Com.IASetPrimitiveTopology(context, D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        Com.VSSetShader(context, _vertexShader.Pointer);
        Com.PSSetShader(context, _pixelShader.Pointer);
        Com.VSSetConstantBuffers(context, 0, cb);
        Com.PSSetConstantBuffers(context, 0, cb);

        // The target is sRGB, so the clear colour is given in linear RGB and comes out as #dfe5ea.
        var background = ColorSpace.HexToLinear(Look.BackgroundHex);
        float* clear = stackalloc float[] { background.X, background.Y, background.Z, 1f };
        Com.ClearRenderTargetView(context, targets.ColorView.Pointer, clear);
        Com.ClearDepthStencilView(context, targets.DepthView.Pointer, D3D11_CLEAR_DEPTH, 1f, 0);

        if (gpuMesh.Streamed is { } source)
        {
            DrawStreamed(source);
        }
        else
        {
            foreach (var (buffer, vertices) in gpuMesh.Chunks)
            {
                Com.IASetVertexBuffer(context, buffer.Pointer, MeshVertex.SizeInBytes);
                Com.Draw(context, (uint)vertices, 0);
            }
        }

        // Multisampled image -> plain texture -> CPU-readable copy.
        if (targets.Resolve is not null)
        {
            Com.ResolveSubresource(context, targets.Resolve.Pointer, targets.Color.Pointer, DXGI_FORMAT_R8G8B8A8_UNORM_SRGB);
            Com.CopyResource(context, targets.Staging.Pointer, targets.Resolve.Pointer);
        }
        else
        {
            Com.CopyResource(context, targets.Staging.Pointer, targets.Color.Pointer);
        }

        D3D11_MAPPED_SUBRESOURCE mapped;
        int hr = Com.Map(context, targets.Staging.Pointer, 0, D3D11_MAP_READ, &mapped);
        if (hr < 0)
        {
            int reason = Com.GetDeviceRemovedReason(_device.Pointer);
            Com.Check(reason < 0 ? reason : hr, "read the finished image back");
        }
        try
        {
            int rowBytes = request.Width * 4;
            var pixels = reuse is not null && reuse.Length >= rowBytes * request.Height ? reuse : new byte[rowBytes * request.Height];
            for (int y = 0; y < request.Height; y++)
            {
                new ReadOnlySpan<byte>((byte*)mapped.pData + (long)y * mapped.RowPitch, rowBytes).CopyTo(pixels.AsSpan(y * rowBytes, rowBytes));
            }
            return new RenderedImage(request.Width, request.Height, pixels);
        }
        finally
        {
            Com.Unmap(context, targets.Staging.Pointer, 0);
        }
    }

    private RenderTargets EnsureTargets(int width, int height)
    {
        if (_targets is { } t && t.Width == width && t.Height == height) return t;
        _targets?.Dispose();
        _targets = null;
        _targets = new RenderTargets(_device.Pointer, width, height, SampleCount);
        return _targets;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (_context is not null)
        {
            try { Com.ClearState(_context.Pointer); } catch (ObjectDisposedException) { }
        }
        _targets?.Dispose();
        _streamBuffer?.Dispose();
        _constantBuffer?.Dispose();
        _rasterizer?.Dispose();
        _inputLayout?.Dispose();
        _pixelShader?.Dispose();
        _vertexShader?.Dispose();
        _context?.Dispose();
        _device?.Dispose();
    }

    /* ---------- render targets for one image size ---------- */

    private sealed class RenderTargets : IDisposable
    {
        public int Width { get; }
        public int Height { get; }
        public ComObject Color { get; }
        public ComObject ColorView { get; }
        public ComObject Depth { get; }
        public ComObject DepthView { get; }
        public ComObject? Resolve { get; }
        public ComObject Staging { get; }

        public RenderTargets(nint device, int width, int height, int samples)
        {
            Width = width;
            Height = height;
            var made = new List<ComObject>();
            try
            {
                Color = Track(made, Texture(device, width, height, DXGI_FORMAT_R8G8B8A8_UNORM_SRGB, samples, D3D11_USAGE_DEFAULT, D3D11_BIND_RENDER_TARGET, 0, "create the image"));
                nint p;
                Com.Check(Com.CreateRenderTargetView(device, Color.Pointer, &p), "create the image view");
                ColorView = Track(made, new ComObject(p));

                Depth = Track(made, Texture(device, width, height, DXGI_FORMAT_D32_FLOAT, samples, D3D11_USAGE_DEFAULT, D3D11_BIND_DEPTH_STENCIL, 0, "create the depth buffer"));
                Com.Check(Com.CreateDepthStencilView(device, Depth.Pointer, &p), "create the depth view");
                DepthView = Track(made, new ComObject(p));

                if (samples > 1)
                    Resolve = Track(made, Texture(device, width, height, DXGI_FORMAT_R8G8B8A8_UNORM_SRGB, 1, D3D11_USAGE_DEFAULT, 0, 0, "create the resolve image"));
                Staging = Track(made, Texture(device, width, height, DXGI_FORMAT_R8G8B8A8_UNORM_SRGB, 1, D3D11_USAGE_STAGING, 0, D3D11_CPU_ACCESS_READ, "create the read-back image"));
            }
            catch
            {
                foreach (var o in made) o.Dispose();
                throw;
            }
        }

        private static ComObject Track(List<ComObject> list, ComObject o)
        {
            list.Add(o);
            return o;
        }

        private static ComObject Texture(nint device, int width, int height, int format, int samples, int usage, uint bind, uint cpu, string what)
        {
            var desc = new D3D11_TEXTURE2D_DESC
            {
                Width = (uint)width,
                Height = (uint)height,
                MipLevels = 1,
                ArraySize = 1,
                Format = format,
                SampleDesc = new DXGI_SAMPLE_DESC { Count = (uint)samples, Quality = 0 },
                Usage = usage,
                BindFlags = bind,
                CPUAccessFlags = cpu,
            };
            nint texture;
            Com.Check(Com.CreateTexture2D(device, &desc, null, &texture), what);
            return new ComObject(texture);
        }

        public void Dispose()
        {
            Staging.Dispose();
            Resolve?.Dispose();
            DepthView.Dispose();
            Depth.Dispose();
            ColorView.Dispose();
            Color.Dispose();
        }
    }
}

/// <summary>A mesh uploaded by <see cref="D3D11Renderer"/>: vertex buffers on the GPU, or a very large mesh streamed at draw time.</summary>
internal sealed class D3D11Mesh : IGpuMesh
{
    public D3D11Mesh(List<(ComObject Buffer, int Vertices)> chunks, int triangles)
    {
        Chunks = chunks;
        TriangleCount = triangles;
    }

    public D3D11Mesh(Mesh streamed)
    {
        Streamed = streamed;
        Chunks = [];
        TriangleCount = streamed.TriangleCount;
    }

    public List<(ComObject Buffer, int Vertices)> Chunks { get; }

    public Mesh? Streamed { get; }

    public int TriangleCount { get; }

    public void Dispose()
    {
        foreach (var chunk in Chunks) chunk.Buffer.Dispose();
        Chunks.Clear();
    }
}
