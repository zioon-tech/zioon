export const identityStyles = `
:root{--bg:#fafafa;--panel:#fafafa;--field:#fff;--field-muted:#f2f3f3;--text:#202523;--muted:#727975;--faint:#929994;--line:#e5e8e6;--line-strong:#d9dedb;--accent:#237862;--accent-hover:#1a6451;--accent-soft:#23786214}
:root[data-theme="dark"]{--bg:#161918;--panel:#161918;--field:#1c201e;--field-muted:#252b27;--text:#eff3f0;--muted:#a3ada6;--faint:#79867d;--line:#303a33;--line-strong:#404d44;--accent:#7dc8a9;--accent-hover:#8bd7b7;--accent-soft:#7dc8a91a}
body{font-size:14px;-webkit-font-smoothing:antialiased}
.product-bar{height:80px;padding:0 40px;border:0;background:transparent}
.brand{gap:11px}.brand-mark{width:30px;height:30px;flex-basis:30px}.brand strong{font-size:21px;font-weight:650}
.environment,.auth-context{display:none}
.auth-shell{min-height:calc(100svh - 80px);padding:44px 24px 12vh;place-items:center}
.auth-panel{width:min(384px,100%);animation:auth-enter 180ms ease-out}
h1{font-size:30px;line-height:1.25;font-weight:620;margin-bottom:10px;letter-spacing:-.7px}
p{font-size:14px;line-height:1.65;margin-top:8px}
form{gap:20px;margin:28px 0 22px}
label{font-size:13px;font-weight:550;gap:9px}
input{height:48px;border-radius:9px;padding:0 14px;font-size:15px;border-color:var(--line-strong)}
input::placeholder{color:var(--faint)}input:focus{box-shadow:0 0 0 3px var(--accent-soft)}
button,.button{min-height:46px;border-radius:9px;font-size:14px;font-weight:580;gap:9px;text-decoration:none}
.social{margin:0;background:var(--field);color:var(--text)}
form>button{margin-top:2px}.divider{margin:6px 0 24px;font-size:12px}
.actions{justify-content:center;flex-wrap:wrap;gap:12px 22px}.actions a,.text-link,.return-link{font-size:13px}
.hint{font-size:12px;line-height:1.6}.notice,.error{padding:13px 15px;border-radius:9px;font-size:13px;line-height:1.65}
footer{margin-top:40px;padding-top:0;border:0;justify-content:center;flex-direction:column;gap:10px;font-size:12px}
footer>span{display:none}.return-link{color:var(--muted)}
.password-field{position:relative}.password-field input{padding-right:62px}
.password-toggle{position:absolute;right:6px;top:6px;min-height:36px;padding:0 10px;border:0;background:transparent;color:var(--muted);font-size:12px}
.password-toggle:hover{background:var(--field-muted);color:var(--text)}
.method-list{margin-top:30px;display:grid;gap:0}
.method-row{display:grid;grid-template-columns:40px minmax(0,1fr) auto;align-items:center;gap:13px;padding:20px 0;border-bottom:1px solid var(--line)}
.method-icon{height:40px;display:grid;place-items:center;border-radius:10px;background:var(--field-muted);color:var(--muted);font-size:16px}
.method-row strong{display:block;font-size:14px;font-weight:580}.method-row small{display:block;margin-top:4px;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
.method-row form{margin:0;display:block}.method-row button{min-height:36px;padding:0 13px;font-size:13px;background:var(--field);color:var(--text);border-color:var(--line-strong)}
.linked{color:var(--accent);font-size:12px;white-space:nowrap}
.completion{padding:24px 0 10px}.completion-icon{width:44px;height:44px;display:grid;place-items:center;border-radius:50%;background:var(--accent-soft);color:var(--accent);margin-bottom:22px;font-size:22px}
.resend-form{margin:14px 0}.resend-form button{border:0;background:transparent;color:var(--accent);min-height:36px}
.busy-dot{width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:auth-spin .7s linear infinite}
button:disabled{opacity:.6;cursor:wait}
@keyframes auth-spin{to{transform:rotate(360deg)}}@keyframes auth-enter{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:600px){.product-bar{height:72px;padding:0 24px}.auth-shell{min-height:calc(100svh - 72px);padding:32px 24px 60px;place-items:start center}h1{font-size:28px}footer{align-items:center}.method-row{grid-template-columns:34px minmax(0,1fr) auto;gap:10px}}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#161918;--panel:#161918;--field:#1c201e;--field-muted:#252b27;--text:#eff3f0;--muted:#a3ada6;--faint:#79867d;--line:#303a33;--line-strong:#404d44;--accent:#7dc8a9;--accent-hover:#8bd7b7;--accent-soft:#7dc8a91a}}
@media(prefers-reduced-motion:reduce){.auth-panel,.busy-dot{animation:none}*{transition:none!important}}
`;

// Progressive enhancement: forms still work without JavaScript.
export const identityScript = `
for (const input of document.querySelectorAll('input[type="password"]')) {
  const field = document.createElement('div');
  field.className = 'password-field';
  input.replaceWith(field); field.append(input);
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.className = 'password-toggle'; toggle.textContent = '显示';
  toggle.setAttribute('aria-label', '显示密码'); toggle.setAttribute('aria-pressed', 'false');
  toggle.onclick = () => {
    const visible = input.type === 'password'; input.type = visible ? 'text' : 'password';
    toggle.textContent = visible ? '隐藏' : '显示';
    toggle.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
    toggle.setAttribute('aria-pressed', String(visible));
  };
  field.append(toggle);
}
for (const form of document.querySelectorAll('form')) {
  form.addEventListener('submit', event => {
    if (form.dataset.busy) { event.preventDefault(); return; }
    form.dataset.busy = '1'; form.setAttribute('aria-busy', 'true');
    const button = form.querySelector('button[type="submit"]');
    if (button) {
      button.dataset.original = button.innerHTML; button.disabled = true;
      const spinner = document.createElement('span'); spinner.className = 'busy-dot'; spinner.setAttribute('aria-hidden','true');
      button.replaceChildren(spinner, document.createTextNode(form.action.includes('/github') ? '正在打开 GitHub…' : '正在处理…'));
    }
  });
}
window.addEventListener('pageshow', () => {
  for (const form of document.querySelectorAll('form[data-busy]')) {
    delete form.dataset.busy; form.removeAttribute('aria-busy');
    const button = form.querySelector('button[type="submit"]');
    if (button) { button.disabled = false; button.innerHTML = button.dataset.original || '继续'; }
  }
});
for (const button of document.querySelectorAll('[data-cooldown]')) {
  let seconds = Number(button.dataset.cooldown); const original = button.textContent;
  if (seconds > 0) {
    button.disabled = true; button.textContent = seconds + ' 秒后重新发送';
    const timer = setInterval(() => {
      seconds -= 1; button.textContent = seconds > 0 ? seconds + ' 秒后重新发送' : original;
      if (seconds <= 0) { button.disabled = false; clearInterval(timer); }
    }, 1000);
  }
}
`;
