using System.Numerics;
using Xandrite.Framing;

namespace Xandrite.Core.Tests;

public class OrbitCameraTests
{
    private static void Near(float expected, float actual, float tolerance = 1e-3f) =>
        Assert.True(MathF.Abs(expected - actual) <= tolerance, $"expected {expected}, got {actual}");

    private static OrbitCamera Front(float distance = 10)
    {
        var camera = new OrbitCamera();
        camera.SetView(new StoredView(new Vector3(0, 0, distance), Vector3.Zero, 35, true), modelRadius: 1);
        return camera;
    }

    [Fact]
    public void ResetGivesTheSameViewAsTheThumbnails()
    {
        var camera = new OrbitCamera();
        camera.Reset(38.16f, 1);
        var automatic = ViewMath.DefaultCamera(38.16f, 1);
        Assert.Equal(automatic.Position, camera.Position);
        Assert.Equal(Vector3.Zero, camera.Target);
    }

    [Fact]
    public void DraggingAcrossAQuarterOfTheHeightTurnsAQuarter()
    {
        var camera = Front();
        camera.Rotate(dxPixels: 100, dyPixels: 0, viewportHeight: 400);   // 2π · 100/400 = 90°
        Near(-10, camera.Position.X);
        Near(0, camera.Position.Z);
        Near(10, camera.Distance);
    }

    [Fact]
    public void TheCameraStopsAtThePolesInsteadOfFlippingOver()
    {
        var camera = Front();
        camera.Rotate(0, dyPixels: 1000, viewportHeight: 400);   // far past straight up
        Assert.True(camera.Position.Y > 9.99f);
        Assert.False(float.IsNaN(camera.Position.X));
        var view = camera.Setup(1).View;
        Assert.False(float.IsNaN(view.M11));
    }

    [Fact]
    public void PanningMovesCameraAndTargetTogether()
    {
        var camera = Front();
        camera.Pan(dxPixels: 50, dyPixels: 0, viewportHeight: 400);
        Assert.True(camera.Target.X < 0);        // dragging right moves the scene right, so the camera goes left
        Near(camera.Target.X, camera.Position.X);
        Near(10, camera.Distance);
        // Half the visible height at the target is distance · tan(fov / 2); 50 of 400 pixels pans a quarter of that.
        Near(-2 * 50 * 10 * MathF.Tan(35 * MathF.PI / 360) / 400, camera.Target.X);
    }

    [Fact]
    public void TheWheelZoomsByFivePercentANotchWithinLimits()
    {
        var camera = Front();
        camera.Zoom(120);
        Near(9.5f, camera.Distance);
        camera.Zoom(-120);
        Near(10, camera.Distance);
        for (int i = 0; i < 1000; i++) camera.Zoom(120);
        Near(0.01f, camera.Distance, 1e-4f);    // never inside the model's centre
    }

    [Fact]
    public void ClippingPlanesFollowTheDistance()
    {
        var camera = Front(distance: 500);
        var setup = camera.Setup(1.5f);
        Assert.True(setup.Far > 500);
        Assert.Equal(1.5f, setup.Aspect);
    }

    [Fact]
    public void TheThumbnailShowsTheSameWidthInATallViewport()
    {
        var camera = Front();
        Assert.Equal(35f, camera.ThumbnailView(aspect: 1.6f, zUp: true).FovDeg);   // wide: unchanged
        var tall = camera.ThumbnailView(aspect: 0.5f, zUp: false);
        Near((float)(2 * Math.Atan(Math.Tan(35 * Math.PI / 360) * 0.5) * 180 / Math.PI), tall.FovDeg);
        Assert.False(tall.ZUp);
        Assert.Equal(camera.Position, tall.Position);
    }
}
