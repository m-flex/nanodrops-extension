const $ = (id) => document.getElementById(id);
const SIGN = 'Ӿ'; // the nano sign

// Tiny copies of the HUD formatters (separate context, no build step — like pow.js).
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
/** `Ӿ<amount>` plus a muted USD estimate when a price is known. */
function val(xno, usdPerXno) {
  const n = Number(xno);
  const usd = usdPerXno ? fmtUsd(n * usdPerXno) : '';
  return `${SIGN}${fmtNano(n)}${usd ? ` (${usd})` : ''}`;
}
/** Show a row with text, or hide it when text is null (never render a fake 0). */
function row(rowId, elId, text) {
  $(rowId).classList.toggle('hide', text == null);
  if (text != null) $(elId).textContent = text;
}

// Next-drop countdown: tick locally off the absolute snapshot time (same
// machine, same clock) and wrap at 0 — same scheme as the HUD.
let cd = null; // { remainingMs, statusAt, intervalMs } or null
function renderNext() {
  if (!cd) return;
  const iv = cd.intervalMs;
  const raw = cd.remainingMs - (Date.now() - cd.statusAt);
  const left = ((raw % iv) + iv) % iv; // wrap into [0, interval)
  const s = Math.max(0, Math.ceil(left / 1000));
  $('next').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
setInterval(renderNext, 1000);

chrome.runtime.sendMessage({ type: 'get-status' }, (s) => {
  if (chrome.runtime.lastError || !s) {
    $('acct').textContent = 'unavailable';
    return;
  }
  $('acct').textContent = s.signedIn ? 'signed in' : 'not signed in';
  $('acct').className = 'v ' + (s.signedIn ? 'ok' : 'off');

  $('chan').textContent = s.channel || '-';
  $('chan').className = 'v ' + (s.channel ? '' : 'off');

  // The reason is the server's own not-counting verdict (mapped in the
  // background), or the local blocker while not watching — never invented here.
  $('earn').textContent = s.earning ? 'yes' : s.reason || 'no';
  $('earn').className = 'v ' + (s.earning ? 'ok' : 'off');

  const usd = s.usdPerXno;
  row('row-life', 'life', s.lifetimeXno != null ? val(s.lifetimeXno, usd) : null);
  // Pending 0 is the steady state — only worth a row when something is queued.
  row('row-pend', 'pend', s.pendingXno > 0 ? val(s.pendingXno, usd) : null);
  const rate = Number(s.hourlyRateXno);
  row('row-rate', 'rate', Number.isFinite(rate) && rate > 0 ? `~${SIGN}${rate >= 1 ? rate.toFixed(2) : rate.toPrecision(2)}/hr` : null);
  // "This stream" + countdown only while actually earning.
  row('row-stream', 'estream', s.earning && s.earnedStreamXno != null ? val(s.earnedStreamXno, usd) : null);
  cd =
    s.earning && s.counting && s.remainingMs != null && s.statusAt != null
      ? { remainingMs: s.remainingMs, statusAt: s.statusAt, intervalMs: s.intervalMs || 60000 }
      : null;
  $('row-next').classList.toggle('hide', !cd);
  renderNext();

  // Follow-a-faucet: background offers this only when the faucet is dry/offline
  // (or already watched, so it can be untoggled).
  const fw = s.faucetWatch;
  $('row-watch').classList.toggle('hide', !fw);
  if (fw) {
    const t = $('watch');
    t.checked = fw.watched;
    t.onchange = () => {
      const on = t.checked;
      t.disabled = true;
      chrome.runtime.sendMessage({ type: 'faucet-watch', on, channel: fw.channel, platform: fw.platform, faucetId: fw.faucetId }, (r) => {
        t.disabled = false;
        if (chrome.runtime.lastError || !r?.ok) t.checked = !on; // revert on failure
      });
    };
  }

  // Toggle both ways so a button is never left showing in the wrong state: sign-in
  // only when signed out, verify only when a check is actually due. (The sign-in
  // href is hardcoded in the HTML, so even a stale button goes to the site, not
  // back to this popup.)
  $('signin').classList.toggle('hide', s.signedIn);

  const verify = $('verify');
  verify.classList.toggle('hide', !s.needsHumanCheck);
  if (s.needsHumanCheck) {
    verify.onclick = (e) => {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: 'open-verify' }, () => void chrome.runtime.lastError);
      window.close();
    };
  }
});
