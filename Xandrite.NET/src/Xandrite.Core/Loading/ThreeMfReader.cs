using System.Globalization;
using System.IO.Compression;
using System.Numerics;
using System.Xml;
using Xandrite.Geometry;

namespace Xandrite.Loading;

/// <summary>
/// Reads 3MF packages: the main model named in _rels/.rels, its build items, and objects made of meshes and of
/// components, including components stored in other model files (the 3MF "production" extension that Bambu Studio,
/// Orca Slicer and PrusaSlicer use). Colours from &lt;basematerials&gt; and &lt;m:colorgroup&gt; are kept.
///
/// This does in one reader what the JS app did with three.js's 3MFLoader plus its own fallback reader.
/// The XML is streamed, so very large meshes do not build a DOM in memory.
/// </summary>
public static class ThreeMfReader
{
    private const int MaxDepth = 16;
    private const long MaxPartBytes = 4L * 1024 * 1024 * 1024;

    public static Mesh Read(Stream package)
    {
        ZipArchive zip;
        try
        {
            zip = new ZipArchive(package, ZipArchiveMode.Read, leaveOpen: true);
        }
        catch (InvalidDataException e)
        {
            throw new ModelFormatException("This is not a readable 3MF file (the file is not a valid zip package).", e);
        }

        MeshBuilder builder;
        using (zip)
        {
            try
            {
                builder = new Reader(zip).Read();
            }
            catch (Exception e) when (e is ModelFormatException or XmlException or InvalidDataException or IOException or FormatException or OverflowException)
            {
                throw new ModelFormatException("This is not a readable 3MF file (" + e.Message.TrimEnd('.') + ").", e);
            }
        }
        return builder.Build();   // "The file contains no triangles." if the build items held no mesh
    }

    private sealed class Reader(ZipArchive zip)
    {
        private readonly Dictionary<string, ModelPart> _parts = new(StringComparer.OrdinalIgnoreCase);
        private readonly MeshBuilder _builder = new();

        public MeshBuilder Read()
        {
            string rootPath = FindRootModelPath();
            var root = LoadPart(rootPath);
            if (root.Build.Count == 0) throw new ModelFormatException("the 3MF has no build items");
            foreach (var item in root.Build)
            {
                Emit(item.Path ?? rootPath, item.ObjectId, item.Transform, 0);
            }
            return _builder;
        }

        private string FindRootModelPath()
        {
            var rels = Find("_rels/.rels");
            if (rels is not null)
            {
                using var reader = OpenXml(rels);
                while (reader.Read())
                {
                    if (reader.NodeType == XmlNodeType.Element && reader.LocalName == "Relationship")
                    {
                        string? type = reader.GetAttribute("Type");
                        string? target = reader.GetAttribute("Target");
                        if (type is not null && target is not null && type.EndsWith("3dmodel", StringComparison.OrdinalIgnoreCase))
                            return Normalize(target);
                    }
                }
            }
            return "3D/3dmodel.model";
        }

        private static string Normalize(string path) => path.Replace('\\', '/').TrimStart('/');

        private ZipArchiveEntry? Find(string path)
        {
            path = Normalize(path);
            return zip.GetEntry(path) ?? zip.Entries.FirstOrDefault(e => string.Equals(e.FullName, path, StringComparison.OrdinalIgnoreCase));
        }

        private static XmlReader OpenXml(ZipArchiveEntry entry)
        {
            if (entry.Length > MaxPartBytes) throw new ModelFormatException(entry.FullName + " is too large");
            var settings = new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit,
                IgnoreComments = true,
                IgnoreWhitespace = true,
                IgnoreProcessingInstructions = true,
                XmlResolver = null,
            };
            return XmlReader.Create(entry.Open(), settings);
        }

        private ModelPart LoadPart(string path)
        {
            path = Normalize(path);
            if (_parts.TryGetValue(path, out var part)) return part;
            var entry = Find(path) ?? throw new ModelFormatException("missing " + path + " in the 3MF package");
            using var reader = OpenXml(entry);
            part = ModelPart.Parse(reader);
            _parts[path] = part;
            return part;
        }

