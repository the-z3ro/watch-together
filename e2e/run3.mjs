// New in v3: responsive sweep, touch gestures, YouTube sync (with a fake YouTube player — the sandbox can't reach youtube.com).
import { capbar, S, check, step, summary, sleep, startServer, startWeb, stopAll, launch, newClient, create, join, loadVideo, ready, until, errors, URL } from './lib.mjs';

export const FAKE_YT = `
(function(){
  window.__ytPlayers = [];
  function P(el, o){
    var self=this, frame=document.createElement('div');
    frame.className='fake-yt'; frame.style.cssText='width:100%;height:100%;background:#223;color:#fff;display:grid;place-items:center';
    frame.textContent='fake youtube '+o.videoId;
    el.parentNode.replaceChild(frame, el);
    var pos=(o.playerVars&&o.playerVars.start)||0, playing=false, since=performance.now(), state=-1, rate=1, vid=o.videoId, vol=100, muted=false;
    var now=function(){return performance.now();};
    var cur=function(){return playing? pos+(now()-since)/1000*rate : pos;};
    var set=function(s){ state=s; o.events.onStateChange && o.events.onStateChange({data:s,target:self}); };
    self.playVideo=function(){ if(playing) return; pos=cur(); playing=true; since=now(); set(1); };
    self.pauseVideo=function(){ if(window.__dbg) console.log('PAUSE '+(new Error().stack.split('\\n').slice(2,5).join(' <- '))); if(!playing) return; pos=cur(); playing=false; set(2); };
    self.seekTo=function(t){ pos=t; since=now(); set(3); setTimeout(function(){ if(state===3) set(playing?1:2); },250); };
    self.getCurrentTime=cur; self.getDuration=function(){return 600;}; self.getPlayerState=function(){return state;};
    self.getPlaybackRate=function(){return rate;}; self.setPlaybackRate=function(r){ pos=cur(); since=now(); rate=r; };
    self.getAvailablePlaybackRates=function(){return [0.5,1,1.5,2];};
    self.getVideoLoadedFraction=function(){return 0.3;};
    self.getVideoData=function(){return {video_id:vid,title:'Fake video '+o.videoId,isLive:false};};
    var ccOn=false, ccTrack=null;
    self.loadModule=function(m){ if(m==='captions') ccOn=true; }; self.unloadModule=function(m){ if(m==='captions'){ ccOn=false; ccTrack=null; } };
    self.getOption=function(m,o){ return (m==='captions'&&o==='tracklist') ? [{languageCode:'en',displayName:'English'},{languageCode:'hi',displayName:'Hindi'}] : null; };
    self.setOption=function(m,o,v){ if(m==='captions'&&o==='track') ccTrack=v.languageCode; };
    self.__cc=function(){ return {on:ccOn,track:ccTrack}; };
    self.setVolume=function(v){vol=v;}; self.mute=function(){muted=true;}; self.unMute=function(){muted=false;};
    self.destroy=function(){ frame.remove(); self.dead=true; };
    self.__fail=function(code){ o.events.onError({data:code}); };
    self.__setVid=function(v){ vid=v; };
    self.__info=function(){ return {pos:cur(),playing:playing,state:state,rate:rate,vol:vol,muted:muted,id:o.videoId,controls:o.playerVars.controls}; };
    window.__ytPlayers.push(self);
    setTimeout(function(){ state=5; o.events.onReady && o.events.onReady({target:self}); },60);
  }
  window.YT={Player:P};
  setTimeout(function(){ window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(); },20);
})();
`;

const ytInfo = (c) => c.page.evaluate(() => { const l = window.__ytPlayers.filter((p) => !p.dead); return l.length ? l[l.length - 1].__info() : null; });
const ytCall = (c, fn, ...a) => c.page.evaluate(([f, args]) => { const l = window.__ytPlayers.filter((p) => !p.dead); return l[l.length - 1][f](...args); }, [fn, a]);
async function withYt(browser, name, viewport, opts = {}) {
  const c = await newClient(browser, name, viewport);
  return c;
}
async function mk(browser, name, viewport, ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport, ...ctxOpts });
  await ctx.route('https://www.youtube.com/iframe_api', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_YT }));
  await ctx.route(/i\.ytimg\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource|WebSocket|websocket/.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
  const c = { name, ctx, page };
  c.pos = () => page.evaluate(() => document.querySelector('video')?.currentTime ?? null);
  c.toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent));
  return c;
}

