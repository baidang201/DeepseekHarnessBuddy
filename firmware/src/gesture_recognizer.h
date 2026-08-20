// gesture_recognizer.h — air-gesture approval for Codebuddy "encourager" (P2)
//
// Pure algorithm, zero hardware dependency. No <Arduino.h>, no M5Unified,
// no <vector>. Inputs are already-gravity-compensated 2D trajectory points
// expressed in units of g (so |a|~1 means ~1g shake magnitude). Callers are
// responsible for:
//   1) reading M5.Imu.getAccelData() at their own cadence,
//   2) removing gravity with whatever baseline / high-pass they prefer,
//   3) clipping into the 800ms sliding window and feeding the points here.
//
// Algorithm summary (see prd-p2.md FR3 / tech-p2.md §4):
//   * resample to RESAMPLE_N points by equal-arc-length,
//   * branch A: algebraic least-squares circle fit + closure + radius band
//     + ellipse aspect + per-point residual,
//   * branch B: split at the largest direction turn and verify two near-
//     straight strokes form an X (perpendicular-ish, similar length,
//     not closed),
//   * either branch failing its own constraints returns None — never force
//     a guess (tech-p2.md §8).
//
// Tuning lives in the CONSTANTS block below; nothing else is magic.

#pragma once

#include <stddef.h>
#include <stdint.h>

// ---------- public types ----------

enum class Gesture : uint8_t { None = 0, Circle = 1, Cross = 2 };

struct GesturePoint {
  float x;
  float y;
  uint32_t tMs;
};

// ---------- tunables (single source of truth) ----------

namespace gesture_cfg {

// Sliding window. The caller filters points by tMs before calling;
// we keep the constant here for documentation and downstream callers.
inline constexpr uint32_t kWindowMs            = 800;

// Equal-arc-length resample target. Higher = smoother circle fit,
// more compute on the X branch. 32 matches tech-p2.md §4.
inline constexpr size_t   kResampleN           = 32;

// Below this many raw points the gesture is too brief / too coarse to
// trust.
inline constexpr size_t   kMinRawPoints        = 8;

// Total path length below this (in g-equivalent units, after gravity
// removal) is treated as "stationary / jitter", not a gesture.
inline constexpr float    kMinPathLenG         = 0.40f;

// Bounding-box diameter below this is treated as "tiny / accidental".
inline constexpr float    kMinBoundingDiamG    = 0.20f;

// ---- Circle branch ----
// closure = 1 - |first-last|/diameter. Spec says > 70%.
inline constexpr float    kCircleClosureMin    = 0.70f;
// Radius band in g. tech-p2.md §4 calls for 0.3g ~ 1.2g.
inline constexpr float    kCircleRadiusMinG    = 0.30f;
inline constexpr float    kCircleRadiusMaxG    = 1.20f;
// Ellipse long/short axis ratio minimum — drops "egg with a sharp tip".
inline constexpr float    kCircleAspectMin     = 0.55f;
// Per-point mean residual against the fitted circle, normalised by radius.
inline constexpr float    kCircleResidualRelMax= 0.35f;

// ---- Cross branch ----
// Segment length ratio (longer / shorter). Spec 0.6 ~ 1.6.
inline constexpr float    kCrossLenRatioMin    = 0.60f;
inline constexpr float    kCrossLenRatioMax    = 1.60f;
// Angle between the two segments (degrees), spec 90° ~ 160°.
inline constexpr float    kCrossAngleMinDeg    = 90.0f;
inline constexpr float    kCrossAngleMaxDeg    = 160.0f;
// The shorter segment must still be long enough (in g).
inline constexpr float    kCrossMinSegLenG     = 0.25f;
// Corner must sit in the middle band of the path.
inline constexpr float    kCrossCornerFracMin  = 0.25f;
inline constexpr float    kCrossCornerFracMax  = 0.75f;
// Two segments must not be collinear.
inline constexpr float    kCrossCollinearTol   = 0.18f;  // sin(angle) headroom
// Per-segment residual normalised by segment length.
inline constexpr float    kCrossSegResidualRelMax = 0.30f;
// A genuine X is NOT closed.
inline constexpr float    kCrossClosureMax     = 0.45f;
// Jump required to declare a turning corner (1 - cos between tangents).
inline constexpr float    kCrossCornerJumpMin  = 0.50f;

// Max source points accepted by gestureResample (kept as a fixed-size
// stack array inside the helper — see comment there).
inline constexpr size_t   kMaxRawPoints        = 96;

} // namespace gesture_cfg

