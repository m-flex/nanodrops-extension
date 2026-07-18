const $ = (id) => document.getElementById(id);

chrome.runtime.sendMessage({ type: 'get-status' }, (s) => {
  if (chrome.runtime.lastError || !s) {
    $('acct').textContent = 'unavailable';
    return;
  }
  $('acct').textContent = s.signedIn ? 'signed in' : 'not signed in';
  $('acct').className = 'v ' + (s.signedIn ? 'ok' : 'off');

  $('chan').textContent = s.channel || '-';
  $('chan').className = 'v ' + (s.channel ? '' : 'off');

  $('earn').textContent = s.earning ? 'yes' : s.reason || 'no';
  $('earn').className = 'v ' + (s.earning ? 'ok' : 'off');

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
