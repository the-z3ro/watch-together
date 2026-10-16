import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { fileURLToPath } from 'node:url';
// Run from the e2e/ folder: npm i playwright-core, then `node run1.mjs` / `node run2.mjs`.
// Set CHROMIUM=/path/to/chromium if it is not at /opt/pw-browsers/chromium.
export const S = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(S, '..');
export const SERVER_PORT = 3101;
export const WEB_PORT = 5174;
export const URL = `http://localhost:${WEB_PORT}/`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- tiny assertion log ----------
export const results = [];
export function check(cond, msg, detail = '') {
  results.push({ ok: !!cond, msg });
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${msg}${detail ? '  — ' + detail : ''}`);
  return !!cond;
}
export async function step(name, fn) {
  console.log('\n▶ ' + name);
  try {
    await fn();
  } catch (e) {
    check(false, `${name} threw`, String(e?.message ?? e).split('\n')[0]);
  }
}
export function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  failed.forEach((f) => console.log('  FAILED: ' + f.msg));
  return failed.length === 0;
}

// ---------- processes ----------
const procs = {};
function start(name, cmd, args, cwd, env) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`[${name}] ${d}`));
  p.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write(`[${name}!] ${d}`));
  procs[name] = p;
  return p;
}
async function waitHttp(url, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error('timeout waiting for ' + url);
}
export async function startServer(extraEnv = {}) {
  start('server', 'node', ['--import', 'tsx', 'src/index.ts'], path.join(ROOT, 'server'), { PORT: String(SERVER_PORT), ...extraEnv });
  await waitHttp(`http://localhost:${SERVER_PORT}/health`);
}
export async function stopServer(signal = 'SIGKILL') {
  const p = procs.server;
  if (!p) return;
  await new Promise((res) => (p.once('exit', res), p.kill(signal)));
  delete procs.server;
}
export async function startWeb() {
  start('web', 'node', ['node_modules/vite/bin/vite.js', '--port', String(WEB_PORT), '--strictPort'], path.join(ROOT, 'web'), { VITE_SERVER_URL: `http://localhost:${SERVER_PORT}` });
  await waitHttp(URL);
}
export async function stopAll() {
  for (const p of Object.values(procs)) p.kill('SIGKILL');
}

// ---------- browser clients ----------
export async function launch() {
  return chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--autoplay-policy=document-user-activation-required'] });
}

export const errors = [];
export async function newClient(browser, name, viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: false });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource|WebSocket|websocket/.test(m.text())) errors.push(`${name} console: ${m.text()}`);
  });
  const c = { name, ctx, page };
  c.pos = () => page.evaluate(() => document.querySelector('video')?.currentTime ?? null);
  c.playing = () => page.evaluate(() => { const v = document.querySelector('video'); return !!v && !v.paused; });
  c.rate = () => page.evaluate(() => document.querySelector('video')?.playbackRate ?? null);
  c.toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent));
  c.hover = () => page.locator('.player').hover({ position: { x: 200, y: 100 } });
  c.press = (k) => page.keyboard.press(k);
  c.chip = () => page.evaluate(() => [...document.querySelectorAll('.chip')].map((t) => t.textContent).join(' | '));
  c.capInfo = () =>
    page.evaluate(() => {
      const v = document.querySelector('video');
      const tt = v ? [...v.textTracks] : [];
      const t = tt[0];
      const tcount = tt.length;
      return { tracks: tcount, mode: t?.mode ?? null, cues: t?.cues?.length ?? 0, active: t?.activeCues ? [...t.activeCues].map((c) => c.text) : [], first: t?.cues?.[0]?.text ?? null };
    });
  return c;
}

export async function create(c) {
  await c.page.goto(URL);
  await c.page.fill('#name', c.name);
  await c.page.click('text=Create a room');
  await c.page.waitForSelector('.code', { timeout: 30000 });
  return (await c.page.textContent('.code')).trim();
}
export async function join(c, code) {
  await c.page.goto(URL + '?r=' + code);
  await c.page.fill('#name', c.name);
  await c.page.click('text=Join room');
  await c.page.waitForSelector('.code', { timeout: 30000 });
}
export async function loadVideo(c, file = S + '/movie.webm') {
  await c.page.setInputFiles('input[accept^="video"]', file);
  await c.page.waitForFunction(() => (document.querySelector('video')?.duration ?? 0) > 1);
}
export async function ready(c) {
  await c.page.getByRole('button', { name: /ready/i }).click();
  await c.page.waitForFunction(() => !document.querySelector('.overlay button.big'), null, { timeout: 5000 });
}

/** Positions of several clients sampled at (nearly) the same moment. */
export async function sample(clients) {
  return Promise.all(clients.map((c) => c.pos()));
}
export const spread = (xs) => Math.max(...xs) - Math.min(...xs);
export async function until(fn, ms = 8000, every = 100) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() - t0 > ms) return false;
    await sleep(every);
  }
}
