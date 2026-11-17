/// Compiled at runtime with `makeLibrary(source:)`, so building the helper only
/// needs `swift build`, not the separately installed Metal toolchain.
///
/// The overlay can't read the live screen it covers. Its output is
/// premultiplied, and the window server composites it as
/// `rgb + (1 - a) × screen`, so wherever nothing is drawn the real screen shows
/// through untouched. Behind the first front it draws the backdrop opaquely
/// (the stage), so from there on it owns every pixel and can move them all.
let shaderSource = """
#include <metal_stdlib>
using namespace metal;

struct RippleUniforms {
  float2 resolution;
  float2 stone;
  float4 rippleStart;
  float4 rippleStrength;
  float time;
  float rippleCount;
  float speed;
  float wavelength;
  float pack;
  float soft;
  float amplitude;
  float decay;
  float refraction;
  float hasBackdrop;
  float darkBottom;
  float darkTop;
  float push;
  float pushOmega;
  float pushDecay;
  float pushNorm;
  float pushOnset;
  float stageStart;
  float stageWash;
  float swellOnset;
};

struct TextUniforms {
  float4 rect;
  float4 color;
  float2 target;
  float sigma;
  float opacity;
};

struct VOut {
  float4 position [[position]];
  float2 uv;
};

constexpr sampler backdropSampler(coord::normalized, address::mirrored_repeat, filter::linear);
constexpr sampler textSampler(coord::normalized, address::clamp_to_zero, filter::linear);

vertex VOut fullscreen_vertex(uint vid [[vertex_id]]) {
  float2 p = float2((vid << 1) & 2, vid & 2);
  VOut out;
  out.position = float4(p * 2 - 1, 0, 1);
  out.uv = float2(p.x, 1 - p.y);
  return out;
}

struct Field {
  float fill;
  float height;
  float rim;
};

// Mirrors rippleSample() in Timeline.swift.
Field rippleField(float2 p, constant RippleUniforms& u) {
  Field f = { 0, 0, 0 };
  float d = distance(p, u.stone);
  float weight = 1.0 / u.rippleCount;
  float rimSoft = u.soft * 0.35;
  for (int i = 0; i < int(u.rippleCount); i++) {
    float age = u.time - u.rippleStart[i];
    if (age < 0) continue;
    float strength = u.rippleStrength[i];
    float x = d - age * u.speed;
    f.fill += weight * (1 - smoothstep(-u.soft, 0.0, x));
    float s = x > 0 ? u.wavelength * 0.6 : u.pack;
    float envelope = exp(-(x * x) / (s * s));
    float fade = exp(-age * u.decay) * smoothstep(0.0, u.swellOnset, age);
    f.height += strength * u.amplitude * fade * envelope * sin(x * 2 * M_PI_F / u.wavelength);
    f.rim += strength * fade * exp(-(x * x) / (rimSoft * rimSoft));
  }
  return f;
}

// Mirrors pushOffset() in Timeline.swift: each front shoves the content away
// from the stone, and it rides a damped spring back. y up.
float2 pushField(float2 p, constant RippleUniforms& u) {
  float2 delta = p - u.stone;
  float d = length(delta);
  float amount = 0;
  for (int i = 0; i < int(u.rippleCount); i++) {
    float tau = u.time - u.rippleStart[i] - d / u.speed;
    if (tau <= 0) continue;
    amount += u.rippleStrength[i] * u.pushNorm * smoothstep(0.0, u.pushOnset, tau)
      * exp(-u.pushDecay * tau) * sin(u.pushOmega * tau);
  }
  return delta / max(d, 1e-3) * (amount * u.push);
}

struct WaterLook {
  float shade;
  float sheen;
  float sheenPower;
  float rim;
};


// The water: the ripples are seen by how they bend the stage, a soft light
// on their slopes and the darkness they bring in, never by bands or glints.
fragment float4 water_fragment(
  VOut in [[stage_in]],
  constant RippleUniforms& u [[buffer(0)]],
  constant WaterLook& w [[buffer(2)]],
  texture2d<float> backdrop [[texture(0)]]
) {
  float2 pix = in.position.xy;
  float2 p = float2(pix.x, u.resolution.y - pix.y);
  Field f = rippleField(p, u);
  float2 g = float2(
    rippleField(p + float2(1, 0), u).height - f.height,
    rippleField(p + float2(0, 1), u).height - f.height
  );

  float y01 = clamp(p.y / u.resolution.y, 0.0, 1.0);
  float alpha = mix(u.darkBottom, u.darkTop, y01) * clamp(f.fill, 0.0, 1.0);
  const float3 tint = float3(5, 5, 7) / 255;
  const float3 cool = float3(0x8F, 0xA8, 0xFF) / 255;
  const float3 L = normalize(float3(-0.4, 0.65, 0.8));

  // Slopes turned from the light darken half as much as lit ones brighten,
  // so a swell reads as a rounded form, not a dark band.
  float3 n = normalize(float3(-g * 1.6, 1));
  float lit = (dot(n, L) - L.z) * w.shade;
  float3 extra = lit > 0 ? lit : lit * 0.5;
  float sheen = max(pow(max(dot(reflect(-L, n), float3(0, 0, 1)), 0.0), w.sheenPower) - pow(L.z, w.sheenPower), 0.0);
  extra += cool * (sheen * w.sheen + f.rim * w.rim);

  float r = 0;
  float3 behind = 0;
  if (u.hasBackdrop > 0.5 && u.time >= u.stageStart) {
    float x = distance(p, u.stone) - (u.time - u.stageStart) * u.speed;
    r = 1 - smoothstep(-u.stageWash, 0.0, x);
    if (r > 0) {
      float2 offset = g * u.refraction - pushField(p, u);
      float2 samplePix = float2(pix.x + offset.x, pix.y - offset.y);
      behind = backdrop.sample(backdropSampler, samplePix / u.resolution).rgb;
    }
  }

  float a = 1 - (1 - alpha) * (1 - r);
  float3 rgb = (1 - alpha) * r * behind + alpha * tint + extra;
  float deficit = max(0.0, -min(rgb.r, min(rgb.g, rgb.b)));
  rgb = max(rgb, 0.0);
  a += deficit * (1 - a);
  return float4(rgb, a);
}

float blur1D(texture2d<float> t, float2 uv, float2 step, float sigma) {
  if (sigma < 0.3) return t.sample(textSampler, uv).r;
  int radius = int(ceil(sigma * 3));
  float sum = 0;
  float total = 0;
  for (int i = -radius; i <= radius; i++) {
    float w = exp(-float(i * i) / (2 * sigma * sigma));
    sum += w * t.sample(textSampler, uv + step * float(i)).r;
    total += w;
  }
  return sum / total;
}

fragment float text_blur_horizontal(
  VOut in [[stage_in]],
  constant TextUniforms& u [[buffer(0)]],
  texture2d<float> mask [[texture(0)]]
) {
  return blur1D(mask, in.uv, float2(1.0 / mask.get_width(), 0), u.sigma);
}

vertex VOut text_vertex(uint vid [[vertex_id]], constant TextUniforms& u [[buffer(0)]]) {
  float2 corner = float2(vid & 1, vid >> 1);
  float2 pix = u.rect.xy + corner * u.rect.zw;
  VOut out;
  out.position = float4(pix.x / u.target.x * 2 - 1, 1 - pix.y / u.target.y * 2, 0, 1);
  out.uv = corner;
  return out;
}

fragment float4 text_fragment(
  VOut in [[stage_in]],
  constant TextUniforms& u [[buffer(0)]],
  texture2d<float> blurred [[texture(0)]]
) {
  float coverage = blur1D(blurred, in.uv, float2(0, 1.0 / blurred.get_height()), u.sigma);
  float a = u.color.a * coverage * u.opacity;
  return float4(u.color.rgb * a, a);
}

fragment float4 copy_fragment(VOut in [[stage_in]], texture2d<float> source [[texture(0)]]) {
  return float4(source.sample(backdropSampler, in.uv).rgb, 1);
}

// The reveal: a wave from the middle of the display that opens
// the overlay onto the real window underneath. Drawn last, over everything
// the overlay holds, with a blend that keeps `keep` of it (colour and
// coverage alike) and adds the cool light along the wave's edge.
// Mirrors `revealKeep` in Timeline.swift.
struct RevealUniforms {
  float2 centre;
  float radius;
  float soft;
  float rim;
};

fragment float4 reveal_fragment(VOut in [[stage_in]], constant RevealUniforms& u [[buffer(0)]]) {
  float2 pix = in.position.xy;
  float d = distance(pix, u.centre);
  float keep = smoothstep(u.radius - u.soft, u.radius, d);
  // A low swell just outside the opening: light on its rounded crest.
  float x = (d - u.radius - u.soft * 0.25) / (u.soft * 0.45);
  float crest = exp(-x * x) * u.rim;
  const float3 cool = float3(0x8F, 0xA8, 0xFF) / 255;
  // rgb: cool·crest + dst·keep. alpha: dst·keep (see the reveal pipeline).
  return float4(cool * crest * keep, 1 - keep);
}
"""
