using Xandrite.Imaging;
using Xandrite.Loading;
using Xandrite.Rendering;
using Xandrite.Thumbnails;

namespace Xandrite.Core.Tests;

/// <summary>Checks the thumbnail pipeline around the renderer, with a stand-in renderer so no GPU is needed.</summary>
public class ThumbnailGeneratorTests
{
    private sealed class FakeRenderer : IModelRenderer
    {
        public RenderRequest? LastRequest { get; private set; }
        public int Uploads { get; private set; }
        public int Disposed { get; private set; }

        public string AdapterDescription => "Fake";

        public IGpuMesh Upload(Geometry.Mesh mesh)
        {
            Uploads++;
            return new FakeMesh(this, mesh.TriangleCount);
        }

        public RenderedImage Render(IGpuMesh mesh, in RenderRequest request)
        {
            LastRequest = request;
            var rgba = new byte[request.Width * request.Height * 4];
            Array.Fill(rgba, (byte)200);
            return new RenderedImage(request.Width, request.Height, rgba);
        }

        public void Dispose() { }

        private sealed class FakeMesh(FakeRenderer owner, int triangles) : IGpuMesh
        {
            public int TriangleCount { get; } = triangles;
            public void Dispose() => owner.Disposed++;
        }
    }

    [Fact]
    public void MakesAPngWithTheViewSettingsInside()
    {
        var renderer = new FakeRenderer();
        var data = File.ReadAllBytes(TestModels.SamplePath("torus-knot-on-plate.stl"));
        var result = new ThumbnailGenerator(renderer).Generate(new ThumbnailJob(data, "stl", "torus-knot-on-plate.stl", "ab12"));

        Assert.Equal(20172, result.Triangles);
        Assert.Equal(1, renderer.Uploads);
        Assert.Equal(1, renderer.Disposed);                 // the GPU copy is released straight away
        Assert.Equal(512, renderer.LastRequest!.Value.Width);

        string? json = PngText.Read(result.Png, Look.StateKeyword);
        Assert.Equal(result.ViewStateJson, json);
        Assert.Contains("\"name\": \"torus-knot-on-plate.stl\"", json!);
        Assert.Contains("\"format\": \"STL\"", json!);
        Assert.Contains("\"auto\": true", json!);
    }

    [Fact]
    public void UsesAStoredViewWhenThereIsOne()
    {
        var renderer = new FakeRenderer();
        var view = new Framing.StoredView(new(10, 20, 30), new(1, 2, 3), 40, ZUp: false);
        var data = File.ReadAllBytes(TestModels.SamplePath("ascii-pyramid.stl"));
        var result = new ThumbnailGenerator(renderer).Generate(new ThumbnailJob(data, "stl", "p.stl", View: view, SizePx: 256));

        var camera = renderer.LastRequest!.Value.Camera;
        Assert.Equal(view.Position, camera.Position);
        Assert.Equal(view.Target, camera.Target);
        Assert.Equal(40f, camera.FovDeg);
        Assert.Contains("\"auto\": false", result.ViewStateJson);
        Assert.Contains("\"zUp\": false", result.ViewStateJson);
    }

    [Fact]
    public void ABadModelIsReportedAsAModelProblem()
    {
        var generator = new ThumbnailGenerator(new FakeRenderer());
        Assert.Throws<ModelFormatException>(() => generator.Generate(new ThumbnailJob(new byte[] { 1, 2, 3 }, "stl", "bad.stl")));
    }
}
