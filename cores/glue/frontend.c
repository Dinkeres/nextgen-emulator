// Minimal libretro frontend linked into each core. Exposes a flat C API to JS.
// The JS side (src/engine/core.ts) owns timing, audio output, rendering and input.
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <emscripten/emscripten.h>
#include "libretro.h"

#define API EMSCRIPTEN_KEEPALIVE

// ---------- video: converted to RGBA8888, tightly packed ----------
static uint32_t *fb = NULL;
static size_t fb_cap = 0;
static unsigned fb_w = 0, fb_h = 0;
static unsigned pixfmt = RETRO_PIXEL_FORMAT_0RGB1555;
static int want_video = 1;
static int want_audio = 1;
static int fast_forwarding = 0;
static int frame_ready = 0;

static void video_cb(const void *data, unsigned w, unsigned h, size_t pitch) {
  if (!data || !want_video) return; // dupe frame or skipped
  size_t need = (size_t)w * h;
  if (need > fb_cap) { free(fb); fb = (uint32_t *)malloc(need * 4); fb_cap = need; }
  fb_w = w; fb_h = h; frame_ready = 1;
  const uint8_t *src = (const uint8_t *)data;
  uint32_t *dst = fb;
  if (pixfmt == RETRO_PIXEL_FORMAT_XRGB8888) {
    for (unsigned y = 0; y < h; y++, src += pitch) {
      const uint32_t *s = (const uint32_t *)src;
      for (unsigned x = 0; x < w; x++) {
        uint32_t p = s[x]; // 0x00RRGGBB -> little-endian RGBA bytes
        *dst++ = 0xFF000000u | ((p & 0xFF) << 16) | (p & 0xFF00) | ((p >> 16) & 0xFF);
      }
    }
  } else if (pixfmt == RETRO_PIXEL_FORMAT_RGB565) {
    for (unsigned y = 0; y < h; y++, src += pitch) {
      const uint16_t *s = (const uint16_t *)src;
      for (unsigned x = 0; x < w; x++) {
        uint32_t p = s[x];
        uint32_t r = (p >> 11) & 31, g = (p >> 5) & 63, b = p & 31;
        r = (r << 3) | (r >> 2); g = (g << 2) | (g >> 4); b = (b << 3) | (b >> 2);
        *dst++ = 0xFF000000u | (b << 16) | (g << 8) | r;
      }
    }
  } else { // 0RGB1555
    for (unsigned y = 0; y < h; y++, src += pitch) {
      const uint16_t *s = (const uint16_t *)src;
      for (unsigned x = 0; x < w; x++) {
        uint32_t p = s[x];
        uint32_t r = (p >> 10) & 31, g = (p >> 5) & 31, b = p & 31;
        r = (r << 3) | (r >> 2); g = (g << 3) | (g >> 2); b = (b << 3) | (b >> 2);
        *dst++ = 0xFF000000u | (b << 16) | (g << 8) | r;
      }
    }
  }
}

API uint32_t *ng_fb(void) { return fb; }
API unsigned ng_fb_w(void) { return fb_w; }
API unsigned ng_fb_h(void) { return fb_h; }
API int ng_frame_ready(void) { return frame_ready; }

// ---------- audio: interleaved int16 stereo, drained by JS after each run ----------
#define AUDIO_CAP 16384
static int16_t abuf[AUDIO_CAP * 2];
static size_t aframes = 0;

static size_t audio_batch_cb(const int16_t *data, size_t frames) {
  if (!want_audio) return frames;
  size_t room = AUDIO_CAP - aframes;
  size_t n = frames < room ? frames : room;
  memcpy(abuf + aframes * 2, data, n * 4);
  aframes += n;
  return frames;
}
static void audio_cb(int16_t l, int16_t r) {
  int16_t s[2] = {l, r};
  audio_batch_cb(s, 1);
}
API int16_t *ng_audio(void) { return abuf; }
API size_t ng_audio_frames(void) { return aframes; }

