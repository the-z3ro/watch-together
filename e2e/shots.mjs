import { S, sleep, startServer, startWeb, stopAll, launch, create, loadVideo, ready } from './lib.mjs';
const browser = await launch();
try {
  await startServer(); await startWeb();
  for (const [w, h, touch, name] of [[390, 844, true, 'phone-portrait'], [844, 390, true, 'phone-landscape'], [1280, 800, false, 'laptop'], [820, 1180, true, 'tablet']]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const c = { name: 'Alice', page };
    await create(c); await loadVideo(c); await ready(c);
    await page.setInputFiles('input[accept=".srt,.vtt"]', S + '/sub1.srt');
    await sleep(600);
    await page.locator('.player').hover({ position: { x: 30, y: 30 } }).catch(() => {});
    await sleep(300);
    await page.screenshot({ path: `${S}/shot-${name}.png` });
    await page.locator('button[aria-label="Settings"]').first().click();
    await sleep(400);
    await page.screenshot({ path: `${S}/shot-${name}-settings.png` });
    await ctx.close();
  }
} finally { await stopAll(); await browser.close(); }
