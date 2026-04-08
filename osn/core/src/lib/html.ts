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
    input[type="email"], input[type="text"], input[type="password"] {
      width: 100%;
      padding: 0.5rem 0.75rem;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-size: 0.875rem;
      outline: none;
      transition: border-color 0.15s;
    }
    input:focus { border-color: #111; }
    input.valid { border-color: #16a34a; }
    input.invalid { border-color: #c00; }
    .id-toggle {
      display: flex;
      background: #f0f0f0;
      border-radius: 6px;
      padding: 2px;
      gap: 2px;
      margin-bottom: 0.5rem;
    }
    .id-opt {
      flex: 1;
      padding: 0.375rem 0.5rem;
      font-size: 0.8125rem;
      font-weight: 500;
      background: none;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      color: #666;
      transition: background 0.12s, color 0.12s;
    }
    .id-opt.active {
      background: #fff;
      color: #111;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
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
    .hint { font-size: 0.75rem; color: #777; margin: 0; }
    .hint.ok { color: #16a34a; }
    .hint.bad { color: #c00; }
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
    .field { display: flex; flex-direction: column; gap: 0.25rem; }
    .handle-wrap { position: relative; }
    .handle-wrap .at { position: absolute; left: 0.75rem; top: 50%; transform: translateY(-50%); color: #999; font-size: 0.875rem; pointer-events: none; }
    .handle-wrap input { padding-left: 1.5rem; }
  </style>
</head>
<body>
<div class="card">
  <h1 id="page-title">Sign in to OSN</h1>
  <div class="tabs">
    <button class="tab active" data-tab="passkey">Passkey</button>
    <button class="tab" data-tab="otp">One-time code</button>
    <button class="tab" data-tab="magic">Email link</button>
    <button class="tab" data-tab="register">Create account</button>
  </div>

  <!-- Passkey tab -->
  <div class="panel active" id="panel-passkey">
    <div class="field">
      <div class="id-toggle" data-group="passkey">
        <button class="id-opt active" data-mode="email">Email</button>
        <button class="id-opt" data-mode="handle">Handle</button>
      </div>
      <input type="email" id="passkey-email" autocomplete="email webauthn" placeholder="you@example.com" />
      <div class="handle-wrap hidden" id="passkey-handle-wrap">
        <span class="at">@</span>
        <input type="text" id="passkey-handle" autocomplete="username" placeholder="yourhandle" maxlength="30" />
      </div>
    </div>
    <button class="primary" id="passkey-btn">Sign in with passkey</button>
    <p class="err hidden" id="passkey-err"></p>
  </div>

  <!-- OTP tab -->
  <div class="panel" id="panel-otp">
    <div class="field">
      <div class="id-toggle" data-group="otp">
        <button class="id-opt active" data-mode="email">Email</button>
        <button class="id-opt" data-mode="handle">Handle</button>
      </div>
      <input type="email" id="otp-email" autocomplete="email" placeholder="you@example.com" />
      <div class="handle-wrap hidden" id="otp-handle-wrap">
        <span class="at">@</span>
        <input type="text" id="otp-handle" autocomplete="username" placeholder="yourhandle" maxlength="30" />
      </div>
    </div>
    <button class="primary" id="otp-send-btn">Send code</button>
    <div id="otp-verify-section" class="hidden" style="display:flex;flex-direction:column;gap:0.75rem;">
      <div class="field">
        <label for="otp-code">Enter code</label>
        <input type="text" id="otp-code" placeholder="6-digit code" autocomplete="one-time-code" maxlength="6" inputmode="numeric" />
      </div>
      <button class="primary" id="otp-verify-btn">Verify</button>
    </div>
    <p class="err hidden" id="otp-err"></p>
  </div>

  <!-- Magic link tab -->
  <div class="panel" id="panel-magic">
    <div class="field">
      <div class="id-toggle" data-group="magic">
        <button class="id-opt active" data-mode="email">Email</button>
        <button class="id-opt" data-mode="handle">Handle</button>
      </div>
      <input type="email" id="magic-email" autocomplete="email" placeholder="you@example.com" />
      <div class="handle-wrap hidden" id="magic-handle-wrap">
        <span class="at">@</span>
        <input type="text" id="magic-handle" autocomplete="username" placeholder="yourhandle" maxlength="30" />
      </div>
    </div>
    <button class="primary" id="magic-btn">Send magic link</button>
    <p class="msg hidden" id="magic-msg">Check your email for the sign-in link.</p>
    <p class="err hidden" id="magic-err"></p>
  </div>

  <!-- Register tab -->
  <div class="panel" id="panel-register">
    <div class="field">
      <label for="reg-email">Email</label>
      <input type="email" id="reg-email" autocomplete="email" placeholder="you@example.com" />
    </div>
    <div class="field">
      <label for="reg-handle">Handle</label>
      <div class="handle-wrap">
        <span class="at">@</span>
        <input type="text" id="reg-handle" autocomplete="username" placeholder="yourhandle" maxlength="30" />
      </div>
      <p class="hint hidden" id="reg-handle-hint"></p>
    </div>
    <div class="field">
      <label for="reg-display-name">Display name <span style="font-weight:400;color:#999;">(optional)</span></label>
      <input type="text" id="reg-display-name" autocomplete="name" placeholder="Your Name" />
    </div>
    <button class="primary" id="reg-btn">Create account</button>
    <p class="err hidden" id="reg-err"></p>

    <!-- Post-registration: verify via OTP -->
    <div id="reg-otp-section" class="hidden" style="display:flex;flex-direction:column;gap:0.75rem;">
      <p class="msg">Account created! Enter the code sent to your email to sign in.</p>
      <div class="field">
        <label for="reg-otp-code">One-time code</label>
        <input type="text" id="reg-otp-code" placeholder="6-digit code" autocomplete="one-time-code" maxlength="6" inputmode="numeric" />
      </div>
      <button class="primary" id="reg-otp-verify-btn">Verify and sign in</button>
      <p class="err hidden" id="reg-otp-err"></p>
    </div>
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

<script src="https://unpkg.com/@simplewebauthn/browser@13/dist/bundle/index.es5.umd.min.js"></script>
<script>
(function () {
  var P = ${escaped};
  var issuer = P.issuerUrl;

  // ---------------------------------------------------------------------------
  // Cached DOM references (queried once at init)
  // ---------------------------------------------------------------------------
  var tabs = document.querySelectorAll('.tab');
  var panels = document.querySelectorAll('.panel');
  // Tracks which input mode is active per sign-in panel group
  var activeMode = { passkey: 'email', otp: 'email', magic: 'email' };
  // Closure state for multi-step flows
  var otpIdentifier = '';
  var _regEmail = '';
  var _regUserId = '';

  // ---------------------------------------------------------------------------
  // Tab switching
  // ---------------------------------------------------------------------------
  tabs.forEach(function(btn) {
    btn.addEventListener('click', function() {
      tabs.forEach(function(b) { b.classList.remove('active'); });
      panels.forEach(function(p) { p.classList.remove('active'); });
      btn.classList.add('active');
      document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
      document.getElementById('page-title').textContent =
        btn.dataset.tab === 'register' ? 'Create an OSN account' : 'Sign in to OSN';
    });
  });

  // ---------------------------------------------------------------------------
  // Email / Handle toggle (shared across passkey, otp, magic panels)
  // ---------------------------------------------------------------------------
  document.querySelectorAll('.id-toggle').forEach(function(toggle) {
    var group = toggle.dataset.group;
    var emailInput = document.getElementById(group + '-email');
    var handleWrap = document.getElementById(group + '-handle-wrap');
    var handleInput = document.getElementById(group + '-handle');
    toggle.querySelectorAll('.id-opt').forEach(function(btn) {
      btn.addEventListener('click', function() {
        toggle.querySelectorAll('.id-opt').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        activeMode[group] = btn.dataset.mode;
        if (btn.dataset.mode === 'email') {
          emailInput.classList.remove('hidden');
          handleWrap.classList.add('hidden');
          emailInput.focus();
        } else {
          emailInput.classList.add('hidden');
          handleWrap.classList.remove('hidden');
          handleInput.focus();
        }
      });
    });
  });

  /** Returns the current identifier value for a given panel group. */
  function getIdentifier(group) {
    return activeMode[group] === 'handle'
      ? document.getElementById(group + '-handle').value.trim()
      : document.getElementById(group + '-email').value.trim();
  }

  function showErr(id, msg) {
    var el = document.getElementById(id);
    el.textContent = msg;
    el.classList.remove('hidden');
    el.style.display = '';
  }
  function hideErr(id) {
    var el = document.getElementById(id);
    el.classList.add('hidden');
  }

  function completeAuth(code) {
    var url = new URL(P.redirectUri);
    url.searchParams.set('code', code);
    url.searchParams.set('state', P.state);
    window.location.href = url.toString();
  }

  // ---------------------------------------------------------------------------
  // Post-auth passkey prompt
  // ---------------------------------------------------------------------------
  function showPasskeyPrompt(userId, onDone) {
    var prompt = document.getElementById('passkey-prompt');
    prompt.classList.remove('hidden');

    function dismiss() {
      prompt.classList.add('hidden');
      onDone();
    }

    document.getElementById('passkey-prompt-no').onclick = dismiss;

    document.getElementById('passkey-prompt-yes').onclick = async function() {
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
      } catch(e) {
        console.error('Passkey registration failed:', e);
      }
      dismiss();
    };
  }

  // ---------------------------------------------------------------------------
  // Passkey sign-in
  // ---------------------------------------------------------------------------
  document.getElementById('passkey-btn').addEventListener('click', async function() {
    hideErr('passkey-err');
    var identifier = getIdentifier('passkey');
    if (!identifier) { showErr('passkey-err', 'Please enter your email or handle.'); return; }
    try {
      var beginRes = await fetch(issuer + '/passkey/login/begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: identifier })
      }).then(function(r) { return r.json(); });

      if (beginRes.error) {
        // No account or no passkeys — pre-fill OTP panel and switch to it
        if (activeMode.otp === 'handle' && !identifier.includes('@')) {
          document.getElementById('otp-handle').value = identifier;
        } else {
          document.getElementById('otp-email').value = identifier;
        }
        tabs.forEach(function(b) { b.classList.remove('active'); });
        panels.forEach(function(p) { p.classList.remove('active'); });
        document.querySelector('.tab[data-tab="otp"]').classList.add('active');
        document.getElementById('panel-otp').classList.add('active');
        showErr('otp-err', 'No passkey found — receive a one-time code instead.');
        return;
      }

      var assertion = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: beginRes.options });
      var completeRes = await fetch(issuer + '/passkey/login/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: identifier, assertion: assertion })
      }).then(function(r) { return r.json(); });

      if (completeRes.error) { showErr('passkey-err', completeRes.error); return; }
      completeAuth(completeRes.code);
    } catch(e) {
      showErr('passkey-err', e.message || 'Sign-in failed.');
    }
  });

  // ---------------------------------------------------------------------------
  // OTP sign-in
  // ---------------------------------------------------------------------------

  document.getElementById('otp-send-btn').addEventListener('click', async function() {
    hideErr('otp-err');
    otpIdentifier = getIdentifier('otp');
    if (!otpIdentifier) { showErr('otp-err', 'Please enter your email or handle.'); return; }
    try {
      var res = await fetch(issuer + '/otp/begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: otpIdentifier })
      }).then(function(r) { return r.json(); });
      if (res.error) { showErr('otp-err', res.error); return; }
      var section = document.getElementById('otp-verify-section');
      section.classList.remove('hidden');
      section.style.display = 'flex';
    } catch(e) {
      showErr('otp-err', e.message || 'Failed to send code.');
    }
  });

  document.getElementById('otp-verify-btn').addEventListener('click', async function() {
    hideErr('otp-err');
    var code = document.getElementById('otp-code').value.trim();
    if (!code) { showErr('otp-err', 'Please enter the code.'); return; }
    try {
      var res = await fetch(issuer + '/otp/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: otpIdentifier, code: code })
      }).then(function(r) { return r.json(); });
      if (res.error) { showErr('otp-err', res.error); return; }
      showPasskeyPrompt(res.userId, function() { completeAuth(res.code); });
    } catch(e) {
      showErr('otp-err', e.message || 'Verification failed.');
    }
  });

  // ---------------------------------------------------------------------------
  // Magic link sign-in
  // ---------------------------------------------------------------------------
  document.getElementById('magic-btn').addEventListener('click', async function() {
    hideErr('magic-err');
    var identifier = getIdentifier('magic');
    if (!identifier) { showErr('magic-err', 'Please enter your email or handle.'); return; }
    try {
      var res = await fetch(issuer + '/magic/begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: identifier })
      }).then(function(r) { return r.json(); });
      if (res.error) { showErr('magic-err', res.error); return; }
      document.getElementById('magic-msg').classList.remove('hidden');
      document.getElementById('magic-btn').disabled = true;
    } catch(e) {
      showErr('magic-err', e.message || 'Failed to send link.');
    }
  });

  // ---------------------------------------------------------------------------
  // Registration with handle claiming
  // ---------------------------------------------------------------------------
  var handleCheckTimer = null;
  var handleAvailable = false;

  document.getElementById('reg-handle').addEventListener('input', function() {
    clearTimeout(handleCheckTimer);
    var handle = this.value.trim().toLowerCase();
    var hint = document.getElementById('reg-handle-hint');
    var input = this;

    input.classList.remove('valid', 'invalid');
    hint.className = 'hint hidden';
    handleAvailable = false;

    if (!handle) return;

    // Basic format check client-side before hitting the server
    if (!/^[a-z0-9_]{1,30}$/.test(handle)) {
      hint.textContent = 'Handles can only contain lowercase letters, numbers, and underscores (max 30 chars).';
      hint.className = 'hint bad';
      input.classList.add('invalid');
      return;
    }

    hint.textContent = 'Checking\u2026';
    hint.className = 'hint';

    handleCheckTimer = setTimeout(async function() {
      try {
        var res = await fetch(issuer + '/handle/' + encodeURIComponent(handle)).then(function(r) { return r.json(); });
        if (res.available) {
          hint.textContent = '@' + handle + ' is available';
          hint.className = 'hint ok';
          input.classList.remove('invalid');
          input.classList.add('valid');
          handleAvailable = true;
        } else {
          hint.textContent = '@' + handle + ' is already taken';
          hint.className = 'hint bad';
          input.classList.remove('valid');
          input.classList.add('invalid');
          handleAvailable = false;
        }
      } catch(e) {
        hint.textContent = 'Could not check handle availability.';
        hint.className = 'hint bad';
      }
    }, 350);
  });

  document.getElementById('reg-btn').addEventListener('click', async function() {
    hideErr('reg-err');
    var email = document.getElementById('reg-email').value.trim();
    var handle = document.getElementById('reg-handle').value.trim().toLowerCase();
    var displayName = document.getElementById('reg-display-name').value.trim();

    if (!email) { showErr('reg-err', 'Please enter your email.'); return; }
    if (!handle) { showErr('reg-err', 'Please enter a handle.'); return; }
    if (!handleAvailable) { showErr('reg-err', 'Please choose an available handle.'); return; }

    this.disabled = true;
    try {
      var body = { email: email, handle: handle };
      if (displayName) body.displayName = displayName;

      var res = await fetch(issuer + '/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function(r) { return r.json(); });

      if (res.error) {
        showErr('reg-err', res.error);
        this.disabled = false;
        return;
      }

      // Registration succeeded — hide the form, show OTP verification
      document.getElementById('reg-btn').classList.add('hidden');
      document.getElementById('reg-email').disabled = true;
      document.getElementById('reg-handle').disabled = true;
      document.getElementById('reg-display-name').disabled = true;

      // Trigger OTP send automatically so user can sign in immediately
      var otpSent = await fetch(issuer + '/otp/begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: email })
      }).then(function(r) { return r.json(); });

      var regOtpSection = document.getElementById('reg-otp-section');
      regOtpSection.classList.remove('hidden');
      regOtpSection.style.display = 'flex';

      if (otpSent.error) {
        showErr('reg-otp-err', 'Account created but could not send code: ' + otpSent.error);
      }

      // Store for the OTP verify step (closure vars, not window globals)
      _regEmail = email;
      _regUserId = res.userId;
    } catch(e) {
      showErr('reg-err', e.message || 'Registration failed.');
      document.getElementById('reg-btn').disabled = false;
    }
  });

  document.getElementById('reg-otp-verify-btn').addEventListener('click', async function() {
    hideErr('reg-otp-err');
    var code = document.getElementById('reg-otp-code').value.trim();
    if (!code) { showErr('reg-otp-err', 'Please enter the code.'); return; }
    try {
      var res = await fetch(issuer + '/otp/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: _regEmail, code: code })
      }).then(function(r) { return r.json(); });
      if (res.error) { showErr('reg-otp-err', res.error); return; }
      showPasskeyPrompt(_regUserId, function() { completeAuth(res.code); });
    } catch(e) {
      showErr('reg-otp-err', e.message || 'Verification failed.');
    }
  });
})();
</script>
</body>
</html>`;
}
