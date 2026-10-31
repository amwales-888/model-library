using System.Runtime.InteropServices;

namespace Xandrite.Rendering.Direct3D11.Interop;

/// <summary>Owns one COM interface pointer and releases it once.</summary>
internal sealed class ComObject : IDisposable
{
    private nint _pointer;

    public ComObject(nint pointer) => _pointer = pointer;

    public nint Pointer => _pointer != 0 ? _pointer : throw new ObjectDisposedException(nameof(ComObject));

    public void Dispose()
    {
        nint p = Interlocked.Exchange(ref _pointer, 0);
        if (p != 0) Com.Release(p);
    }
}

/// <summary>
/// Vtable calls. Each method is named after the COM method it calls; the number in each call is its slot in the
/// interface's vtable, taken from the Windows SDK headers.
/// </summary>
internal static unsafe class Com
{
    private static void** Vtbl(nint p) => *(void***)p;

    public static void Check(int hr, string what)
    {
        if (hr >= 0) return;
        bool lost = hr is Constants.DXGI_ERROR_DEVICE_REMOVED or Constants.DXGI_ERROR_DEVICE_HUNG
            or Constants.DXGI_ERROR_DEVICE_RESET or Constants.DXGI_ERROR_DRIVER_INTERNAL_ERROR;
        throw new RendererException($"Direct3D could not {what} (error 0x{hr:X8}).", lost, Marshal.GetExceptionForHR(hr));
    }

    /* ---------- IUnknown ---------- */

    public static int QueryInterface(nint p, Guid* iid, nint* result) =>
        ((delegate* unmanaged[Stdcall]<nint, Guid*, nint*, int>)Vtbl(p)[0])(p, iid, result);

    public static uint Release(nint p) =>
        ((delegate* unmanaged[Stdcall]<nint, uint>)Vtbl(p)[2])(p);

    /* ---------- ID3D11Device ---------- */

    public static int CreateBuffer(nint device, D3D11_BUFFER_DESC* desc, D3D11_SUBRESOURCE_DATA* initial, nint* buffer) =>
        ((delegate* unmanaged[Stdcall]<nint, D3D11_BUFFER_DESC*, D3D11_SUBRESOURCE_DATA*, nint*, int>)Vtbl(device)[3])(device, desc, initial, buffer);

    public static int CreateTexture2D(nint device, D3D11_TEXTURE2D_DESC* desc, D3D11_SUBRESOURCE_DATA* initial, nint* texture) =>
        ((delegate* unmanaged[Stdcall]<nint, D3D11_TEXTURE2D_DESC*, D3D11_SUBRESOURCE_DATA*, nint*, int>)Vtbl(device)[5])(device, desc, initial, texture);

    public static int CreateRenderTargetView(nint device, nint resource, nint* view) =>
        ((delegate* unmanaged[Stdcall]<nint, nint, void*, nint*, int>)Vtbl(device)[9])(device, resource, null, view);

    public static int CreateDepthStencilView(nint device, nint resource, nint* view) =>
        ((delegate* unmanaged[Stdcall]<nint, nint, void*, nint*, int>)Vtbl(device)[10])(device, resource, null, view);

    public static int CreateInputLayout(nint device, D3D11_INPUT_ELEMENT_DESC* elements, uint count, void* bytecode, nuint length, nint* layout) =>
        ((delegate* unmanaged[Stdcall]<nint, D3D11_INPUT_ELEMENT_DESC*, uint, void*, nuint, nint*, int>)Vtbl(device)[11])(device, elements, count, bytecode, length, layout);

    public static int CreateVertexShader(nint device, void* bytecode, nuint length, nint* shader) =>
        ((delegate* unmanaged[Stdcall]<nint, void*, nuint, nint, nint*, int>)Vtbl(device)[12])(device, bytecode, length, 0, shader);

    public static int CreatePixelShader(nint device, void* bytecode, nuint length, nint* shader) =>
        ((delegate* unmanaged[Stdcall]<nint, void*, nuint, nint, nint*, int>)Vtbl(device)[15])(device, bytecode, length, 0, shader);

    public static int CreateRasterizerState(nint device, D3D11_RASTERIZER_DESC* desc, nint* state) =>
        ((delegate* unmanaged[Stdcall]<nint, D3D11_RASTERIZER_DESC*, nint*, int>)Vtbl(device)[22])(device, desc, state);

    public static int CheckMultisampleQualityLevels(nint device, int format, uint sampleCount, uint* levels) =>
        ((delegate* unmanaged[Stdcall]<nint, int, uint, uint*, int>)Vtbl(device)[30])(device, format, sampleCount, levels);

    public static int GetFeatureLevel(nint device) =>
        ((delegate* unmanaged[Stdcall]<nint, int>)Vtbl(device)[37])(device);

    public static int GetDeviceRemovedReason(nint device) =>
        ((delegate* unmanaged[Stdcall]<nint, int>)Vtbl(device)[39])(device);

    /* ---------- ID3D11DeviceContext ---------- */

    public static void VSSetConstantBuffers(nint context, uint slot, nint buffer) =>
        ((delegate* unmanaged[Stdcall]<nint, uint, uint, nint*, void>)Vtbl(context)[7])(context, slot, 1, &buffer);

