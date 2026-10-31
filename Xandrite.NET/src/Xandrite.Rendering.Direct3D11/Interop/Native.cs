using System.Runtime.InteropServices;

namespace Xandrite.Rendering.Direct3D11.Interop;

/*
 * The small part of the Direct3D 11, DXGI and D3DCompiler APIs the renderer uses, declared by hand.
 *
 * COM methods are called through the object's vtable with unmanaged function pointers. The slot numbers come from
 * the order of methods in the Windows SDK headers (d3d11.h, dxgi.h, d3dcommon.h); IUnknown takes slots 0 to 2.
 * Only methods that return HRESULT, void or a plain integer are used, which have no calling-convention surprises.
 */

internal static class Constants
{
    public const uint D3D11_SDK_VERSION = 7;

    public const int D3D_DRIVER_TYPE_HARDWARE = 1;
    public const int D3D_DRIVER_TYPE_WARP = 5;

    public const uint D3D11_CREATE_DEVICE_DEBUG = 0x2;

    public const int D3D_FEATURE_LEVEL_10_0 = 0xa000;
    public const int D3D_FEATURE_LEVEL_10_1 = 0xa100;
    public const int D3D_FEATURE_LEVEL_11_0 = 0xb000;

    public const int D3D11_USAGE_DEFAULT = 0;
    public const int D3D11_USAGE_IMMUTABLE = 1;
    public const int D3D11_USAGE_DYNAMIC = 2;
    public const int D3D11_USAGE_STAGING = 3;

    public const uint D3D11_BIND_VERTEX_BUFFER = 0x1;
    public const uint D3D11_BIND_CONSTANT_BUFFER = 0x4;
    public const uint D3D11_BIND_RENDER_TARGET = 0x20;
    public const uint D3D11_BIND_DEPTH_STENCIL = 0x40;

    public const uint D3D11_CPU_ACCESS_WRITE = 0x10000;
    public const uint D3D11_CPU_ACCESS_READ = 0x20000;

    public const int DXGI_FORMAT_R32G32B32_FLOAT = 6;
    public const int DXGI_FORMAT_R8G8B8A8_UNORM = 28;
    public const int DXGI_FORMAT_R8G8B8A8_UNORM_SRGB = 29;
    public const int DXGI_FORMAT_D32_FLOAT = 40;

    public const int D3D11_INPUT_PER_VERTEX_DATA = 0;
    public const int D3D11_FILL_SOLID = 3;
    public const int D3D11_CULL_NONE = 1;
    public const int D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST = 4;
    public const int D3D11_MAP_READ = 1;
    public const int D3D11_MAP_WRITE_DISCARD = 4;
    public const uint D3D11_CLEAR_DEPTH = 0x1;

    public const uint D3DCOMPILE_ENABLE_STRICTNESS = 1 << 11;
    public const uint D3DCOMPILE_OPTIMIZATION_LEVEL3 = 1 << 15;

    public const int DXGI_ERROR_DEVICE_REMOVED = unchecked((int)0x887A0005);
    public const int DXGI_ERROR_DEVICE_HUNG = unchecked((int)0x887A0006);
    public const int DXGI_ERROR_DEVICE_RESET = unchecked((int)0x887A0007);
    public const int DXGI_ERROR_DRIVER_INTERNAL_ERROR = unchecked((int)0x887A0020);
    public const int E_OUTOFMEMORY = unchecked((int)0x8007000E);

    public static readonly Guid IID_IDXGIDevice = new("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
}

[StructLayout(LayoutKind.Sequential)]
internal struct D3D11_BUFFER_DESC
{
    public uint ByteWidth;
    public int Usage;
    public uint BindFlags;
    public uint CPUAccessFlags;
    public uint MiscFlags;
    public uint StructureByteStride;
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct D3D11_SUBRESOURCE_DATA
{
    public void* pSysMem;
    public uint SysMemPitch;
    public uint SysMemSlicePitch;
}

[StructLayout(LayoutKind.Sequential)]
internal struct DXGI_SAMPLE_DESC
{
    public uint Count;
    public uint Quality;
}

[StructLayout(LayoutKind.Sequential)]
internal struct D3D11_TEXTURE2D_DESC
{
    public uint Width;
    public uint Height;
    public uint MipLevels;
    public uint ArraySize;
    public int Format;
    public DXGI_SAMPLE_DESC SampleDesc;
    public int Usage;
    public uint BindFlags;
    public uint CPUAccessFlags;
    public uint MiscFlags;
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct D3D11_INPUT_ELEMENT_DESC
{
    public byte* SemanticName;
    public uint SemanticIndex;
    public int Format;
    public uint InputSlot;
    public uint AlignedByteOffset;
    public int InputSlotClass;
    public uint InstanceDataStepRate;
}

[StructLayout(LayoutKind.Sequential)]
internal struct D3D11_RASTERIZER_DESC
{
    public int FillMode;
    public int CullMode;
    public int FrontCounterClockwise;
    public int DepthBias;
    public float DepthBiasClamp;
    public float SlopeScaledDepthBias;
    public int DepthClipEnable;
    public int ScissorEnable;
    public int MultisampleEnable;
    public int AntialiasedLineEnable;
}

[StructLayout(LayoutKind.Sequential)]
internal struct D3D11_VIEWPORT
{
    public float TopLeftX;
    public float TopLeftY;
    public float Width;
    public float Height;
    public float MinDepth;
    public float MaxDepth;
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct D3D11_MAPPED_SUBRESOURCE
{
    public void* pData;
    public uint RowPitch;
    public uint DepthPitch;
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct DXGI_ADAPTER_DESC
{
    public fixed char Description[128];
    public uint VendorId;
    public uint DeviceId;
    public uint SubSysId;
    public uint Revision;
    public nuint DedicatedVideoMemory;
    public nuint DedicatedSystemMemory;
    public nuint SharedSystemMemory;
    public uint AdapterLuidLow;
    public int AdapterLuidHigh;
}

internal static unsafe partial class NativeMethods
{
    [LibraryImport("d3d11.dll")]
    public static partial int D3D11CreateDevice(
        nint adapter, int driverType, nint software, uint flags,
        int* featureLevels, uint featureLevelCount, uint sdkVersion,
        nint* device, int* featureLevel, nint* immediateContext);

    [LibraryImport("d3dcompiler_47.dll")]
    public static partial int D3DCompile(
        void* srcData, nuint srcDataSize, byte* sourceName, void* defines, nint include,
        byte* entryPoint, byte* target, uint flags1, uint flags2, nint* code, nint* errorMessages);
}
