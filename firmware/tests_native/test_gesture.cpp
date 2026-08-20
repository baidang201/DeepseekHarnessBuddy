// test_gesture.cpp — host-side unit test for gesture_recognizer.h
//
// Build & run:
//   g++ -std=c++17 -I firmware/src firmware/tests_native/test_gesture.cpp \
//       -o /tmp/test_gesture && /tmp/test_gesture
//
// Synthetic generators produce Circle / Cross / degenerate inputs and feed
// them into gestureClassify(). Each row prints PASS/FAIL and the harness
// exits non-zero on any failure.

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <random>
#include <string>
#include <vector>

#include "gesture_recognizer.h"

namespace {

// -------- shared randomness (deterministic seed for reproducibility) ----
std::mt19937& rng() {
  static std::mt19937 g(0xC0DEBABEu);
  return g;
}

float uniform(float lo, float hi) {
  std::uniform_real_distribution<float> d(lo, hi);
  return d(rng());
}

// -------- point column helper --------
struct Trace {
  std::vector<GesturePoint> pts;
  void push(float x, float y, uint32_t t) {
    pts.push_back(GesturePoint{x, y, t});
  }
  size_t size() const { return pts.size(); }
};

// -------- generators ----------------------------------------------------

// Clean circle / ellipse. angle goes 0..2π; radius in g; aspect=1 is round.
Trace genCircle(float radiusG, float aspect, bool clockwise, size_t n,
                float jitter = 0.0f) {
  Trace t;
  t.pts.reserve(n);
  const float dtMs = 800.0f / float(n - 1);
  for (size_t i = 0; i < n; ++i) {
    const float u = float(i) / float(n - 1);
    float a = clockwise ? -2.0f * float(M_PI) * u
                        :  2.0f * float(M_PI) * u;
    const float ax = radiusG * std::cos(a);
    const float ay = radiusG * std::sin(a) * aspect;
    const float jx = (jitter > 0.0f) ? uniform(-jitter, jitter) : 0.0f;
    const float jy = (jitter > 0.0f) ? uniform(-jitter, jitter) : 0.0f;
    t.push(ax + jx, ay + jy, uint32_t(u * 800.0f));
  }
  return t;
}

// Two straight strokes that meet at a corner. `half` controls how far the
// path walks along the *direction*; `gap` is the corner position fraction
// (0..1). The two strokes have the given angle between them.
Trace genCross(float len1, float len2, float angleDeg,
               float gapFrac, bool reverseSecond, size_t n) {
  Trace t;
  t.pts.reserve(n);
  const float a1 = reverseSecond ? float(M_PI) : 0.0f;          // first stroke
  const float a2 = a1 + float(angleDeg) * (float(M_PI) / 180.0f); // second stroke
  const float cornerX = -len1 * std::cos(a1) * gapFrac;
  const float cornerY = -len1 * std::sin(a1) * gapFrac;
  // first stroke end == corner; start = corner - len1 * dir1
  const float s1x = cornerX - len1 * std::cos(a1);
  const float s1y = cornerY - len1 * std::sin(a1);
  const float e2x = cornerX + len2 * std::cos(a2);
  const float e2y = cornerY + len2 * std::sin(a2);
  const size_t n1 = std::max<size_t>(3, size_t(float(n) * gapFrac));
  const size_t n2 = std::max<size_t>(3, n - n1);
  const uint32_t tEnd = 800;
  // first stroke
  for (size_t i = 0; i < n1; ++i) {
    const float u = (n1 == 1) ? 0.0f : float(i) / float(n1 - 1);
    t.push(s1x + (cornerX - s1x) * u,
           s1y + (cornerY - s1y) * u,
           uint32_t(u * 0.5f * float(tEnd)));
  }
  // second stroke
  for (size_t i = 1; i < n2; ++i) {  // skip the corner (duplicate)
    const float u = (n2 == 1) ? 0.0f : float(i) / float(n2 - 1);
    t.push(cornerX + (e2x - cornerX) * u,
           cornerY + (e2y - cornerY) * u,
           uint32_t((0.5f + u * 0.5f) * float(tEnd)));
  }
  return t;
}

// Straight line from (x0,y0) to (x1,y1) over n points.
Trace genLine(float x0, float y0, float x1, float y1, size_t n) {
  Trace t;
  t.pts.reserve(n);
  for (size_t i = 0; i < n; ++i) {
    const float u = (n == 1) ? 0.0f : float(i) / float(n - 1);
    t.push(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, uint32_t(u * 800.0f));
  }
  return t;
}

// Stationary blob: tight cluster around origin with mild noise.
Trace genJitter(size_t n, float amp = 0.02f) {
  Trace t;
  t.pts.reserve(n);
  for (size_t i = 0; i < n; ++i) {
    t.push(uniform(-amp, amp), uniform(-amp, amp),
           uint32_t(float(i) / float(n - 1) * 800.0f));
  }
  return t;
}

// Random walk that does NOT close (just wanders).
Trace genRandomWalk(size_t n, float step) {
  Trace t;
  t.pts.reserve(n);
  float x = 0, y = 0;
  for (size_t i = 0; i < n; ++i) {
    x += uniform(-step, step);
    y += uniform(-step, step);
    t.push(x, y, uint32_t(float(i) / float(n - 1) * 800.0f));
  }
  return t;
}

// -------- assertion harness --------------------------------------------

struct Counter { int total = 0, hit = 0; const char* label = ""; };

struct Summary {
  std::vector<std::string> rows;
  bool ok = true;
  void row(const std::string& r) { rows.push_back(r); }
  void fail(const std::string& r) { rows.push_back(r); ok = false; }
};

void check(Summary& s, Counter& c, const Trace& tr, Gesture want) {
  ++c.total;
  const Gesture got = gestureClassify(tr.pts.data(), tr.pts.size());
  const bool pass = (got == want);
  if (pass) ++c.hit;
  char buf[400];
  if (!pass) {
    std::snprintf(buf, sizeof(buf), "  [%s] %s total=%d got=%d want=%d n=%zu pts[0]=(%.2f,%.2f) pts[n-1]=(%.2f,%.2f)",
                  "FAIL", c.label, c.total, (int)got, (int)want, tr.pts.size(),
                  tr.pts[0].x, tr.pts[0].y,
                  tr.pts[tr.pts.size()-1].x, tr.pts[tr.pts.size()-1].y);
  } else {
    std::snprintf(buf, sizeof(buf), "  [%s] %s  total=%d hit=%d rate=%.1f%%",
                  "PASS", c.label, c.total, c.hit,
                  100.0f * float(c.hit) / float(c.total));
  }
  if (pass) s.row(buf);
  else      s.fail(buf);
}

void printTable(Summary& s) {
  std::printf("=== Gesture classifier test results ===\n");
  for (const auto& r : s.rows) std::printf("%s\n", r.c_str());
  std::printf("=== overall: %s ===\n", s.ok ? "PASS" : "FAIL");
}

// -------- the test matrix ----------------------------------------------

Summary runMatrix() {
  Summary s;

  // ---- Circle family ----
  {
    Counter c; c.label = "Circle";
    // perfect circles, large and small, both rotations
    for (int rep = 0; rep < 20; ++rep) {
      const float r = uniform(0.4f, 1.1f);
      const bool  cw = (rep % 2) == 0;
      const float aspect = 1.0f;
      check(s, c, genCircle(r, aspect, cw, /*n*/48), Gesture::Circle);
    }
    // ellipses with aspect 0.75..1.0
    for (int rep = 0; rep < 15; ++rep) {
      const float r = uniform(0.5f, 1.0f);
      const float a = uniform(0.75f, 1.0f);
      const bool  cw = (rep % 2) == 0;
      check(s, c, genCircle(r, a, cw, 48), Gesture::Circle);
    }
    // noisy circles (±15% jitter) — represents shaky hands.
    for (int rep = 0; rep < 15; ++rep) {
      const float r = uniform(0.5f, 1.0f);
      const bool  cw = (rep % 2) == 0;
      check(s, c, genCircle(r, 1.0f, cw, 48, /*jitter*/0.15f),
            Gesture::Circle);
    }
    // require >=90%
    if (c.hit * 10 < c.total * 9) {
      s.fail(std::string("  [FAIL] Circle family below 90%: ") +
             std::to_string(c.hit) + "/" + std::to_string(c.total));
    } else {
      s.row(std::string("  [PASS] Circle family >= 90% (") +
            std::to_string(c.hit) + "/" + std::to_string(c.total) + ")");
    }
  }

  // ---- Cross family ----
  {
    Counter c; c.label = "Cross";
    // angles 100°, 130°, 150° × length ratios 1.0 / 1.3 / 1.55
    const float angles[] = {100.0f, 130.0f, 150.0f};
    // max(len1,len2)/min(len1,len2). Spec uses "长度比 0.6~1.6"; we
    // interpret as short/long ∈ [0.6, 1.6] which equals long/short ∈ [1, 1.6].
    const float ratios[] = {1.0f, 1.3f, 1.55f};
    for (float ang : angles) {
      for (float r : ratios) {
        for (int rep = 0; rep < 5; ++rep) {
          const float baseLen = uniform(0.6f, 1.0f);
          // ratio r in {0.6, 1.0, 1.6}: r = max(len1,len2)/min(len1,len2).
          // Keep both lengths >= kCrossMinSegLenG with margin.
          float len1, len2;
          if (r >= 1.0f) {
            len1 = baseLen;
            len2 = baseLen / r;
          } else {
            len1 = baseLen * r;
            len2 = baseLen;
          }
          const float gap  = uniform(0.40f, 0.60f);
          check(s, c, genCross(len1, len2, ang, gap, /*rev*/false, 40),
                Gesture::Cross);
        }
      }
    }
    if (c.hit * 10 < c.total * 9) {
      s.fail(std::string("  [FAIL] Cross family below 90%: ") +
             std::to_string(c.hit) + "/" + std::to_string(c.total));
    } else {
      s.row(std::string("  [PASS] Cross family >= 90% (") +
            std::to_string(c.hit) + "/" + std::to_string(c.total) + ")");
    }
  }

  // ---- Degenerate / noise inputs (must NEVER trigger Circle or Cross) ----
  {
    Counter c; c.label = "NoTrigger";
    // straight lines in many directions
    for (int rep = 0; rep < 10; ++rep) {
      const float ang = uniform(0.0f, 2.0f * float(M_PI));
      const float r   = uniform(0.6f, 1.0f);
      Trace t = genLine(0, 0, r * std::cos(ang), r * std::sin(ang), 30);
      check(s, c, t, Gesture::None);
    }
    // stationary / jitter blobs (2 levels)
    for (int rep = 0; rep < 10; ++rep) {
      check(s, c, genJitter(30, 0.02f), Gesture::None);
    }
    for (int rep = 0; rep < 10; ++rep) {
      check(s, c, genJitter(30, 0.10f), Gesture::None);
    }
    // random walk (does not close into a circle or X)
    for (int rep = 0; rep < 10; ++rep) {
      check(s, c, genRandomWalk(30, 0.04f), Gesture::None);
    }
    // short / V / U / hook shapes that LOOK like part of an X but are not
    for (int rep = 0; rep < 5; ++rep) {
      Trace t;
      const float a = uniform(0.4f, 1.0f);
      const float gap = uniform(0.4f, 0.6f);
      const float ang = uniform(60.0f, 150.0f) * float(M_PI) / 180.0f;
      t.push(0, 0, 0);
      t.push(a * std::cos(0) * gap, a * std::sin(0) * gap, 200);
      t.push(a * std::cos(ang) * 0.8f, a * std::sin(ang) * 0.8f, 400);  // overshoot
      t.push(a * std::cos(ang) * 1.2f, a * std::sin(ang) * 1.2f, 600);  // overshoot
      t.push(a * std::cos(ang) * 1.4f, a * std::sin(ang) * 1.4f, 800);
      check(s, c, t, Gesture::None);
    }
    // under-sized inputs
    check(s, c, genCircle(0.6f, 1.0f, false, /*n*/3), Gesture::None);
    check(s, c, genLine(0, 0, 0.5f, 0.5f, /*n*/3), Gesture::None);
    // empty / null
    {
      Counter n; n.label = "NoTrigger-empty";
      check(s, n, Trace{}, Gesture::None);
      const Gesture g = gestureClassify(nullptr, 0);
      if (g != Gesture::None) s.fail("  [FAIL] nullptr input -> not None");
      else                     s.row("  [PASS] nullptr input -> None");
    }
    // tiny amplitude circle (should be rejected)
    check(s, c, genCircle(0.10f, 1.0f, false, 30), Gesture::None);

    // any miss here is a false positive — must be 0
    if (c.hit != c.total) {
      s.fail(std::string("  [FAIL] degenerate family false positives: ") +
             std::to_string(c.hit) + "/" + std::to_string(c.total));
    } else {
      s.row(std::string("  [PASS] degenerate family 0 false positives (") +
            std::to_string(c.hit) + "/" + std::to_string(c.total) + ")");
    }
  }

  // ---- gestureResample spot checks ----
  {
    Counter c; c.label = "Resample";
    Trace in = genCircle(0.7f, 1.0f, false, 16);
    GesturePoint out[32];
    const size_t got = gestureResample(in.pts.data(), in.pts.size(),
                                       out, 32);
    if (got == 32) s.row("  [PASS] resample(16 -> 32) returned 32");
    else s.fail("  [FAIL] resample(16 -> 32) returned " + std::to_string(got));
    // first and last should be pinned
    const float dx = out[0].x - in.pts.front().x;
    const float dy = out[0].y - in.pts.front().y;
    const float ex = out[31].x - in.pts.back().x;
    const float ey = out[31].y - in.pts.back().y;
    if (std::sqrt(dx * dx + dy * dy) < 1e-3f &&
        std::sqrt(ex * ex + ey * ey) < 1e-3f) {
      s.row("  [PASS] resample pins first/last to source");
    } else {
      s.fail("  [FAIL] resample did not pin first/last");
    }
  }

  return s;
}

} // namespace

int main() {
  Summary s = runMatrix();
  printTable(s);
  return s.ok ? 0 : 1;
}
