// Kaiser DS Demo — an original test program for the Kaiser emulator (GPL-3.0-or-later).
// Top screen: a 3D cube (D-pad rotates). Bottom screen: touch to paint, tap the palette to
// change colour, L/R brush size, A clears. Exercises 3D, both screens and the touchscreen.
#include <nds.h>

static u16 *canvas;
static const u16 palette[8] = {
	RGB15(31, 31, 31), RGB15(31, 6, 8), RGB15(31, 18, 0), RGB15(31, 29, 4),
	RGB15(6, 28, 10), RGB15(4, 22, 31), RGB15(17, 10, 31), RGB15(31, 10, 24),
};
#define BAR_Y 172
#define BG RGB15(3, 3, 6)

static void plot(int x, int y, u16 c, int r) {
	for (int dy = -r; dy <= r; dy++)
		for (int dx = -r; dx <= r; dx++) {
			int px = x + dx, py = y + dy;
			if (dx * dx + dy * dy > r * r || px < 0 || px > 255 || py < 0 || py >= BAR_Y - 2) continue;
			canvas[py * 256 + px] = c | BIT(15);
		}
}

static void clearCanvas(void) {
	for (int i = 0; i < 256 * (BAR_Y - 2); i++) canvas[i] = BG | BIT(15);
}

static void drawBar(int sel) {
	for (int y = BAR_Y - 2; y < 192; y++)
		for (int x = 0; x < 256; x++) {
			int i = x / 32;
			u16 c = y < BAR_Y ? RGB15(10, 10, 14) : palette[i];
			if (y >= BAR_Y && i == sel && (y < BAR_Y + 3 || y > 188 || x % 32 < 3 || x % 32 > 28)) c = RGB15(31, 31, 31);
			canvas[y * 256 + x] = c | BIT(15);
		}
}

static void face(u16 c, int shade, float v[4][3]) {
	int r = (c & 31) * 8 * shade / 8, g = ((c >> 5) & 31) * 8 * shade / 8, b = ((c >> 10) & 31) * 8 * shade / 8;
	glColor3b(r, g, b);
	for (int i = 0; i < 4; i++) glVertex3f(v[i][0], v[i][1], v[i][2]);
}

int main(void) {
	videoSetMode(MODE_0_3D);
	videoSetModeSub(MODE_5_2D);
	vramSetBankC(VRAM_C_SUB_BG);
	int bg = bgInitSub(3, BgType_Bmp16, BgSize_B16_256x256, 0, 0);
	canvas = (u16 *)bgGetGfxPtr(bg);
	lcdMainOnTop();

	glInit();
	glEnable(GL_ANTIALIAS);
	glClearColor(2, 2, 6, 31);
	glClearPolyID(63);
	glClearDepth(0x7FFF);
	glViewport(0, 0, 255, 191);
	glMatrixMode(GL_PROJECTION);
	glLoadIdentity();
	gluPerspective(60, 256.0 / 192.0, 0.1, 40);

	clearCanvas();
	int sel = 5, size = 3, lastX = -1, lastY = -1;
	float rx = 25, ry = 0, spin = 1;
	drawBar(sel);

	while (1) {
		scanKeys();
		int held = keysHeld(), down = keysDown();
		if (held & KEY_LEFT) ry -= 3;
		if (held & KEY_RIGHT) ry += 3;
		if (held & KEY_UP) rx -= 3;
		if (held & KEY_DOWN) rx += 3;
		if (down & KEY_B) spin = spin ? 0 : 1;
		if (down & KEY_A) clearCanvas();
		if (down & KEY_R && size < 12) size++;
		if (down & KEY_L && size > 1) size--;
		if (down & KEY_START) { rx = 25; ry = 0; }

		if (held & KEY_TOUCH) {
			touchPosition t;
			touchRead(&t);
			if (t.py >= BAR_Y) {
				if (t.px / 32 != sel) { sel = t.px / 32; drawBar(sel); }
				lastX = -1;
			} else {
				if (lastX < 0) { lastX = t.px; lastY = t.py; }
				int steps = abs(t.px - lastX) + abs(t.py - lastY) + 1;
				for (int i = 0; i <= steps; i++) plot(lastX + (t.px - lastX) * i / steps, lastY + (t.py - lastY) * i / steps, palette[sel], size);
				lastX = t.px; lastY = t.py;
			}
		} else lastX = -1;

		glMatrixMode(GL_MODELVIEW);
		glLoadIdentity();
		glTranslatef(0, 0, -3.2);
		glRotateX(rx);
		glRotateY(ry);
		glPolyFmt(POLY_ALPHA(31) | POLY_CULL_BACK);
		glBegin(GL_QUADS);
		u16 c = palette[sel];
		float F[4][3] = {{-1,-1,1},{1,-1,1},{1,1,1},{-1,1,1}}, B[4][3] = {{1,-1,-1},{-1,-1,-1},{-1,1,-1},{1,1,-1}};
		float T[4][3] = {{-1,1,1},{1,1,1},{1,1,-1},{-1,1,-1}}, D[4][3] = {{-1,-1,-1},{1,-1,-1},{1,-1,1},{-1,-1,1}};
		float R[4][3] = {{1,-1,1},{1,-1,-1},{1,1,-1},{1,1,1}}, L[4][3] = {{-1,-1,-1},{-1,-1,1},{-1,1,1},{-1,1,-1}};
		face(c, 8, F); face(c, 5, B); face(RGB15(31, 31, 31), 7, T); face(c, 3, D); face(c, 6, R); face(c, 4, L);
		glEnd();
		glFlush(0);
		swiWaitForVBlank();
		ry += spin;
	}
	return 0;
}
