// On-stream HUD. Injected on twitch.tv + kick.com next to content-stream.js.
// A small draggable overlay (Shadow DOM, mode:'closed' so page CSS/JS can't
// touch it) showing whether you're earning, why not, your earnings, the rate,
// and the next-drop countdown. Draggable anywhere; collapses to a pill; position
// and collapsed state persist per browser.
//
// Background is the site's ambient lofi rain; a funding deposit anywhere surges
// the rain and a big one flashes lightning — the same weather as the main site
// (background diffs /api/stats fundedTotal and signals it here).
//
// Public-facing copy rules: "nano" is lowercase, no em-dashes.

const POLL_MS = 1000;
const SIGN = 'Ӿ'; // Ӿ — the nano sign (reads like an X)
const COLLAPSED_KEY = 'nd_hud_collapsed';
const POS_KEY = 'nd_hud_pos';
const MARGIN = 14; // viewport gap for the default (bottom-right) placement + clamping

// Rain look, matched to the site (components/RainCanvas.tsx).
const NANO = '103, 183, 215';
const LIGHT = '208, 231, 245'; // storm-light: nano washed toward white
const STORM_TAU = 9000; // funding surge e-folding time (ms)
const FLASH_MS = 620;
const FRAME_MS = 33; // cap the rain to ~30fps: lofi reads fine and leaves the GPU for the stream

let collapsed = false;
let pos = null; // { left, top } or null → default bottom-right
let root = null;
let els = null;
let host = null;
let lastStormSeq = 0;
let lastStream = null; // last "this stream" value, to animate a tick-up
let cd = null; // countdown snapshot { remainingMs, statusAt, intervalMs } or null

// ── Rain engine (canvas) ─────────────────────────────────────────────────────
const rain = {
  ctx: null,
  canvas: null,
  w: 0,
  h: 0,
  dpr: 1,
  drops: [],
  storm: 0, // 0..1 surge level, decays over time
  flashAt: 0,
  raf: 0,
  last: 0,
  running: false,
};

function makeDrop(spawnTop) {
  const z = Math.random();
  return {
    x: Math.random() * rain.w,
    y: spawnTop ? -8 - Math.random() * rain.h : Math.random() * rain.h,
    z,
    len: 5 + z * 9,
    warm: false,
  };
}

function targetDrops() {
  const base = Math.max(10, Math.round((rain.w * rain.h) / 2800));
  return Math.round(base * (1 + rain.storm * 0.8)); // storms rain heavier
}

// One stroked path for a whole depth band, so a frame is 2 stroke() calls, not
// ~30. Per-drop strokeStyle changes were the expensive part.
function strokeBand(ctx, drops, color, alpha, width) {
  if (alpha <= 0.01) return;
  ctx.strokeStyle = `rgba(${color}, ${Math.min(0.9, alpha)})`;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (const d of drops) {
    ctx.moveTo(d.x, d.y);
    ctx.lineTo(d.x, d.y + d.len);
  }
  ctx.stroke();
}

function drawRain(now) {
  if (!rain.running) return;
  rain.raf = requestAnimationFrame(drawRain);
  if (now - rain.last < FRAME_MS) return; // ~30fps cap
  const dt = Math.min(0.05, (now - rain.last) / 1000);
  rain.last = now;
  rain.storm *= Math.exp(-(dt * 1000) / STORM_TAU); // wall-clock decay

  const { ctx, w, h } = rain;
  ctx.clearRect(0, 0, w, h);

  const want = targetDrops();
  while (rain.drops.length < want) rain.drops.push(makeDrop(true));
  if (rain.drops.length > want) rain.drops.length = want;

  const flashAge = now - rain.flashAt;
  const flash = flashAge < FLASH_MS ? (1 - flashAge / FLASH_MS) * (0.6 + 0.4 * Math.sin(flashAge / 22)) : 0;
  const color = flash > 0.25 ? LIGHT : NANO;
  const speed = 240 + rain.storm * 260; // px/s at z=0, faster in a storm

  const near = [];
  const far = [];
  for (const d of rain.drops) {
    d.y += (speed + d.z * 260) * dt;
    if (d.y - d.len > h) {
      d.x = Math.random() * w;
      d.y = -8 - Math.random() * 40;
      d.z = Math.random();
      d.len = 5 + d.z * 9;
    }
    (d.z >= 0.5 ? near : far).push(d);
  }
  const boost = 0.6 + rain.storm * 0.6;
  ctx.lineCap = 'round';
  strokeBand(ctx, far, color, 0.13 * boost + flash * 0.5, 0.8);
  strokeBand(ctx, near, color, 0.28 * boost + flash * 0.5, 1.4);

  // Lightning wash: soft, low peak so the text stays readable.
  if (flash > 0) {
    ctx.fillStyle = `rgba(${LIGHT}, ${flash * 0.14})`;
    ctx.fillRect(0, 0, w, h);
  }
}