        private void Emit(string path, string objectId, Matrix4x4 transform, int depth)
        {
            if (depth > MaxDepth) throw new ModelFormatException("components are nested too deeply");
            var part = LoadPart(path);
            if (!part.Objects.TryGetValue(objectId, out var obj)) throw new ModelFormatException("object " + objectId + " not found in " + path);

            if (obj.Triangles.Count > 0) EmitMesh(part, obj, transform);
            foreach (var component in obj.Components)
            {
                // 3MF matrices are written for row vectors (v' = v * M), the same convention as System.Numerics,
                // so a component placed inside a parent is simply child * parent.
                Emit(component.Path ?? path, component.ObjectId, component.Transform * transform, depth + 1);
            }
        }

        private void EmitMesh(ModelPart part, ObjectDef obj, Matrix4x4 transform)
        {
            var positions = obj.Vertices;
            int vertexCount = positions.Count / 3;
            var world = new Vector3[vertexCount];
            bool identity = transform.IsIdentity;
            for (int i = 0; i < vertexCount; i++)
            {
                var v = new Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
                world[i] = identity ? v : Vector3.Transform(v, transform);
            }

            var tris = obj.Triangles;
            for (int t = 0; t < tris.Count; t++)
            {
                var tri = tris[t];
                if ((uint)tri.V1 >= (uint)vertexCount || (uint)tri.V2 >= (uint)vertexCount || (uint)tri.V3 >= (uint)vertexCount)
                    throw new ModelFormatException("a triangle in object " + obj.Id + " points to a vertex that does not exist");

                string? pid = tri.Pid ?? obj.Pid;
                uint c1 = Look.MaterialColorPacked, c2 = c1, c3 = c1;
                if (pid is not null && part.Properties.TryGetValue(pid, out var group))
                {
                    int p1 = tri.P1 >= 0 ? tri.P1 : obj.PIndex;
                    int p2 = tri.P2 >= 0 ? tri.P2 : p1;    // 3MF: p2 and p3 default to p1
                    int p3 = tri.P3 >= 0 ? tri.P3 : p1;
                    c1 = Pick(group, p1, c1);
                    c2 = Pick(group, p2, c2);
                    c3 = Pick(group, p3, c3);
                    _builder.HasOwnColors = true;
                }
                _builder.Add(world[tri.V1], world[tri.V2], world[tri.V3], c1, c2, c3);
            }
        }