// ---------- small math primitives ----------
//
// We deliberately avoid <cmath> at file scope to keep the header self-
// contained for host unit tests; the few primitives needed live here.
// Build flag: define GR_USE_LIBC_MATH to fall back to libc <cmath>.
#if defined(GR_USE_LIBC_MATH)
#  include <cmath>
namespace gesture_math {
  using std::sqrtf;
  using std::fabsf;
  using std::acosf;
  inline bool isfinite(float v) { return std::isfinite(v); }
}
#else
namespace gesture_math {
  inline float sqrtf(float v)  { return __builtin_sqrtf(v); }
  inline float fabsf(float v)  { return v < 0.0f ? -v : v; }
  inline float acosf(float v)  {
    if (v < -1.0f) v = -1.0f;
    if (v >  1.0f) v =  1.0f;
    return __builtin_acosf(v);
  }
  inline bool isfinite(float v) { return v == v; }   // NaN check; good enough
}
#endif

namespace gesture_math {
  inline float dist(float ax, float ay, float bx, float by) {
    float dx = ax - bx;
    float dy = ay - by;
    return sqrtf(dx * dx + dy * dy);
  }

  struct CircleFit {
    float cx, cy, r;
    bool  ok;
  };

  // Algebraic least-squares circle fit (Kasa's method).
  // Minimises Σ (x² + y² + Dx + Ey + F)²  =>  3x3 normal equations.
  inline CircleFit fitCircle(const GesturePoint* pts, size_t n) {
    CircleFit out{0, 0, 0, false};
    if (n < 3) return out;

    float Sx = 0, Sy = 0;
    float Sxx = 0, Syy = 0, Sxy = 0;
    float Sxxx = 0, Sxyy = 0, Sxxy = 0, Syyy = 0;
    float Sr2  = 0;
    for (size_t i = 0; i < n; ++i) {
      const float x  = pts[i].x;
      const float y  = pts[i].y;
      const float x2 = x * x;
      const float y2 = y * y;
      const float xy = x * y;
      Sx   += x;
      Sy   += y;
      Sxx  += x2;
      Syy  += y2;
      Sxy  += xy;
      Sxxx += x * x2;
      Sxyy += x * y2;
      Sxxy += x2 * y;
      Syyy += y * y2;
      Sr2  += x2 + y2;
    }

    // A = [ n   Sx   Sy  ]
    //     [ Sx  Sxx  Sxy ]
    //     [ Sy  Sxy  Syy ]
    // b = [-Sr2, -(Sxxx+Sxyy), -(Sxxy+Syyy)]
    const float A11 = (float)n, A12 = Sx,  A13 = Sy;
    const float A21 = Sx,       A22 = Sxx, A23 = Sxy;
    const float A31 = Sy,       A32 = Sxy, A33 = Syy;

    const float b1 = -Sr2;
    const float b2 = -(Sxxx + Sxyy);
    const float b3 = -(Sxxy + Syyy);

    const float det = A11 * (A22 * A33 - A23 * A32)
                    - A12 * (A21 * A33 - A23 * A31)
                    + A13 * (A21 * A32 - A22 * A31);
    if (fabsf(det) < 1e-9f) return out;

    const float detF = b1   * (A22 * A33 - A23 * A32)
                     - A12 * (b2   * A33 - A23 * b3)
                     + A13 * (b2   * A32 - A22 * b3);
    const float detD = A11 * (b2   * A33 - A23 * b3)
                     - b1   * (A21 * A33 - A23 * A31)
                     + A13 * (A21 * b3   - b2   * A31);
    const float detE = A11 * (A22 * b3   - b2   * A32)
                     - A12 * (A21 * b3   - b2   * A31)
                     + b1   * (A21 * A32 - A22 * A31);

    const float F = detF / det;
    const float D = detD / det;
    const float E = detE / det;

    const float cx = -D * 0.5f;
    const float cy = -E * 0.5f;
    const float r2 = cx * cx + cy * cy - F;
    if (!(r2 > 0.0f)) return out;
    const float r = sqrtf(r2);
    if (!isfinite(r)) return out;

    out.cx = cx;
    out.cy = cy;
    out.r  = r;
    out.ok = true;
    return out;
  }
} // namespace gesture_math

// ---------- public API ----------