// ---------- input: 16-bit joypad mask + 4 analog axes per port ----------
#define PORTS 8
static uint16_t joy[PORTS];
static int16_t analog[PORTS][4];
API uint16_t *ng_joy(void) { return joy; }
API int16_t *ng_analog(void) { return &analog[0][0]; }

static void input_poll_cb(void) {}
static int16_t input_state_cb(unsigned port, unsigned device, unsigned index, unsigned id) {
  if (port >= PORTS) return 0;
  if ((device & RETRO_DEVICE_MASK) == RETRO_DEVICE_JOYPAD) {
    if (id == RETRO_DEVICE_ID_JOYPAD_MASK) return (int16_t)joy[port];
    return id < 16 ? (joy[port] >> id) & 1 : 0;
  }
  if ((device & RETRO_DEVICE_MASK) == RETRO_DEVICE_ANALOG && index < 2 && id < 2)
    return analog[port][index * 2 + id];
  return 0;
}

// ---------- core options (legacy SET_VARIABLES + overrides) ----------
#define MAXVARS 256
static char *var_key[MAXVARS], *var_val[MAXVARS];
static int nvars = 0, vars_dirty = 0;

static int find_var(const char *key) {
  for (int i = 0; i < nvars; i++) if (!strcmp(var_key[i], key)) return i;
  return -1;
}
static void put_var(const char *key, const char *val) {
  int i = find_var(key);
  if (i < 0) { if (nvars >= MAXVARS) return; i = nvars++; var_key[i] = strdup(key); var_val[i] = NULL; }
  free(var_val[i]); var_val[i] = strdup(val);
}
// JS may call before load (overrides) or after (live change)
API void ng_set_var(const char *key, const char *val) { put_var(key, val); vars_dirty = 1; }

// Human-readable list of options "key\tdesc; a|b|c\n" for the settings UI
static char *opts_desc = NULL; static size_t opts_len = 0;
API const char *ng_options(void) { return opts_desc ? opts_desc : ""; }

static void register_vars(const struct retro_variable *v) {
  for (; v && v->key; v++) {
    // value format "Description; default|other|..."
    const char *semi = strstr(v->value, "; ");
    if (!semi) continue;
    size_t add = strlen(v->key) + strlen(v->value) + 3;
    opts_desc = (char *)realloc(opts_desc, opts_len + add + 1);
    opts_len += sprintf(opts_desc + opts_len, "%s\t%s\n", v->key, v->value);
    if (find_var(v->key) >= 0) continue; // JS override wins
    const char *def = semi + 2, *bar = strchr(def, '|');
    size_t n = bar ? (size_t)(bar - def) : strlen(def);
    char tmp[256]; if (n > 255) n = 255;
    memcpy(tmp, def, n); tmp[n] = 0;
    put_var(v->key, tmp);
  }
}

// ---------- environment ----------
static struct retro_system_av_info av;
static int verbose = 0;
static int strict = 0;
API void ng_strict(int on) { strict = on; }
API void ng_verbose(int v) { verbose = v; }

static void log_cb(enum retro_log_level level, const char *fmt, ...) {
  if (!verbose && level < RETRO_LOG_WARN) return;
  va_list ap; va_start(ap, fmt); vfprintf(stderr, fmt, ap); va_end(ap);
}

