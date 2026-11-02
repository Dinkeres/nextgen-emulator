// Kaiser Link Squares — original GBA link-cable test (GPL-3.0-or-later).
// Each player moves a square with the D-pad. Positions are exchanged every frame over the
// link port in 16-bit multiplayer mode, so every screen shows every player's square.
// Top bar: your player colour when linked, grey when alone.
#include <stdint.h>
typedef uint16_t u16;
typedef volatile uint16_t vu16;
#define REG_DISPCNT     (*(vu16 *)0x4000000)
#define REG_VCOUNT      (*(vu16 *)0x4000006)
#define REG_SIOMULTI    ((vu16 *)0x4000120)
#define REG_SIOCNT      (*(vu16 *)0x4000128)
#define REG_SIOMLT_SEND (*(vu16 *)0x400012A)
#define REG_KEYINPUT    (*(vu16 *)0x4000130)
#define REG_RCNT        (*(vu16 *)0x4000134)
#define VRAM            ((vu16 *)0x6000000)
#define RGB(r, g, b)    ((r) | ((g) << 5) | ((b) << 10))
#define BG              RGB(3, 3, 7)
#define SQ              12

static const u16 colors[4] = {RGB(31, 8, 8), RGB(6, 20, 31), RGB(8, 28, 10), RGB(31, 26, 4)};

static void rect(int x, int y, int w, int h, u16 c) {
	for (int j = y; j < y + h; j++) {
		if (j < 0 || j >= 160) continue;
		for (int i = x; i < x + w; i++) if (i >= 0 && i < 240) VRAM[j * 240 + i] = c;
	}
}

static void vsync(void) {
	while (REG_VCOUNT >= 160);
	while (REG_VCOUNT < 160);
}

int main(void) {
	REG_DISPCNT = 3 | (1 << 10); // mode 3 bitmap, BG2 on
	REG_RCNT = 0;
	REG_SIOCNT = 0x2003;         // multiplayer mode, 115200 bps
	rect(0, 0, 240, 160, BG);
	int x = 30, y = 70, lx[4], ly[4];
	for (int i = 0; i < 4; i++) { lx[i] = -100; ly[i] = -100; }

	for (;;) {
		vsync();
		u16 k = ~REG_KEYINPUT;
		if (k & 0x10) x += 2;
		if (k & 0x20) x -= 2;
		if (k & 0x40) y -= 2;
		if (k & 0x80) y += 2;
		if (x < 0) x = 0; if (x > 240 - SQ) x = 240 - SQ;
		if (y < 6) y = 6; if (y > 160 - SQ) y = 160 - SQ;

		u16 cnt = REG_SIOCNT;
		int id = (cnt >> 4) & 3, linked = (cnt >> 3) & 1;
		rect(0, 0, 240, 4, linked ? colors[id] : RGB(12, 12, 12));

		// squares from the last completed transfer (0xFFFF = nobody in that slot)
		int px[4], py[4];
		for (int p = 0; p < 4; p++) {
			u16 v = REG_SIOMULTI[p];
			if (!linked || v == 0xFFFF) { px[p] = -100; py[p] = -100; }
			else { px[p] = v & 0xFF; py[p] = v >> 8; }
		}
		px[id] = x; py[id] = y; // our own square is always local
		for (int p = 0; p < 4; p++) {
			if (px[p] == lx[p] && py[p] == ly[p]) continue;
			rect(lx[p], ly[p], SQ, SQ, BG);
			lx[p] = px[p]; ly[p] = py[p];
		}
		for (int p = 0; p < 4; p++) rect(px[p], py[p], SQ, SQ, colors[p]);

		// send our position; the parent (SI low) starts the transfer when everyone is ready
		REG_SIOMLT_SEND = (u16)((x & 0xFF) | (y << 8));
		if (linked && !(cnt & 4) && !(cnt & 0x80)) REG_SIOCNT = cnt | 0x80;
	}
}