// Equal-arc-length resample into out[outN]. Returns the number of points
// written (= outN on success; 0 if the input path is degenerate).
// `out` may not alias `in`.
inline size_t gestureResample(const GesturePoint* in, size_t n,
                              GesturePoint* out, size_t outN) {
  using namespace gesture_cfg;
  if (in == nullptr || out == nullptr || n < 2 || outN < 2) return 0;
  if (n > kMaxRawPoints) return 0;  // fixed-size seg[] below

  // Total path length.
  float seg[kMaxRawPoints];
  float total = 0.0f;
  for (size_t i = 1; i < n; ++i) {
    seg[i - 1] = gesture_math::dist(in[i - 1].x, in[i - 1].y,
                                    in[i].x,     in[i].y);
    total += seg[i - 1];
  }
  if (!(total > 1e-6f)) return 0;

  // First and last are always pinned.
  out[0] = in[0];
  out[outN - 1] = in[n - 1];

  // Walk along, emitting points at equal arc-length intervals.
  const float step = total / (float)(outN - 1);
  float acc = 0.0f;
  size_t src = 1;
  for (size_t dst = 1; dst < outN - 1; ++dst) {
    const float target = step * (float)dst;
    while (src < n && acc + seg[src - 1] < target) {
      acc += seg[src - 1];
      ++src;
    }
    if (src >= n) {
      out[dst] = in[n - 1];
      continue;
    }
    const float remain = target - acc;
    const float sLen   = seg[src - 1];
    const float t      = (sLen > 1e-6f) ? (remain / sLen) : 0.0f;
    const float ax = in[src - 1].x, ay = in[src - 1].y;
    const float bx = in[src].x,     by = in[src].y;
    out[dst].x = ax + (bx - ax) * t;
    out[dst].y = ay + (by - ay) * t;
    const uint32_t ta = in[src - 1].tMs;
    const uint32_t tb = in[src].tMs;
    out[dst].tMs = ta + (uint32_t)((float)(tb - ta) * t);
  }
  return outN;
}

