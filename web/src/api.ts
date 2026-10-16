import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from './protocol.js';

export type Sock = Socket<ServerToClientEvents, ClientToServerEvents>;

// In production set VITE_SERVER_URL on Vercel. In dev we assume the server runs next to the page (works from a phone on LAN too).
export const SERVER: string =
  (import.meta.env.VITE_SERVER_URL as string | undefined) || (import.meta.env.DEV ? `${location.protocol}//${location.hostname}:3001` : '');

/** Random id that also works on plain-http LAN origins where crypto.randomUUID is unavailable. */
export function uid(): string {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* insecure context */
  }
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function getStored(key: string): string | null {
  try {
    return localStorage.getItem('wt:' + key);
  } catch {
    return null;
  }
}
export function setStored(key: string, value: string): void {
  try {
    localStorage.setItem('wt:' + key, value);
  } catch {
    /* private mode etc. */
  }
}

export function getClientId(): string {
  let id = getStored('clientId');
  if (!id) {
    id = uid();
    setStored('clientId', id);
  }
  return id;
}

/** Free hosting sleeps when idle; poke the server as soon as the page opens so it is awake when needed. */
export function wake(): void {
  if (SERVER) fetch(SERVER + '/health', { mode: 'no-cors' }).catch(() => {});
}

export function createRoom(name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!SERVER) return reject(new Error('noserver'));
    const s: Sock = io(SERVER, { timeout: 20_000 });
    const kill = setTimeout(() => (s.close(), reject(new Error('timeout'))), 90_000);
    s.on('connect', () =>
      s.emit('room:create', { clientId: getClientId(), name }, (r) => {
        clearTimeout(kill);
        s.close();
        r.ok ? resolve(r.roomId) : reject(new Error(r.error));
      }),
    );
  });
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard API needs https; fall back for plain-http LAN testing
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      /* ignore */
    }
    ta.remove();
    return ok;
  }
}