const PHONE = { hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
const SIZES = process.env.SIZES ? JSON.parse(process.env.SIZES) : [
  [320, 568, 'phone'], [360, 640, 'phone'], [375, 667, 'phone'], [390, 844, 'phone'], [412, 915, 'phone'], [430, 932, 'phone'], [280, 653, 'phone'],
  [568, 320, 'phone'], [667, 375, 'phone'], [844, 390, 'phone'], [915, 412, 'phone'], [932, 430, 'phone'],
  [768, 1024, 'tablet'], [820, 1180, 'tablet'], [1024, 768, 'tablet'], [1180, 820, 'tablet'],
  [700, 800, 'desk'], [999, 700, 'desk'], [1000, 700, 'desk'], [1280, 720, 'desk'], [1366, 768, 'desk'], [1440, 900, 'desk'], [1920, 1080, 'desk'], [2560, 1080, 'desk'], [600, 300, 'desk'],
];

/** Everything that must hold at every size. Returns a list of problems (empty = fine). */
async function geometry(page, label) {
  return page.evaluate((label) => {
    const bad = [];
    const vw = window.innerWidth, vh = window.innerHeight;
    const de = document.documentElement;
    if (de.scrollWidth > vw + 1) bad.push(`horizontal scroll: ${de.scrollWidth} > ${vw}`);
    const pl = document.querySelector('.player, .drop');
    if (!pl) return ['no player'];
    const r = pl.getBoundingClientRect();
    if (r.left < -1 || r.right > vw + 1) bad.push(`player outside viewport x ${r.left.toFixed(0)}..${r.right.toFixed(0)} of ${vw}`);
    if (r.width < 200) bad.push('player too small ' + r.width.toFixed(0));
    const mode = document.querySelector('.room')?.getAttribute('data-mode');
    if (mode === 'landscape' && Math.abs(r.height - vh) > 2) bad.push(`landscape player ${r.height} != ${vh}`);
    if (mode === 'stack' && r.height > vh * 0.64) bad.push(`stack player too tall ${r.height.toFixed(0)} of ${vh}`);
    if (mode === 'wide' && r.bottom > vh + 2 && vh >= 700) bad.push(`wide player bottom ${r.bottom.toFixed(0)} > ${vh}`);
    const player = document.querySelector('.player');
    if (player && player.classList.contains('ui')) {
      const pr = player.getBoundingClientRect();
      for (const el of player.querySelectorAll('.controls button, .controls input, .controls .scrub, .cluster button, .topbar button')) {
        const b = el.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) continue;
        if (b.left < pr.left - 1 || b.right > pr.right + 1 || b.top < pr.top - 1 || b.bottom > pr.bottom + 1) bad.push(`control outside player: ${el.getAttribute('aria-label') || el.className}`);
      }
      const row = player.querySelector('.controls .row');
      if (row && row.scrollWidth > row.clientWidth + 1) bad.push(`control row overflows ${row.scrollWidth}>${row.clientWidth}`);
      const names = [...player.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
      for (const need of ['Settings', 'Fullscreen']) if (!names.includes(need) && !player.classList.contains('native')) bad.push('missing ' + need);
      if (!names.includes('Play') && !names.includes('Pause')) bad.push('missing play/pause');
      // overlapping buttons inside the row
      const bs = [...player.querySelectorAll('.controls .row > *')].map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0);
      for (let i = 1; i < bs.length; i++) if (bs[i].left < bs[i - 1].right - 1) { bad.push('controls overlap'); break; }
    }
    return bad.map((b) => label + ': ' + b);
  }, label);
}

