# Update v3 — test it, then redeploy (one step at a time)

## A. Test it on your own computer
1. Unzip the new zip. Open a terminal in the folder.
2. Terminal 1:  `cd server && npm install && npm run dev`
3. Terminal 2:  `cd web && npm install && npm run dev`  → open the address it prints (http://localhost:5173).
4. Create a room, drop a video, tap **I'm ready**, press play.
5. See it as a phone: press F12 → click the phone icon (device toolbar) → pick "iPhone 14" or "Pixel 7" → reload. Try rotating it. Gestures work with the mouse in this mode.
6. Second person: open an **incognito window** and join with the room code.
7. YouTube: click the YouTube icon in the top bar → paste a link → Load. In the second window tap **I'm ready**, then play.
   - In the owner window flip the **YouTube** switch next to the friend's name; they can now load links too.
8. Test on your real phone (same Wi‑Fi): open `http://<your computer's IP>:5173`.

## B. Redeploy
1. Put the new files in your repo folder (copy over the old ones, keep your `.git` folder), then:
   `git add . && git commit -m "responsive + YouTube" && git push`
2. **Vercel** redeploys by itself after the push (1–2 minutes). No settings change.
3. **Azure server** (SSH in), then one line at a time:
   `cd ~/watch-together && git pull`
   `cd server && npm install`
   `pm2 restart watch-together`
   `curl https://sync.eshanstudio.com/health`  → should say ok.
4. On your phone/PC do a hard refresh (or close and reopen the tab) so the new version loads.
5. Important: web and server must both be updated — the old server doesn't know YouTube.
