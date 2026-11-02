import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
for (const dev of [{ n: 'desktop', o: { viewport: { width: 1280, height: 800 } } }, { n: 'phone', o: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } }]) {
  const p = await b.newPage(dev.o);
  p.on('pageerror', e => console.log('ERR', e.message));
  await p.goto('http://localhost:4173/');
  await p.click('text=Get started');
  await p.waitForFunction(() => document.querySelectorAll('.tile').length >= 9, null, { timeout: 30000 });
  await p.click('.tile[aria-label^="Kaiser DS Demo"]');
  await p.click('.details .btn.primary.big');
  await p.waitForSelector('canvas.screen'); await p.waitForTimeout(2500);
  // draw a zig-zag on the lower half of the canvas (the DS touch screen in stacked layout)
  const r = await p.$eval('canvas.screen', c => { const b = c.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  const gw = Math.min(r.w, r.h * 256 / 384), gh = gw * 384 / 256, gx = r.x + (r.w - gw) / 2, gy = r.y + (r.h - gh) / 2;
  const pts = Array.from({ length: 24 }, (_, i) => [gx + gw * (0.15 + i * 0.03), gy + gh * (0.65 + (i % 2 ? 0.1 : -0.05))]);
  if (dev.n === 'desktop') {
    await p.mouse.move(pts[0][0], pts[0][1]); await p.mouse.down();
    for (const [x, y] of pts) { await p.mouse.move(x, y, { steps: 3 }); await p.waitForTimeout(16); }
    await p.mouse.up();
  } else {
    const cdp = await p.context().newCDPSession(p);
    const tp = (type, [x, y]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await tp('touchStart', pts[0]);
    for (const pt of pts) { await tp('touchMove', pt); await p.waitForTimeout(16); }
    await tp('touchEnd', pts[0]);
  }
  await p.waitForTimeout(800);
  await p.screenshot({ path: `docs/screenshots/${dev.n}-18-ds.png` });
  console.log(dev.n, 'ok');
  await p.close();
}
await b.close();
