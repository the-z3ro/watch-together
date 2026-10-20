# Watch Together

Watch the same local video with a friend, in sync, from anywhere.
Everyone plays **their own copy** of the file — nothing is streamed or uploaded. The server only relays tiny
messages (play / pause / seek + the current time), so it works on weak networks and you keep full quality.
Stay on a WhatsApp / Meet call for voices.

```
watch-together/
├── web/      React + Vite client  → deploy on Vercel
├── server/   Node + Socket.IO (TypeScript) → deploy on Render (free)
├── e2e/      Playwright multi-browser test scripts
└── render.yaml
```

**Why two hosts?** Vercel runs serverless functions, which can't keep a WebSocket open. So the web app lives on
Vercel and the tiny sync server lives on Render's free tier.

---

## Run it locally (2 minutes)

```bash
# terminal 1
cd server && npm install && npm run dev      # http://localhost:3001

# terminal 2
cd web && npm install && npm run dev         # http://localhost:5173
```

Open `http://localhost:5173` in two browser windows (or one normal + one incognito), create a room in one,
join with the code in the other, load the same file in both, tap **I'm ready**, press play.

Test from your phone on the same Wi-Fi: open `http://<your-laptop-ip>:5173` (the dev server prints it).
The client automatically talks to `<same-host>:3001` in dev.

Checks (all optional, nothing extra to install for the app itself):

```bash
cd server && npm run typecheck && npm test     # 36 tests: permissions, versions, 2+ real socket clients
cd web    && npm test && npm run build         # 32 tests (sync engine, captions, version judge) + typecheck + bundle
```
Real-browser end-to-end scripts are in `e2e/` (they need `npm i playwright-core` and a Chromium; see the header of `e2e/lib.mjs`).
The server is TypeScript but runs through `tsx`, so the Render **Build** (`npm install`) and **Start** (`npm start`) commands are unchanged.

---

## Deploy

### 0. Put the code on GitHub
```bash
cd watch-together
git init && git add . && git commit -m "watch together"
# create an empty repo on github.com, then:
git remote add origin https://github.com/<you>/watch-together.git
git branch -M main && git push -u origin main
```

