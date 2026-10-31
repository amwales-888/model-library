using System.Numerics;
using Xandrite.Geometry;

namespace Xandrite.Framing;

/// <summary>A camera, described the way three.js's PerspectiveCamera is.</summary>
public readonly record struct CameraSetup(Vector3 Position, Vector3 Target, Vector3 Up, float FovDeg, float Near, float Far, float Aspect)
{
    public Matrix4x4 View => ViewMath.LookAt(Position, Target, Up);

    /// <summary>Right-handed, depth 0..1 (Direct3D).</summary>
    public Matrix4x4 Projection => Matrix4x4.CreatePerspectiveFieldOfView(FovDeg * MathF.PI / 180f, Aspect, Near, Far);

    public float Distance => Vector3.Distance(Position, Target);
}

/// <summary>Where the model sits in the scene: rotated so Z points up (if asked) and centred at the origin.</summary>
public readonly record struct ModelFrame(Matrix4x4 Transform, float Radius, bool ZUp);

/// <summary>A view the person set up in the viewer (the `views` table of the library database).</summary>
public sealed record StoredView(Vector3 Position, Vector3 Target, float FovDeg, bool ZUp);

/// <summary>Camera and framing maths, ported from renderer/lib/view.js.</summary>
public static class ViewMath
{
    /// <summary>
    /// Rotates the model so the file's Z axis points up (if zUp) and moves it so the middle of its bounding box is at
    /// the origin. The radius is half the diagonal of that box. STL and 3MF files are normally Z-up; the scene is Y-up.
    /// </summary>
    public static ModelFrame OrientAndCentre(BoundingBox fileBounds, bool zUp)
    {
        // A -90° turn about X maps (x, y, z) to (x, z, -y). Written out exactly so no rounding creeps in.
        var rotation = zUp
            ? new Matrix4x4(1, 0, 0, 0,
                            0, 0, -1, 0,
                            0, 1, 0, 0,
                            0, 0, 0, 1)
            : Matrix4x4.Identity;

        var min = fileBounds.Min;
        var max = fileBounds.Max;
        var box = zUp
            ? new BoundingBox(new Vector3(min.X, min.Z, -max.Y), new Vector3(max.X, max.Z, -min.Y))
            : fileBounds;

        float radius = box.Size.Length() / 2f;
        if (!(radius > 0) || !float.IsFinite(radius)) radius = 1f;
        return new ModelFrame(rotation * Matrix4x4.CreateTranslation(-box.Center), radius, zUp);
    }

    /// <summary>Distance at which a model of the given radius just fits the view, with a small margin.</summary>
    public static float FitDistance(float radius, float fovDeg, float aspect)
    {
        double vfov = fovDeg * Math.PI / 180.0;
        double hfov = 2 * Math.Atan(Math.Tan(vfov / 2) * aspect);
        return (float)(radius / Math.Sin(Math.Min(vfov, hfov) / 2) * 1.08);
    }

    /// <summary>The automatic view: on <see cref="Look.DefaultViewDirection"/>, framed for the radius, looking at the origin.</summary>
    public static CameraSetup DefaultCamera(float radius, float aspect, float fovDeg = Look.CameraFovDeg)
    {
        float distance = FitDistance(radius, fovDeg, aspect);
        return new CameraSetup(
            Position: Look.DefaultViewDirection * distance,
            Target: Vector3.Zero,
            Up: Vector3.UnitY,
            FovDeg: fovDeg,
            Near: MathF.Max(radius * 0.01f, 0.0001f),
            Far: distance + radius * 6f,
            Aspect: aspect);
    }

    /// <summary>
    /// A stored view. The clipping planes are worked out from the model's radius and the camera's distance, so a view
    /// that was zoomed far out or in still shows the whole model.
    /// </summary>
    public static CameraSetup StoredCamera(StoredView view, float radius, float aspect)
    {
        float distance = Vector3.Distance(view.Position, view.Target);
        if (!(distance > 0)) distance = 1f;
        return new CameraSetup(
            Position: view.Position,
            Target: view.Target,
            Up: Vector3.UnitY,
            FovDeg: view.FovDeg,
            Near: MathF.Max(MathF.Min(radius * 0.01f, distance * 0.5f), 0.0001f),
            Far: distance + radius * 6f,
            Aspect: aspect);
    }

    /// <summary>
    /// A right-handed view matrix, built the way three.js's Matrix4.lookAt is, including its small nudge when the
    /// camera looks straight along the up direction (where an ordinary look-at has no answer).
    /// </summary>
    public static Matrix4x4 LookAt(Vector3 eye, Vector3 target, Vector3 up)
    {
        var z = eye - target;
        if (z.LengthSquared() == 0) z = new Vector3(z.X, z.Y, 1);
        z = Vector3.Normalize(z);
        var x = Vector3.Cross(up, z);
        if (x.LengthSquared() == 0)
        {
            z = MathF.Abs(up.Z) == 1 ? z with { X = z.X + 0.0001f } : z with { Z = z.Z + 0.0001f };
            z = Vector3.Normalize(z);
            x = Vector3.Cross(up, z);
        }
        x = Vector3.Normalize(x);
        var y = Vector3.Cross(z, x);

        return new Matrix4x4(
            x.X, y.X, z.X, 0,
            x.Y, y.Y, z.Y, 0,
            x.Z, y.Z, z.Z, 0,
            -Vector3.Dot(x, eye), -Vector3.Dot(y, eye), -Vector3.Dot(z, eye), 1);
    }
}
