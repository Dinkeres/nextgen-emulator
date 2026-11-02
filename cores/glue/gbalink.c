// Linked Game Boy Advance system: up to 4 mGBA cores in ONE wasm instance, connected by mGBA's
// lockstep link-cable coordinator and scheduled deterministically on a single thread.
//
// For online play every browser runs all players' GBAs in lockstep; only button presses cross
// the network (src/net/rollback.ts). Each browser shows and plays audio of its own player's GBA.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten/emscripten.h>
#include <mgba/core/core.h>
#include <mgba/core/config.h>
#include <mgba/core/lockstep.h>
#include <mgba/gba/interface.h>
#include <mgba/internal/gba/gba.h>
#include <mgba/internal/gba/sio/lockstep.h>
#include <mgba-util/audio-buffer.h>
#include <mgba-util/vfs.h>

#define API EMSCRIPTEN_KEEPALIVE
#define MAXP 4
#define W 240
#define H 160

struct LinkUser { struct mLockstepUser d; int idx; };

static int np = 0, view = 0;
static struct mCore *cores[MAXP];
static struct GBASIOLockstepCoordinator coord;
static struct GBASIOLockstepDriver drivers[MAXP];
static struct LinkUser users[MAXP];
static int asleep[MAXP];
static mColor video[MAXP][W * H];
static void *roms[MAXP];
static uint32_t keys[MAXP];
static int want_audio = 1;
static int16_t abuf[16384 * 2];
static size_t aframes = 0;
static int frame_ready = 0;

// --- lockstep user callbacks: "sleep" means stop scheduling this GBA until woken ---
static void u_sleep(struct mLockstepUser *u) {
	int i = ((struct LinkUser *)u)->idx;
	asleep[i] = 1;
	GBAInterrupt((struct GBA *)cores[i]->board); // leave its run loop right away
}
static void u_wake(struct mLockstepUser *u) { asleep[((struct LinkUser *)u)->idx] = 0; }
static int u_requested(struct mLockstepUser *u) { return ((struct LinkUser *)u)->idx; }

API void lk_teardown(void) {
	for (int i = 0; i < np; i++) {
		if (!cores[i]) continue;
		if (np > 1) {
			cores[i]->setPeripheral(cores[i], mPERIPH_GBA_LINK_PORT, NULL);
			GBASIOLockstepCoordinatorDetach(&coord, &drivers[i]);
		}
		cores[i]->deinit(cores[i]);
		cores[i] = NULL;
		free(roms[i]); roms[i] = NULL;
	}
	if (np > 1) GBASIOLockstepCoordinatorDeinit(&coord);
	np = 0;
}

/** Create n linked GBAs. Then call lk_load(i, rom) for each (same or different ROMs). */
API int lk_create(int n) {
	lk_teardown();
	if (n < 1 || n > MAXP) return 0;
	np = n;
	if (n > 1) GBASIOLockstepCoordinatorInit(&coord);
	for (int i = 0; i < n; i++) {
		struct mCore *c = mCoreCreate(mPLATFORM_GBA);
		if (!c) return 0;
		c->init(c);
		mCoreInitConfig(c, NULL);
		c->setVideoBuffer(c, video[i], W);
		c->setAudioBufferSize(c, 2048);
		cores[i] = c;
		asleep[i] = 0; keys[i] = 0;
	}
	return 1;
}

API int lk_load(int i, const void *data, size_t size) {
	if (i < 0 || i >= np) return 0;
	struct mCore *c = cores[i];
	roms[i] = malloc(size);
	memcpy(roms[i], data, size);
	struct VFile *vf = VFileFromConstMemory(roms[i], size);
	if (!c->loadROM(c, vf)) return 0;
	c->reset(c);
	return 1;
}

/** Wire the link cable once every ROM is loaded. */
API void lk_link(void) {
	if (np < 2) return;
	for (int i = 0; i < np; i++) {
		memset(&users[i], 0, sizeof(users[i]));
		users[i].idx = i;
		users[i].d.sleep = u_sleep;
		users[i].d.wake = u_wake;
		users[i].d.requestedId = u_requested;
		GBASIOLockstepDriverCreate(&drivers[i], &users[i].d);
		GBASIOLockstepCoordinatorAttach(&coord, &drivers[i]);
		cores[i]->setPeripheral(cores[i], mPERIPH_GBA_LINK_PORT, &drivers[i].d);
	}
}

API void lk_set_view(int i) { if (i >= 0 && i < np) view = i; }
API int lk_players(void) { return np; }