        private static uint Pick(uint[] group, int index, uint fallback) =>
            (uint)index < (uint)group.Length ? group[index] : fallback;
    }

    /* ---------- one model file (3D/3dmodel.model or 3D/Objects/object_N.model) ---------- */

    private sealed class ModelPart
    {
        public Dictionary<string, ObjectDef> Objects { get; } = new(StringComparer.Ordinal);

        /// <summary>basematerials and colorgroup resources: id → packed colours by index.</summary>
        public Dictionary<string, uint[]> Properties { get; } = new(StringComparer.Ordinal);

        public List<ComponentRef> Build { get; } = [];

        public static ModelPart Parse(XmlReader reader)
        {
            var part = new ModelPart();
            ObjectDef? current = null;
            List<uint>? group = null;
            string? groupId = null;

            while (reader.Read())
            {
                if (reader.NodeType == XmlNodeType.EndElement)
                {
                    switch (reader.LocalName)
                    {
                        case "object" when current is not null:
                            part.Objects[current.Id] = current;
                            current = null;
                            break;
                        case "basematerials" or "colorgroup" when group is not null && groupId is not null:
                            part.Properties[groupId] = [.. group];
                            group = null;
                            groupId = null;
                            break;
                    }
                    continue;
                }
                if (reader.NodeType != XmlNodeType.Element) continue;

                switch (reader.LocalName)
                {
                    case "object":
                        current = new ObjectDef(reader.GetAttribute("id") ?? "")
                        {
                            Pid = reader.GetAttribute("pid"),
                            PIndex = Int(reader.GetAttribute("pindex"), 0),
                        };
                        if (reader.IsEmptyElement) { part.Objects[current.Id] = current; current = null; }
                        break;

                    case "vertex" when current is not null:
                        current.Vertices.Add(Float(reader.GetAttribute("x")));
                        current.Vertices.Add(Float(reader.GetAttribute("y")));
                        current.Vertices.Add(Float(reader.GetAttribute("z")));
                        break;

                    case "triangle" when current is not null:
                        current.Triangles.Add(new TriangleDef(
                            Int(reader.GetAttribute("v1"), -1), Int(reader.GetAttribute("v2"), -1), Int(reader.GetAttribute("v3"), -1),
                            reader.GetAttribute("pid"),
                            Int(reader.GetAttribute("p1"), -1), Int(reader.GetAttribute("p2"), -1), Int(reader.GetAttribute("p3"), -1)));
                        break;

                    case "component" when current is not null:
                        current.Components.Add(new ComponentRef(
                            reader.GetAttribute("objectid") ?? "",
                            LocalAttribute(reader, "path"),
                            Matrix(reader.GetAttribute("transform"))));
                        break;

                    case "basematerials" or "colorgroup":
                        groupId = reader.GetAttribute("id");
                        group = [];
                        if (reader.IsEmptyElement && groupId is not null) { part.Properties[groupId] = []; group = null; groupId = null; }
                        break;

                    case "base" when group is not null:
                        group.Add(ColorSpace.TryParse3mfColor(reader.GetAttribute("displaycolor"), out var baseColor) ? baseColor : Look.MaterialColorPacked);
                        break;

                    case "color" when group is not null:
                        group.Add(ColorSpace.TryParse3mfColor(reader.GetAttribute("color"), out var color) ? color : Look.MaterialColorPacked);
                        break;

                    case "item":
                        part.Build.Add(new ComponentRef(
                            reader.GetAttribute("objectid") ?? "",
                            LocalAttribute(reader, "path"),
                            Matrix(reader.GetAttribute("transform"))));
                        break;
                }
            }
            return part;
        }

        /// <summary>An attribute matched by local name, so both "p:path" and "path" are found.</summary>
        private static string? LocalAttribute(XmlReader reader, string localName)
        {
            if (!reader.HasAttributes) return null;
            string? value = null;
            for (int i = 0; i < reader.AttributeCount; i++)
            {
                reader.MoveToAttribute(i);
                if (reader.LocalName == localName) { value = reader.Value; break; }
            }
            reader.MoveToElement();
            return value;
        }

        private static float Float(string? s)
        {
            if (s is null || !float.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out float v))
                throw new ModelFormatException("a vertex has a coordinate that is not a number");
            return v;
        }

        private static int Int(string? s, int fallback) =>
            s is not null && int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out int v) ? v : fallback;

        /// <summary>"m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32"; anything else is treated as no transform.</summary>
        private static Matrix4x4 Matrix(string? s)
        {
            if (string.IsNullOrWhiteSpace(s)) return Matrix4x4.Identity;
            var parts = s.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length != 12) return Matrix4x4.Identity;
            Span<float> n = stackalloc float[12];
            for (int i = 0; i < 12; i++)
            {
                if (!float.TryParse(parts[i], NumberStyles.Float, CultureInfo.InvariantCulture, out n[i])) return Matrix4x4.Identity;
            }
            return new Matrix4x4(
                n[0], n[1], n[2], 0,
                n[3], n[4], n[5], 0,
                n[6], n[7], n[8], 0,
                n[9], n[10], n[11], 1);
        }
    }

    private sealed class ObjectDef(string id)
    {
        public string Id { get; } = id;
        public string? Pid { get; init; }
        public int PIndex { get; init; }
        public List<float> Vertices { get; } = [];
        public List<TriangleDef> Triangles { get; } = [];
        public List<ComponentRef> Components { get; } = [];
    }

    private readonly record struct TriangleDef(int V1, int V2, int V3, string? Pid, int P1, int P2, int P3);

    private readonly record struct ComponentRef(string ObjectId, string? Path, Matrix4x4 Transform);
}
