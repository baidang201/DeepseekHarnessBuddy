// ---------------------------------------------------------------------------
// P2-B firmware implementation. See audio_clips.h for the design contract.
//
// Speaker_Class contract (verified against upstream M5Unified):
//   void   setVolume(uint8_t);                                 // 0..255
//   uint8_t getVolume() const;
//   bool   isPlaying() const volatile;
//   bool   playRaw(const int16_t* data, size_t len,
//                  uint32_t sample_rate, bool stereo = false,
//                  uint32_t repeat = 1, int channel = -1,
//                  bool stop_current_sound = false);
//   void   stop();
// The const-eval `isPlaying()` is volatile (the I2S task flips it from another
// core), so audio_clips.cpp reads through a relaxed lambda and treats snapshots
// as advisory — the time-bounded interrupt in playClip() is the source of truth.
//
// Compilation modes:
//   1. Real PlatformIO build: board_compat.h pulls in <M5Unified.h> *first* and
//      defines the real `M5` singleton. We pick that up via the
//      `AUDIO_CLIPS_USE_M5UNIFIED` macro guard and skip the shim below.
//   2. Standalone syntax-only validation: `g++ -fsyntax-only -std=c++17 -I src
//      src/audio_clips.cpp` runs without PlatformIO. We then compile a
//      minimal M5 stub so the file parses in isolation. The validation harness
//      defines `AUDIO_CLIPS_SYNTAX_CHECK` to opt into that branch.
// ---------------------------------------------------------------------------

#include "audio_clips.h"
#include "audio_clips_data.h"
#include <stdint.h>
#include <stddef.h>

#if !__has_include(<M5Unified.h>)
// --- Standalone syntax-check shim ------------------------------------------
// Real PlatformIO builds pull in <M5Unified.h> via board_compat.h, which provides
// the genuine `M5` singleton. On a vanilla validator VM (g++ -fsyntax-only with
// no M5Unified install) the include is absent, so we fall back to a namespace
// stub that mirrors the Speaker_Class surface we actually use. The standalone
// build must NEVER reach the linker, so the stub methods have no definitions.
namespace m5 {
  class Speaker_Class {
  public:
    void setVolume(uint8_t v);
    uint8_t getVolume() const;
    bool isPlaying() const volatile;
    bool playRaw(const int16_t* data, size_t len,
                 uint32_t sample_rate = 44100,
                 bool stereo = false,
                 uint32_t repeat = 1,
                 int channel = -1,
                 bool stop_current_sound = false);
    void stop();
  };
  struct M5Unified_t { Speaker_Class Speaker; };
}
static m5::M5Unified_t M5;
#endif  // !__has_include(<M5Unified.h>)

namespace {

// Per-clip payload. `static const` so it lands in flash (.rodata) and we don't
// need to copy the waveform into RAM. Indexed by the Clip enum value.
struct ClipSlot {
  const int16_t* data;   // PROGMEM / flash-resident
  size_t samples;        // count of int16_t samples (NOT bytes)
};

// Real per-clip table. Lives in audio_clips_data.h so the generator owns the
// sample counts (it knows the WAV durations exactly).
static const ClipSlot kClipTable[(size_t)Clip::Count] = CLIP_TABLE_INIT;

}  // namespace

static uint8_t sVolume    = CLIP_DEFAULT_MAX_VOLUME;  // currently applied
static uint8_t sMaxVolume = CLIP_DEFAULT_MAX_VOLUME;  // ceiling

void audioClipsInit(uint8_t maxVolume) {
  sMaxVolume = maxVolume;
  if (sVolume > sMaxVolume) sVolume = sMaxVolume;
  M5.Speaker.setVolume(sVolume);
}

void playClip(Clip c) {
  const size_t idx = (size_t)c;
  if (idx >= (size_t)Clip::Count) return;
  const ClipSlot& slot = kClipTable[idx];
  if (!slot.data || slot.samples == 0) return;

  // Interrupt any in-progress clip on the Speaker — M5Unified treats
  // repeat=1 + stop_current_sound=true as "kill whatever was playing, start
  // this one immediately on a free channel". We pin channel 0 so clipPlaying()
  // is meaningful and the loop can observe when the clip ends.
  M5.Speaker.stop();  // belt-and-braces: flush before issuing the new clip
  M5.Speaker.setVolume(sVolume);
  M5.Speaker.playRaw(
    slot.data,
    slot.samples,
    CLIP_SAMPLE_RATE_HZ,
    /*stereo=*/false,
    /*repeat=*/1,
    /*channel=*/0,
    /*stop_current_sound=*/true
  );
}

bool clipPlaying() {
  // isPlaying() is volatile (the I2S task flips it from another core). Reading
  // once gives a snapshot; that is all clipPlaying() needs.
  return M5.Speaker.isPlaying();
}

uint8_t clipVolume() { return sVolume; }

void setClipVolume(uint8_t v) {
  if (v > sMaxVolume) v = sMaxVolume;
  sVolume = v;
  M5.Speaker.setVolume(sVolume);
}
