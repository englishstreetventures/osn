export interface AuthorizeHtmlParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  issuerUrl: string;
}

export function buildAuthorizeHtml(params: AuthorizeHtmlParams): string {
  const escaped = JSON.stringify(params);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sign in — OSN</title>
  <script src="https://unpkg.com/@simplewebauthn/browser@13/dist/bundle/index.es5.umd.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f5f5;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      color: #111;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
      padding: 2rem;
      width: 100%;
      max-width: 380px;
    }
    h1 { font-size: 1.25rem; font-weight: 700; margin: 0 0 1.5rem; }
    .tabs { display: flex; gap: 0; border-bottom: 1px solid #e5e5e5; margin-bottom: 1.5rem; }
    .tab {
      flex: 1;
      padding: 0.5rem 0.75rem;
      font-size: 0.875rem;
      font-weight: 500;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      color: #666;
      transition: color 0.15s, border-color 0.15s;
    }
    .tab.active { color: #111; border-bottom-color: #111; }
    .panel { display: none; }
    .panel.active { display: flex; flex-direction: column; gap: 0.75rem; }
    label { font-size: 0.75rem; font-weight: 600; color: #555; display: block; margin-bottom: 0.25rem; }
    input[type="email"], input[type="text"] {
      width: 100%;
      padding: 0.5rem 0.75rem;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 0.875rem;
      outline: none;
      transition: border-color 0.15s;
    }
    input:focus { border-color: #111; }
    button.primary {
      width: 100%;
      padding: 0.625rem;
      background: #111;
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    button.primary:hover { opacity: 0.85; }
    button.primary:disabled { opacity: 0.4; cursor: not-allowed; }
    .msg { font-size: 0.8125rem; color: #555; padding: 0.5rem; background: #f5f5f5; border-radius: 6px; }
    .err { color: #c00; font-size: 0.8125rem; }
    .hidden { display: none !important; }
    .passkey-prompt {
      border-top: 1px solid #e5e5e5;
      padding-top: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .passkey-prompt p { font-size: 0.875rem; margin: 0; }
    .passkey-prompt .actions { display: flex; gap: 0.5rem; }
    .passkey-prompt .actions button { flex: 1; padding: 0.5rem; font-size: 0.8125rem; border-radius: 6px; border: 1px solid #ddd; background: #fff; cursor: pointer; }
    .passkey-prompt .actions button.yes { background: #111; color: #fff; border-color: #111; }
  </style>
</head>
<body>
<div class="card">
  <h1>Sign in to OSN</h1>
  <div class="tabs">
    <button class="tab active" data-tab="passkey">Passkey</button>
    <button class="tab" data-tab="otp">OTP</button>
    <button class="tab" data-tab="email">Email link</button>
  </div>

  <!-- Passkey tab -->
  <div class="panel active" id="panel-passkey">
    <div>
      <label for="passkey-email">Email</label>
      <input type="email" id="passkey-email" autocomplete="email webauthn" placeholder="you@example.com" />
    </div>
    <button class="primary" id="passkey-btn">Sign in with passkey</button>
    <p class="err hidden" id="passkey-err"></p>
  </div>

  <!-- OTP tab -->
  <div class="panel" id="panel-otp">
    <div>
      <label for="otp-email">Email</label>
      <input type="email" id="otp-email" autocomplete="email" placeholder="you@example.com" />
    </div>
    <button class="primary" id="otp-send-btn">Send code</button>
    <div id="otp-verify-section" class="hidden">
      <label for="otp-code">Enter code</label>
      <input type="text" id="otp-code" placeholder="6-digit code" autocomplete="one-time-code" maxlength="6" />
      <button class="primary" id="otp-verify-btn" style="margin-top:0.5rem">Verify</button>
    </div>
    <p class="err hidden" id="otp-err"></p>
  </div>

  <!-- Email / magic link tab -->
  <div class="panel" id="panel-email">
    <div>
      <label for="magic-email">Email</label>
      <input type="email" id="magic-email" autocomplete="email" placeholder="you@example.com" />
    </div>
    <button class="primary" id="magic-btn">Send magic link</button>
    <p class="msg hidden" id="magic-msg">Check your email for the sign-in link.</p>
    <p class="err hidden" id="magic-err"></p>
  </div>

  <!-- Post-auth passkey prompt -->
  <div class="passkey-prompt hidden" id="passkey-prompt">
    <p>Add a passkey to this device for faster sign-in next time?</p>
    <div class="actions">
      <button class="yes" id="passkey-prompt-yes">Add passkey</button>
      <button id="passkey-prompt-no">Not now</button>
    </div>
  </div>
</div>

<script>
(function () {
  var P = ${escaped};
  var issuer = P.issuerUrl;

  // Tab switching
  document.querySelectorAll('.tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.tab').forEach(function(b) { b.classList.remove('active'); });
      document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
      btn.classList.add('active');
      document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
    });
  });

  function showErr(id, msg) {
    var el = document.getElementById(id);
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  function hideErr(id) { document.getElementById(id).classList.add('hidden'); }

  function completeAuth(code) {
    var url = new URL(P.redirectUri);
    url.searchParams.set('code', code);
    url.searchParams.set('state', P.state);
    window.location.href = url.toString();
  }

  function showPasskeyPrompt(userId) {
    document.getElementById('passkey-prompt').classList.remove('hidden');
    document.getElementById('passkey-prompt-no').addEventListener('click', function() {
      document.getElementById('passkey-prompt').classList.add('hidden');
    });
    document.getElementById('passkey-prompt-yes').addEventListener('click', async function() {
      try {
        var opts = await fetch(issuer + '/passkey/register/begin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: userId })
        }).then(function(r) { return r.json(); });
        var attestation = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: opts });
        await fetch(issuer + '/passkey/register/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: userId, attestation: attestation })
        });
        document.getElementById('passkey-prompt').classList.add('hidden');
      } catch(e) {
        console.error('Passkey registration failed:', e);
        document.getElementById('passkey-prompt').classList.add('hidden');
      }
    });
  }

  // Passkey sign-in
  document.getElementById('passkey-btn').addEventListener('click', async function() {
    hideErr('passkey-err');
    var email = document.getElementById('passkey-email').value.trim();
    if (!email) { showErr('passkey-err', 'Please enter your email.'); return; }
    try {
      var opts = await fetch(issuer + '/passkey/login/begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
      }).then(function(r) { return r.json(); });
      if (opts.error) {
        // No account or no passkeys registered — switch to OTP to get started
        document.getElementById('otp-email').value = email;
        document.querySelectorAll('.tab').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
        document.querySelector('.tab[data-tab="otp"]').classList.add('active');
        document.getElementById('panel-otp').classList.add('active');
        showErr('otp-err', 'No passkey found for this account — enter your email to receive a one-time code instead.');
        return;
      }
      var assertion = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: opts.options });
      var res = await fetch(issuer + '/passkey/login/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, assertion: assertion })
      }).then(function(r) { return r.json(); });
      if (res.error) { showErr('passkey-err', res.error); return; }
      completeAuth(res.code);
    } catch(e) {
      showErr('passkey-err', e.message || 'Sign-in failed.');
    }
  });

  // OTP send
  var otpEmail = '';
  document.getElementById('otp-send-btn').addEventListener('click', async function() {
    hideErr('otp-err');
    otpEmail = document.getElementById('otp-email').value.trim();
    if (!otpEmail) { showErr('otp-err', 'Please enter your email.'); return; }
    try {
      var res = await fetch(issuer + '/otp/begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: otpEmail })
      }).then(function(r) { return r.json(); });
      if (res.error) { showErr('otp-err', res.error); return; }
      document.getElementById('otp-verify-section').classList.remove('hidden');
    } catch(e) {
      showErr('otp-err', e.message || 'Failed to send code.');
    }
  });

  // OTP verify
  document.getElementById('otp-verify-btn').addEventListener('click', async function() {
    hideErr('otp-err');
    var code = document.getElementById('otp-code').value.trim();
    if (!code) { showErr('otp-err', 'Please enter the code.'); return; }
    try {
      var res = await fetch(issuer + '/otp/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: otpEmail, code: code })
      }).then(function(r) { return r.json(); });
      if (res.error) { showErr('otp-err', res.error); return; }
      showPasskeyPrompt(res.userId);
      setTimeout(function() {
        if (document.getElementById('passkey-prompt').classList.contains('hidden')) {
          completeAuth(res.code);
        } else {
          document.getElementById('passkey-prompt-no').addEventListener('click', function() {
            completeAuth(res.code);
          }, { once: true });
          document.getElementById('passkey-prompt-yes').addEventListener('click', function() {
            completeAuth(res.code);
          }, { once: true });
        }
      }, 100);
    } catch(e) {
      showErr('otp-err', e.message || 'Verification failed.');
    }
  });

  // Magic link
  document.getElementById('magic-btn').addEventListener('click', async function() {
    hideErr('magic-err');
    var email = document.getElementById('magic-email').value.trim();
    if (!email) { showErr('magic-err', 'Please enter your email.'); return; }
    try {
      var res = await fetch(issuer + '/magic/begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
      }).then(function(r) { return r.json(); });
      if (res.error) { showErr('magic-err', res.error); return; }
      document.getElementById('magic-msg').classList.remove('hidden');
      document.getElementById('magic-btn').disabled = true;
    } catch(e) {
      showErr('magic-err', e.message || 'Failed to send link.');
    }
  });
})();
</script>
</body>
</html>`;
}
