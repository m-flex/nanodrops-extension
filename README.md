# Nanodrops browser extension

Earn nano for watching Twitch and Kick **on the platform** itself, no embed.
The extension watches the real tab's `<video>` element and reports playback
evidence to the Nanodrops server. It does **not** embed, restream, proxy, or
touch platform playback endpoints. It reads the same `<video>` you are already
watching, and reads the site's own login token from `nanodrops.org`
localStorage (first-party), so you earn as your own account without signing in
twice.

This is the full, unmodified source of what ships to the stores. No build
step, no bundler, no minification: the JS in this repo is byte for byte the JS
that runs in your browser.

## What's in the box

| Piece | Role |
|---|---|
| `content-stream.js` | On `twitch.tv/*` + `kick.com/*`: reports the player's playback state every 1s. |
| `hud.js` | On-stream overlay (Shadow DOM): earning state + why-not reason, rate, next-drop countdown, verify/sign-in links. Collapses to a pill. |
| `content-bridge.js` | On `nanodrops.org/*`: lifts the site's own `nd_token` (JWT) to the background worker. |
| `background.js` | Session state machine: per-tab state, channel-to-faucet resolve, heartbeats, rolling PoW, human-check pause/resume, badge. |
| `pow.js` | sha256 hashcash solver (liveness proof, not mining). |
| `popup.*` | Toolbar status + verify / sign-in deep links. |

## What it reads, and what it sends

On a stream page it reads the video player's own state: playing, muted,
visible. That is what tells the server you are really watching instead of
parking a muted tab in the background. On nanodrops.org it reads the login
token the site already saved for you. It sends heartbeats to the Nanodrops
server, which validates the playback evidence before crediting anything;
this signal is one anti-abuse layer of several on the server side. It does
not read browsing history, page content, keystrokes, other tabs, or anything
on any other site. Payouts are public by design on the nano ledger and in
the transparency feed at https://nanodrops.org.

## Why there's a proof-of-work

`pow.js` is a plain sha256 hashcash solver, the same idea as a proof-of-work
CAPTCHA. The server hands out a nonce and a difficulty, the extension finds a
matching hash, the server checks it. It exists to make it expensive for bots
to drain rewards meant for real viewers. It does not mine cryptocurrency and
produces no coin, for anyone. Cost is a few milliseconds of CPU roughly every
25 seconds, only while actively watching a funded stream.

## One package, both engines

A single `manifest.json` ships to Chrome/Edge **and** Firefox:

- **`background` declares both** `service_worker` (Chrome) and `scripts` +
  `"type": "module"` (Firefox). Each engine uses its own key and ignores the
  other's; the `BACKGROUND_SERVICE_WORKER_IGNORED` warning from `web-ext lint`
  is expected.
- **`background.js` picks the promise namespace**
  (`globalThis.browser ?? globalThis.chrome`): Firefox's `chrome.*` alias is
  callback-only, so every `await chrome.*` there would silently resolve to
  `undefined`.
- **`browser_specific_settings.gecko`** supplies the AMO add-on id, the min
  version (140, the floor for `data_collection_permissions`), and the
  data-collection declaration.

## Load it (Chrome/Edge, unpacked)

1. `chrome://extensions` -> Developer mode -> **Load unpacked** -> this folder.
2. Sign in at https://nanodrops.org; the bridge picks the token up within ~2s.
   Popup shows **signed in**.
3. Open a live `twitch.tv/<channel>` or `kick.com/<channel>`, playing and
   unmuted. The HUD (bottom-right) shows **earning** with rate + countdown;
   the toolbar badge shows `$`.
4. Human check due -> badge `!`, HUD/notification offer a verify link;
   verifying resumes earning automatically.

## Load it (Firefox, temporary)

1. `about:debugging#/runtime/this-firefox` -> **Load Temporary Add-on** ->
   pick `manifest.json`. (Or `npx web-ext run`, which auto-reloads on save.)
2. Steps 2-4 above are identical. Background console lives at
   `about:debugging` -> **Inspect**.
3. If nothing earns and the console is quiet, check `about:addons` ->
   Nanodrops -> **Permissions**: host access must be on.

Temporary add-ons vanish on restart; a durable Firefox install needs a signed
XPI.