// libretro joypad bits -> GBA keys (A,B,Select,Start,Right,Left,Up,Down,R,L)
API void lk_set_input(int i, unsigned m) {
	if (i < 0 || i >= np) return;
	unsigned k = 0;
	if (m & (1 << 8)) k |= 1 << 0;  // A
	if (m & (1 << 0)) k |= 1 << 1;  // B
	if (m & (1 << 2)) k |= 1 << 2;  // Select
	if (m & (1 << 3)) k |= 1 << 3;  // Start
	if (m & (1 << 7)) k |= 1 << 4;  // Right
	if (m & (1 << 6)) k |= 1 << 5;  // Left
	if (m & (1 << 4)) k |= 1 << 6;  // Up
	if (m & (1 << 5)) k |= 1 << 7;  // Down
	if (m & (1 << 11)) k |= 1 << 8; // R
	if (m & (1 << 10)) k |= 1 << 9; // L
	keys[i] = k;
}

/** Run every GBA until player 0 (the link clock owner) finishes a frame. Deterministic:
 *  scheduling depends only on emulated state, never on wall-clock time. */
API void lk_run(int flags) {
	want_audio = (flags >> 1) & 1;
	aframes = 0; frame_ready = 0;
	for (int i = 0; i < np; i++) cores[i]->setKeys(cores[i], keys[i]);
	uint32_t start = cores[0]->frameCounter(cores[0]);
	uint32_t vstart = cores[view]->frameCounter(cores[view]);
	for (int guard = 0; cores[0]->frameCounter(cores[0]) == start && guard < 2000000; guard++) {
		int ran = 0;
		for (int i = 0; i < np; i++) {
			if (asleep[i]) continue;
			cores[i]->runLoop(cores[i]);
			ran = 1;
		}
		if (!ran) for (int i = 0; i < np; i++) asleep[i] = 0; // never deadlock
	}
	frame_ready = (flags & 1) && cores[view]->frameCounter(cores[view]) != vstart;
	// audio of the local player's GBA; drain the others so their buffers never fill up
	for (int i = 0; i < np; i++) {
		struct mAudioBuffer *b = cores[i]->getAudioBuffer(cores[i]);
		size_t avail = mAudioBufferAvailable(b);
		if (i == view && want_audio) {
			if (avail > 16384) avail = 16384;
			aframes = mAudioBufferRead(b, abuf, avail);
		} else {
			int16_t tmp[512 * 2];
			while (avail) { size_t k = avail > 512 ? 512 : avail; mAudioBufferRead(b, tmp, k); avail -= k; }
		}
	}
}

API int lk_frame_ready(void) { return frame_ready; }
API mColor *lk_fb(void) { return video[view]; }
API int16_t *lk_audio(void) { return abuf; }
API size_t lk_audio_frames(void) { return aframes; }
API unsigned lk_sample_rate(void) { return np ? cores[0]->audioSampleRate(cores[0]) : 32768; }
API void lk_reset(void) { for (int i = 0; i < np; i++) cores[i]->reset(cores[i]); }

// --- save states: all GBAs + scheduler flags (the link driver state is inside each GBA's state) ---
API size_t lk_state_size(void) {
	size_t n = 16;
	for (int i = 0; i < np; i++) n += cores[i]->stateSize(cores[i]) + 8;
	return n;
}
API int lk_state_save(uint8_t *buf, size_t size) {
	if (size < lk_state_size()) return 0;
	memset(buf, 0, size);
	uint8_t *p = buf;
	for (int i = 0; i < MAXP; i++) p[i] = i < np ? (uint8_t)asleep[i] : 0;
	p += 16;
	for (int i = 0; i < np; i++) {
		size_t s = cores[i]->stateSize(cores[i]);
		memcpy(p, &s, 4); p += 8;
		if (!cores[i]->saveState(cores[i], p)) return 0;
		p += s;
	}
	return 1;
}
API int lk_state_load(const uint8_t *buf, size_t size) {
	if (size < 16) return 0;
	const uint8_t *p = buf + 16;
	for (int i = 0; i < np; i++) {
		uint32_t s; memcpy(&s, p, 4); p += 8;
		if (!cores[i]->loadState(cores[i], p)) return 0;
		p += s;
	}
	for (int i = 0; i < np; i++) asleep[i] = buf[i];
	return 1;
}

// --- battery saves per player ---
static void *sram_tmp = NULL;
API size_t lk_sram_clone(int i) {
	free(sram_tmp); sram_tmp = NULL;
	if (i < 0 || i >= np) return 0;
	return cores[i]->savedataClone(cores[i], &sram_tmp);
}
API void *lk_sram_ptr(void) { return sram_tmp; }
API int lk_sram_restore(int i, const void *data, size_t size) {
	if (i < 0 || i >= np) return 0;
	return cores[i]->savedataRestore(cores[i], data, size, false);
}
