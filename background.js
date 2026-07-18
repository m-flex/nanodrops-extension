// Nanodrops extension background service worker.
//
// Speaks the SAME earning protocol as the web watch page (app/web/app/watch),
// but the "is the stream playing / unmuted" signal comes from the real Twitch/
// Kick tab's <video> element instead of an embed. The server treats these as
// source:'extension' sessions (src/api/handlers.ts startSession).
//
// Everything is driven by the ~1s state pings from content-stream.js: those
// pings are the clock AND what keeps this ephemeral MV3 worker alive while
// earning. A chrome.alarms backstop pauses earning if the pings stop.

import { solveChallenge } from './pow.js';

// Firefox's `chrome.*` alias is callback-only — every `await chrome.…` below
// would resolve to undefined. `browser.*` is the promise-returning namespace, so
// prefer it where it exists (Firefox) and fall back to `chrome` (Chrome/Edge).
// Module scope, so this shadows the global for the whole file.
const chrome = globalThis.browser ?? globalThis.chrome;

const API_BASE = 'https://nanodrops.imminence.uk';
const SITE = 'https://nanodrops.org';
const SITE_ORIGINS = ['https://nanodrops.org', 'https://www.nanodrops.org'];

// Cadences fit the DEPLOYED prod windows, which come from devConfig in
// src/server.ts (NOT the "production-ish" defaultConfig): presence 12s,
// engagement 25s, proof window 90s. The heartbeat MUST stay well under 12s or
// the session keeps falling out of "present" and earning flaps off — the web
// watch page pings every ~3-6s for the same reason.
const CHAT_EVERY = 6_000; // heartbeat: refreshes presence(12s)+engagement(25s), carries evidence
const PROOF_EVERY = 25_000; // web uses 25s; window 90s spans ~3 cadences
const PROOF_RETRY = 5_000; // after a failed proof, retry soon so one miss can't flap
const STATUS_EVERY = 10_000; // poll countdown + needsHumanCheck (feeds the HUD)
const VERIFY_POLL = 2_500; // faster status poll while the verify window is open (snappy resume)
const STATS_EVERY = 6_000; // rate + funding pulse for the HUD (tiny payload; keeps lightning ~timely)
const ME_EVERY = 15_000; // /api/me refresh; feeds the HUD's "this stream" earned delta
const AUDIBLE_WINDOW = 60_000; // "recently made sound" grace so a quiet passage isn't "muted"
const RESUME_AFTER = 700;
const PAUSE_AFTER = 1_500;
const STALE_MS = 5_000; // no ping for this long => tab gone
const RESOLVE_BACKOFF = 60_000;
const START_BACKOFF = 15_000; // after a failed session start, wait before re-attempting (don't burn the rate limit)

let token = null;
let fp = null;
let loaded = false;

const faucetCache = new Map(); // 'platform/login' -> faucetId
const resolveFailUntil = new Map(); // 'platform/login' -> ts; throttles unresolvable channels

// Per-tab stream state, keyed by tabId. Multiple twitch/kick tabs each ping
// every second; keeping them separate (instead of last-write-wins) is what
// stops a playing tab and an idle tab from flapping earning on/off.
const tabStates = new Map(); // tabId -> {platform, channel, frameAdvancing, mediaTime, onScreen, videoMuted, visible, lastPingAt}

let cur = false; // currently earning?
let since = 0; // debounce timer for want!=cur
let startFailUntil = 0; // backoff after a failed startEarning (401/403/network)
let session = null; // { faucetId, platform, channel, tabId, challenge, lastChatAt, lastProofAt, startedAt, solving, status }
let evidence = { mediaTime: 0, frameAdvancing: false, audible: false, onScreen: false };
let lastReason = 'no stream open'; // why we're not earning (for the HUD)
let stats = null; // { hourlyRateXno, usdPerXno, minXno, at } — global rate cache
let me = null; // { earnedXno } lifetime, from /api/me
let lastMePoll = 0;
// Funding weather: diff the monotonic fundedTotal across stats polls (see
// /api/stats). A rise = a real deposit landed somewhere; big ones flash
// lightning. stormSeq increments per detected deposit so the HUD fires each once.
let prevFunded = null;
let stormSeq = 0;
let stormMag = 0;
let stormLightning = false;
let lastAudibleAt = 0; // last time the earning tab actually produced sound
// "this stream"/lifetime include reserved-but-unsent drops (/api/me `pending`),
// so the number rises the instant the countdown hits 0 — no wait for the on-chain
// send. We still briefly fast-poll /api/me right after a drop so it shows within
// a second or two rather than at the next 6s poll.
let fastMeUntil = 0;
let prevRemaining = null; // extrapolated countdown last tick, to catch the 0 crossing
// Human-check state lives OUTSIDE the session: the check pauses earning, which
// destroys the session — if the flag lived there it would be lost and earning
// would flap (restart, rediscover the check, pause, repeat). It is viewer-
// anchored server-side, so we keep polling while paused to notice the viewer
// verifying on the site, then resume.
let needsHumanCheck = false;
let lastFaucetId = null; // last session's faucet; status polls + verify link while paused
let lastStatusPoll = 0;
let verifyWindowId = null; // the open Turnstile popup window, if any
let ticking = false;

