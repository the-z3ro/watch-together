import { S, check, step, summary, sleep, startServer, startWeb, stopAll, stopServer, launch, newClient, create, join, loadVideo, ready, sample, spread, until, errors } from './lib.mjs';

const browser = await launch();
let code = '';
try {
  await startServer();
  await startWeb();
  const A = await newClient(browser, 'Alice');
  const B = await newClient(browser, 'Bob');
  const C = await newClient(browser, 'Cara', { width: 390, height: 780 });
  const D = await newClient(browser, 'Dan');
  for (const c of [A, B, C, D]) c.page.on('dialog', (d) => d.accept());
  const net = { blocked: false, sockets: [] };
  await C.ctx.route('**/socket.io/**', (r) => (net.blocked ? r.abort() : r.continue()));
  await C.page.routeWebSocket(/socket\.io/, (ws) => {
    if (net.blocked) { ws.close(); return; }
    ws.connectToServer();
    net.sockets.push(ws);
  });
  // Dan's browser clock runs 7 s fast
  await D.page.addInitScript(() => { const o = Date.now; Date.now = () => o() + 7000; });

  await step('setup', async () => {
    code = await create(A);
    for (const c of [B, C, D]) await join(c, code);
    for (const c of [A, B, C, D]) await loadVideo(c);
    await sleep(600);
    for (const c of [A, B, C, D]) await ready(c);
    await A.page.locator('.members li', { hasText: 'Bob' }).locator('.switch').click();
    await A.hover(); await A.press('k');
    await sleep(2500);
    const p = await sample([A, B, C, D]);
    check(Math.abs(p[3] - p[0]) < 0.5 && spread(p) < 0.5, 'all four playing together (Dan’s clock is 7 s fast)', p.map((x) => x.toFixed(2)).join(' / '));
  });

  await step('reconnection: offline viewer catches up on missed pause + seek', async () => {
    net.blocked = true; net.sockets.forEach((w) => w.close()); net.sockets.length = 0;
    await sleep(500);
    check(await until(async () => /Reconnecting/.test(await C.page.textContent('body')), 15000), 'offline viewer shows Reconnecting');
    await A.press('k');
    await sleep(500);
    await A.press(';'); // +15 s
    await sleep(1000);
    net.blocked = false;
    check(await until(async () => !(await C.page.textContent('body')).includes('Reconnecting') && Math.abs((await C.pos()) - (await A.pos())) < 0.5 && !(await C.playing()), 25000), 'viewer recovers: paused at the owner’s new position', `C ${(await C.pos()).toFixed(1)} vs A ${(await A.pos()).toFixed(1)} playing=${await C.playing()}`);
    check((await C.page.locator('.members li').count()) === 4, 'no duplicate member after reconnect');
    await A.press('k');
    await sleep(2500);
    check((await C.playing()) && spread(await sample([A, B, C, D])) < 0.6, 'playing in sync again after reconnect');
  });

  await step('page reload keeps identity and role', async () => {
    await B.page.reload();
    await B.page.waitForSelector('.code');
    check(await until(async () => (await B.page.locator('.members li').count()) === 4, 8000), 'still 4 members');
    check((await B.page.textContent('.bar-right .role')).includes('Controller'), 'Bob is still a controller after reload');
    await loadVideo(B);
    await ready(B);
    check(await until(async () => (await B.playing()) && Math.abs((await B.pos()) - (await A.pos())) < 0.6, 8000), 'reloaded client rejoins playback');
  });

  await step('revocation takes effect immediately', async () => {
    await A.page.locator('.members li', { hasText: 'Bob' }).locator('.switch').click();
    check(await until(async () => /Viewer/.test(await B.page.textContent('.bar-right .role')), 4000), 'Bob becomes a viewer');
    const before = await A.pos();
    await B.hover(); await B.press('k'); await B.press('l');
    await sleep(900);
    check((await A.playing()) && Math.abs((await A.pos()) - before - 0.9) < 0.6, 'revoked controller cannot pause or seek anyone');
    check(await B.page.isDisabled('button[aria-label=Pause]'), 'and the UI buttons are disabled');
  });

  await step('transfer ownership', async () => {
    await A.page.locator('.members li', { hasText: 'Cara' }).getByText('make owner').click();
    check(await until(async () => /Owner/.test(await C.page.textContent('.bar-right .role')), 5000), 'Cara is now the owner');
    check(await until(async () => /Controller/.test(await A.page.textContent('.bar-right .role')), 3000), 'Alice became a controller');
    check((await A.page.locator('.setting').count()) === 0, 'ex-owner no longer sees room controls (power / appoint / close)');
    check((await A.page.locator('.members .switch').count()) === 0, 'controller cannot appoint or revoke anyone');
    await A.hover();
    await A.page.click('button[aria-label="Hard Sync"]');
    check((await A.page.locator('.pitem', { hasText: 'Sync everyone' }).count()) === 0, 'ex-owner is not offered "Sync everyone"');
    await A.press('Escape');
    await A.press('k');
    check(await until(async () => !(await B.playing()), 3000), 'but as a controller she can still pause the room');
    await A.press('k');
    await sleep(2500);
  });

  await step('owner disconnect: controller-first promotion after the grace period', async () => {
    await C.page.locator('.members li', { hasText: 'Dan' }).locator('.switch').click();
    await sleep(500);
    await C.ctx.close();
    check(await until(async () => /Owner/.test(await A.page.textContent('.bar-right .role')) || /Owner/.test(await D.page.textContent('.bar-right .role')), 50000, 500), 'after ~30 s a controller is promoted to owner');
    const rb = await B.page.textContent('.bar-right .role');
    check(/Viewer/.test(rb), 'the plain viewer (Bob) was not promoted over controllers', rb);
    const owners = (await Promise.all([A, D, B].map(async (c) => /Owner/.test(await c.page.textContent('.bar-right .role'))))).filter(Boolean).length;
    check(owners === 1, 'exactly one owner', String(owners));
  });

  await step('server restart: clients reconnect, room + position + owner restored', async () => {
    const O = /Owner/.test(await A.page.textContent('.bar-right .role')) ? A : D;
    const others = [A, B, D].filter((c) => c !== O);
    await O.hover();
    if (!(await O.playing())) { await O.press('k'); }
    await sleep(2500);
    const posBefore = await O.pos();
    await stopServer('SIGKILL');
    await sleep(1500);
    check(/Reconnecting/.test(await O.page.textContent('body')), 'clients show Reconnecting while the server is down');
    await startServer();
    check(await until(async () => !(await O.page.textContent('body')).includes('Reconnecting'), 40000, 500), 'clients reconnect by themselves');
    await sleep(2500);
    const roleD = await O.page.textContent('.bar-right .role');
    const pos = await sample([O, ...others]);
    check(/Owner/.test(roleD), 'owner role restored', roleD);
    check(spread(pos) < 0.6 && pos[0] > posBefore, 'playback continues in sync after restart', pos.map((x) => x.toFixed(1)).join(' / ') + ` (before ${posBefore.toFixed(1)})`);
    await sleep(1500);
    const names = await O.page.locator('.members li').evaluateAll((e) => e.map((x) => x.textContent.slice(0, 30)));
    check(names.length >= 3, 'members re-listed', JSON.stringify(names));
    await O.hover(); await O.press('k');
    await sleep(1200);
    check(!(await others[0].playing()) && !(await others[1].playing()), 'owner can still pause everyone after the restart');
  });

  check(errors.length === 0, 'no uncaught page errors', errors.slice(0, 3).join(' | '));
} finally {
  const ok = summary();
  await browser.close();
  await stopAll();
  process.exit(ok ? 0 : 1);
}