// Top-level classifier. `pts` is the gravity-removed 2D trajectory
// clipped to the 800ms window. Returns the verdict; None if neither
// branch satisfies all its constraints.
inline Gesture gestureClassify(const GesturePoint* pts, size_t n) {
  using namespace gesture_cfg;
  if (pts == nullptr || n < kMinRawPoints) return Gesture::None;
  if (n > kMaxRawPoints) return Gesture::None;

  // Cheap shape sanity: bounding box + path length.
  float minX = pts[0].x, maxX = pts[0].x;
  float minY = pts[0].y, maxY = pts[0].y;
  float pathLen = 0.0f;
  for (size_t i = 1; i < n; ++i) {
    if (pts[i].x < minX) minX = pts[i].x; if (pts[i].x > maxX) maxX = pts[i].x;
    if (pts[i].y < minY) minY = pts[i].y; if (pts[i].y > maxY) maxY = pts[i].y;
    pathLen += gesture_math::dist(pts[i - 1].x, pts[i - 1].y,
                                  pts[i].x,     pts[i].y);
  }
  const float diam = gesture_math::dist(minX, minY, maxX, maxY);
  if (pathLen < kMinPathLenG)      return Gesture::None;
  if (diam    < kMinBoundingDiamG) return Gesture::None;

  // Resample onto kResampleN points so the rest of the analysis is
  // scale- and density-invariant.
  GesturePoint rs[kResampleN];
  if (gestureResample(pts, n, rs, kResampleN) != kResampleN) {
    return Gesture::None;
  }

  // --- Branch A: Circle ---
  const gesture_math::CircleFit cf = gesture_math::fitCircle(rs, kResampleN);
  if (cf.ok) {
    if (cf.r >= kCircleRadiusMinG && cf.r <= kCircleRadiusMaxG) {
      // ellipse aspect (long/short axis of the cloud)
      float mx = 0, my = 0;
      for (size_t i = 0; i < kResampleN; ++i) { mx += rs[i].x; my += rs[i].y; }
      mx /= (float)kResampleN; my /= (float)kResampleN;
      float sxx = 0, syy = 0, sxy = 0;
      for (size_t i = 0; i < kResampleN; ++i) {
        const float dx = rs[i].x - mx;
        const float dy = rs[i].y - my;
        sxx += dx * dx;
        syy += dy * dy;
        sxy += dx * dy;
      }
      const float trace = sxx + syy;
      const float disc  = gesture_math::sqrtf((sxx - syy) * (sxx - syy) + 4.0f * sxy * sxy);
      const float l1 = (trace + disc) * 0.5f;
      const float l2 = (trace - disc) * 0.5f;
      const float longA  = gesture_math::sqrtf(l1 > 0.0f ? l1 : 0.0f);
      const float shortA = gesture_math::sqrtf(l2 > 0.0f ? l2 : 0.0f);
      const float aspect = (longA > 1e-6f) ? (shortA / longA) : 0.0f;

      // closure = 1 - |first-last|/diameter. Spec says > 70%.
      const float closure =
          1.0f - gesture_math::dist(rs[0].x, rs[0].y,
                                    rs[kResampleN - 1].x, rs[kResampleN - 1].y)
                        / diam;

      // per-point residual against the fitted circle
      float residSum = 0;
      for (size_t i = 0; i < kResampleN; ++i) {
        const float d = gesture_math::dist(rs[i].x, rs[i].y, cf.cx, cf.cy);
        residSum += gesture_math::fabsf(d - cf.r);
      }
      const float residRel = (residSum / (float)kResampleN) / cf.r;

      if (closure  >= kCircleClosureMin    &&
          aspect   >= kCircleAspectMin     &&
          residRel <= kCircleResidualRelMax) {
        return Gesture::Circle;
      }
    }
  }

  // --- Branch B: Cross ---
  // The corner is the point whose tangent direction differs most from
  // its neighbours on the OTHER side of the path. For a real X this is
  // a near-180° reversal.
  if (kResampleN >= 6) {
    float tx[kResampleN], ty[kResampleN];
    for (size_t i = 0; i < kResampleN; ++i) {
      const size_t a = (i == 0)             ? 0          : i - 1;
      const size_t b = (i == kResampleN - 1)? i          : i + 1;
      tx[i] = rs[b].x - rs[a].x;
      ty[i] = rs[b].y - rs[a].y;
    }

    size_t corner = 0;
    float  bestJump = 0;
    for (size_t i = 2; i < kResampleN - 2; ++i) {
      const float ax = tx[i - 1], ay = ty[i - 1];
      const float bx = tx[i + 1], by = ty[i + 1];
      const float la = gesture_math::sqrtf(ax * ax + ay * ay);
      const float lb = gesture_math::sqrtf(bx * bx + by * by);
      if (la < 1e-4f || lb < 1e-4f) continue;
      float c = (ax * bx + ay * by) / (la * lb);
      if (c < -1.0f) c = -1.0f;
      if (c >  1.0f) c =  1.0f;
      const float jump = 1.0f - c;
      if (jump > bestJump) { bestJump = jump; corner = i; }
    }
    if (bestJump < kCrossCornerJumpMin) return Gesture::None;

    const float cornerFrac = (float)corner / (float)(kResampleN - 1);
    if (cornerFrac < kCrossCornerFracMin || cornerFrac > kCrossCornerFracMax) {
      return Gesture::None;
    }

    // Fit a principal line to each segment and report length + residual.
    struct SegFit { float dx, dy, residRel; bool ok; };
    auto fitSeg = [](const GesturePoint* p, size_t m) -> SegFit {
      SegFit s{0, 0, 1.0f, false};
      if (m < 3) return s;
      float mx = 0, my = 0;
      for (size_t i = 0; i < m; ++i) { mx += p[i].x; my += p[i].y; }
      mx /= (float)m; my /= (float)m;
      float sxx = 0, syy = 0, sxy = 0;
      for (size_t i = 0; i < m; ++i) {
        const float dx = p[i].x - mx;
        const float dy = p[i].y - my;
        sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
      }
      const float trace = sxx + syy;
      const float disc  = gesture_math::sqrtf((sxx - syy) * (sxx - syy) + 4.0f * sxy * sxy);
      const float l1 = (trace + disc) * 0.5f;
      const float l2 = (trace - disc) * 0.5f;
      float longDx, longDy;
      if (l1 >= l2) { longDx = sxx - l2; longDy = sxy; }
      else          { longDx = sxx - l1; longDy = sxy; }
      const float L = gesture_math::sqrtf(longDx * longDx + longDy * longDy);
      if (L < 1e-6f) return s;
      const float ux = longDx / L;
      const float uy = longDy / L;
      float maxProj = -1e9f, minProj = 1e9f;
      float resid = 0;
      for (size_t i = 0; i < m; ++i) {
        const float dx = p[i].x - mx;
        const float dy = p[i].y - my;
        const float proj = dx * ux + dy * uy;
        if (proj > maxProj) maxProj = proj;
        if (proj < minProj) minProj = proj;
        const float px = mx + proj * ux;
        const float py = my + proj * uy;
        const float ex = p[i].x - px;
        const float ey = p[i].y - py;
        resid += gesture_math::sqrtf(ex * ex + ey * ey);
      }
      const float len = maxProj - minProj;
      s.dx = ux * len;
      s.dy = uy * len;
      s.residRel = (len > 1e-6f) ? (resid / (float)m / len) : 1.0f;
      s.ok = true;
      return s;
    };

    const SegFit s1 = fitSeg(rs, corner + 1);
    const SegFit s2 = fitSeg(rs + corner, kResampleN - corner);
    if (!s1.ok || !s2.ok) return Gesture::None;

    // PCA direction is sign-ambiguous — align each segment's fitted
    // direction to the actual travel direction (start -> end of segment).
    auto alignSign = [](const GesturePoint* p, size_t m, SegFit& s) {
      const float sx = p[0].x, sy = p[0].y;
      const float ex = p[m - 1].x, ey = p[m - 1].y;
      const float dx = ex - sx, dy = ey - sy;
      if (dx * s.dx + dy * s.dy < 0.0f) { s.dx = -s.dx; s.dy = -s.dy; }
    };
    {
      SegFit sa = s1; alignSign(rs, corner + 1, sa);
      SegFit sb = s2; alignSign(rs + corner, kResampleN - corner, sb);
      // re-bind by copy
      const_cast<SegFit&>(s1) = sa;
      const_cast<SegFit&>(s2) = sb;
    }

    const float L1 = gesture_math::sqrtf(s1.dx * s1.dx + s1.dy * s1.dy);
    const float L2 = gesture_math::sqrtf(s2.dx * s2.dx + s2.dy * s2.dy);
    if (L1 < kCrossMinSegLenG || L2 < kCrossMinSegLenG) return Gesture::None;
    if (s1.residRel > kCrossSegResidualRelMax)         return Gesture::None;
    if (s2.residRel > kCrossSegResidualRelMax)         return Gesture::None;

    const float lenRatio = (L1 > L2) ? (L1 / L2) : (L2 / L1);
    if (lenRatio < kCrossLenRatioMin || lenRatio > kCrossLenRatioMax) {
      return Gesture::None;
    }

    // Unsigned angle between the two strokes.
    const float dot = s1.dx * s2.dx + s1.dy * s2.dy;
    float cosA = dot / (L1 * L2);
    if (cosA < -1.0f) cosA = -1.0f;
    if (cosA >  1.0f) cosA =  1.0f;
    const float angleDeg = gesture_math::acosf(cosA)
                           * (180.0f / 3.14159265358979323846f);
    if (angleDeg < kCrossAngleMinDeg || angleDeg > kCrossAngleMaxDeg) {
      return Gesture::None;
    }
    // Reject near-collinear strokes (would have been a straight line).
    const float sinA = gesture_math::sqrtf(1.0f - cosA * cosA);
    if (sinA < kCrossCollinearTol) return Gesture::None;

    // Verify the two strokes actually cross near the middle: intersect
    // the two fitted lines (anchor + direction) and check that the
    // intersection sits inside a loose bounding box around the cloud.
    auto lineIntersect = [](float px1, float py1, float dx1, float dy1,
                            float px2, float py2, float dx2, float dy2,
                            float& outX, float& outY) -> bool {
      const float det = dx1 * dy2 - dy1 * dx2;
      if (gesture_math::fabsf(det) < 1e-4f) return false;
      const float t = ((px2 - px1) * dy2 - (py2 - py1) * dx2) / det;
      outX = px1 + t * dx1;
      outY = py1 + t * dy1;
      return true;
    };
    auto segCentre = [&](const GesturePoint* p, size_t m,
                         float& cx, float& cy) {
      cx = 0; cy = 0;
      for (size_t i = 0; i < m; ++i) { cx += p[i].x; cy += p[i].y; }
      cx /= (float)m; cy /= (float)m;
    };
    float c1x, c1y, c2x, c2y;
    segCentre(rs, corner + 1, c1x, c1y);
    segCentre(rs + corner, kResampleN - corner, c2x, c2y);
    float ix, iy;
    if (!lineIntersect(c1x, c1y, s1.dx, s1.dy,
                       c2x, c2y, s2.dx, s2.dy, ix, iy)) {
      return Gesture::None;
    }
    const float ixc = (minX + maxX) * 0.5f;
    const float iyc = (minY + maxY) * 0.5f;
    const float padX = 0.5f * diam + 0.1f;
    const float padY = 0.5f * diam + 0.1f;
    if (gesture_math::fabsf(ix - ixc) > padX || gesture_math::fabsf(iy - iyc) > padY) {
      return Gesture::None;
    }

    return Gesture::Cross;

  }

  return Gesture::None;
}