const only = (n) => !process.env.ONLY || process.env.ONLY.split(',').includes(String(n));
const browser = await launch();
try {
  await startServer();
  await startWeb();

  // ------------------------------------------------------------------ 1. responsive sweep
  if (only(1)) await step('1. responsive sweep: every size, file + captions + sheets, then YouTube', async () => {
    let problems = 0;
    for (const [w, h, kind] of SIZES) {
      const label = `${w}x${h}`;
      const c = await mk(browser, 'Sweep', { width: w, height: h }, kind === 'desk' ? {} : PHONE);
      try {
        const code = await create(c);
        const g0 = await geometry(c.page, label + ' empty');
        await loadVideo(c);
        await ready(c);
        // add captions so the CC button joins the row
        await c.page.setInputFiles('input[accept=".srt,.vtt"]', S + '/sub1.srt');
        await sleep(700);
        await c.page.mouse.move(Math.min(w - 5, 100), Math.min(h - 5, 100)).catch(() => {});
        if (kind !== 'desk') await c.page.evaluate(() => document.querySelector('.player')?.classList.add('ui'));
        await c.page.locator('.player').hover({ position: { x: 20, y: 20 } }).catch(() => {});
        await sleep(300);
        const g1 = await geometry(c.page, label + ' file');
        // settings sheet
        await c.page.locator('button[aria-label="Settings"]').first().click({ timeout: 4000 }).catch(() => {});
        await sleep(300);
        const sheet = await c.page.evaluate(() => {
          const d = document.querySelector('.dock');
          if (!d) return 'no sheet';
          const b = d.getBoundingClientRect();
          return b.left < -1 || b.right > innerWidth + 1 || b.top < -1 || b.bottom > innerHeight + 1 ? `sheet outside viewport ${JSON.stringify([b.left, b.top, b.right, b.bottom])}` : '';
        });
        await c.page.keyboard.press('Escape');
        await sleep(250);
        const closed = await c.page.locator('.dock').count();
        // YouTube mode
        if (await c.page.locator('button[aria-label="Watch from YouTube"]').count()) await c.page.locator('button[aria-label="Watch from YouTube"]').first().click();
        else {
          await c.page.locator('button[aria-label="People and room"]').click(); // landscape: the room lives in the drawer
          await c.page.locator('.tabs button', { hasText: 'Media' }).click();
          await c.page.locator('.linkbtn', { hasText: /YouTube/ }).first().click();
        }
        await c.page.fill('#ytlink', 'https://youtu.be/dQw4w9WgXcQ');
        await c.page.locator('.dock button[type=submit]').click();
        await c.page.waitForSelector('.player.yt', { timeout: 8000 });
        await until(async () => (await ytInfo(c)) !== null, 4000);
        await c.page.getByRole('button', { name: /ready/i }).click();
        await sleep(400);
        await c.page.locator('.player').hover({ position: { x: 20, y: 20 } }).catch(() => {});
        if (kind !== 'desk') await c.page.evaluate(() => document.querySelector('.player')?.classList.add('ui'));
        await sleep(300);
        const g2 = await geometry(c.page, label + ' youtube');
        const all = [...g0, ...g1, ...g2, ...(sheet ? [label + ': ' + sheet] : []), ...(closed ? [label + ': sheet did not close'] : [])];
        problems += all.length;
        check(all.length === 0, `layout ${label} (${kind})`, all.join(' | '));
        if (w === 390 || w === 844 || w === 1280) await c.page.screenshot({ path: `${S}/shot-${label}-yt.png` });
      } catch (e) {
        problems++;
        check(false, `layout ${label} threw`, String(e.message).split('\n').slice(0, 12).join(' / ').slice(0, 700));
      }
      await c.ctx.close();
    }
  });

  // ------------------------------------------------------------------ 2. touch gestures
  if (only(2)) await step('2. touch gestures on a phone (owner + viewer)', async () => {
    const A = await mk(browser, 'Alice', { width: 390, height: 844 }, PHONE);
    const B = await mk(browser, 'Bob', { width: 390, height: 844 }, PHONE);
    const code = await create(A);
    await join(B, code);
    for (const c of [A, B]) await loadVideo(c);
    for (const c of [A, B]) await ready(c);
    check(await A.page.evaluate(() => document.querySelector('.player').classList.contains('touch')), 'touch layout detected (big centre cluster)');
    check((await A.page.locator('.cluster button').count()) === 3, 'back / play / forward cluster present');
    const box = await A.page.locator('.gest').boundingBox();
    const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
    const cdp = await A.ctx.newCDPSession(A.page);
    const swipe = async (from, to, steps = 8) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1], id: 1 }] });
      for (let i = 1; i <= steps; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from[0] + ((to[0] - from[0]) * i) / steps, y: from[1] + ((to[1] - from[1]) * i) / steps, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(250);
    };
    const tap = async (p) => { await A.page.touchscreen.tap(p[0], p[1]); };

    // start playing from the centre cluster
    await A.page.locator('.cluster button[aria-label=Play]').tap();
    await sleep(1800);
    check((await A.pos()) > 0.5, 'tapping the centre play button starts playback');
    // pause so seeks are easy to read
    await A.page.locator('.cluster button[aria-label=Pause]').tap().catch(async () => { await tap(at(0.5, 0.5)); });
    await sleep(900);
    const p0 = await A.pos();
    // double-tap right = +10 s
    await tap(at(0.85, 0.2)); await sleep(60); await tap(at(0.85, 0.2));
    await sleep(1300);
    const p1 = await A.pos();
    check(Math.abs(p1 - p0 - 10) < 1.2, 'double-tap right seeks +10 s', `Δ=${(p1 - p0).toFixed(2)}`);
    check((await B.pos()) > p0 + 8, "…and it moved the other person's player too", `B=${(await B.pos()).toFixed(1)}`);
    // keep tapping adds another 10
    await tap(at(0.85, 0.2)); await sleep(60); await tap(at(0.85, 0.2)); await sleep(100); await tap(at(0.85, 0.4));
    await sleep(1400);
    const p2 = await A.pos();
    check(Math.abs(p2 - p1 - 20) < 1.5, 'double-tap + extra tap = +20 s (merged into one seek)', `Δ=${(p2 - p1).toFixed(2)}`);
    // double-tap left = −10
    await tap(at(0.15, 0.2)); await sleep(60); await tap(at(0.15, 0.2));
    await sleep(1300);
    const p3 = await A.pos();
    check(Math.abs(p2 - p3 - 10) < 1.2, 'double-tap left seeks −10 s', `Δ=${(p3 - p2).toFixed(2)}`);

    // volume: swipe on the right half
    const vol0 = await A.page.evaluate(() => document.querySelector('video').volume);
    await swipe(at(0.92, 0.12), at(0.92, 0.5));
    const vol1 = await A.page.evaluate(() => document.querySelector('video').volume);
    check(vol0 === 1 && vol1 < 1, 'swiping down on the right side lowers the volume', `${vol0} -> ${vol1}`);
    await swipe(at(0.92, 0.5), at(0.92, 0.12));
    check((await A.page.evaluate(() => document.querySelector('video').volume)) > vol1, 'swiping up raises it', String(await A.page.evaluate(() => document.querySelector('video').volume)));
    await swipe(at(0.92, 0.12), at(0.92, 0.5));
    const vol2 = await A.page.evaluate(() => document.querySelector('video').volume);
    
    await swipe(at(0.2, 0.12), at(0.2, 0.5));
    check((await A.page.evaluate(() => document.querySelector('video').volume)) === vol2, 'vertical swipe on the LEFT does nothing (no brightness/dim)');
    check(Math.abs((await A.pos()) - p3) < 0.5, 'and does not seek', `${await A.pos()} vs ${p3}`);

    // horizontal swipe scrubs (owner)
    await swipe(at(0.25, 0.15), at(0.75, 0.15));
    await sleep(1200);
    const p4 = await A.pos();
    check(p4 - p3 > 5, 'horizontal swipe scrubs forward for everyone', `Δ=${(p4 - p3).toFixed(1)}`);

    // tap toggles controls (while playing)
    if (process.env.DBG) { A.page.on('console', (m) => console.log('  [A]', m.text())); await A.page.evaluate(() => { const g = document.querySelector('.gest'); for (const t of ['pointerdown','pointerup','pointercancel','click']) g.addEventListener(t, (e) => console.log(t, e.pointerType, e.clientX|0, e.clientY|0)); }); }
    await A.page.locator('.cluster button[aria-label=Play]').tap();
    await sleep(1500);
    const hasUi = () => A.page.evaluate(() => document.querySelector('.player').classList.contains('ui'));
    await sleep(3600); // let any auto-hide timer from earlier taps run out
    if (!(await hasUi())) { await tap(at(0.5, 0.15)); await sleep(500); }
    check(await hasUi(), 'controls are shown');
    await tap(at(0.5, 0.15)); await sleep(500);
    check(!(await hasUi()), 'single tap hides the controls while playing');
    await tap(at(0.5, 0.15)); await sleep(500);
    check(await hasUi(), 'another tap shows them');
    // double-tap centre pauses
    await tap(at(0.5, 0.15)); await sleep(60); await tap(at(0.5, 0.15));
    await sleep(900);
    check(await A.page.evaluate(() => document.querySelector('video').paused), 'double-tap in the middle pauses');

    // viewer: gestures that change playback are refused politely, volume still works
    const bbox = await B.page.locator('.gest').boundingBox();
    await B.page.touchscreen.tap(bbox.x + bbox.width * 0.85, bbox.y + bbox.height * 0.2);
    await sleep(60);
    await B.page.touchscreen.tap(bbox.x + bbox.width * 0.85, bbox.y + bbox.height * 0.2);
    await sleep(500);
    check((await B.toasts()).some((t) => /owner or a controller/i.test(t)), 'viewer double-tap explains who can control');

    // lock controls
    await A.page.locator('button[aria-label="Settings"]').tap().catch(async () => { await tap(at(0.5, 0.15)); await A.page.locator('button[aria-label="Settings"]').tap(); });
    await A.page.locator('.srow', { hasText: 'Lock controls' }).tap();
    await sleep(400);
    check((await A.page.locator('.lockveil').count()) === 1 && (await A.page.locator('.controls').count()) === 0, 'lock mode hides the controls');
    await tap(at(0.5, 0.15)); await sleep(300);
    check(await A.page.locator('.lockveil button', { hasText: 'Unlock' }).isVisible(), 'a tap offers Unlock');
    await A.page.locator('.lockveil button').tap();
    await sleep(300);
    check((await A.page.locator('.lockveil').count()) === 0, 'unlocked again');

    // Android Back closes a sheet instead of leaving the room
    await A.page.locator('button[aria-label="Settings"]').tap().catch(() => {});
    await sleep(300);
    const open = await A.page.locator('.dock').count();
    await A.page.goBack();
    await sleep(500);
    check(open === 1 && (await A.page.locator('.dock').count()) === 0 && A.page.url().includes('?r='), 'Back button closes the sheet and stays in the room');
    // pinch zoom
    await tap(at(0.5, 0.15));
    const two = async (a0, b0, a1, b1, steps = 6) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a0[0], y: a0[1], id: 1 }, { x: b0[0], y: b0[1], id: 2 }] });
      for (let i = 1; i <= steps; i++) {
        const f = i / steps;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a0[0] + (a1[0] - a0[0]) * f, y: a0[1] + (a1[1] - a0[1]) * f, id: 1 }, { x: b0[0] + (b1[0] - b0[0]) * f, y: b0[1] + (b1[1] - b0[1]) * f, id: 2 }] });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await two(at(0.42, 0.15), at(0.58, 0.15), at(0.2, 0.15), at(0.8, 0.15));
    await sleep(200);
    const z = await A.page.evaluate(() => document.querySelector('video').style.transform);
    check(/scale\(/.test(z), 'pinch zooms the picture', z + ' ' + (await A.page.evaluate(() => document.querySelector('.player').className)));
    await A.ctx.close(); await B.ctx.close();
  });

  // ------------------------------------------------------------------ 3. YouTube
  if (only(3)) await step('3. YouTube: permissions, sync, grant / revoke, errors, ads, back to file', async () => {
    const A = await mk(browser, 'Alice', { width: 1280, height: 800 });
    const B = await mk(browser, 'Bob', { width: 390, height: 844 }, PHONE);
    const C = await mk(browser, 'Cara', { width: 1100, height: 760 });
    const code = await create(A);
    await join(B, code); await join(C, code);
    await loadVideo(A);
    await A.page.waitForSelector('.members li:nth-child(3)');
    const openLoader = async (c) => {
      const btn = c.page.locator('button[aria-label="Watch from YouTube"]');
      await btn.click();
      await c.page.waitForSelector('.dock');
    };
    // Bob cannot
    await openLoader(B);
    check((await B.page.locator('#ytlink').count()) === 0 && /can’t load YouTube/.test(await B.page.locator('.dock').textContent()), 'participant sees why they cannot load YouTube (no input)');
    await B.page.keyboard.press('Escape'); await sleep(250);
    // owner: bad link then good link with start time
    await openLoader(A);
    await A.page.fill('#ytlink', 'https://example.com/watch?v=dQw4w9WgXcQ');
    await A.page.locator('.dock button[type=submit]').click();
    check(/doesn’t look like a YouTube/.test(await A.page.locator('.dock').textContent()), 'non-YouTube link is rejected with a clear message');
    await A.page.fill('#ytlink', 'https://youtu.be/dQw4w9WgXcQ?t=42');
    check(/from 0:42/.test(await A.page.locator('.ytprev').textContent()), 'preview shows the start time');
    await A.page.locator('.dock button[type=submit]').click();
    for (const c of [A, B, C]) await c.page.waitForSelector('.player.yt', { timeout: 8000 });
    check(true, 'everyone switched to the YouTube player');
    for (const c of [A, B, C]) check(await until(async () => (await ytInfo(c))?.id === 'dQw4w9WgXcQ', 4000), `${c.name}: embedded the right video id`);
    check(Math.abs((await ytInfo(B)).pos - 42) < 1, 'starts at 0:42', String((await ytInfo(B)).pos));
    check((await A.page.locator('.members').textContent()).includes('Watching on YouTube'), 'people list says they are watching YouTube');
    for (const c of [A, B, C]) await c.page.getByRole('button', { name: /ready/i }).click();
    await sleep(600);
    check(!(await ytInfo(A)).playing, 'ready tap leaves it paused');
    if (process.env.DBG) { for (const c of [A, B, C]) { c.page.on('console', (m) => /PAUSE|RUN/.test(m.text()) && c.name==='Alice' && console.log('  [' + c.name + ']', m.text().slice(0, 400))); await c.page.evaluate(() => (window.__dbg = 1)); } }
    await A.page.keyboard.press('k');
    if (process.env.DBG) for (let i = 0; i < 6; i++) { await sleep(500); console.log('  t+' + (i + 1) * 500, JSON.stringify(await ytInfo(A)), JSON.stringify(await A.toasts()), await A.page.evaluate(() => document.querySelector('.chip.floating')?.textContent)); }
    await sleep(process.env.DBG ? 200 : 3200);
    const infos = await Promise.all([A, B, C].map(ytInfo));
    check(infos.every((i) => i.playing), 'owner play => all three YouTube players playing', JSON.stringify(infos) + ' ' + JSON.stringify(await A.toasts()));
    const ps = infos.map((i) => i.pos);
    check(Math.max(...ps) - Math.min(...ps) < 1.3, 'YouTube positions within 1.3 s', ps.map((p) => p.toFixed(2)).join(' / '));
    // viewer can't pause
    await B.page.keyboard.press('k'); await sleep(600);
    check((await ytInfo(A)).playing, 'participant cannot pause');
    // controller can pause/seek but not load
    await A.page.locator('.members li', { hasText: 'Cara' }).locator('.switch', { hasText: 'controller' }).click();
    await sleep(500);
    await C.page.keyboard.press('k'); await sleep(900);
    check(!(await ytInfo(A)).playing, 'controller pauses everyone');
    await C.page.keyboard.press('l'); await sleep(900);
    check(Math.abs((await ytInfo(B)).pos - (await ytInfo(A)).pos) < 1, 'controller seek reaches everyone');
    await openLoader(C);
    check((await C.page.locator('#ytlink').count()) === 0, 'controller still cannot load YouTube');
    await C.page.keyboard.press('Escape'); await sleep(250);
    // grant Bob
    await A.page.locator('.members li', { hasText: 'Bob' }).locator('.switch', { hasText: 'YouTube' }).click();
    check(await until(async () => (await B.page.locator('.members').textContent()).includes('Can load YouTube')), 'Bob is badged "Can load YouTube"');
    await openLoader(B);
    check((await B.page.locator('#ytlink').count()) === 1, 'after the grant Bob sees the paste box');
    await B.page.fill('#ytlink', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
    await B.page.locator('.dock button[type=submit]').click();
    check(/replaces what the room is watching/.test(await B.page.locator('.dock').textContent()), 'replacing a running video asks for confirmation');
    await B.page.locator('.dock button[type=submit]').click();
    check(await until(async () => (await ytInfo(A))?.id === 'aqz-KE-bpKQ', 5000), 'Bob loaded a new video for everyone (owner sees it)');
    check(await until(() => A.page.locator('.overlay button.big').isVisible(), 4000), 'a new video asks everyone to tap ready again');
    // revoke
    await A.page.locator('.members li', { hasText: 'Bob' }).locator('.switch', { hasText: 'YouTube' }).click();
    await sleep(600);
    await B.page.locator('button[aria-label="Watch from YouTube"]').click(); await B.page.waitForSelector('.dock');
    check((await B.page.locator('#ytlink').count()) === 0, 'revoked: Bob can no longer load');
    await B.page.keyboard.press('Escape'); await sleep(250);

    // embedding blocked on one machine
    for (const c of [A, B, C]) await c.page.getByRole('button', { name: /ready/i }).click();
    await sleep(400);
    await ytCall(B, '__fail', 101);
    await B.page.waitForSelector('.overlay .card-lite');
    check(/outside YouTube/.test(await B.page.locator('.overlay').textContent()), 'blocked embed explains itself');
    check(await until(async () => (await A.page.locator('.members').textContent()).includes('Embedding blocked'), 4000), 'owner sees who cannot play it');
    // ad on Cara: sync holds, UI hides, resumes after
    await A.page.keyboard.press('k'); await sleep(2500);
    await ytCall(C, '__setVid', 'AD00000000x');
    await sleep(900);
    check(await C.page.evaluate(() => document.querySelector('.player').classList.contains('ad')), 'ad detected on that viewer');
    check((await C.page.locator('.chip', { hasText: 'Ad playing' }).count()) === 1, 'viewer is told sync is on hold');
    check((await C.page.evaluate(() => getComputedStyle(document.querySelector('.gest')).pointerEvents)) === 'none', 'our touch layer steps aside so the skip button works');
    await ytCall(C, '__setVid', 'aqz-KE-bpKQ');
    await sleep(2500);
    check(!(await C.page.evaluate(() => document.querySelector('.player').classList.contains('ad'))), 'ad state clears');
    const ps2 = (await Promise.all([A, C].map(ytInfo))).map((i) => i.pos);
    check(Math.abs(ps2[0] - ps2[1]) < 1.6, 'after the ad the viewer is back in sync', ps2.map((p) => p.toFixed(2)).join(' / '));

    // owner back to own file
    await A.page.locator('button[aria-label="Load a video from this device"]').waitFor();
    await loadVideo(A, S + '/movie.webm');
    for (const c of [A]) await c.page.waitForSelector('video', { timeout: 5000 });
    check(await A.page.locator('.player.yt').count() === 0, 'owner returned to their local file');
    check(await until(async () => (await B.page.locator('.drop').count()) === 1, 4000), 'people without a file see the drop zone');
    await A.ctx.close(); await B.ctx.close(); await C.ctx.close();
  });

  // ------------------------------------------------------------------ 4. fullscreen fills the screen; YouTube-native mode doesn't overlap; YouTube captions
  if (only(4)) await step('4. fullscreen fills the screen, native YouTube controls never overlap ours, YouTube captions', async () => {
    const A = await mk(browser, 'Alice', { width: 1280, height: 800 });
    const code = await create(A);
    await loadVideo(A);
    await ready(A);
    const fsFill = async (label) => {
      await A.page.locator('.player').hover({ position: { x: 30, y: 30 } });
      await A.page.locator('button[aria-label=Fullscreen]').click();
      await sleep(600);
      const r = await A.page.evaluate(() => { const p = document.querySelector('.player').getBoundingClientRect(); return { w: p.width, h: p.height, iw: innerWidth, ih: innerHeight, fs: !!document.fullscreenElement }; });
      check(r.fs && Math.abs(r.w - r.iw) < 2 && Math.abs(r.h - r.ih) < 2, `${label}: fullscreen player fills the whole screen`, JSON.stringify(r));
      await A.page.keyboard.press('f');
      await sleep(500);
    };
    await fsFill('file');
    // YouTube
    await A.page.locator('button[aria-label="Watch from YouTube"]').click();
    await A.page.fill('#ytlink', 'https://youtu.be/dQw4w9WgXcQ');
    await A.page.locator('.dock button[type=submit]').click();
    await A.page.waitForSelector('.player.yt');
    await until(async () => (await ytInfo(A)) !== null, 4000);
    await A.page.getByRole('button', { name: /ready/i }).click();
    await sleep(400);
    await fsFill('youtube');
    // captions from our own controls
    await A.page.locator('.player').hover({ position: { x: 30, y: 30 } });
    await A.page.locator('button[aria-label=Captions]').click();
    await sleep(1100);
    let cc = await ytCall(A, '__cc');
    check(cc.on && cc.track === 'en', 'CC button turns YouTube captions on (English)', JSON.stringify(cc));
    await A.page.locator('button[aria-label=Settings]').click();
    await A.page.locator('select[aria-label="Caption language"]').focus();
    await sleep(1200); // the player re-renders several times a second; focus must stay on the dropdown
    check(await A.page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Caption language'), 'caption language dropdown keeps focus while the video plays');
    await A.page.selectOption('select[aria-label="Caption language"]', 'hi');
    await sleep(1100);
    cc = await ytCall(A, '__cc');
    check(cc.track === 'hi', 'language can be changed in settings', JSON.stringify(cc));
    await A.page.keyboard.press('Escape'); await sleep(300);
    await A.page.locator('button[aria-label=Captions]').click();
    await sleep(300);
    check(!(await ytCall(A, '__cc')).on, 'CC button turns them off again');
    // native controls mode: our strip sits below the video, no overlap
    await A.page.locator('button[aria-label=Settings]').click();
    await A.page.locator('.srow', { hasText: 'Use YouTube’s own controls' }).locator('.switch').click();
    await A.page.keyboard.press('Escape'); await sleep(900);
    const ov = await A.page.evaluate(() => {
      const y = document.querySelector('.yt-wrap').getBoundingClientRect(), n = document.querySelector('.nativebar').getBoundingClientRect();
      return { yb: y.bottom, nt: n.top, extra: document.querySelectorAll('.controls, .cluster, .topbar').length };
    });
    check(ov.yb <= ov.nt + 1 && ov.extra === 0, 'native mode: our bar is below the YouTube video and our overlays are gone', JSON.stringify(ov));
    await A.page.locator('.nativebar button[aria-label=Settings]').click();
    check((await A.page.locator('.dock').count()) === 1, 'settings still reachable in native mode');
    await A.ctx.close();
  });
} finally {
  await stopAll();
  await browser.close();
}
check(errors.length === 0, 'no page errors / console errors', errors.slice(0, 3).join(' | '));
process.exit(summary() ? 0 : 1);
