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
};

// The surfacing @: two neighbouring blur levels of its shape, each in a box
// centred on the glyph, sized in surfaced device pixels.
struct MarkUniforms {
  float2 sizeA;
  float2 sizeB;
  float2 centre;
  float scale;
  float levelMix;
  float relief;
  float bend;
  float shade;
  float shine;
  float shadow;
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
    float fade = exp(-age * u.decay);
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

float markLevel(texture2d<float> level, float2 local, float2 size) {
  return level.sample(textSampler, float2(local.x / size.x + 0.5, 0.5 - local.y / size.y)).r;
}

// How much of the @'s shadow covers a pixel, 0 to 1.
float markShadow(float2 p, constant MarkUniforms& m, texture2d<float> a, texture2d<float> b) {
  float2 local = (p - m.centre) / m.scale;
  return mix(markLevel(a, local, m.sizeA), markLevel(b, local, m.sizeB), m.levelMix);
}

fragment float4 ripple_fragment(
  VOut in [[stage_in]],
  constant RippleUniforms& u [[buffer(0)]],
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
  const float3 L = normalize(float3(-0.4, 0.65, 0.8));
  float3 n = normalize(float3(-g * 1.6, 1));
  float light = (dot(n, L) - L.z) * 0.30;
  float glint = max(pow(max(dot(reflect(-L, n), float3(0, 0, 1)), 0.0), 60.0) - pow(L.z, 60.0), 0.0) * 0.55;
  float3 extra = light + glint + float3(0x8F, 0xA8, 0xFF) / 255 * f.rim * 0.30;

  // Behind the first front the backdrop covers the screen (the stage), drawn
  // displaced: shoved by the passing fronts and bent a little along the
  // bands. Ahead of it the live screen is left alone; nothing there can move.
  // Mirrors stageCover() in Timeline.swift.
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

  // colour = mix(mix(screen, behind, r), tint, alpha) + extra
  float a = 1 - (1 - alpha) * (1 - r);
  float3 rgb = (1 - alpha) * r * behind + alpha * tint + extra;
  // Shading darker than what's drawn here can't subtract from the screen;
  // deepen the ink by the same amount instead.
  float deficit = max(0.0, -min(rgb.r, min(rgb.g, rgb.b)));
  rgb = max(rgb, 0.0);
  a += deficit * (1 - a);
  return float4(rgb, a);
}

// Once the line is sharp: the same water and stage as ripple_fragment, with
// the @ rising under the dark surface. It is never drawn: its rounded body
// bends the stage and catches the light, as the ripples did. The water settles
// through its uniforms (each ripple's strength eases to 0), so ripple_fragment
// stays as it was and frames up to the sharp line are unchanged to the byte.
// Mirrors surfaceFrame() in Timeline.swift.
fragment float4 surface_fragment(
  VOut in [[stage_in]],
  constant RippleUniforms& u [[buffer(0)]],
  constant MarkUniforms& m [[buffer(1)]],
  texture2d<float> backdrop [[texture(0)]],
  texture2d<float> markA [[texture(1)]],
  texture2d<float> markB [[texture(2)]]
) {
  float2 pix = in.position.xy;
  float2 p = float2(pix.x, u.resolution.y - pix.y);
  Field f = rippleField(p, u);
  float2 g = float2(
    rippleField(p + float2(1, 0), u).height - f.height,
    rippleField(p + float2(0, 1), u).height - f.height
  );

  // The body's surface: its form, blurred to how rounded it is at this depth,
  // raised by `relief`. Its slope tilts the surface the light falls on.
  const float e = 2;
  float2 body = float2(
    markShadow(p + float2(e, 0), m, markA, markB) - markShadow(p - float2(e, 0), m, markA, markB),
    markShadow(p + float2(0, e), m, markA, markB) - markShadow(p - float2(0, e), m, markA, markB)
  ) / (2 * e) * m.relief;

  float y01 = clamp(p.y / u.resolution.y, 0.0, 1.0);
  float alpha = mix(u.darkBottom, u.darkTop, y01) * clamp(f.fill, 0.0, 1.0);
  // The darkness was its shadow: under its body the light is held back more.
  alpha += (1 - alpha) * m.shadow * markShadow(p, m, markA, markB);
  const float3 tint = float3(5, 5, 7) / 255;
  const float3 cool = float3(0x8F, 0xA8, 0xFF) / 255;
  const float3 L = normalize(float3(-0.4, 0.65, 0.8));
  float3 n = normalize(float3(-g * 1.6, 1));
  float light = (dot(n, L) - L.z) * 0.30;
  float glint = max(pow(max(dot(reflect(-L, n), float3(0, 0, 1)), 0.0), 60.0) - pow(L.z, 60.0), 0.0) * 0.55;
  float3 extra = light + glint + cool * f.rim * 0.30;

  float3 nb = normalize(float3(-body, 1));
  // Its faces turned from the light darken half as much as the lit ones
  // brighten, so its edges read as a rounded form, not as rings.
  float lit = (dot(nb, L) - L.z) * m.shade;
  extra += lit > 0 ? lit : lit * 0.5;
  float sheen = max(pow(max(dot(reflect(-L, nb), float3(0, 0, 1)), 0.0), 14.0) - pow(L.z, 14.0), 0.0);
  extra += cool * sheen * m.shine;

  float r = 0;
  float3 behind = 0;
  if (u.hasBackdrop > 0.5 && u.time >= u.stageStart) {
    float x = distance(p, u.stone) - (u.time - u.stageStart) * u.speed;
    r = 1 - smoothstep(-u.stageWash, 0.0, x);
    if (r > 0) {
      float2 offset = g * u.refraction - pushField(p, u) + body * m.bend;
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

struct WaterLook {
  float shade;
  float sheen;
  float sheenPower;
  float rim;
  float plane;
  float planeDarkness;
};

// The backlit ending: the line cut through a dark plane, a light behind it.
// Positions are device pixels, y down, as the text pass uses.
struct LightUniforms {
  float4 rect;
  float4 hot;
  float4 warm;
  float4 far;
  float2 light;
  float near;
  float span;
  float intensity;
  float spread;
  float reach;
  float shafts;
  float glow;
  float source;
  float falloff;
  float bloom;
  float shaftFalloff;
  float shaftWarmth;
  float exposure;
};

float lightMask(texture2d<float> mask, float2 pix, constant LightUniforms& l) {
  return mask.sample(textSampler, (pix - l.rect.xy) / l.rect.zw).r;
}

// The light's colour by distance from it: hot at the source, amber along the
// line, deep red-orange at its far end.
float3 lightColour(float d, constant LightUniforms& l) {
  float k = clamp((d - l.near) / max(l.span, 1.0), 0.0, 1.0);
  return k < 0.5 ? mix(l.hot.rgb, l.warm.rgb, k * 2) : mix(l.warm.rgb, l.far.rgb, k * 2 - 1);
}

// How lit a point is as the light spreads along the line from its first
// letter, and dimmer the farther it is from the light.
float lightReached(float d, constant LightUniforms& l) {
  float edge = l.near + l.spread * (l.span * 1.15);
  float k = clamp((d - l.near) / max(l.span, 1.0), 0.0, 1.0);
  return (1 - smoothstep(edge - l.span * 0.25, edge, d)) / (1 + k * l.falloff);
}

fragment float4 backlight_fragment(
  VOut in [[stage_in]],
  constant LightUniforms& l [[buffer(0)]],
  texture2d<float> mask [[texture(0)]],
  texture2d<float> soft [[texture(1)]]
) {
  float2 pix = in.position.xy;
  float2 toLight = l.light - pix;
  float dHere = length(toLight);

  // The letters themselves, lit through, with a soft bloom around them.
  float m = lightMask(mask, pix, l);
  float halo = lightMask(soft, pix, l);
  float3 rgb = lightColour(dHere, l) * lightReached(dHere, l) * (m * l.glow + halo * l.bloom);

  // The shafts: march back toward the light, up to `reach` pixels, gathering
  // what comes through the letters on the way. Every letter's shaft is as
  // long, so those nearest the light, whose directions spread widest, fan out
  // into the wedge. Each eases in past its letter so it doesn't paint over
  // the next one. Only the stretch of the ray that crosses the line's box is
  // marched; most rays never cross it and cost nothing. Interleaved noise
  // breaks up the steps.
  const int steps = 48;
  float2 back = toLight / max(dHere, 1e-3);
  float reach = min(l.reach, dHere);
  float2 inv = 1 / select(back, float2(1e-6), abs(back) < 1e-6);
  float2 t0 = (l.rect.xy - pix) * inv;
  float2 t1 = (l.rect.xy + l.rect.zw - pix) * inv;
  float enter = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), 0.0) / max(reach, 1e-3);
  float leave = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), reach) / max(reach, 1e-3);
  float3 shaft = 0;
  if (leave > enter) {
    float noise = fract(52.9829189 * fract(dot(pix, float2(0.06711056, 0.00583715))));
    for (int i = 0; i < steps; i++) {
      float t = enter + (float(i) + noise) / float(steps) * (leave - enter);
      float2 q = pix + back * (t * reach);
      // Beams with a soft body and fine streaks: traced from the softened
      // line and its sharp strokes together.
      float mq = 0.75 * lightMask(soft, q, l) + 0.25 * lightMask(mask, q, l);
      if (mq <= 0) continue;
      float dq = dHere - t * reach;
      float fall = (1 - t) * smoothstep(0.0, 0.05, t);
      // Only the letters nearest the light throw much of a beam, so the rest
      // of the line stays crisp while the fan opens from its start.
      float near = exp(-l.shaftFalloff * clamp((dq - l.near) / max(l.span, 1.0), 0.0, 1.0));
      // Beams run warmer than the letters they come through: the core stays
      // white, the light around it amber and red.
      shaft += lightColour(dq + l.span * l.shaftWarmth, l) * mq * lightReached(dq, l) * fall * near;
    }
    shaft *= (leave - enter) / float(steps);
  }
  // Beams pass behind the letters, not over them, so the line stays readable.
  rgb += shaft * l.shafts * (1 - m);

  // A soft glow where the light is.
  rgb += l.hot.rgb * l.source * exp(-dHere * dHere / (2 * l.near * l.near * 0.08));

  // Roll the highlights off softly: the hottest letters reach white but keep
  // their shape instead of burning into a blob.
  rgb = 1 - exp(-rgb * l.intensity * l.exposure);
  return float4(rgb, 0);
}



// Version 2's water, start to end: the same timeline, but the ripples are seen
// by how they bend the stage, a soft light on their slopes and the darkness
// they bring in, never by bands, rims or glints. Once the line is sharp the
// dark closes into the plane the backlit line is cut from. Version 1 keeps
// ripple_fragment and surface_fragment.
fragment float4 water_v2_fragment(
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
  // The backlit ending: the dark closes into a solid plane.
  alpha = mix(alpha, max(alpha, w.planeDarkness), w.plane);
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
"""