### 1. Sync server → Render (free)
1. [render.com](https://render.com) → **New → Web Service** → pick your repo.
   *(or **New → Blueprint** and it reads `render.yaml` for you — then skip the settings below)*
2. Settings:
   - **Root Directory:** `server`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Free
   - **Health Check Path:** `/health`
3. Deploy. Copy the URL, e.g. `https://watch-together-server.onrender.com`.
4. Check it: opening `<url>/health` should print `ok`.

### 2. Web app → Vercel
1. [vercel.com](https://vercel.com) → **Add New → Project** → import the same repo.
2. Settings:
   - **Root Directory:** `web`  ← important
   - **Framework Preset:** Vite (auto-detected)
   - **Environment Variable:** `VITE_SERVER_URL` = your Render URL (no trailing slash)
3. Deploy. Open the Vercel URL — that's your app. Send the link to your friend.

> Changed `VITE_SERVER_URL` later? Vercel bakes it in at build time, so **redeploy** after changing it.

### 3. (Optional) lock the server to your site
In Render → Environment, set `ALLOWED_ORIGIN` to your Vercel URL (e.g. `https://watch-together.vercel.app`).
Several origins can be comma-separated. Left as `*`, any website can connect to your server — fine for a
private project, but locking it is one line.

### No GitHub? Deploy the web app with the Vercel CLI
```bash
cd web && npx vercel            # first time: follow the prompts
npx vercel env add VITE_SERVER_URL production
npx vercel --prod
```
(Render needs a Git repo, though.)

---

## Using it

1. **Create a room** → share the 6-character code or the **invite link**.
2. Everyone **drops their video onto the page** (or taps to browse). The list shows each person's file, length and a
   *Same video* / *Same length* / *Different video* badge. Tap **I'm ready** (this unlocks autoplay on phones/tablets).
3. Press play. Everyone starts on the same server instant (scheduled ~0.6 s ahead).

### Roles
| | Owner | Controller | Participant |
|---|---|---|---|
| Play / pause / seek / speed (shared) | ✓ | ✓ (while *Controller power* is on) | – |
| Import / replace / remove shared captions | ✓ | ✓ (same condition) | – |
| **Sync me** (Hard Sync, only your player) | ✓ | ✓ | ✓ |
| **Sync everyone** (owner's Hard Sync) | ✓ | only if the owner enables *Controllers can sync everyone* | – |
| Load a YouTube video / switch back to files | ✓ | only if the owner switched *YouTube* on for them | only if allowed |
| Appoint / revoke controllers, grant YouTube, power toggle, transfer ownership, close room | ✓ | – | – |

Roles are shown next to each name. Everything is enforced on the server; a revoked controller's late commands are rejected.
If the owner disconnects for 30 s, a controller (else the longest-present member) becomes owner.

### Phones, tablets and any screen
The layout is chosen from the real window size: **wide** (laptop: room panel beside the player), **stack** (phone/tablet portrait: player pinned on top,
People / Media / Room tabs below) and **landscape** (phone sideways: the player fills the screen, the room is a drawer behind the people button).
The control bar measures its own width and only shows the buttons that fit; everything else lives in the ⚙ settings sheet, so nothing is ever cut off.

Touch gestures (on touch devices): tap = show/hide controls · double-tap right/left = ±10 s (keep tapping for ±20, ±30…) · double-tap middle = play/pause ·
swipe up/down on the right half = volume (just you) · swipe sideways = scrub (owner/controllers) · pinch = zoom (local files).
Also: lock controls, screen stays awake while playing, fullscreen turns the phone sideways, Android Back closes sheets, lock-screen/notification play-pause (local files),
add-to-home-screen app icon. Left-side brightness swipe and hold-for-2× are deliberately **not** included.

### YouTube links
Paste any YouTube link (watch, youtu.be, shorts, with `?t=` start time). Each person's browser plays its own embedded copy through YouTube's official player;
only the timeline is shared, exactly like local files. Permission: **only the owner can load YouTube by default**; the owner flips the *YouTube* switch
next to a person's name to let them load (independent of the Controller role; it can be revoked any time). Controllers can play/pause/seek but not load unless allowed.
Limits: YouTube only offers fixed speeds, so sync uses small jumps (about 0.75 s tolerance) instead of gentle speed nudging; ads play per viewer and
sync pauses until they end; live streams and videos that forbid embedding show a clear message; shared captions are not used (turn on YouTube's own controls in ⚙ for its captions).

### Hard Sync (two different things)
- **Sync me to the room** — your player jumps to where the room is. Nobody else is touched. Everyone has it; works in fullscreen; shortcut `\`.
- **Sync everyone to me** (owner, with confirmation) — every connected player with a playable video jumps to the owner's position; the owner's player does not move. Players that are still buffering are synced as soon as they can play.

### Captions
Owner/controllers import a `.srt` or `.vtt`. It is parsed and validated in the browser, sent **once** to the server (≤ 1.5 MB, ≤ 20 000 cues),
relayed to everyone and shown by each browser's own player, so timing follows each person's local timeline. Everyone can toggle captions for themselves (`C`).
Late joiners and reconnecting clients receive the current track. Captions are only held in server memory while the room exists; nothing is written to disk. Video is never uploaded.

### Keyboard (press `?` in the app)
`K`/`Space` play-pause · `H`/`L` ∓5 s · `J`/`;` ∓15 s · `[`/`]` ∓60 s · `0`/`$` start/end · `\` Hard Sync (me) · `|` sync menu ·
`F` fullscreen · `C` captions · `M` mute · `+`/`-`/`↑`/`↓` volume · `P` picture-in-picture. Ignored while typing; they work in fullscreen.
Shared actions only take effect for the owner/controllers (others get a short explanation).

### How the sync works
- The server owns the playback state `{playing, position, at, rate}` with a per-room `rev`, a playback version and an `epoch`
  (changes if the server restarts). Clients ignore stale or duplicate snapshots. Commands carry unique ids (idempotent, one retry) and are rate-limited.
- Each client estimates its clock offset from ping/pong (lowest RTT) and refreshes it every 30 s.
- Drift correction is two-sided and smooth: when behind you run slightly faster, when ahead slightly slower (max ±5 %, small steps, never affects the owner's shared speed);
  tiny drift is ignored; large drift (≥ 1 s) causes one hard seek with a cooldown and back-off. No correction is made while a player is buffering/seeking/stalled.
- Thresholds live in `DEFAULT_SYNC` in `web/src/engine.ts`.

---

## Good to know

- **Won't play / no picture?** Browsers can't decode everything (MKV, AVI, HEVC are common culprits).
  Convert once: `ffmpeg -i input.mkv -c:v libx264 -c:a aac -movflags +faststart output.mp4`
- **First visit is slow?** Render's free tier sleeps after 15 min of no traffic (up to ~1 min to wake). The app wakes it on page open and keeps it awake while people are connected.
- **Rooms live in server memory.** After a server restart the room code, owner, position, play state, speed and captions come back as clients reconnect,
  but **controller appointments and the member list are not restored** (the owner must re-appoint). Empty rooms are deleted after 10 minutes. Max 12 people.
- **No accounts.** Anyone with the room code can join as a participant.
- **iPhone:** fullscreen uses the native player (own controls, no Hard Sync button). iPad, Android and desktop keep the synced controls.
- **Asymmetric networks** (very different upload/download latency) bias clock-offset estimates; Hard Sync is the escape hatch.

---

## Protocol (for a React Native client)

Plain Socket.IO. Types are in `server/src/protocol.ts` (copied unchanged to `web/src/protocol.ts`).

| Client → server | Notes |
|---|---|
| `room:create`, `room:join`, `room:leave` | join/rejoin with the same `clientId` |
| `member:update` | name, file info, ready, mediaIssue |
| `cmd` `{id, cmd}` → ack | `play`, `pause`, `seek`, `rate`, `hardSyncAll`, `captions:set`, `captions:clear`, `role:set`, `settings`, `owner:transfer`, `room:close`, `media:youtube`, `media:file`, `member:grant` |
| `ping:time`, `state:get`, `captions:get` | clock offset, resync, caption recovery |

Server → client: `room:state` (full snapshot with `epoch`/`rev`), `captions:data`, `room:closed`. The sync maths is pure and lives in
`web/src/engine.ts`; port it with the player glue in `web/src/Player.tsx` to `expo-video` / `react-native-video`.