async function ensureLoaded() {
  if (loaded) return;
  const s = await chrome.storage.local.get(['nd_token', 'nd_fp']);
  token = s.nd_token || null;
  fp = s.nd_fp || crypto.randomUUID();
  if (!s.nd_fp) await chrome.storage.local.set({ nd_fp: fp });
  loaded = true;
}

async function api(path, body) {
  const res = await fetch(API_BASE + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    // A hung request would wedge tick() (the `ticking` guard) for minutes; fail
    // fast instead — every caller already handles a thrown fetch.
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 && token) {
    // The JWT expired (30d) or was revoked. Forget it so pausedReason flips to
    // "sign in on nanodrops.org" instead of retrying a dead token forever; the
    // bridge re-lifts a fresh one after the user signs in again.
    token = null;
    await chrome.storage.local.remove('nd_token').catch(() => {});
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json().catch(() => ({}));
}

async function resolveFaucet(platform, channel) {
  const key = `${platform}/${channel}`;
  if (faucetCache.has(key)) return faucetCache.get(key);
  // Don't hammer the API every tick on an offline/unknown channel.
  if (Date.now() < (resolveFailUntil.get(key) ?? 0)) throw new Error('resolve backoff');
  try {
    // Already in the directory? The public search needs no auth and no linked
    // platform identity, so a Twitch-linked viewer can still earn on a Kick
    // channel someone else already added (and vice versa).
    const found = await api(`/api/search?q=${encodeURIComponent(channel)}&platform=${platform}`).catch(() => null);
    const hit = found?.results?.find((r) => r.alreadyAdded && r.faucetId);
    if (hit) {
      faucetCache.set(key, hit.faucetId);
      return hit.faucetId;
    }
    // Not yet added: find-or-create — same call the website makes, and like the
    // website it requires a linked identity for THAT platform.
    const f = await api('/api/directory', { platform, login: channel });
    if (!f?.id) throw new Error('no faucet id');
    faucetCache.set(key, f.id);
    return f.id;
  } catch (e) {
    resolveFailUntil.set(key, Date.now() + RESOLVE_BACKOFF);
    throw e;
  }
}

/** Are we ACTUALLY earning right now? Client-side watching is necessary but not
 *  sufficient — the server only pays if this is the viewer's eligible primary
 *  stream AND a covering pot is funded (status.counting). Until the first status
 *  poll lands we don't know, so treat it as earning (optimistic ~1s). */
function earningNow() {
  if (!cur || needsHumanCheck) return false;
  const st = session?.status;
  return st ? st.counting === true : true;
}

async function setBadge() {
  const text = needsHumanCheck ? '!' : earningNow() ? '$' : '';
  const color = needsHumanCheck ? '#f5a623' : '#22c55e';
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    /* action API unavailable during teardown */
  }
}

async function startEarning(tab) {
  const faucetId = await resolveFaucet(tab.platform, tab.channel);
  const r = await api('/api/sessions/start', { faucetId, source: 'extension', fp });
  const now = Date.now();
  lastFaucetId = faucetId;
  session = {
    faucetId,
    platform: tab.platform,
    channel: tab.channel,
    tabId: tab.tabId,
    challenge: r?.challenge || null,
    // First evidence-bearing heartbeat ~2s in (not 30s) so lastPlaybackOkAt
    // lands well inside the server's new-session grace.
    lastChatAt: now - CHAT_EVERY + 2000,
    lastProofAt: 0, // first proof promptly (server grace covers it)
    startedAt: now,
    solving: false,
    status: null, // last /sessions/status payload + fetch time (HUD countdown)
    baseTotalXno: meTotal(), // credited+pending at start → "this stream" delta
  };
  lastStatusPoll = 0; // fetch status right away so "earning"/funded state is accurate fast
  void refreshMe(); // get a fresh baseline promptly if `me` was stale/absent
}

