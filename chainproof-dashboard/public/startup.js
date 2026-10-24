'use strict';
// VeriMash cold-start readiness screen. No background keep-alive.
(() => {
  const overlay = document.createElement('div');
  overlay.id = 'verimash-startup';
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');
  overlay.innerHTML = `
    <div class="vm-start-card">
      <div class="vm-start-mark">◇</div>
      <div class="vm-start-brand">VeriMash</div>
      <div class="vm-start-eyebrow">CROSS-CHAIN VERIFICATION</div>
      <h1>Preparing your verification environment</h1>
      <p id="vm-start-detail">Connecting to the VeriMash service…</p>
      <div class="vm-start-indicator" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="vm-start-route"><div><strong>A</strong><small>Blockchain A</small></div><span>→</span><div><strong>B</strong><small>Blockchain B</small></div></div>
      <div id="vm-start-trouble" class="vm-start-trouble" hidden>
        <p>The demo service is taking longer than expected. No transaction has been submitted.</p>
        <button id="vm-start-retry" type="button">Retry connection</button>
      </div>
      <p class="vm-start-foot">Temporary local test networks · No real cryptocurrency required</p>
    </div>`;
  document.body.appendChild(overlay);
  const detail = overlay.querySelector('#vm-start-detail');
  const trouble = overlay.querySelector('#vm-start-trouble');
  const retry = overlay.querySelector('#vm-start-retry');
  let run = 0;
  let active = true;
  let waiting = false;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function getJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {cache:'no-store', headers:{'Accept':'application/json'}, signal: controller.signal});
      const type = response.headers.get('content-type') || '';
      if (!type.includes('application/json')) throw new Error('The API route returned a non-JSON page');
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      return body;
    } finally {clearTimeout(timeout);}
  }
  async function check(currentRun) {
    if (waiting || !active || currentRun !== run) return;
    waiting = true;
    try {
      const health = await getJson('/health');
      if (health.ready !== true) {
        detail.textContent = health.note || 'Blockchain A and B are starting…';
        return;
      }
      detail.textContent = 'Verifying both blockchain connections…';
      const status = await getJson('/api/status');
      if (status.online === true && Number(status.chainId) === 31337 && Number(status.chainIdB) === 31338) {
        active = false;
        detail.textContent = 'VeriMash is ready';
        // Existing app refresh may have run before Render was ready.
        document.getElementById('refreshButton')?.click();
        overlay.classList.add('vm-start-done');
        setTimeout(() => overlay.remove(), 450);
      } else {
        detail.textContent = 'Waiting for both blockchain networks to respond…';
      }
    } catch (e) {
      detail.textContent = 'Connecting to the demo service…';
      if (String(e.message).includes('non-JSON')) detail.textContent = 'Checking the VeriMash API connection…';
    } finally {waiting = false;}
  }
  async function loop(currentRun) {
    const started = Date.now();
    trouble.hidden = true;
    retry.disabled = false;
    while (active && currentRun === run && Date.now() - started < 180000) {
      await check(currentRun);
      if (active && currentRun === run) await delay(5000);
    }
    if (active && currentRun === run) {
      detail.textContent = 'VeriMash is not ready yet.';
      trouble.hidden = false;
    }
  }
  retry.addEventListener('click', () => {
    run += 1;
    detail.textContent = 'Retrying the connection…';
    loop(run);
  });
  loop(run);
})();
