// Runs on nanodrops.org. Lifts the site's OWN session token (the JWT the web app
// already stored in localStorage after Twitch/Kick sign-in) and hands it to the
// background worker, so the extension earns as the same account without a
// separate login. First-party only: it reads nanodrops.org's own storage.

let last = undefined;

function send() {
  let token = null;
  try {
    token = localStorage.getItem('nd_token');
  } catch {
    /* storage blocked */
  }
  if (token === last) return;
  last = token;
  try {
    chrome.runtime.sendMessage({ type: 'nd-token', token }, () => void chrome.runtime.lastError);
  } catch {
    /* extension context gone */
  }
}

send();
setInterval(send, 2000); // catches sign-in / sign-out without a page reload
window.addEventListener('storage', (e) => {
  if (e.key === 'nd_token' || e.key === null) send();
});