async function stopEarning() {
  const s = session;
  session = null;
  if (s) await api('/api/sessions/pause', { faucetId: s.faucetId }).catch(() => {});
}

async function doProof() {
  if (!session || session.solving) return;
  session.solving = true;
  try {
    let ch = session.challenge;
    if (!ch) {
      const seeded = await api('/api/sessions/proof', { faucetId: session.faucetId, seq: -1, solution: '' });
      ch = seeded?.challenge || null;
    }
    if (ch) {
      const sol = solveChallenge(ch.nonce, ch.bits);
      const res = await api('/api/sessions/proof', { faucetId: session.faucetId, seq: ch.seq, solution: sol });
      session.challenge = res?.challenge || null;
    }
    session.lastProofAt = Date.now();
  } catch {
    if (session) session.lastProofAt = Date.now() - (PROOF_EVERY - PROOF_RETRY); // retry soon
  } finally {
    if (session) session.solving = false;
  }
}

async function keepalive() {
  if (!session) return;
  try {
    // The heartbeat carries the hardened playback evidence; the server stamps
    // lastPlaybackOkAt only when it looks genuine (src/core/activity.ts).
    await api('/api/sessions/chat', { faucetId: session.faucetId, evidence });
    session.lastChatAt = Date.now();
  } catch (e) {
    // Session evaporated server-side (restart/expiry) — re-establish next tick.
    if (String(e).includes('404')) {
      session = null;
      cur = false;
    }
  }
}

/** Poll /sessions/status: countdown for the HUD + the viewer-anchored human
 *  check. Runs while earning AND while paused for a check (to notice the viewer
 *  verifying on the site and resume). */
async function pollStatus(faucetId) {
  lastStatusPoll = Date.now();
  try {
    const st = await api(`/api/sessions/status?faucetId=${encodeURIComponent(faucetId)}`);
    if (session?.faucetId === faucetId) session.status = { ...st, at: Date.now() };
    const need = !!st?.needsHumanCheck;
    if (need && !needsHumanCheck) notifyHumanCheck();
    // Check just cleared (viewer passed the popup) → close the verify window; the
    // session stayed alive throughout, so earning resumes on the next cycle.
    if (!need && needsHumanCheck) await closeVerify();
    needsHumanCheck = need;
  } catch {
    /* transient */
  }
}

/** Open the standalone Turnstile page in a small popup window over the stream.
 *  Focuses the existing one if already open. Falls back to a tab if the window
 *  API is unavailable. */
async function openVerify() {
  if (!lastFaucetId) return;
  const url = `${SITE}/verify?faucet=${encodeURIComponent(lastFaucetId)}`;
  if (verifyWindowId !== null) {
    try {
      await chrome.windows.update(verifyWindowId, { focused: true });
      return;
    } catch {
      verifyWindowId = null; // it was closed out from under us
    }
  }
  try {
    const win = await chrome.windows.create({ url, type: 'popup', focused: true, width: 460, height: 620 });
    verifyWindowId = win?.id ?? null;
  } catch {
    try {
      await chrome.tabs.create({ url });
    } catch {
      /* nothing we can do */
    }
  }
}

async function closeVerify() {
  if (verifyWindowId === null) return;
  const id = verifyWindowId;
  verifyWindowId = null;
  try {
    await chrome.windows.remove(id);
  } catch {
    /* already closed */
  }
}

async function refreshStats() {
  try {
    const s = await api('/api/stats');
    const minXno = Number(s?.fundingAnnounceMinXno ?? 0.05);
    stats = { hourlyRateXno: s?.hourlyRate?.xno ?? null, usdPerXno: s?.usdPerXno ?? null, minXno, at: Date.now() };
    detectFunding(Number(s?.fundedTotal?.xno), minXno);
  } catch {
    stats = { hourlyRateXno: null, usdPerXno: null, minXno: 0.05, at: Date.now() }; // don't refetch every ask
  }
}