function startRain() {
  if (rain.running || !rain.ctx) return;
  rain.running = true;
  rain.last = performance.now() - FRAME_MS; // draw on the next frame, not one FRAME_MS late
  rain.raf = requestAnimationFrame(drawRain);
}
function stopRain() {
  rain.running = false;
  if (rain.raf) cancelAnimationFrame(rain.raf);
  rain.raf = 0;
}
function rainActive() {
  // Stop rendering when the overlay isn't actually shown: collapsed, tab hidden,
  // or a fullscreen video is covering it (earning continues — that's the content
  // script — this only halts the decorative canvas so playback keeps the GPU).
  return !collapsed && document.visibilityState === 'visible' && !document.fullscreenElement;
}
function syncRain() {
  if (rainActive()) startRain();
  else stopRain();
}

function resizeCanvas() {
  if (!rain.canvas || !els) return;
  const r = els.card.getBoundingClientRect();
  rain.dpr = Math.min(window.devicePixelRatio || 1, 2);
  rain.w = Math.max(1, Math.round(r.width));
  rain.h = Math.max(1, Math.round(r.height));
  rain.canvas.width = rain.w * rain.dpr;
  rain.canvas.height = rain.h * rain.dpr;
  rain.canvas.style.width = `${rain.w}px`;
  rain.canvas.style.height = `${rain.h}px`;
  const ctx = rain.canvas.getContext('2d');
  ctx.setTransform(rain.dpr, 0, 0, rain.dpr, 0, 0);
  rain.ctx = ctx;
}