    public static void PSSetShader(nint context, nint shader) =>
        ((delegate* unmanaged[Stdcall]<nint, nint, nint*, uint, void>)Vtbl(context)[9])(context, shader, null, 0);

    public static void VSSetShader(nint context, nint shader) =>
        ((delegate* unmanaged[Stdcall]<nint, nint, nint*, uint, void>)Vtbl(context)[11])(context, shader, null, 0);

    public static void Draw(nint context, uint vertexCount, uint startVertex) =>
        ((delegate* unmanaged[Stdcall]<nint, uint, uint, void>)Vtbl(context)[13])(context, vertexCount, startVertex);

    public static int Map(nint context, nint resource, uint subresource, int mapType, D3D11_MAPPED_SUBRESOURCE* mapped) =>
        ((delegate* unmanaged[Stdcall]<nint, nint, uint, int, uint, D3D11_MAPPED_SUBRESOURCE*, int>)Vtbl(context)[14])(context, resource, subresource, mapType, 0, mapped);

    public static void Unmap(nint context, nint resource, uint subresource) =>
        ((delegate* unmanaged[Stdcall]<nint, nint, uint, void>)Vtbl(context)[15])(context, resource, subresource);

    public static void PSSetConstantBuffers(nint context, uint slot, nint buffer) =>
        ((delegate* unmanaged[Stdcall]<nint, uint, uint, nint*, void>)Vtbl(context)[16])(context, slot, 1, &buffer);

    public static void IASetInputLayout(nint context, nint layout) =>
        ((delegate* unmanaged[Stdcall]<nint, nint, void>)Vtbl(context)[17])(context, layout);

    public static void IASetVertexBuffer(nint context, nint buffer, uint stride)
    {
        uint offset = 0;
        ((delegate* unmanaged[Stdcall]<nint, uint, uint, nint*, uint*, uint*, void>)Vtbl(context)[18])(context, 0, 1, &buffer, &stride, &offset);
    }

    public static void IASetPrimitiveTopology(nint context, int topology) =>
        ((delegate* unmanaged[Stdcall]<nint, int, void>)Vtbl(context)[24])(context, topology);

    public static void OMSetRenderTargets(nint context, nint renderTarget, nint depthStencil) =>
        ((delegate* unmanaged[Stdcall]<nint, uint, nint*, nint, void>)Vtbl(context)[33])(context, 1, &renderTarget, depthStencil);

    public static void RSSetState(nint context, nint state) =>
        ((delegate* unmanaged[Stdcall]<nint, nint, void>)Vtbl(context)[43])(context, state);

    public static void RSSetViewport(nint context, D3D11_VIEWPORT* viewport) =>
        ((delegate* unmanaged[Stdcall]<nint, uint, D3D11_VIEWPORT*, void>)Vtbl(context)[44])(context, 1, viewport);

    public static void CopyResource(nint context, nint destination, nint source) =>
        ((delegate* unmanaged[Stdcall]<nint, nint, nint, void>)Vtbl(context)[47])(context, destination, source);

    public static void UpdateSubresource(nint context, nint resource, void* data) =>
        ((delegate* unmanaged[Stdcall]<nint, nint, uint, void*, void*, uint, uint, void>)Vtbl(context)[48])(context, resource, 0, null, data, 0, 0);

    public static void ClearRenderTargetView(nint context, nint view, float* rgba) =>
        ((delegate* unmanaged[Stdcall]<nint, nint, float*, void>)Vtbl(context)[50])(context, view, rgba);

    public static void ClearDepthStencilView(nint context, nint view, uint flags, float depth, byte stencil) =>
        ((delegate* unmanaged[Stdcall]<nint, nint, uint, float, byte, void>)Vtbl(context)[53])(context, view, flags, depth, stencil);

    public static void ResolveSubresource(nint context, nint destination, nint source, int format) =>
        ((delegate* unmanaged[Stdcall]<nint, nint, uint, nint, uint, int, void>)Vtbl(context)[57])(context, destination, 0, source, 0, format);

    public static void ClearState(nint context) =>
        ((delegate* unmanaged[Stdcall]<nint, void>)Vtbl(context)[110])(context);

    /* ---------- DXGI ---------- */

    public static int GetAdapter(nint dxgiDevice, nint* adapter) =>
        ((delegate* unmanaged[Stdcall]<nint, nint*, int>)Vtbl(dxgiDevice)[7])(dxgiDevice, adapter);

    public static int GetDesc(nint adapter, DXGI_ADAPTER_DESC* desc) =>
        ((delegate* unmanaged[Stdcall]<nint, DXGI_ADAPTER_DESC*, int>)Vtbl(adapter)[8])(adapter, desc);

    /* ---------- ID3DBlob ---------- */

    public static void* GetBufferPointer(nint blob) =>
        ((delegate* unmanaged[Stdcall]<nint, void*>)Vtbl(blob)[3])(blob);

    public static nuint GetBufferSize(nint blob) =>
        ((delegate* unmanaged[Stdcall]<nint, nuint>)Vtbl(blob)[4])(blob);
}