/** Turn a rise in the monotonic funded total into a storm the HUD can render —
 *  same thresholds/curve as the site's StormWatcher. First sighting seeds
 *  silently (standing balances aren't news). */
function detectFunding(funded, minXno) {
  if (!Number.isFinite(funded)) return;
  if (prevFunded !== null) {
    const added = funded - prevFunded;
    if (added >= minXno) {
      const bigXno = Math.max(1, minXno * 20);
      stormMag = Math.min(1, Math.sqrt(added / bigXno)); // sqrt: a threshold deposit still stirs the rain
      stormLightning = added >= bigXno;
      stormSeq += 1; // HUD fires once per increment
    }
  }
  prevFunded = funded;
}

async function refreshMe() {
  lastMePoll = Date.now();
  try {
    const m = await api('/api/me');
    // Total = credited + reserved-but-unsent. Smooth: when a reserved drop settles,
    // pending falls by X and earned rises by X, so the total doesn't jump.
    me = { earnedXno: Number(m?.earned?.xno ?? 0), pendingXno: Number(m?.pending?.xno ?? 0) };
    // Baseline for "earned on this stream" = the total when this session began
    // (captures any pre-existing pending from a prior stream so it's excluded).
    if (session && session.baseTotalXno == null) session.baseTotalXno = me.earnedXno + me.pendingXno;
  } catch {
    /* keep the last value */
  }
}

/** Credited + reserved-but-unsent earnings (xno), or null if unknown. */
function meTotal() {
  return me ? me.earnedXno + me.pendingXno : null;
}

function notifyHumanCheck() {
  try {
    chrome.notifications?.create('nd-human-check', {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: 'Nanodrops: confirm you are watching',
      message: 'Verify to keep earning. Open the stream tab or click the Nanodrops icon.',
    });
  } catch {
    /* notifications optional */
  }
}

/** Browser-level audio state (Chrome-set, a page can't forge either field):
 *  - tabMuted: the tab is muted (tab mute or site mute)
 *  - audibleNow: the tab produced sound in the last ~2s
 *  The EARNING gate keys on "not muted" (intent to hear) — NOT on audibleNow,
 *  which drops to false during any genuinely quiet passage and would otherwise
 *  flap earning off every time the streamer stops talking. audibleNow feeds the
 *  server's anti-spoof evidence as a RECENCY signal instead (see the tick). */
async function tabAudio(tabId) {
  if (tabId < 0) return { tabMuted: true, audibleNow: false };
  try {
    const tab = await chrome.tabs.get(tabId);
    return { tabMuted: tab.mutedInfo?.muted === true, audibleNow: tab.audible === true };
  } catch {
    return { tabMuted: true, audibleNow: false }; // tab gone
  }
}

/** Pick the tab to earn from. Prefer fully-qualifying tabs (playing, on-screen,
 *  visible, not muted in-page); stick with the current earning tab on ties so
 *  two qualifying tabs can't seesaw; else the freshest tab with a channel (for
 *  HUD display even when nothing qualifies). */
function pickTab(now) {
  let best = null;
  let bestScore = -1;
  for (const [tabId, t] of tabStates) {
    if (now - t.lastPingAt >= STALE_MS) {
      tabStates.delete(tabId);
      continue;
    }
    if (!t.channel) continue;
    const qualifies = t.frameAdvancing && t.visible && t.onScreen && t.videoMuted !== true;
    const sticky = session && tabId === session.tabId;
    const score = (qualifies ? 4 : 0) + (sticky ? 2 : 0) + (t.visible ? 1 : 0);
    if (score > bestScore || (score === bestScore && t.lastPingAt > (best?.lastPingAt ?? 0))) {
      best = { ...t, tabId };
      bestScore = score;
    }
  }
  return best;
}

function pausedReason(tab, soundOn) {
  if (!token) return 'sign in on nanodrops.org to earn';
  if (!tab) return 'no stream open';
  if (!tab.channel) return 'not on a stream page';
  // A pending human check does NOT tear the session down: we keep it alive
  // (heartbeating) so the server-side check can attach to it, while the server
  // freezes actual earning via humanVerified until the viewer passes. Tearing
  // it down would 404 the /verify submit (challenge needs an active session).
  if (!tab.visible) return 'tab is in the background';
  if (!tab.frameAdvancing) return 'stream is paused or loading';
  if (!tab.onScreen) return 'player is hidden or too small';
  if (!soundOn) return 'unmute the stream to earn';
  return null; // no blocker → earning (or about to)
}