// ── Formatting ───────────────────────────────────────────────────────────────
function fmtRate(xno) {
  const n = Number(xno);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 1 ? n.toFixed(2) : n.toPrecision(2);
}
// Mirrors the site's nano formatter (web/lib/format.ts) — a plain-JS content
// script can't import it, so it's a copy, like pow.js. Do NOT reintroduce
// per-magnitude branches: the old ones rendered a normal ~0.0009 drop as
// "9.1e-4". 6 dp matches the API's own precision (money() = rawToXno(raw, 6)),
// so nothing the server sends is ever rounded away.
function fmtNano(xno) {
  const n = Number(xno);
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}
function fmtUsd(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}
/** A value cell: `Ӿ<amount>` plus a muted USD estimate when a price is known. */
function valCell(xno, usdPerXno) {
  if (xno == null) return '-';
  const usd = usdPerXno ? fmtUsd(Number(xno) * usdPerXno) : '';
  return `${SIGN}${fmtNano(xno)}${usd ? ` <span class="usd">${usd}</span>` : ''}`;
}
function fmtCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ── Build ────────────────────────────────────────────────────────────────────
function build() {
  host = document.createElement('div');
  host.id = 'nanodrops-hud';
  host.style.cssText = 'position:fixed;z-index:2147483646;touch-action:none;';
  root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; margin: 0; }
      .card {
        position: relative; overflow: hidden;
        font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: #e7e9ee; background: rgba(9, 10, 14, 0.92);
        border: 1px solid #262a33; border-radius: 9px;
        width: 236px;
        box-shadow: 0 6px 26px rgba(0,0,0,.5);
      }
      /* Deliberately no blur here. Re-blurring the video behind the card every
         frame stalls playback; a near-opaque solid background is free. */
      canvas.rain { position: absolute; inset: 0; z-index: 0; pointer-events: none; opacity: .75; border-radius: 9px; }
      .inner { position: relative; z-index: 1; padding: 10px 12px; }
      .head { display: flex; align-items: center; gap: 7px; cursor: grab; user-select: none; }
      .head:active { cursor: grabbing; }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: #6b7280; flex: none; }
      .dot.on { background: #22c55e; box-shadow: 0 0 6px #22c55e88; }
      .dot.warn { background: #f5a623; box-shadow: 0 0 6px #f5a62388; }
      .brand { letter-spacing: .09em; text-transform: uppercase; font-size: 10px; color: #9aa0ab; }
      .grip { margin-left: 2px; color: #4b5160; font-size: 11px; letter-spacing: 1px; }
      .state { margin-left: auto; font-size: 11px; }
      .state.on { color: #22c55e; } .state.off { color: #9aa0ab; } .state.warn { color: #f5a623; }
      .body { margin-top: 8px; display: none; }
      .card.open .body { display: block; }
      .row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin: 3px 0; }
      .k { color: #6b7280; flex: none; } .v { font-variant-numeric: tabular-nums; text-align: right; }
      .v.pos { color: #67b7d7; transform-origin: right center; }
      .usd { font-size: 10px; color: #6b7280; margin-left: 4px; }
      @keyframes ndbump { 0% { transform: scale(1); } 28% { transform: scale(1.22); color: #8fe3b0; } 100% { transform: scale(1); } }
      .v.pos.bump { animation: ndbump .6s ease-out; }
      .reason { margin-top: 6px; color: #9aa0ab; font-size: 11px; }
      .bar { margin-top: 8px; height: 3px; background: #1b1e26; border-radius: 2px; overflow: hidden; }
      .bar > i { display: block; height: 100%; width: 0; background: #22c55e; transition: width .5s linear; }
      .btn { display: block; margin-top: 9px; padding: 6px 8px; text-align: center; text-decoration: none;
             border-radius: 6px; font-size: 11px; border: 1px solid #2a2d36; color: #e7e9ee; cursor: pointer; background: transparent; }
      .btn.warn { border-color: #f5a62355; color: #f5a623; }
      .btn.go { border-color: #22c55e55; color: #22c55e; }
      .site { display: block; margin-top: 9px; text-align: center; font-size: 10px; color: #6b7280; text-decoration: none; letter-spacing: .02em; }
      .site:hover { color: #9aa0ab; }
      .hide { display: none !important; }
      .card.pill { width: auto; }
      .card.pill .brand, .card.pill .grip { display: none; }
    </style>
    <div class="card open">
      <canvas class="rain"></canvas>
      <div class="inner">
        <div class="head" title="drag to move / click to collapse">
          <span class="dot"></span>
          <span class="brand">nanodrops</span>
          <span class="grip">⠿</span>
          <span class="state off">paused</span>
        </div>
        <div class="body">
          <div class="row"><span class="k">channel</span><span class="v" data-el="chan">-</span></div>
          <div class="row"><span class="k">this stream</span><span class="v pos" data-el="estream">-</span></div>
          <div class="row"><span class="k">faucet</span><span class="v" data-el="fbal">-</span></div>
          <div class="row"><span class="k">rate</span><span class="v" data-el="rate">-</span></div>
          <div class="row"><span class="k">next drop</span><span class="v" data-el="next">-</span></div>
          <div class="bar"><i data-el="fill"></i></div>
          <div class="reason hide" data-el="reason"></div>
          <button class="btn warn hide" data-el="verify">verify to keep earning</button>
          <a class="btn go hide" target="_blank" rel="noopener" data-el="signin">sign in on nanodrops.org</a>
          <a class="site" target="_blank" rel="noopener" href="https://nanodrops.org">browse more streams on nanodrops.org ↗</a>
        </div>
      </div>
    </div>`;
  els = {
    card: root.querySelector('.card'),
    canvas: root.querySelector('canvas.rain'),
    head: root.querySelector('.head'),
    dot: root.querySelector('.dot'),
    state: root.querySelector('.state'),
    chan: root.querySelector('[data-el="chan"]'),
    estream: root.querySelector('[data-el="estream"]'),
    fbal: root.querySelector('[data-el="fbal"]'),
    rate: root.querySelector('[data-el="rate"]'),
    next: root.querySelector('[data-el="next"]'),
    fill: root.querySelector('[data-el="fill"]'),
    reason: root.querySelector('[data-el="reason"]'),
    verify: root.querySelector('[data-el="verify"]'),
    signin: root.querySelector('[data-el="signin"]'),
  };
  rain.canvas = els.canvas;

  wireDrag();
  els.verify.addEventListener('click', (e) => {
    e.preventDefault();
    try {
      chrome.runtime.sendMessage({ type: 'open-verify' }, () => void chrome.runtime.lastError);
    } catch {
      /* extension reloaded */
    }
  });

  document.documentElement.appendChild(host);
  applyCollapsed();
  placeHost();
  resizeCanvas();

  const ro = new ResizeObserver(() => resizeCanvas());
  ro.observe(els.card);
  window.addEventListener('resize', () => {
    clampPos();
    placeHost();
  });
  document.addEventListener('visibilitychange', syncRain);
  document.addEventListener('fullscreenchange', () => {
    // Hide the whole overlay in fullscreen (it'd be covered anyway) and stop the rain.
    host.style.display = document.fullscreenElement ? 'none' : '';
    syncRain();
  });
  syncRain();
}

// ── Position + drag ──────────────────────────────────────────────────────────
function hostSize() {
  const r = host.getBoundingClientRect();
  return { w: r.width, h: r.height };
}
function clampPos() {
  if (!pos) return;
  const { w, h } = hostSize();
  pos.left = Math.max(MARGIN, Math.min(pos.left, window.innerWidth - w - MARGIN));
  pos.top = Math.max(MARGIN, Math.min(pos.top, window.innerHeight - h - MARGIN));
}
function placeHost() {
  if (pos) {
    clampPos();
    host.style.left = `${pos.left}px`;
    host.style.top = `${pos.top}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
  } else {
    // Default: bottom-right until the user drags it somewhere.
    host.style.left = 'auto';
    host.style.top = 'auto';
    host.style.right = `${MARGIN}px`;
    host.style.bottom = `${MARGIN}px`;
  }
}
function savePos() {
  try {
    chrome.storage.local.set({ [POS_KEY]: pos });
  } catch {
    /* context gone */
  }
}

function wireDrag() {
  let startX = 0, startY = 0, baseL = 0, baseT = 0, moved = false, dragging = false;

  els.head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const r = host.getBoundingClientRect();
    baseL = r.left;
    baseT = r.top;
    els.head.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  els.head.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    if (!moved) return;
    pos = { left: baseL + dx, top: baseT + dy };
    clampPos();
    host.style.left = `${pos.left}px`;
    host.style.top = `${pos.top}px`;
    host.style.right = 'auto';
    host.style.bottom = 'auto';
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try {
      els.head.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (moved) {
      savePos();
    } else {
      // A click (no drag) toggles collapse.
      collapsed = !collapsed;
      applyCollapsed();
      resizeCanvas();
      syncRain();
      try {
        chrome.storage.local.set({ [COLLAPSED_KEY]: collapsed });
      } catch {
        /* context gone */
      }
    }
  };
  els.head.addEventListener('pointerup', end);
  els.head.addEventListener('pointercancel', end);
}

function applyCollapsed() {
  els.card.classList.toggle('open', !collapsed);
  els.card.classList.toggle('pill', collapsed);
}

// ── Render + storm ───────────────────────────────────────────────────────────
function triggerStorm(mag, lightning) {
  rain.storm = Math.min(1, rain.storm + Math.max(0.25, mag));
  if (lightning) rain.flashAt = performance.now();
  if (!rain.running && rainActive()) startRain();
}

// Ticks locally off an absolute snapshot time, wrapping at 0 so the reset is
// predicted instead of stalling at 0:00 for up to a status-poll interval. Runs
// on its own timer, so it stays smooth even when the background is busy.
function renderCountdown() {
  if (!els) return;
  if (!cd) {
    els.next.textContent = '-';
    els.fill.style.width = '0%';
    return;
  }
  const iv = cd.intervalMs;
  const raw = cd.remainingMs - (Date.now() - cd.statusAt);
  const left = ((raw % iv) + iv) % iv; // wrap into [0, interval)
  els.next.textContent = fmtCountdown(left);
  els.fill.style.width = `${Math.min(100, Math.max(0, (1 - left / iv) * 100))}%`;
}

function render(s) {
  if (!els) return;

  // Funding weather (fire once per new deposit the background reports).
  if (s.storm && s.storm.seq > lastStormSeq) {
    if (lastStormSeq !== 0) triggerStorm(s.storm.mag ?? 0.4, !!s.storm.lightning);
    lastStormSeq = s.storm.seq; // first sight seeds without a flash
  } else if (s.storm && s.storm.seq < lastStormSeq) {
    lastStormSeq = s.storm.seq; // background worker restarted (seq reset) — re-seed silently
  }

  const mode = s.needsHumanCheck ? 'warn' : s.earning ? 'on' : 'off';
  els.dot.className = `dot ${mode === 'off' ? '' : mode}`.trim();
  els.state.className = `state ${mode}`;
  els.state.textContent = s.needsHumanCheck ? 'check due' : s.earning ? (s.thisTab ? 'earning' : 'other tab') : s.watching ? 'watching' : 'paused';

  els.chan.textContent = s.channel ?? '-';

  // "this stream": update, then flash + pop when it ticks up (a drop was earned —
  // now the instant the countdown hits 0, since reserved drops count immediately).
  const inc = lastStream != null && s.earnedStreamXno != null && s.earnedStreamXno > lastStream + 1e-9;
  els.estream.innerHTML = valCell(s.earnedStreamXno, s.usdPerXno);
  if (inc) {
    els.estream.classList.remove('bump');
    void els.estream.offsetWidth; // reflow so the animation restarts
    els.estream.classList.add('bump');
  }
  lastStream = s.earnedStreamXno;

  els.fbal.innerHTML = valCell(s.faucetBalanceXno, s.usdPerXno);
  const rate = fmtRate(s.hourlyRateXno);
  const rateUsd = rate && s.usdPerXno ? fmtUsd(Number(s.hourlyRateXno) * s.usdPerXno) : '';
  els.rate.innerHTML = rate ? `~${SIGN}${rate}/hr${rateUsd ? ` <span class="usd">${rateUsd}/hr</span>` : ''}` : '-';

  // Store the countdown snapshot; a local ticker renders it smoothly (below).
  cd =
    s.earning && s.counting && s.remainingMs != null && s.statusAt != null
      ? { remainingMs: s.remainingMs, statusAt: s.statusAt, intervalMs: s.intervalMs || 60000 }
      : null;
  renderCountdown();

  let reason = !s.earning && s.reason ? s.reason : null;
  if (s.earning && !s.thisTab) reason = 'earning from a stream in another tab';
  els.reason.classList.toggle('hide', !reason);
  if (reason) els.reason.textContent = reason;

  els.verify.classList.toggle('hide', !s.needsHumanCheck);
  els.signin.classList.toggle('hide', s.signedIn);
  if (!s.signedIn) els.signin.href = 'https://nanodrops.org';
}

function poll() {
  try {
    chrome.runtime.sendMessage({ type: 'get-status' }, (s) => {
      if (chrome.runtime.lastError || !s) return;
      render(s);
    });
  } catch {
    /* extension reloaded */
  }
}

(async () => {
  try {
    // `browser` (Firefox) returns a promise here; `chrome` in Firefox is callback-only.
    const st = await (globalThis.browser ?? chrome).storage.local.get([COLLAPSED_KEY, POS_KEY]);
    collapsed = st[COLLAPSED_KEY] === true;
    pos = st[POS_KEY] && typeof st[POS_KEY].left === 'number' ? st[POS_KEY] : null;
  } catch {
    /* defaults */
  }
  build();
  poll();
  setInterval(poll, POLL_MS);
  setInterval(renderCountdown, 250); // smooth local countdown, independent of get-status timing
})();
