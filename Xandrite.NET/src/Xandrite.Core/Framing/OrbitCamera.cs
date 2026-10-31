using System.Numerics;

namespace Xandrite.Framing;

/// <summary>
/// The viewer's camera: orbits around a target, pans, and zooms, the way three.js's OrbitControls did in the Electron
/// app (left-drag turns, right-drag pans, the wheel zooms; up stays up, and the camera never flips over the poles).
/// Distances are in the scene's units (the model's own, centred and turned Z-up if asked).
/// </summary>
public sealed class OrbitCamera
{
    private const float PoleMargin = 1e-6f;

    public Vector3 Position { get; private set; } = new(1, 1, 1);

    public Vector3 Target { get; private set; } = Vector3.Zero;

    /// <summary>Vertical field of view of the viewer's own camera.</summary>
    public float FovDeg { get; } = Look.CameraFovDeg;

    /// <summary>The model's radius, for the clipping planes and the closest zoom.</summary>
    public float ModelRadius { get; private set; } = 1;

    public float Distance => Vector3.Distance(Position, Target);

    /// <summary>The automatic view for a model of this radius, in a viewport of this shape.</summary>
    public void Reset(float modelRadius, float aspect)
    {
        ModelRadius = modelRadius > 0 ? modelRadius : 1;
        var camera = ViewMath.DefaultCamera(ModelRadius, aspect, FovDeg);
        Position = camera.Position;
        Target = camera.Target;
    }

    /// <summary>A saved view: its position and target (the viewer keeps its own field of view, as the JS app did).</summary>
    public void SetView(StoredView view, float modelRadius)
    {
        ModelRadius = modelRadius > 0 ? modelRadius : 1;
        Position = view.Position;
        Target = view.Target;
        if (Vector3.DistanceSquared(Position, Target) < 1e-12f) Position = Target + new Vector3(0, 0, ModelRadius);
    }

    /// <summary>Turns the camera around the target. A drag across the full height of the viewport is a full turn.</summary>
    public void Rotate(float dxPixels, float dyPixels, float viewportHeight)
    {
        if (viewportHeight <= 0) return;
        var offset = Position - Target;
        float radius = offset.Length();
        if (radius <= 0) return;

        float theta = MathF.Atan2(offset.X, offset.Z);                        // around the vertical axis
        float phi = MathF.Acos(Math.Clamp(offset.Y / radius, -1f, 1f));       // down from straight above
        theta -= 2 * MathF.PI * dxPixels / viewportHeight;
        phi -= 2 * MathF.PI * dyPixels / viewportHeight;
        phi = Math.Clamp(phi, PoleMargin, MathF.PI - PoleMargin);

        Position = Target + radius * new Vector3(MathF.Sin(phi) * MathF.Sin(theta), MathF.Cos(phi), MathF.Sin(phi) * MathF.Cos(theta));
    }

    /// <summary>Moves the camera and target together, so the point under the mouse follows it.</summary>
    public void Pan(float dxPixels, float dyPixels, float viewportHeight)
    {
        if (viewportHeight <= 0) return;
        var view = ViewMath.LookAt(Position, Target, Vector3.UnitY);
        var right = new Vector3(view.M11, view.M21, view.M31);   // the camera's x axis in the scene
        var up = new Vector3(view.M12, view.M22, view.M32);      // and its y axis
        float halfHeight = Distance * MathF.Tan(FovDeg * MathF.PI / 360f);   // half the visible height at the target
        var move = -right * (2 * dxPixels * halfHeight / viewportHeight) + up * (2 * dyPixels * halfHeight / viewportHeight);
        Position += move;
        Target += move;
    }

    /// <summary>Zooms in (positive) or out (negative). One wheel notch (120) moves 5% closer or further.</summary>
    public void Zoom(float wheelDelta)
    {
        if (wheelDelta == 0) return;
        float scale = MathF.Pow(0.95f, MathF.Abs(wheelDelta) / 120f);
        float distance = wheelDelta > 0 ? Distance * scale : Distance / scale;
        distance = Math.Clamp(distance, ModelRadius * 0.01f, ModelRadius * 1000f);
        Position = Target + Vector3.Normalize(Position - Target) * distance;
    }

    /// <summary>The camera for a viewport of this shape. Clipping planes follow the distance, so zooming never cuts the model.</summary>
    public CameraSetup Setup(float aspect) =>
        ViewMath.StoredCamera(new StoredView(Position, Target, FovDeg, false), ModelRadius, aspect);

    /// <summary>
    /// The square thumbnail of what the viewer shows: the same position and direction. In a viewport taller than it is
    /// wide, the field of view is narrowed so the thumbnail shows the same width (as the JS app's syncThumbCamera did).
    /// </summary>
    public StoredView ThumbnailView(float aspect, bool zUp)
    {
        double halfV = FovDeg * Math.PI / 360.0;
        float fov = (float)(2 * Math.Atan(Math.Tan(halfV) * Math.Min(1, aspect)) * 180 / Math.PI);
        return new StoredView(Position, Target, fov, zUp);
    }
}