// The clock. Runs on every stream ping and on the alarm backstop.
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await ensureLoaded();
    const now = Date.now();
    const tab = pickTab(now);
    const audio = tab ? await tabAudio(tab.tabId) : { tabMuted: true, audibleNow: false };
    if (audio.audibleNow) lastAudibleAt = now;
    // Sound is "on" when nothing is muted (tab mute or in-page mute/zero volume).
    // Silence-tolerant on purpose: a quiet stream is still being listened to.
    const soundOn = !!tab && !audio.tabMuted && tab.videoMuted !== true;

    // Evidence for the server: audible as a RECENCY signal (produced sound within
    // the window), which tolerates quiet passages while still catching a muted or
    // silent-fake feed.
    if (tab) {
      const recentlyAudible = now - lastAudibleAt < AUDIBLE_WINDOW;
      evidence = { mediaTime: tab.mediaTime, frameAdvancing: tab.frameAdvancing, audible: recentlyAudible, onScreen: tab.onScreen };
    }

    // Switching channel/platform in the earning tab (SPA nav) must re-key the
    // session immediately — otherwise we'd keep earning attributed to the OLD
    // faucet while watching the new one. Attribution integrity beats debounce.
    if (cur && session && tab && (session.channel !== tab.channel || session.platform !== tab.platform)) {
      await commit(false, tab);
    }

    const reason = pausedReason(tab, soundOn);
    lastReason = reason ?? '';
    const w = reason === null && !!tab;

    if (w !== cur) {
      if (since === 0) since = now;
      // Resuming also waits out the start-failure backoff, so a failing start
      // (expired auth, unresolvable channel, 5xx) can't retry itself into 429s.
      const gated = w && now < startFailUntil;
      if (now - since >= (w ? RESUME_AFTER : PAUSE_AFTER) && !gated) await commit(w, tab);
    } else {
      since = 0;
    }

    // Poll status faster while the verify popup is open so earning resumes the
    // moment the viewer passes, then the window auto-closes.
    const statusEvery = verifyWindowId !== null ? VERIFY_POLL : STATUS_EVERY;
    if (cur && session) {
      if (now - session.lastChatAt >= CHAT_EVERY) await keepalive();
      if (session && now - session.lastProofAt >= PROOF_EVERY) await doProof();
      if (session && now - lastStatusPoll >= statusEvery) await pollStatus(session.faucetId);
      if (!stats || now - stats.at >= STATS_EVERY) await refreshStats();

      // Extrapolate the countdown; when it crosses 0 a drop was just reserved →
      // fast-poll /api/me briefly so the reserved amount shows within a second or two.
      const st = session?.status;
      const remaining = st?.counting && typeof st.remainingMs === 'number' ? st.remainingMs - (now - st.at) : null;
      if (prevRemaining != null && prevRemaining > 0 && remaining != null && remaining <= 0) fastMeUntil = now + 10_000;
      prevRemaining = remaining;

      const meEvery = now < fastMeUntil ? 2_000 : st?.counting ? 6_000 : ME_EVERY;
      if (now - lastMePoll >= meEvery) await refreshMe();
      await setBadge();
    } else if (needsHumanCheck && lastFaucetId && now - lastStatusPoll >= statusEvery) {
      // Not earning but a check is pending (e.g. viewer paused mid-check): keep
      // polling so passing it still closes the verify window cleanly.
      await pollStatus(lastFaucetId);
      await setBadge();
    }
  } finally {
    ticking = false;
  }
}

