// Runs on twitch.tv AND kick.com. Reports hard-to-fake evidence that the user
// is really watching, once a second, to the background worker:
//   - frameAdvancing: decoded video frames actually moved (a paused/stalled/
//     stubbed <video> decodes nothing)
//   - mediaTime: player currentTime, so the server can check ~1x forward motion
//   - onScreen: the player is visible AND big enough (defeats a 1px/offscreen
//     hidden player left "playing")
//   - videoMuted/volume: in-page mute INTENT (the authoritative signal is
//     tab.audible, read browser-side in background.js where pages can't reach)
//
// It reads only the <video> the user is already watching — no embed, no
// restream, no platform playback endpoints.

const PLATFORM = location.hostname.endsWith('kick.com') ? 'kick' : 'twitch';

// Path segments that are app routes, not channel logins.
const RESERVED = {
  twitch: new Set([
    '', 'directory', 'videos', 'settings', 'subscriptions', 'wallet', 'drops',
    'friends', 'inventory', 'search', 'following', 'p', 'u', 'jobs', 'turbo',
    'prime', 'downloads', 'store', 'bits', 'redeem', 'popout', 'moderator',
  ]),
  kick: new Set([
    '', 'browse', 'categories', 'category', 'search', 'messages', 'account',
    'subscriptions', 'help', 'terms', 'privacy', 'community-guidelines',
    'dashboard', 'transactions', 'wallet', 'support', 'dmca-policy', 'video',
  ]),
}[PLATFORM];

// Only canonical channel-page hosts. clips.twitch.tv, player.twitch.tv,
// dashboard.twitch.tv etc. all match *.twitch.tv and carry a playing <video>,
// but their first path segment is NOT a channel login.
const HOST_OK = {
  twitch: /^(www\.|m\.)?twitch\.tv$/,
  kick: /^(www\.)?kick\.com$/,
}[PLATFORM];

// Channel sub-pages that play recorded content, not the live stream
// (twitch.tv/<chan>/clip/<slug>, kick.com/<chan>/clips/<id>, .../videos).
const VOD_SEGS = new Set(['clip', 'clips', 'video', 'videos']);

// A genuine player is at least roughly this big and at least half on-screen.
const MIN_W = 240;
const MIN_H = 135;

let prevFrames = -1;
let prevVideo = null; // frame counters aren't comparable across <video> elements

function currentChannel() {
  if (!HOST_OK.test(location.hostname)) return '';
  const segs = location.pathname.split('/').filter(Boolean);
  const seg = (segs[0] ?? '').toLowerCase();
  if (RESERVED.has(seg)) return '';
  if (segs[1] && VOD_SEGS.has(segs[1].toLowerCase())) return ''; // a clip/VOD is not watching the stream
  return seg;
}

function playerVideo() {
  if (PLATFORM === 'twitch') {
    // The player can hold more than one <video> during ad/quality transitions;
    // prefer the one actually playing over whichever is first in DOM order.
    const inPlayer = Array.from(document.querySelectorAll('.video-player video, [data-a-target="video-player"] video'));
    const hit = inPlayer.find((v) => !v.paused) ?? inPlayer[0];
    if (hit) return hit;
  }
  const vids = Array.from(document.querySelectorAll('video'));
  return vids.find((v) => !v.paused) ?? vids[0] ?? null;
}

function decodedFrames(v) {
  try {
    return v.getVideoPlaybackQuality().totalVideoFrames;
  } catch {
    return v.webkitDecodedFrameCount ?? 0;
  }
}

function onScreen(v) {
  if (document.visibilityState !== 'visible') return false;
  const r = v.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
  const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
  return w >= MIN_W && h >= MIN_H && w * h >= (r.width * r.height) * 0.5;
}

function readState() {
  const channel = currentChannel();
  const v = channel ? playerVideo() : null;
  if (!v) {
    prevFrames = -1;
    prevVideo = null;
    return { platform: PLATFORM, channel, frameAdvancing: false, mediaTime: 0, onScreen: false, videoMuted: true, visible: document.visibilityState === 'visible' };
  }
  if (v !== prevVideo) {
    prevVideo = v;
    prevFrames = -1;
  }
  const frames = decodedFrames(v);
  const advancing = !v.paused && !v.ended && prevFrames >= 0 && frames > prevFrames;
  prevFrames = frames;
  return {
    platform: PLATFORM,
    channel,
    frameAdvancing: advancing,
    mediaTime: Number.isFinite(v.currentTime) ? v.currentTime : 0,
    onScreen: onScreen(v),
    videoMuted: v.muted || v.volume === 0,
    visible: document.visibilityState === 'visible',
  };
}

function ping(extra) {
  try {
    chrome.runtime.sendMessage({ type: 'stream-state', ...readState(), ...extra }, () => void chrome.runtime.lastError);
  } catch {
    /* extension reloaded / context invalidated */
  }
}

setInterval(() => ping(), 1000);
document.addEventListener('visibilitychange', () => ping());
window.addEventListener('pagehide', () => ping({ frameAdvancing: false, onScreen: false, visible: false }));
ping();