static bool env_cb(unsigned cmd, void *data) {
  if (verbose > 1) fprintf(stderr, "env %u\n", cmd & 0xffff);
  switch (cmd & ~RETRO_ENVIRONMENT_EXPERIMENTAL) {
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: {
      unsigned f = *(const enum retro_pixel_format *)data;
      if (f > RETRO_PIXEL_FORMAT_RGB565) return false;
      pixfmt = f; return true;
    }
    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY: *(const char **)data = "/system"; return true;
    case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY: *(const char **)data = "/save"; return true;
    case RETRO_ENVIRONMENT_GET_CAN_DUPE: *(bool *)data = true; return true;
    case RETRO_ENVIRONMENT_GET_LOG_INTERFACE: ((struct retro_log_callback *)data)->log = log_cb; return true;
    case RETRO_ENVIRONMENT_SET_VARIABLES: register_vars((const struct retro_variable *)data); return true;
    case RETRO_ENVIRONMENT_GET_VARIABLE: {
      struct retro_variable *v = (struct retro_variable *)data;
      int i = find_var(v->key);
      v->value = i >= 0 ? var_val[i] : NULL;
      return i >= 0;
    }
    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE: *(bool *)data = vars_dirty; vars_dirty = 0; return true;
    case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS: return true;
    case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION: *(unsigned *)data = 0; return true;
    case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO: av = *(const struct retro_system_av_info *)data; return true;
    case RETRO_ENVIRONMENT_SET_GEOMETRY: av.geometry = *(const struct retro_game_geometry *)data; return true;
    case RETRO_ENVIRONMENT_GET_LANGUAGE: *(unsigned *)data = RETRO_LANGUAGE_ENGLISH; return true;
    case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME: return true;
    // In strict mode (netplay) the core must not know frames are skipped: some cores change
    // emulated state when rendering/audio is disabled, which would desync rollback.
    case 47: /* GET_AUDIO_VIDEO_ENABLE */ if (strict) return false; *(int *)data = (want_video ? 1 : 0) | (want_audio ? 2 : 0); return true;
    case 64: /* GET_FASTFORWARDING */ if (strict) return false; *(bool *)data = fast_forwarding; return true;
    default: return false;
  }
}

// ---------- lifecycle ----------
static struct retro_system_info sysinfo;
static double avout[8];

API int ng_load(const char *path, const void *data, size_t size) {
  retro_set_environment(env_cb);
  retro_set_video_refresh(video_cb);
  retro_set_audio_sample(audio_cb);
  retro_set_audio_sample_batch(audio_batch_cb);
  retro_set_input_poll(input_poll_cb);
  retro_set_input_state(input_state_cb);
  retro_init();
  retro_get_system_info(&sysinfo);
  struct retro_game_info gi = {path, sysinfo.need_fullpath ? NULL : data, size, NULL};
  if (!retro_load_game(&gi)) return 0;
  retro_get_system_av_info(&av);
  for (unsigned p = 0; p < 4; p++) retro_set_controller_port_device(p, RETRO_DEVICE_JOYPAD);
  return 1;
}

// [base_w, base_h, max_w, max_h, aspect, fps, sample_rate]
API double *ng_av(void) {
  avout[0] = av.geometry.base_width; avout[1] = av.geometry.base_height;
  avout[2] = av.geometry.max_width; avout[3] = av.geometry.max_height;
  avout[4] = av.geometry.aspect_ratio > 0 ? av.geometry.aspect_ratio
                                          : (double)av.geometry.base_width / av.geometry.base_height;
  avout[5] = av.timing.fps; avout[6] = av.timing.sample_rate;
  return avout;
}

// flags: bit0 = render video, bit1 = produce audio, bit2 = fast-forward hint
API void ng_run(int flags) {
  want_video = flags & 1; want_audio = (flags >> 1) & 1; fast_forwarding = (flags >> 2) & 1;
  aframes = 0; frame_ready = 0;
  retro_run();
}

API void ng_reset(void) { retro_reset(); }
API size_t ng_state_size(void) { return retro_serialize_size(); }
API int ng_state_save(void *buf, size_t size) { return retro_serialize(buf, size); }
API int ng_state_load(const void *buf, size_t size) { return retro_unserialize(buf, size); }
API void *ng_mem(unsigned id) { return retro_get_memory_data(id); }
API size_t ng_mem_size(unsigned id) { return retro_get_memory_size(id); }
API void ng_cheat_reset(void) { retro_cheat_reset(); }
API void ng_cheat_set(unsigned i, int on, const char *code) { retro_cheat_set(i, on, code); }
API const char *ng_core_name(void) { return sysinfo.library_name; }
API const char *ng_core_version(void) { return sysinfo.library_version; }