async function commit(w, tab) {
  cur = w;
  since = 0;
  try {
    if (w && tab) await startEarning(tab);
    else await stopEarning();
  } catch {
    cur = false; // start failed (channel unresolvable, network) — stay idle
    session = null;
    if (w) startFailUntil = Date.now() + START_BACKOFF;
  }
  await setBadge();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'nd-token') {
    // Only the nanodrops.org content script may set the token. Defense in
    // depth: senders are already limited to our own scripts, but a token write
    // is the one message worth pinning to its origin.
    const org = sender.origin ?? (sender.url ? new URL(sender.url).origin : '');
    if (!SITE_ORIGINS.includes(org)) return false;
    (async () => {
      await ensureLoaded();
      if (msg.token && msg.token !== token) {
        token = msg.token;
        await chrome.storage.local.set({ nd_token: token });
      } else if (msg.token === null && token) {
        token = null;
        await chrome.storage.local.remove('nd_token');
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg?.type === 'stream-state') {
    const tabId = sender.tab?.id ?? -1;
    if (tabId >= 0) {
      tabStates.set(tabId, {
        platform: msg.platform === 'kick' ? 'kick' : 'twitch',
        channel: typeof msg.channel === 'string' ? msg.channel : '',
        frameAdvancing: !!msg.frameAdvancing,
        mediaTime: typeof msg.mediaTime === 'number' ? msg.mediaTime : 0,
        onScreen: !!msg.onScreen,
        videoMuted: msg.videoMuted !== false, // fail-closed if absent
        visible: !!msg.visible,
        lastPingAt: Date.now(),
      });
    }
    void tick();
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === 'get-status') {
    (async () => {
      await ensureLoaded();
      if (!stats || Date.now() - stats.at >= STATS_EVERY) await refreshStats();
      if (token && (!me || Date.now() - lastMePoll >= ME_EVERY)) await refreshMe();
      const senderTabId = sender.tab?.id ?? -1;
      const st = session?.status;
      const earning = earningNow();
      // Watching client-side but the server isn't counting it → say WHY, not
      // "earning". The common case is an unfunded stream (no covering pot has a
      // balance); other not-counting cases (IP cap, VPN, another primary) we
      // can't disambiguate from status, so keep it honest but generic.
      let reason;
      if (needsHumanCheck) reason = null; // verify button carries the message
      else if (!cur) reason = lastReason || 'paused';
      else if (session?.status && !session.status.counting) {
        reason = session.status.faucetFunded === false ? 'this stream has no rewards funded' : 'not earning right now';
      } else reason = null;
      sendResponse({
        signedIn: !!token,
        earning,
        // Client-side watching is fine (playing, visible, unmuted) — the HUD says
        // "watching" instead of "paused" when only the server isn't counting.
        watching: cur,
        // Is the asking tab the one earning? (HUD shows "another tab" otherwise.)
        thisTab: !cur || !session || senderTabId < 0 || session.tabId === senderTabId,
        channel: session?.channel ?? null,
        reason,
        needsHumanCheck,
        hourlyRateXno: stats?.hourlyRateXno ?? null,
        usdPerXno: stats?.usdPerXno ?? null,
        // Earnings accrued since this stream's session began (credited + reserved-
        // but-unsent). The viewer earns from one stream at a time, so the total's
        // rise while watching this one IS what it paid.
        earnedStreamXno:
          session && meTotal() != null && session.baseTotalXno != null ? Math.max(0, meTotal() - session.baseTotalXno) : session ? 0 : null,
        // Balance of the pot backing the current stream (covering faucets combined),
        // from the last status poll. Replaces the lifetime-earned readout in the HUD.
        faucetBalanceXno: st?.faucetBalanceXno ?? null,
        // Funding weather. seq bumps per detected deposit so the HUD fires once.
        storm: { seq: stormSeq, mag: stormMag, lightning: stormLightning },
        // Countdown snapshot. The HUD ticks it locally off statusAt (an absolute
        // timestamp — same machine, same clock) so it stays smooth regardless of
        // message timing, and wraps at 0 to predict the next cycle.
        remainingMs: st?.remainingMs ?? null,
        intervalMs: st?.intervalMs ?? null,
        counting: st?.counting ?? false,
        statusAt: st?.at ?? null,
      });
    })();
    return true;
  }
  if (msg?.type === 'open-verify') {
    // From the HUD (content script can't open windows) or the popup.
    void openVerify();
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

// Backstop: a hard-closed tab sends no final ping; the alarm re-runs tick so
// staleness is noticed and earning pauses. 30s is Chrome's alarm floor.
chrome.alarms.create('backstop', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'backstop') void tick();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  void tick();
});

// Viewer closed the verify popup manually — forget it so we don't try to focus a
// dead window on the next verify.
chrome.windows.onRemoved.addListener((id) => {
  if (id === verifyWindowId) verifyWindowId = null;
});
