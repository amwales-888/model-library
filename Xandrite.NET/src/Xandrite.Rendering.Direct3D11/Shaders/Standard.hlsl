// Xandrite model shader.
//
// A port of the lighting the Electron app got from three.js (r160): MeshStandardMaterial lit by one hemisphere light
// and two directional lights, no environment map, no tone mapping. Colours are linear; the render target is sRGB,
// so the GPU applies the sRGB curve on write, as three.js did for its canvas output.
//
// Faces are shaded flat. The face normal comes from the screen-space derivatives of the world position, so vertices
// carry no normals, and it is turned to face the camera, which matches three.js's DoubleSide rendering.

cbuffer Frame : register(b0)
{
    row_major float4x4 Model;           // file coordinates -> scene (Z-up rotation and centring)
    row_major float4x4 ViewProjection;
    float4 CameraPosition;              // xyz: camera position in the scene
    float4 SkyColor;                    // rgb: hemisphere sky colour x intensity (linear)
    float4 GroundColor;                 // rgb: hemisphere ground colour x intensity (linear)
    float4 KeyDirection;                // xyz: unit vector towards the key light
    float4 KeyColor;                    // rgb: colour x intensity
    float4 FillDirection;
    float4 FillColor;
    float4 Material;                    // x: roughness, y: metalness
};

struct VertexInput
{
    float3 position : POSITION;
    float4 color    : COLOR;            // linear base colour
};

struct PixelInput
{
    float4 position : SV_Position;
    float3 world    : WORLDPOS;
    float3 color    : COLOR;
};

PixelInput VSMain(VertexInput input)
{
    PixelInput output;
    float4 world = mul(float4(input.position, 1.0), Model);
    output.position = mul(world, ViewProjection);
    output.world = world.xyz;
    output.color = input.color.rgb;
    return output;
}

static const float RECIPROCAL_PI = 0.3183098861837907;

// The functions below follow three.js's bsdfs / lights_physical shader chunks.
float3 F_Schlick(float3 f0, float f90, float dotVH)
{
    float fresnel = exp2((-5.55473 * dotVH - 6.98316) * dotVH);
    return f0 * (1.0 - fresnel) + f90 * fresnel;
}

float V_GGX_SmithCorrelated(float alpha, float dotNL, float dotNV)
{
    float a2 = alpha * alpha;
    float gv = dotNL * sqrt(a2 + (1.0 - a2) * dotNV * dotNV);
    float gl = dotNV * sqrt(a2 + (1.0 - a2) * dotNL * dotNL);
    return 0.5 / max(gv + gl, 1e-6);
}

float D_GGX(float alpha, float dotNH)
{
    float a2 = alpha * alpha;
    float denom = dotNH * dotNH * (a2 - 1.0) + 1.0;
    return RECIPROCAL_PI * a2 / (denom * denom);
}

float3 DirectLight(float3 n, float3 v, float3 l, float3 radiance, float3 diffuseColor, float3 specularColor, float roughness)
{
    float dotNL = saturate(dot(n, l));
    float3 irradiance = dotNL * radiance;
    float3 h = normalize(l + v);
    float dotNV = saturate(dot(n, v));
    float dotNH = saturate(dot(n, h));
    float dotVH = saturate(dot(v, h));
    float alpha = roughness * roughness;
    float3 specular = F_Schlick(specularColor, 1.0, dotVH) * (V_GGX_SmithCorrelated(alpha, dotNL, dotNV) * D_GGX(alpha, dotNH));
    return irradiance * (diffuseColor * RECIPROCAL_PI + specular);
}

float4 PSMain(PixelInput input) : SV_Target
{
    float3 v = normalize(CameraPosition.xyz - input.world);

    // Flat face normal from the derivatives of the position, turned towards the camera.
    float3 n = cross(ddx(input.world), ddy(input.world));
    float len = length(n);
    n = len > 1e-30 ? n / len : v;
    if (dot(n, v) < 0.0) n = -n;

    float roughness = min(max(Material.x, 0.0525), 1.0);
    float metalness = Material.y;
    float3 diffuseColor = input.color * (1.0 - metalness);
    float3 specularColor = lerp(float3(0.04, 0.04, 0.04), input.color, metalness);

    // Hemisphere light: sky colour from above, ground colour from below (three.js uses it as indirect diffuse).
    float3 hemisphere = lerp(GroundColor.rgb, SkyColor.rgb, 0.5 * n.y + 0.5);
    float3 color = hemisphere * diffuseColor * RECIPROCAL_PI;

    color += DirectLight(n, v, KeyDirection.xyz, KeyColor.rgb, diffuseColor, specularColor, roughness);
    color += DirectLight(n, v, FillDirection.xyz, FillColor.rgb, diffuseColor, specularColor, roughness);
    return float4(color, 1.0);
}
