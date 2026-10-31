using System.Numerics;
using Xandrite.Framing;
using Xandrite.Geometry;
using Xandrite.Thumbnails;

namespace Xandrite.Core.Tests;

/// <summary>
/// The expected numbers were produced by running the Electron app's own renderer/lib/view.js (three.js 0.160) under
/// Node on the same box, so these tests pin the .NET framing to the JS behaviour.
/// </summary>
public class ViewMathTests
{
    // A box from (-10, -20, 0) to (30, 40, 25) in file coordinates (Z up).
    private static readonly BoundingBox Box = new(new Vector3(-10, -20, 0), new Vector3(30, 40, 25));

    private static void Near(double expected, double actual, double tolerance = 1e-3) =>
        Assert.True(Math.Abs(expected - actual) <= tolerance, $"expected {expected}, got {actual}");

    [Fact]
    public void OrientsZUpAndCentresLikeTheJsApp()
    {
        var frame = ViewMath.OrientAndCentre(Box, zUp: true);
        Near(38.160843806184374, frame.Radius);

        // The file point at the box centre ends up at the origin...
        var centre = Vector3.Transform(Box.Center, frame.Transform);
        Near(0, centre.X); Near(0, centre.Y); Near(0, centre.Z);
        // ...and the file's +Z points up the scene's +Y.
        var up = Vector3.TransformNormal(Vector3.UnitZ, frame.Transform);
        Assert.Equal(Vector3.UnitY, up);
        // three.js moved its holder group by (-10, -12.5, 10) for this box.
        Assert.Equal(new Vector3(-10, -12.5f, 10), frame.Transform.Translation);
    }

    [Fact]
    public void WithoutZUpOnlyCentres()
    {
        var frame = ViewMath.OrientAndCentre(Box, zUp: false);
        Assert.Equal(new Vector3(-10, -10, -12.5f), frame.Transform.Translation);
    }

    [Fact]
    public void PlacesTheDefaultCameraLikeTheJsApp()
    {
        var frame = ViewMath.OrientAndCentre(Box, zUp: true);
        var camera = ViewMath.DefaultCamera(frame.Radius, 1f);
        Near(84.35249972542007, camera.Position.X);
        Near(67.48199978033607, camera.Position.Y);
        Near(84.35249972542007, camera.Position.Z);
        Near(0.38160843806184375, camera.Near, 1e-6);
        Near(366.0216522963776, camera.Far);
        Near(137.05658945927138, ViewMath.FitDistance(frame.Radius, 35, 1));
        Near(137.05658945927138, ViewMath.FitDistance(frame.Radius, 35, 1.7f));   // the vertical fov is the limit when wide
    }

    [Fact]
    public void PlacesAStoredCameraLikeTheJsApp()
    {
        var frame = ViewMath.OrientAndCentre(Box, zUp: false);
        var view = new StoredView(new Vector3(120.5f, -40.25f, 60), new Vector3(1, 2, -3), 28, false);
        var camera = ViewMath.StoredCamera(view, frame.Radius, 1f);
        Near(0.3816084380618437, camera.Near, 1e-6);
        Near(370.5076800942419, camera.Far);
        Assert.Equal(28f, camera.FovDeg);
    }

    [Fact]
    public void TheViewStateJsonMatchesTheJsApp()
    {
        var frame = ViewMath.OrientAndCentre(Box, zUp: true);
        var camera = ViewMath.DefaultCamera(frame.Radius, 1f);
        string json = ViewState.Build(camera, zUp: true, sizePx: 512, auto: true,
            new ThumbnailFileInfo("box ü.stl", "stl", 684, string.Concat(Enumerable.Repeat("ab", 32))));

        // JSON.stringify(state, null, 2) from view.js, with renderVersion moved on to the Direct3D renderer's.
        string expected = """
            {
              "app": "Model Thumbnailer",
              "renderVersion": 2,
              "auto": true,
              "file": {
                "name": "box ü.stl",
                "format": "STL",
                "sizeBytes": 684,
                "sha256": "abababababababababababababababababababababababababababababababab"
              },
              "camera": {
                "position": [
                  84.352,
                  67.482,
                  84.352
                ],
                "target": [
                  0,
                  0,
                  0
                ],
                "up": [
                  0,
                  1,
                  0
                ],
                "fovDeg": 35,
                "distance": 137.057,
                "azimuthDeg": 45,
                "elevationDeg": 29.496
              },
              "zUp": true,
              "thumbnail": {
                "sizePx": 512,
                "background": "#dfe5ea"
              },
              "space": "Y-up. The model is centred on its bounding-box centre at the origin. If zUp is true, the file Z axis was rotated to point up."
            }
            """;
        Assert.Equal(expected.ReplaceLineEndings("\n"), json.ReplaceLineEndings("\n"));
    }

    [Fact]
    public void AStoredViewRoundTripsThroughTheJson()
    {
        var view = new StoredView(new Vector3(120.5f, -40.25f, 60), new Vector3(1, 2, -3), 28, false);
        var camera = ViewMath.StoredCamera(view, 10, 1);
        string json = ViewState.Build(camera, zUp: false, sizePx: 256, auto: false, file: null);
        Assert.Contains("\"distance\": 141.543", json);
        Assert.Contains("\"azimuthDeg\": 62.202", json);
        Assert.Contains("\"elevationDeg\": -17.367", json);
        Assert.Equal(view, ViewState.ParseStoredView(json));
    }

    [Theory]
    [InlineData(1.0005, 1.001)]
    [InlineData(-1.0005, -1)]      // Math.round sends halves up, so -1.0005 becomes -1, not -1.001
    [InlineData(-0.0001, 0)]       // and never writes -0
    [InlineData(2.4994, 2.499)]
    public void RoundsLikeTheJsApp(double value, double expected) => Assert.Equal(expected, ViewState.R3(value));

    [Fact]
    public void LookingStraightDownStillGivesAValidView()
    {
        var view = ViewMath.LookAt(new Vector3(0, 10, 0), Vector3.Zero, Vector3.UnitY);
        Assert.False(float.IsNaN(view.M11) || float.IsNaN(view.M22) || float.IsNaN(view.M33));
    }
}
