/* PLAENS admin dashboard. Plain JavaScript, no build step.
   All data calls go to window.PlaensServer (js/server.js), which runs in the browser
   and saves to this browser or to Firebase (see js/firebase-config.js). */
'use strict';

/* ================= Core helpers ================= */

const LOCK_KEY = 'plaens_admin_lock';
const UNLOCKED_KEY = 'plaens_admin_unlocked';
const state = { settings: null, meta: null, emailConfigured: false, storage: null, mode: 'local', user: '' };
const LOGO_RECEIPT = new URL('assets/logo-receipt.png', location.href).href;
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const isCloud = () => state.mode === 'cloud';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;

const LABELS = {
  method: { cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', cod: 'Cash on delivery', online: 'Online payment' },
  channel: { online: 'Website', instagram: 'Instagram', facebook: 'Facebook', whatsapp: 'WhatsApp', store: 'In store', other: 'Other' },
  payment: { unpaid: 'Unpaid', paid: 'Paid', refunded: 'Refunded' },
  fulfillment: { unfulfilled: 'Unfulfilled', shipped: 'Shipped', delivered: 'Delivered' },
  reason: { initial: 'Opening stock', restock: 'Restock', sale: 'Sale', return: 'Returned', cancelled: 'Order cancelled', damage: 'Damaged', lost: 'Lost', adjustment: 'Count correction' },
  expense: { marketing: 'Marketing', packaging: 'Packaging', shipping: 'Shipping & courier', rent: 'Rent', salaries: 'Salaries', utilities: 'Utilities', software: 'Software & apps', fees: 'Bank & payment fees', other: 'Other' },
  status: { active: 'Active', draft: 'Draft', archived: 'Archived' },
};

const options = (map, selected) =>
  Object.entries(map).map(([v, l]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${esc(l)}</option>`).join('');

let moneyFmt = null;
function money(n) {
  const cur = state.settings?.currency || 'LKR';
  if (!moneyFmt || moneyFmt.cur !== cur) {
    try {
      const f = new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: 2 });
      moneyFmt = { cur, format: (x) => f.format(x) };
    } catch {
      moneyFmt = { cur, format: (x) => `${cur} ${Number(x).toFixed(2)}` };
    }
  }
  return moneyFmt.format(Number(n) || 0);
}
const asDate = (d) => new Date(typeof d === 'string' && d.length === 10 ? `${d}T12:00:00` : d);
const fmtDate = (d) => asDate(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtShort = (d) => asDate(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const fmtDateTime = (d) => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
const variantLabel = (v) => [v.size, v.color].filter(Boolean).join(' / ') || 'Default';
const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/** Same shape as a real API call, but handled in the browser by js/server.js */
function api(path, { method = 'GET', body } = {}) {
  return window.PlaensServer.handle(method, path, body);
}

function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, kind === 'error' ? 6500 : 3800);
}

async function busy(btn, fn) {
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('busy');
  try { return await fn(); } finally { btn.disabled = false; btn.classList.remove('busy'); }
}

function downloadFile(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function openDialog({ title, body, wide = false, onMount }) {
  const dlg = document.createElement('dialog');
  dlg.className = `dlg${wide ? ' wide' : ''}`;
  dlg.setAttribute('aria-label', title);
  dlg.innerHTML = `<div class="dlg-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">&times;</button></div><div class="dlg-body">${body}</div>`;
  document.body.append(dlg);
  const close = () => {
    if (!dlg.open || dlg.classList.contains('closing')) return;
    if (reduceMotion()) return dlg.close();
    dlg.classList.add('closing');
    setTimeout(() => dlg.open && dlg.close(), 190);
  };
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); }); // Esc key
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
    if (e.target === dlg) close(); // click on backdrop
  });
  dlg.showModal();
  if (onMount) onMount(dlg, close);
  return { dlg, close };
}

/** Confirmation with an optional checkbox or typed word. Resolves to null (cancelled) or { checked }. */
function confirmDialog({ title, message, confirmLabel, danger = false, checkbox = null, typeToConfirm = null }) {
  return new Promise((resolve) => {
    let result = null;
    const { dlg } = openDialog({
      title,
      body: `<p>${message}</p>
        ${checkbox ? `<label class="check" style="margin-top:16px"><input type="checkbox" id="cfCheck" ${checkbox.checked ? 'checked' : ''}> ${esc(checkbox.label)}</label>` : ''}
        ${typeToConfirm ? `<label class="field" style="margin-top:16px">Type ${esc(typeToConfirm)} to confirm<input id="cfType" autocomplete="off"></label>` : ''}
        <div class="form-foot"><span class="grow"></span><button type="button" class="btn" data-close>Keep as is</button>
        <button type="button" class="btn ${danger ? 'danger' : 'primary'}" id="cfOk" ${typeToConfirm ? 'disabled' : ''}>${esc(confirmLabel)}</button></div>`,
      onMount: (d, close) => {
        const ok = $('#cfOk', d);
        if (typeToConfirm) {
          const input = $('#cfType', d);
          input.focus();
          input.oninput = () => { ok.disabled = input.value.trim().toUpperCase() !== typeToConfirm; };
        } else ok.focus();
        ok.onclick = () => { result = { checked: checkbox ? $('#cfCheck', d).checked : false }; close(); };
      },
    });
    dlg.addEventListener('close', () => resolve(result));
  });
}

const formData = (form) => Object.fromEntries(new FormData(form).entries());

/* ================= Receipts: PDF, share, email ================= */

const loadScript = (src) => new Promise((resolve, reject) => {
  if (document.querySelector(`script[data-src="${src}"]`)) return resolve();
  const el = document.createElement('script');
  el.src = src;
  el.dataset.src = src;
  el.onload = resolve;
  el.onerror = () => reject(new Error(`Couldn't load ${src}. Check that the js/vendor folder is uploaded.`));
  document.head.append(el);
});

let logoDataUrl = null;
async function receiptLogoDataUrl() {
  if (logoDataUrl) return logoDataUrl;
  const blob = await (await fetch('assets/logo-receipt.png')).blob();
  logoDataUrl = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
  return logoDataUrl;
}

/** Renders the receipt design into a real A4 PDF. The PDF libraries load only the first time. */
async function receiptPdf(order) {
  if (!window.html2canvas) await loadScript('js/vendor/html2canvas.min.js');
  if (!window.jspdf) await loadScript('js/vendor/jspdf.umd.min.js');
  let { html } = await api(`/orders/${order.id}/receipt?images=1`); // product photos are embedded for the PDF
  try { html = html.split(LOGO_RECEIPT).join(await receiptLogoDataUrl()); } catch { /* opened from disk: PDF without logo */ }

  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:640px;height:1800px;border:0;';
  document.body.append(frame);
  try {
    await new Promise((resolve) => { frame.onload = resolve; frame.srcdoc = html; });
    const doc = frame.contentDocument;
    await Promise.all([...doc.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = r; img.onerror = r; }))));
    const card = doc.getElementById('receipt-card') || doc.body;
    const canvas = await window.html2canvas(card, { scale: 2.5, backgroundColor: '#FFFFFF', logging: false });

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
    pdf.setProperties({ title: `Receipt ${order.orderNumber}`, author: state.settings.storeName, subject: 'Order receipt' });
    const pageW = 210;
    const pageH = 297;
    const margin = 12;
    const usable = pageH - margin * 2;
    let imgW = pageW - margin * 2;
    let imgH = (canvas.height * imgW) / canvas.width;
    const img = canvas.toDataURL('image/jpeg', 0.93);
    if (imgH <= usable * 1.45) {
      // Normal receipts: shrink slightly if needed so everything sits on one page, centred.
      const scale = Math.min(1, usable / imgH);
      imgW *= scale;
      imgH *= scale;
      pdf.addImage(img, 'JPEG', (pageW - imgW) / 2, margin, imgW, imgH);
    } else {
      // Very long orders: continue across pages.
      for (let offset = 0; offset < imgH; offset += usable) {
        if (offset > 0) pdf.addPage();
        pdf.addImage(img, 'JPEG', margin, margin - offset, imgW, imgH);
        pdf.setFillColor(255, 255, 255); // keep the page margins clean
        pdf.rect(0, 0, pageW, margin, 'F');
        pdf.rect(0, pageH - margin, pageW, margin, 'F');
      }
    }
    return pdf.output('blob');
  } finally {
    frame.remove();
  }
}

const pdfName = (order) => `${(state.settings.storeName || 'PLAENS').replace(/[^\w-]+/g, '')}-${order.orderNumber}-receipt.pdf`;

async function downloadReceiptPdf(order) {
  const blob = await receiptPdf(order);
  downloadFile(pdfName(order), blob);
  toast(`Saved ${pdfName(order)}`);
}

/** Phones can hand the PDF straight to WhatsApp, Gmail and so on. */
const canSharePdf = () => {
  try { return Boolean(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] })); } catch { return false; }
};

async function sharePdf(order) {
  const blob = await receiptPdf(order);
  const file = new File([blob], pdfName(order), { type: 'application/pdf' });
  try {
    await navigator.share({ files: [file], title: `Receipt ${order.orderNumber}` });
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  }
}

/** Preview with every way to get the receipt to a customer. */
async function receiptDialog(order) {
  const r = await api(`/orders/${order.id}/receipt`);
  const phone = String(order.customer.phone || '').trim();
  const waNumber = phone.startsWith('+') ? phone.replace(/\D/g, '') : '';
  const waLink = `https://wa.me/${waNumber}?text=${enc(r.text)}`;
  const mailLink = `mailto:${enc(order.customer.email || '')}?subject=${enc(r.subject)}&body=${enc(r.text)}`;
  const closed = order.cancelled || order.paymentStatus === 'refunded';
  openDialog({
    title: `Receipt for ${order.orderNumber}`,
    wide: true,
    body: `<iframe class="receipt-frame" sandbox="allow-same-origin" title="Receipt preview"></iframe>
      <div class="share-row">
        <button type="button" class="btn primary" id="rPdf">Download PDF</button>
        ${canSharePdf() ? '<button type="button" class="btn" id="rShare">Share PDF</button>' : ''}
        <button type="button" class="btn" id="rEmail" ${closed || !order.customer.email ? 'disabled' : ''}>Email receipt</button>
        <button type="button" class="btn" id="rPrint">Print</button>
        <a class="btn" href="${waLink}" target="_blank" rel="noopener">WhatsApp text</a>
        <a class="btn" href="${mailLink}">Email app</a>
      </div>
      <p class="hint" style="margin-top:12px">${canSharePdf() ? '“Share PDF” sends the file straight to WhatsApp, Gmail or any app on this phone. ' : 'Attach the PDF to a WhatsApp or email message, or send the plain text version. '}${!state.emailConfigured
        ? '“Email receipt” needs email connected in Settings.'
        : order.customer.email ? `“Email receipt” sends this design to ${esc(order.customer.email)}.` : 'Add an email to this customer to email the receipt.'}</p>`,
    onMount: (d) => {
      $('iframe', d).srcdoc = r.html;
      $('#rPdf', d).onclick = (e) => busy(e.currentTarget, () => downloadReceiptPdf(order).catch((err) => toast(err.message, 'error')));
      $('#rShare', d)?.addEventListener('click', (e) => busy(e.currentTarget, () => sharePdf(order).catch((err) => toast(err.message, 'error'))));
      $('#rPrint', d).onclick = () => {
        const frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
        frame.srcdoc = r.html;
        frame.onload = () => { frame.contentWindow.focus(); frame.contentWindow.print(); setTimeout(() => frame.remove(), 60000); };
        document.body.append(frame);
      };
      $('#rEmail', d).onclick = (e) => busy(e.currentTarget, async () => {
        try {
          const { email } = await api(`/orders/${order.id}/send-receipt`, { method: 'POST' });
          emailToast(email);
        } catch (err) { toast(err.message, 'error'); }
      });
    },
  });
}

function emailToast(email) {
  if (!email) return;
  if (!email.ok) return toast(email.error || "The receipt couldn't be sent.", 'error');
  toast(`Receipt emailed to ${email.to}.`);
}

/* ================= Shared view pieces ================= */

const pageHead = (title, sub = '', actions = '') => `
  <header class="page-head">
    <div><h1>${esc(title)}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div>
    ${actions ? `<div class="actions">${actions}</div>` : ''}
  </header>`;

const empty = (message, action = '') => `<div class="empty"><p>${message}</p>${action}</div>`;

function backupAge() {
  const last = state.meta?.lastBackupAt;
  return last ? Math.floor((Date.now() - new Date(last)) / 86400000) : null;
}

function backupBanner(hasData) {
  const age = backupAge();
  const limit = isCloud() ? 30 : 7;
  if (!hasData || (age !== null && age < limit)) return '';
  const text = isCloud()
    ? `<strong>Keep a backup file too.</strong> Your data is safe in Firebase, but a monthly backup file protects against accidental deletes${age === null ? '' : ` (last one ${age} days ago)`}.`
    : `<strong>Back up your store.</strong> Your data is saved in this browser only${age === null ? ' and hasn’t been backed up yet' : `, and the last backup was ${age} days ago`}. If this browser’s data is cleared, a backup file is the only way to get it back.`;
  return `<div class="banner"><p>${text}</p><button type="button" class="btn small" data-backup>Download backup</button></div>`;
}

async function downloadBackup() {
  const backup = await api('/backup');
  downloadFile(`plaens-backup-${dayKey()}.json`, JSON.stringify(backup), 'application/json');
  state.meta = backup.data.meta;
  updateSidebarBackup();
  toast('Backup downloaded. Keep it somewhere safe, like Google Drive.');
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-backup]');
  if (b) busy(b, () => downloadBackup().catch((err) => toast(err.message, 'error'))).then(() => b.closest('.banner')?.remove());
});

function statusPills(o) {
  if (o.cancelled) return '<span class="pill cancelled">Cancelled</span>';
  if (o.paymentStatus === 'refunded') return '<span class="pill refunded">Refunded</span>';
  return `<span class="pill ${o.paymentStatus}">${LABELS.payment[o.paymentStatus]}</span><span class="pill ${o.fulfillmentStatus}">${LABELS.fulfillment[o.fulfillmentStatus]}</span>`;
}

function ordersTable(orders, { compact = false } = {}) {
  return `<table class="table">
    <thead><tr>
      <th>Order</th><th>Date</th><th>Customer</th>${compact ? '' : '<th>Channel</th>'}<th>Status</th>
      <th class="num">Total</th>${compact ? '' : '<th class="num">Profit</th>'}
    </tr></thead>
    <tbody>${orders.map((o) => {
      const closed = o.cancelled || o.paymentStatus === 'refunded';
      return `<tr data-href="#/orders/${o.id}">
        <td><a href="#/orders/${o.id}" class="strong">${esc(o.orderNumber)}</a></td>
        <td class="sub">${compact ? fmtShort(o.createdAt) : fmtDate(o.createdAt)}</td>
        <td>${esc(o.customer.name)}</td>
        ${compact ? '' : `<td class="sub">${esc(LABELS.channel[o.channel] || o.channel)}</td>`}
        <td>${statusPills(o)}</td>
        <td class="num strong">${money(o.total)}</td>
        ${compact ? '' : `<td class="num ${closed ? 'muted' : o.grossProfit >= 0 ? '' : 'neg'}">${closed ? 'n/a' : money(o.grossProfit)}</td>`}
      </tr>`;
    }).join('')}</tbody></table>`;
}

function wireRowLinks(root) {
  root.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-href]');
    if (row && !e.target.closest('a, button, input, select')) location.hash = row.dataset.href;
  });
}

function stockClass(stock, threshold) {
  if (stock === 0) return 'stock-num out';
  if (stock <= threshold) return 'stock-num low';
  return 'stock-num';
}

/* ================= Passcode lock =================
   A privacy screen for shared computers. Data itself isn't encrypted:
   anyone with access to this browser's developer tools could read it. */

const getLock = () => { if (isCloud()) return null; try { return JSON.parse(localStorage.getItem(LOCK_KEY)); } catch { return null; } };

async function hashPasscode(code, salt) {
  const data = new TextEncoder().encode(`${salt}:${code}`);
  if (crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 0x811c9dc5; // fallback where crypto.subtle is unavailable
  for (const b of data) { h ^= b; h = Math.imul(h, 16777619); }
  return `f${(h >>> 0).toString(16)}`;
}

async function setPasscode(code) {
  if (!code) { localStorage.removeItem(LOCK_KEY); return; }
  const salt = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16)).join('');
  localStorage.setItem(LOCK_KEY, JSON.stringify({ salt, hash: await hashPasscode(code, salt) }));
  sessionStorage.setItem(UNLOCKED_KEY, '1');
}

function lockNow() {
  sessionStorage.removeItem(UNLOCKED_KEY);
  render();
}

const logoAnim = (extra = '') => `<div class="logo-anim ${extra}"><div class="letters"></div><div class="bar"></div></div>`;

const brandPanel = (line) => `
  <section class="login-art" aria-hidden="true">
    ${logoAnim()}
    <div class="mark">${esc((state.settings?.storeName || 'PLAENS').toUpperCase())}</div>
    <p>${line}</p>
  </section>`;

function staggerForm(root) {
  $$('form > *', root).forEach((el, i) => el.style.setProperty('--i', Math.min(i, 10)));
}

function viewLock() {
  $('#app').innerHTML = `
    <div class="login">
      ${brandPanel('Stock, orders, customers and profit, in one place.')}
      <section class="login-form">
        <form id="lockForm" novalidate>
          <h1>Enter passcode</h1>
          <label class="field">Passcode<input name="code" type="password" inputmode="numeric" autocomplete="current-password" required></label>
          <p class="form-error" id="lockError"></p>
          <button class="btn primary block" type="submit">Unlock</button>
          <button class="btn ghost" type="button" id="forgot">Forgot passcode?</button>
        </form>
      </section>
    </div>`;
  const form = $('#lockForm');
  staggerForm($('#app'));
  form.code.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const lock = getLock();
    if (lock && (await hashPasscode(form.code.value, lock.salt)) === lock.hash) {
      sessionStorage.setItem(UNLOCKED_KEY, '1');
      render();
    } else {
      $('#lockError').textContent = "That passcode isn't right.";
      form.code.select();
    }
  };
  $('#forgot').onclick = async () => {
    const r = await confirmDialog({
      title: 'Remove the passcode?',
      message: 'Your store data stays exactly as it is. The dashboard will open without a passcode until you set a new one in Settings.',
      confirmLabel: 'Remove passcode', danger: true, typeToConfirm: 'REMOVE',
    });
    if (!r) return;
    await setPasscode('');
    sessionStorage.setItem(UNLOCKED_KEY, '1');
    render();
  };
}

/* ================= First-time setup ================= */

async function viewSetup() {
  let local = null;
  if (isCloud()) {
    try {
      const raw = await window.PlaensServer.readLocalData();
      if (raw && raw.meta && raw.meta.setupComplete && ((raw.products || []).length || (raw.orders || []).length)) local = raw;
    } catch { /* no browser data */ }
  }
  $('#app').innerHTML = `
    <div class="login">
      ${brandPanel('Set up once, and this browser becomes your store’s back office.')}
      <section class="login-form">
        <form id="setupForm" novalidate>
          <h1>Set up your store</h1>
          <label class="field">Store name<input name="storeName" value="PLAENS" required></label>
          <label class="field">Currency<input name="currency" value="LKR" maxlength="3" style="text-transform:uppercase"><small>3-letter code, for example LKR or USD.</small></label>
          ${isCloud() ? `<p class="hint" style="margin:0">Signed in as ${esc(state.user)}. This store will be saved in Firebase.</p>` : '<label class="field">Passcode (optional)<input name="code" type="password" autocomplete="new-password"><small>Asks for a passcode when the dashboard opens. Useful on a shared computer.</small></label>'}
          <fieldset style="margin:0">
            <legend>How do you want to start?</legend>
            ${local ? `<label class="check" style="margin-top:8px"><input type="radio" name="start" value="local" checked> Copy the data saved in this browser (${(local.products || []).length} products, ${(local.orders || []).length} orders)</label>` : ''}
            <label class="check" style="margin-top:8px"><input type="radio" name="start" value="sample" ${local ? '' : 'checked'}> With sample products and orders, to explore first</label>
            <label class="check" style="margin-top:8px"><input type="radio" name="start" value="empty"> With an empty store</label>
          </fieldset>
          <p class="form-error" id="setupError"></p>
          <button class="btn primary block" type="submit">Open the dashboard</button>
          <label class="btn ghost" style="cursor:pointer">Restore from a backup file instead<input type="file" id="restoreFile" accept=".json,application/json" hidden></label>
        </form>
      </section>
    </div>`;
  const form = $('#setupForm');
  staggerForm($('#app'));
  form.onsubmit = (e) => {
    e.preventDefault();
    const v = formData(form);
    busy(form.querySelector('[type=submit]'), async () => {
      try {
        if (v.start === 'local' && local) {
          await api('/restore', { method: 'POST', body: { backup: { app: 'plaens-admin', version: 1, data: local } } });
          await api('/settings', { method: 'PUT', body: { storeName: v.storeName, currency: v.currency } });
        } else {
          await api('/setup', { method: 'POST', body: { storeName: v.storeName, currency: v.currency, sample: v.start === 'sample' } });
        }
        if (!isCloud()) await setPasscode(v.code);
        if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
        location.hash = '#/dashboard';
        render();
      } catch (err) { $('#setupError').textContent = err.message; }
    });
  };
  $('#restoreFile').onchange = (e) => restoreFromFile(e.target.files[0]).then((ok) => ok && render());
}

async function restoreFromFile(file) {
  if (!file) return false;
  try {
    const backup = JSON.parse(await file.text());
    const { restored } = await api('/restore', { method: 'POST', body: { backup } });
    state.settings = null;
    toast(`Restored ${restored.products} products, ${restored.orders} orders and ${restored.customers} customers.`);
    return true;
  } catch (err) {
    toast(err instanceof SyntaxError ? "That file couldn't be read. Choose a PLAENS backup (.json) file." : err.message, 'error');
    return false;
  }
}

/* ================= Firebase sign-in ================= */

function viewSignIn() {
  hideSplash();
  $('#app').innerHTML = `
    <div class="login">
      ${brandPanel('Sign in to open the store on any device.')}
      <section class="login-form">
        <form id="signInForm" novalidate>
          <h1>Sign in</h1>
          <label class="field">Email<input name="email" type="email" autocomplete="username" required></label>
          <label class="field">Password<input name="password" type="password" autocomplete="current-password" required></label>
          <p class="form-error" id="signInError"></p>
          <button class="btn primary block" type="submit">Sign in</button>
          <button class="btn ghost" type="button" id="forgotPw">Forgot password?</button>
        </form>
      </section>
    </div>`;
  const form = $('#signInForm');
  staggerForm($('#app'));
  form.email.focus();
  form.onsubmit = (e) => {
    e.preventDefault();
    busy(form.querySelector('[type=submit]'), async () => {
      try {
        await window.PlaensServer.auth.signIn(form.email.value, form.password.value);
      } catch (err) { $('#signInError').textContent = err.message; }
    });
  };
  $('#forgotPw').onclick = async () => {
    if (!form.email.value) { $('#signInError').textContent = 'Type your email above first, then press "Forgot password?" again.'; form.email.focus(); return; }
    try {
      await window.PlaensServer.auth.resetPassword(form.email.value);
      toast(`If ${form.email.value} has an account, a reset link is on its way.`);
    } catch (err) { $('#signInError').textContent = err.message; }
  };
}

function viewCloudError(err) {
  hideSplash();
  const who = window.PlaensServer.auth.user()?.email || '';
  $('#app').innerHTML = `
    <div class="login">
      ${brandPanel('Your store couldn’t open.')}
      <section class="login-form">
        <div style="max-width:380px;display:grid;gap:16px">
          <h1>Something’s not right</h1>
          <p>${esc(err.message)}</p>
          ${who ? `<div class="who-box">
            <span class="k">Signed in as</span>
            <strong id="whoEmail">${esc(who)}</strong>
            <button type="button" class="btn small" id="copyWho">Copy</button>
            <small>This exact address must appear in your Firestore rules, in lowercase.</small>
          </div>` : ''}
          <button class="btn primary" type="button" onclick="location.reload()">Try again</button>
          ${who ? '<button class="btn ghost" type="button" id="outBtn">Sign out</button>' : ''}
        </div>
      </section>
    </div>`;
  $('#outBtn')?.addEventListener('click', () => window.PlaensServer.auth.signOut());
  $('#copyWho')?.addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(who);
      e.target.textContent = 'Copied';
    } catch {
      getSelection().selectAllChildren($('#whoEmail')); // clipboard blocked: select it instead
    }
  });
}

/* ================= Splash ================= */

function showSplash(message = '') {
  let el = $('#splash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'splash';
    el.className = 'splash';
    el.innerHTML = `<div>${logoAnim()}<p id="splashMsg"></p></div>`;
    document.body.append(el);
  }
  el.classList.remove('done');
  $('#splashMsg').textContent = message;
}

let splashShownAt = performance.now();
function hideSplash() {
  const el = $('#splash');
  if (!el || el.classList.contains('done')) return;
  const wait = Math.max(0, 1100 - (performance.now() - splashShownAt)); // let the logo finish drawing
  setTimeout(() => el.classList.add('done'), reduceMotion() ? 0 : wait);
}

/* ================= Shell ================= */

const NAV = [
  ['dashboard', 'Overview'], ['orders', 'Orders'], ['products', 'Products'], ['inventory', 'Inventory'],
  ['customers', 'Customers'], ['expenses', 'Expenses'], ['reports', 'Reports'], ['scan', 'Scan'], ['settings', 'Settings'],
];

function updateSidebarBackup() {
  const el = $('#backupNote');
  if (!el) return;
  const age = backupAge();
  el.textContent = age === null ? 'Not backed up yet' : age === 0 ? 'Backed up today' : `Last backup ${age} day${age === 1 ? '' : 's'} ago`;
  el.classList.toggle('warn', age === null || age >= 7);
}

const SYNC_TEXT = { saved: 'All changes saved', saving: 'Saving…', offline: 'Offline, changes can’t save', error: 'Last change not saved' };
let syncState = 'saved';
function setSync(s) {
  syncState = s;
  const el = $('#sync');
  if (!el) return;
  el.className = `sync ${s}`;
  $('span:last-child', el).textContent = isCloud() ? SYNC_TEXT[s] || s : 'Saved in this browser';
}

function moveNavIndicator() {
  const nav = $('.nav');
  const ind = $('.nav-indicator');
  const active = $('.nav a[aria-current="page"]');
  if (!nav || !ind) return;
  if (!active) { ind.style.opacity = 0; return; }
  ind.style.opacity = 1;
  ind.style.width = `${active.offsetWidth}px`;
  ind.style.height = `${active.offsetHeight}px`;
  ind.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
}

function mountShell() {
  if ($('.shell')) {
    $('.brand span').textContent = (state.settings.storeName || 'PLAENS').toUpperCase();
    $('#lockBtn').hidden = !getLock();
    $('#signOutBtn').hidden = !isCloud();
    updateSidebarBackup();
    return;
  }
  $('#app').innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <a class="brand" href="#/dashboard" aria-label="${esc(state.settings.storeName)} home">
          <img src="assets/logo-light.png" alt="" width="38" height="40"><span>${esc((state.settings.storeName || 'PLAENS').toUpperCase())}</span>
        </a>
        <nav class="nav" aria-label="Main"><span class="nav-indicator" aria-hidden="true"></span>${NAV.map(([k, l]) => `<a href="#/${k}" data-nav="${k}">${l}</a>`).join('')}</nav>
        <div class="sidebar-foot">
          <a href="#/orders/new" class="btn light small">New order</a>
          <div id="sync" class="sync saved" role="status"><span class="dot"></span><span></span></div>
          <a href="#/settings" id="backupNote" class="backup-note"></a>
          <button type="button" id="lockBtn" ${getLock() ? '' : 'hidden'}>Lock</button>
          <button type="button" id="signOutBtn" ${isCloud() ? '' : 'hidden'}>Sign out${state.user ? ` <span class="who">${esc(state.user)}</span>` : ''}</button>
        </div>
      </aside>
      <main id="main" tabindex="-1"></main>
    </div>`;
  $('#lockBtn').onclick = lockNow;
  $('#signOutBtn').onclick = () => window.PlaensServer.auth.signOut();
  setSync(syncState);
  updateSidebarBackup();
  window.addEventListener('resize', debounce(moveNavIndicator, 100));
}

/* ================= Router ================= */

const routes = [
  [/^#\/dashboard$/, viewDashboard],
  [/^#\/orders$/, viewOrders],
  [/^#\/orders\/new$/, viewNewOrder],
  [/^#\/orders\/([\w-]+)$/, viewOrder],
  [/^#\/products$/, viewProducts],
  [/^#\/inventory$/, viewInventory],
  [/^#\/customers$/, viewCustomers],
  [/^#\/expenses$/, viewExpenses],
  [/^#\/reports$/, viewReports],
  [/^#\/scan$/, viewScan],
  [/^#\/settings$/, viewSettings],
];

async function refreshState() {
  const s = await api('/settings');
  state.settings = s.settings;
  state.meta = s.meta;
  state.emailConfigured = s.emailConfigured;
  state.storage = s.storage;
  state.mode = s.mode;
  state.user = s.user;
  moneyFmt = null;
}

/** Count-up for key figures (skipped if the device asks for less motion). */
function countUp(root) {
  if (reduceMotion()) return;
  $$('[data-count]', root).forEach((el) => {
    const target = Number(el.dataset.count) || 0;
    const fmt = el.dataset.fmt === 'money' ? money : (n) => Math.round(n).toLocaleString();
    const start = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - start) / 900);
      el.textContent = fmt(target * (1 - (1 - p) ** 3));
      if (p < 1) requestAnimationFrame(step);
    };
    el.textContent = fmt(0);
    requestAnimationFrame(step);
  });
}

/** Staggered entrance for whatever a page just drew. */
function animateIn(view) {
  [...view.children].forEach((c, i) => c.style.setProperty('--i', Math.min(i, 10)));
  $$('.figures .figure', view).forEach((f, j) => f.style.setProperty('--j', j));
  $$('.table tbody tr', view).forEach((r, i) => { if (i < 14) r.style.setProperty('--r', i); });
  $$('.bars', view).forEach((b) => $$('.fill', b).forEach((f, j) => f.style.setProperty('--j', j)));
  countUp(view);
  view.classList.add('entering');
  setTimeout(() => view.classList.remove('entering'), 1400);
}

async function render() {
  if (isCloud() && !window.PlaensServer.auth.user()) return viewSignIn();
  await refreshState();
  hideSplash();
  if (!state.meta.setupComplete) return viewSetup();
  if (getLock() && !sessionStorage.getItem(UNLOCKED_KEY)) return viewLock();

  mountShell();
  const hash = location.hash || '#/dashboard';
  const route = routes.find(([re]) => re.test(hash));
  if (!route) { location.replace('#/dashboard'); return; }

  const section = hash.split('/')[1];
  $$('.nav a').forEach((a) => (a.dataset.nav === section ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  moveNavIndicator();

  const main = $('#main');
  const view = document.createElement('div');
  view.className = 'view';
  view.innerHTML = '<div class="skeleton-page" aria-label="Loading"><div class="skeleton" style="width:30%;height:28px"></div><div class="skeleton" style="height:140px;margin-top:28px"></div><div class="skeleton" style="height:90px;margin-top:20px"></div></div>';
  main.replaceChildren(view);
  window.scrollTo(0, 0);
  try {
    await route[1](view, ...hash.match(route[0]).slice(1));
    animateIn(view);
    main.focus({ preventScroll: true });
  } catch (err) {
    view.innerHTML = `<div class="error-state"><strong>This page couldn't load.</strong><p>${esc(err.message)}</p></div>`;
  }
}

let started = false;
function startApp() {
  if (!started) {
    started = true;
    // Another tab, or in Firebase mode another device, changed the data: refresh this screen.
    window.PlaensServer.onExternalChange(() => { if (!document.querySelector('dialog[open]') && $('.shell')) render(); });
    window.PlaensServer.onStatus((s, detail) => {
      setSync(s);
      if (s === 'error' && detail) toast(detail, 'error');
    });
    window.addEventListener('hashchange', render);
  }
  render();
}

async function boot() {
  const firstVisit = !sessionStorage.getItem('plaens_seen');
  sessionStorage.setItem('plaens_seen', '1');
  if (firstVisit || (window.PLAENS_FIREBASE && window.PLAENS_FIREBASE.enabled)) { splashShownAt = performance.now(); showSplash(); }

  if (!window.PlaensServer) {
    document.body.innerHTML = '<p style="padding:40px;font-family:sans-serif">js/server.js didn’t load. Check that the js folder sits next to index.html.</p>';
    return;
  }
  window.PlaensServer.setLogoUrl(LOGO_RECEIPT);

  if (window.PlaensServer.cloudEnabled()) {
    state.mode = 'cloud';
    try {
      window.PlaensServer.auth.onChange(async (user) => {
        if (!user) return viewSignIn();
        showSplash('Opening your store…');
        try {
          await window.PlaensServer.init();
          startApp();
        } catch (err) { viewCloudError(err); }
      });
    } catch (err) { viewCloudError(err); }
    return;
  }

  try {
    await window.PlaensServer.init();
  } catch (err) {
    hideSplash();
    document.body.innerHTML = `<p style="padding:40px;font-family:sans-serif">This browser blocked storage, so the dashboard can’t save data. Private or incognito windows sometimes do this. (${esc(err.message)})</p>`;
    return;
  }
  startApp();
}

document.addEventListener('DOMContentLoaded', boot);

/* ================= Overview ================= */

function horizonChart(days) {
  const W = 1000;
  const H = 190;
  const max = Math.max(...days.map((d) => d.revenue), 0);
  const total = days.reduce((s, d) => s + d.revenue, 0);
  const best = days.reduce((b, d) => (d.revenue > (b?.revenue || 0) ? d : b), null);
  const pts = days.map((d, i) => [
    days.length === 1 ? W / 2 : (i / (days.length - 1)) * W,
    max ? H - 4 - (d.revenue / max) * (H - 28) : H - 4,
  ]);
  // Gentle curve through the points so it reads as a landscape, not a zigzag
  let line = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const cx = (x0 + x1) / 2;
    line += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  const area = `${line} L${W},${H} L0,${H} Z`;
  return `
    <div class="h-meta">
      <div><div class="h-total" data-count="${total}" data-fmt="money">${money(total)}</div><div class="h-label">Revenue in the last 30 days</div></div>
      ${best && best.revenue > 0 ? `<div class="h-best">Best day ${fmtDate(best.date)}<br><strong style="color:var(--brand)">${money(best.revenue)}</strong></div>` : ''}
    </div>
    <div class="h-plot">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <path class="h-area" d="${area}"/>
        <path class="h-line" d="${line}" vector-effect="non-scaling-stroke"/>
        <line class="h-ground" x1="0" y1="${H - 1.5}" x2="${W}" y2="${H - 1.5}" vector-effect="non-scaling-stroke"/>
      </svg>
      <div class="h-cols">${days.map((d, i) => `<div class="h-col" data-i="${i}"></div>`).join('')}</div>
      <div class="h-tip" hidden></div>
    </div>
    <div class="h-axis"><span>${fmtDate(days[0].date)}</span><span>Today</span></div>`;
}

function wireHorizon(root, days) {
  const tip = $('.h-tip', root);
  const plot = $('.h-plot', root);
  if (!tip) return;
  $$('.h-col', root).forEach((col) => {
    col.addEventListener('mouseenter', () => {
      const d = days[Number(col.dataset.i)];
      tip.innerHTML = `${fmtDate(d.date)}<strong>${money(d.revenue)}</strong>${d.orders} order${d.orders === 1 ? '' : 's'}`;
      tip.hidden = false;
      const x = col.offsetLeft + col.offsetWidth / 2;
      const half = tip.offsetWidth / 2;
      tip.style.left = `${Math.min(Math.max(x, half), plot.offsetWidth - half)}px`;
    });
  });
  plot.addEventListener('mouseleave', () => { tip.hidden = true; });
}

function change(now, before) {
  if (!before && !now) return '<span class="muted">No sales in either period</span>';
  if (!before) return '<span class="pos">New this period</span>';
  const pct = Math.round(((now - before) / Math.abs(before)) * 100);
  const cls = pct >= 0 ? 'pos' : 'neg';
  return `<span class="${cls}">${pct >= 0 ? '+' : ''}${pct}%</span> vs previous 30 days`;
}

async function viewDashboard(el) {
  const d = await api('/reports/dashboard');
  const s = d.summary;
  const p = d.previous;
  const inv = d.inventory;

  const lowList = inv.lowStock.length
    ? `<ul class="low-list">${inv.lowStock.map((l) => `
        <li><span class="what">${esc(l.productName)}<span>${esc(variantLabel(l))}</span></span>
        <span class="${stockClass(l.stock, l.threshold)}">${l.stock === 0 ? 'Sold out' : `${l.stock} left`}</span></li>`).join('')}</ul>
       ${inv.lowStockCount > inv.lowStock.length ? `<p class="muted" style="margin-top:10px">${inv.lowStockCount - inv.lowStock.length} more running low.</p>` : ''}`
    : empty('Every size is above its low stock alert.');

  el.innerHTML = `
    ${pageHead('Overview', `${fmtDate(d.range.from)} to ${fmtDate(d.range.to)}`, '<a class="btn primary" href="#/orders/new">New order</a>')}
    ${backupBanner(d.recentOrders.length > 0)}
    <section class="horizon" aria-label="Daily revenue chart">${horizonChart(d.salesByDay)}</section>
    <section class="figures" aria-label="Key figures">
      <div class="figure"><div class="label">Gross profit</div><div class="value" data-count="${s.grossProfit}" data-fmt="money">${money(s.grossProfit)}</div><div class="note">${s.grossMargin}% margin, ${change(s.grossProfit, p.grossProfit)}</div></div>
      <div class="figure"><div class="label">Net profit after expenses</div><div class="value ${s.netProfit < 0 ? 'neg' : ''}" data-count="${s.netProfit}" data-fmt="money">${money(s.netProfit)}</div><div class="note">${money(s.expenses)} spent on expenses</div></div>
      <div class="figure"><div class="label">Orders</div><div class="value" data-count="${s.orders}">${s.orders}</div><div class="note">${change(s.orders, p.orders)}</div></div>
      <div class="figure"><div class="label">Average order</div><div class="value" data-count="${s.averageOrderValue}" data-fmt="money">${money(s.averageOrderValue)}</div><div class="note">${s.itemsSold} pieces sold</div></div>
    </section>
    <div class="split">
      <section class="panel">
        <div class="panel-head"><h2>Recent orders</h2><a href="#/orders">All orders</a></div>
        ${d.recentOrders.length ? ordersTable(d.recentOrders, { compact: true }) : empty('No orders yet.', '<a class="btn primary" href="#/orders/new">Record your first order</a>')}
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Running low</h2><a href="#/inventory">Inventory</a></div>
        ${lowList}
      </section>
    </div>
    <section class="panel" style="margin-top:20px">
      <dl class="facts">
        <div><dt>Pieces in stock</dt><dd>${inv.units.toLocaleString()}</dd></div>
        <div><dt>Stock value at cost</dt><dd>${money(inv.valueAtCost)}</dd></div>
        <div><dt>Stock value at selling price</dt><dd>${money(inv.valueAtRetail)}</dd></div>
        <div><dt>Awaiting payment</dt><dd>${money(s.awaitingPayment)}<span class="muted" style="font-weight:400;font-size:13px;font-stretch:100%"> from ${s.unpaidOrders} order${s.unpaidOrders === 1 ? '' : 's'}</span></dd></div>
      </dl>
    </section>`;
  wireHorizon(el, d.salesByDay);
  wireRowLinks(el);
}

/* ================= Orders ================= */

const ORDER_FILTERS = [
  ['all', 'All'], ['unpaid', 'Unpaid'], ['unfulfilled', 'To ship'], ['shipped', 'Shipped'],
  ['delivered', 'Delivered'], ['cancelled', 'Cancelled'], ['refunded', 'Refunded'],
];

async function viewOrders(el) {
  let filter = sessionStorage.getItem('plaens_order_filter') || 'all';
  el.innerHTML = `
    ${pageHead('Orders', '', `<button class="btn" id="exportCsv">Export CSV</button><a class="btn primary" href="#/orders/new">New order</a>`)}
    <div class="toolbar">
      <div class="segmented" role="group" aria-label="Filter orders">
        ${ORDER_FILTERS.map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${k === filter}">${l}</button>`).join('')}
      </div>
      <input type="search" id="q" placeholder="Search order number, name, email or phone" aria-label="Search orders">
    </div>
    <div id="list" class="table-wrap"><p class="loading" style="padding:20px">Loading…</p></div>`;

  const list = $('#list', el);
  const load = async () => {
    const q = $('#q', el).value.trim();
    const { orders, total } = await api(`/orders?filter=${filter}&search=${enc(q)}`);
    list.innerHTML = orders.length
      ? ordersTable(orders) + (total > orders.length ? `<p class="muted" style="padding:12px 14px">Showing ${orders.length} of ${total}. Search to narrow down.</p>` : '')
      : empty(q ? `No orders match "${esc(q)}".` : 'No orders here yet.', filter === 'all' && !q ? '<a class="btn primary" href="#/orders/new">Record an order</a>' : '');
  };

  $$('.segmented button', el).forEach((b) => (b.onclick = () => {
    filter = b.dataset.f;
    sessionStorage.setItem('plaens_order_filter', filter);
    $$('.segmented button', el).forEach((x) => x.setAttribute('aria-pressed', x === b));
    load().catch((e) => toast(e.message, 'error'));
  }));
  $('#q', el).addEventListener('input', debounce(() => load().catch((e) => toast(e.message, 'error'))));
  $('#exportCsv', el).onclick = (e) => exportCsvDialog(e.currentTarget);
  wireRowLinks(list);
  await load();
}

function exportCsvDialog() {
  openDialog({
    title: 'Export orders',
    body: `<form id="csvForm" class="form-grid">
        <label class="field">From<input type="date" name="from" value="${dayKey(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}" required></label>
        <label class="field">To<input type="date" name="to" value="${dayKey()}" required></label>
        <p class="hint span-2">The file opens in Excel or Google Sheets. It includes cancelled and refunded orders, marked in their own columns.</p>
        <div class="form-foot span-2" style="margin-top:0"><span class="grow"></span><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Download CSV</button></div>
      </form>`,
    onMount: (d, close) => {
      $('#csvForm', d).onsubmit = (e) => {
        e.preventDefault();
        const { from, to } = formData(e.target);
        busy(e.submitter, async () => {
          try {
            await downloadCsv(from, to);
            close();
          } catch (err) { toast(err.message, 'error'); }
        });
      };
    },
  });
}

async function downloadCsv(from, to) {
  const { filename, csv } = await api(`/reports/orders.csv?from=${from}&to=${to}`);
  downloadFile(filename, csv, 'text/csv;charset=utf-8');
}

/* ---------- New order ---------- */

async function viewNewOrder(el) {
  const [{ products }, { customers }] = await Promise.all([api('/products'), api('/customers')]);
  const sellable = products.filter((p) => p.status !== 'archived');
  const variants = new Map();
  for (const p of sellable) for (const v of p.variants) variants.set(v.id, { product: p, variant: v });
  const taxRate = Number(state.settings.taxRate) || 0;
  const cart = [];

  el.innerHTML = `
    ${pageHead('New order', 'Stock is taken off the shelf as soon as the order is created.')}
    ${sellable.length ? '' : `<div class="error-state" style="margin-bottom:20px">Add a product before recording an order. <a href="#/products">Go to products</a></div>`}
    <div class="order-layout">
      <div class="stack">
        <section class="panel">
          <h2>Items</h2>
          <div class="add-item" style="margin-top:14px">
            <label class="field">Product, size and colour
              <select id="pick">
                <option value="">Choose an item</option>
                ${sellable.map((p) => `<optgroup label="${esc(p.name)}${p.status === 'draft' ? ' (draft)' : ''}">${p.variants.map((v) =>
                  `<option value="${v.id}" ${v.stock === 0 ? 'disabled' : ''}>${esc(variantLabel(v))}, ${v.stock === 0 ? 'sold out' : `${v.stock} in stock`}, ${money(v.price ?? p.price)}</option>`).join('')}</optgroup>`).join('')}
              </select>
            </label>
            <label class="field">Qty<input id="pickQty" type="number" min="1" step="1" value="1"></label>
            <button type="button" class="btn" id="addItem">Add to order</button>
          </div>
          <div id="cart"></div>
        </section>

        <section class="panel">
          <h2>Customer</h2>
          <label class="field" style="margin-top:14px">Who is this order for?
            <select id="custPick">
              <option value="new">New customer</option>
              <option value="walkin">Walk-in, no details</option>
              ${customers.length ? `<optgroup label="Existing customers">${customers.map((c) => `<option value="${c.id}">${esc(c.name)}${c.email ? `, ${esc(c.email)}` : c.phone ? `, ${esc(c.phone)}` : ''}</option>`).join('')}</optgroup>` : ''}
            </select>
          </label>
          <div id="custNew" class="form-grid" style="margin-top:16px">
            <label class="field span-2">Full name<input id="cName" autocomplete="off"></label>
            <label class="field">Email<input id="cEmail" type="email" autocomplete="off"><small>Needed to email the receipt.</small></label>
            <label class="field">Phone<input id="cPhone" type="tel" autocomplete="off"></label>
          </div>
          <div id="custKnown" class="kv" style="margin-top:14px" hidden></div>
          <fieldset id="shipBox">
            <legend>Delivery address</legend>
            <div class="form-grid" style="margin-top:10px">
              <label class="field span-2">Address<input id="aLine1"></label>
              <label class="field span-2">Apartment, landmark (optional)<input id="aLine2"></label>
              <label class="field">City<input id="aCity"></label>
              <label class="field">Postal code<input id="aPostal"></label>
              <label class="field span-2">Country<input id="aCountry" value="Sri Lanka"></label>
            </div>
          </fieldset>
        </section>
      </div>

      <aside class="panel order-side">
        <h2>Summary</h2>
        <dl class="totals">
          <dt>Subtotal</dt><dd id="tSub">${money(0)}</dd>
          <dt><label for="tDiscount">Discount</label></dt><dd><input id="tDiscount" type="number" min="0" step="0.01" value="0"></dd>
          <dt><label for="tShipping">Shipping charged</label></dt><dd><input id="tShipping" type="number" min="0" step="0.01" value="0"></dd>
          ${taxRate ? `<dt>Tax (${taxRate}%)</dt><dd id="tTax">${money(0)}</dd>` : ''}
          <dt class="grand">Total</dt><dd class="grand" id="tTotal">${money(0)}</dd>
          <dt class="quiet">Estimated profit</dt><dd class="quiet" id="tProfit">${money(0)}</dd>
        </dl>
        <div class="stack" style="margin-top:20px">
          <label class="field">Sales channel<select id="oChannel">${options(LABELS.channel, 'instagram')}</select></label>
          <label class="field">Payment method<select id="oMethod">${options(LABELS.method, 'bank_transfer')}</select></label>
          <label class="field">Payment<select id="oPaid"><option value="paid">Paid</option><option value="unpaid">Not paid yet</option></select></label>
          <label class="field">Order date<input id="oDate" type="date" value="${dayKey()}" max="${dayKey()}"></label>
          <label class="field">Notes<textarea id="oNotes" rows="2" placeholder="Only visible to you"></textarea></label>
          ${state.emailConfigured
            ? '<label class="check"><input type="checkbox" id="oSend" checked> Email the receipt to the customer</label>'
            : '<label class="check"><input type="checkbox" id="oSend" disabled> <span>Email the receipt <span class="muted">(connect email in <a href="#/settings">Settings</a> first; you can download the PDF after creating the order)</span></span></label>'}
          <p class="form-error" id="oError"></p>
          <button type="button" class="btn primary block" id="create">Create order</button>
        </div>
      </aside>
    </div>`;

  const cartEl = $('#cart', el);
  const num = (id) => Math.max(0, Number($(id, el).value) || 0);

  function recalc() {
    const subtotal = cart.reduce((s, c) => s + c.unitPrice * c.quantity, 0);
    const discount = Math.min(num('#tDiscount'), subtotal);
    const shipping = num('#tShipping');
    const tax = Math.round((subtotal - discount) * taxRate) / 100;
    const total = subtotal - discount + shipping + tax;
    const cogs = cart.reduce((s, c) => s + c.unitCost * c.quantity, 0);
    const profit = total - tax - cogs;
    $('#tSub', el).textContent = money(subtotal);
    if (taxRate) $('#tTax', el).textContent = money(tax);
    $('#tTotal', el).textContent = money(total);
    const revenue = total - tax;
    $('#tProfit', el).textContent = `${money(profit)}${revenue > 0 ? ` (${Math.round((profit / revenue) * 100)}%)` : ''}`;
  }

  function drawCart() {
    cartEl.innerHTML = cart.length
      ? `<table class="table cart"><thead><tr><th class="shrink"><span class="sr">Photo</span></th><th>Item</th><th class="num">Qty</th><th class="num">Price each</th><th class="num">Amount</th><th><span class="sr">Remove</span></th></tr></thead>
        <tbody>${cart.map((c, i) => `
          <tr>
            <td class="shrink">${thumbCell(c.thumb, c.name)}</td>
            <td><div class="strong">${esc(c.name)}</div><div class="sub">${esc(c.label)}, ${esc(c.sku)}, ${c.stock} in stock</div></td>
            <td class="num"><input type="number" min="1" max="${c.stock}" step="1" value="${c.quantity}" data-qty="${i}" aria-label="Quantity"></td>
            <td class="num"><input class="price" type="number" min="0" step="0.01" value="${c.unitPrice}" data-price="${i}" aria-label="Price each"></td>
            <td class="num strong">${money(c.unitPrice * c.quantity)}</td>
            <td class="num"><button type="button" class="icon-btn" data-rm="${i}" aria-label="Remove ${esc(c.name)}">&times;</button></td>
          </tr>`).join('')}</tbody></table>`
      : '<p class="muted">No items yet. Choose a product above.</p>';
    recalc();
  }

  $('#addItem', el).onclick = () => {
    const id = $('#pick', el).value;
    const qty = Math.max(1, Math.floor(Number($('#pickQty', el).value) || 1));
    if (!id) return toast('Choose a product, size and colour first.', 'error');
    const { product, variant } = variants.get(id);
    const existing = cart.find((c) => c.variantId === id);
    const want = (existing ? existing.quantity : 0) + qty;
    if (want > variant.stock) return toast(`Only ${variant.stock} of ${product.name} (${variantLabel(variant)}) in stock.`, 'error');
    if (existing) existing.quantity = want;
    else cart.push({
      variantId: id, name: product.name, thumb: product.thumb, label: variantLabel(variant), sku: variant.sku, stock: variant.stock,
      quantity: qty, unitPrice: variant.price ?? product.price, unitCost: variant.costPrice ?? product.costPrice,
    });
    $('#pick', el).value = '';
    $('#pickQty', el).value = 1;
    drawCart();
  };

  cartEl.addEventListener('change', (e) => {
    const qi = e.target.dataset.qty;
    const pi = e.target.dataset.price;
    if (qi !== undefined) {
      const c = cart[qi];
      c.quantity = Math.min(c.stock, Math.max(1, Math.floor(Number(e.target.value) || 1)));
    }
    if (pi !== undefined) cart[pi].unitPrice = Math.max(0, Number(e.target.value) || 0);
    drawCart();
  });
  cartEl.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { cart.splice(Number(rm.dataset.rm), 1); drawCart(); }
  });
  ['#tDiscount', '#tShipping'].forEach((id) => $(id, el).addEventListener('input', recalc));

  // Customer choice
  const custPick = $('#custPick', el);
  const setAddress = (a = {}) => {
    $('#aLine1', el).value = a.line1 || '';
    $('#aLine2', el).value = a.line2 || '';
    $('#aCity', el).value = a.city || '';
    $('#aPostal', el).value = a.postalCode || '';
    $('#aCountry', el).value = a.country || 'Sri Lanka';
  };
  custPick.onchange = () => {
    const v = custPick.value;
    $('#custNew', el).hidden = v !== 'new';
    $('#custKnown', el).hidden = v === 'new' || v === 'walkin';
    $('#shipBox', el).hidden = v === 'walkin';
    $('#oSend', el).closest('label').hidden = v === 'walkin';
    if (v === 'walkin') { $('#oChannel', el).value = 'store'; $('#oMethod', el).value = 'cash'; }
    const c = customers.find((x) => x.id === v);
    if (c) {
      $('#custKnown', el).innerHTML = `<span class="strong" style="color:var(--brand);font-weight:700">${esc(c.name)}</span>
        <span>${esc(c.email || 'No email on file')}</span><span>${esc(c.phone || '')}</span>
        <span class="k">${c.ordersCount} past order${c.ordersCount === 1 ? '' : 's'}, ${money(c.totalSpent)} spent</span>`;
      setAddress(c.address);
      if (!c.email) $('#oSend', el).checked = false;
    } else if (v === 'new') {
      setAddress();
    }
  };

  $('#create', el).onclick = (e) => busy(e.currentTarget, async () => {
    $('#oError', el).textContent = '';
    if (!cart.length) { $('#oError', el).textContent = 'Add at least one item.'; return; }
    const v = custPick.value;
    const shippingAddress = v === 'walkin' ? null : {
      line1: $('#aLine1', el).value, line2: $('#aLine2', el).value, city: $('#aCity', el).value,
      postalCode: $('#aPostal', el).value, country: $('#aCountry', el).value,
    };
    const body = {
      items: cart.map((c) => ({ variantId: c.variantId, quantity: c.quantity, unitPrice: c.unitPrice })),
      discount: num('#tDiscount'),
      shipping: num('#tShipping'),
      channel: $('#oChannel', el).value,
      paymentMethod: $('#oMethod', el).value,
      paymentStatus: $('#oPaid', el).value,
      orderDate: $('#oDate', el).value,
      notes: $('#oNotes', el).value,
      sendReceipt: v !== 'walkin' && $('#oSend', el).checked,
      shippingAddress,
    };
    if (v === 'new') {
      const name = $('#cName', el).value.trim();
      if (!name) { $('#oError', el).textContent = "Enter the customer's name, or choose Walk-in."; $('#cName', el).focus(); return; }
      body.customer = { name, email: $('#cEmail', el).value, phone: $('#cPhone', el).value, address: shippingAddress };
    } else if (v !== 'walkin') {
      body.customerId = v;
    }
    try {
      const { order, email } = await api('/orders', { method: 'POST', body });
      toast(`Order ${order.orderNumber} created.`);
      if (email) emailToast(email);
      location.hash = `#/orders/${order.id}`;
    } catch (err) {
      $('#oError', el).textContent = err.message;
    }
  });

  drawCart();
}


/* ---------- Order detail ---------- */

async function viewOrder(el, id) {
  const { order: o } = await api(`/orders/${id}`);
  const thumbs = Object.fromEntries((await api('/products')).products.map((p) => [p.id, p.thumb]));
  const closed = o.cancelled || o.paymentStatus === 'refunded';
  const addr = o.shippingAddress;
  const addrLines = addr ? [addr.line1, addr.line2, [addr.city, addr.postalCode].filter(Boolean).join(' '), addr.country].filter(Boolean) : [];

  const steps = [];
  if (!closed) {
    if (o.paymentStatus === 'unpaid') steps.push('<button class="btn primary block" data-act="paid">Mark as paid</button>');
    if (o.fulfillmentStatus === 'unfulfilled') steps.push(`<button class="btn ${o.paymentStatus === 'paid' ? 'primary' : ''} block" data-act="ship">Mark as shipped</button>`);
    if (o.fulfillmentStatus === 'unfulfilled' && o.channel === 'store') steps.push('<button class="btn block" data-act="delivered">Handed over in store</button>');
    if (o.fulfillmentStatus === 'shipped') steps.push('<button class="btn primary block" data-act="delivered">Mark as delivered</button>');
    if (o.paymentStatus === 'paid') steps.push('<button class="btn danger block" data-act="refund">Refund order</button>');
    steps.push('<button class="btn danger block" data-act="cancel">Cancel order</button>');
  }

  el.innerHTML = `
    ${pageHead(`Order ${o.orderNumber}`, `${fmtDateTime(o.createdAt)}, ${esc(LABELS.channel[o.channel] || o.channel)}`,
      `<a class="btn" href="#/orders">All orders</a>
       <button class="btn" data-act="pdf">Download PDF</button>
       <button class="btn" data-act="label">Shipping label</button>
       <button class="btn primary" data-act="preview">Share receipt</button>`)}
    <div class="status-line" style="margin:-10px 0 22px">${statusPills(o)}</div>
    <div class="order-layout">
      <div class="stack">
        <section class="panel">
          <h2>Items</h2>
          <table class="table" style="margin-top:10px">
            <thead><tr><th class="shrink"><span class="sr">Photo</span></th><th>Item</th><th class="num">Qty</th><th class="num">Price each</th><th class="num">Amount</th></tr></thead>
            <tbody>${o.items.map((i) => `<tr>
              <td class="shrink">${thumbCell(thumbs[i.productId], i.name)}</td>
              <td><div class="strong">${esc(i.name)}</div><div class="sub">${esc(variantLabel(i))}, ${esc(i.sku)}</div></td>
              <td class="num">${i.quantity}</td><td class="num">${money(i.unitPrice)}</td><td class="num strong">${money(i.lineTotal)}</td></tr>`).join('')}</tbody>
          </table>
          <dl class="totals" style="max-width:360px;margin-left:auto;margin-top:16px">
            <dt>Subtotal</dt><dd>${money(o.subtotal)}</dd>
            ${o.discount ? `<dt>Discount</dt><dd>&minus;${money(o.discount)}</dd>` : ''}
            <dt>Shipping</dt><dd>${money(o.shipping)}</dd>
            ${o.tax ? `<dt>Tax (${o.taxRate}%)</dt><dd>${money(o.tax)}</dd>` : ''}
            <dt class="grand">Total</dt><dd class="grand">${money(o.total)}</dd>
          </dl>
          <div class="profit-box">
            <dl class="totals">
              <dt>Revenue${o.tax ? ' (excluding tax)' : ''}</dt><dd>${money(o.revenue)}</dd>
              <dt>Cost of the pieces sold</dt><dd>&minus;${money(o.cogs)}</dd>
              <dt style="font-weight:700;color:var(--brand)">Gross profit</dt>
              <dd style="font-weight:700" class="${closed ? 'muted' : o.grossProfit < 0 ? 'neg' : 'pos'}">${closed ? `${money(o.grossProfit)}, not counted` : money(o.grossProfit)}</dd>
            </dl>
          </div>
        </section>
        <section class="panel">
          <h2>Activity</h2>
          <ol class="timeline" style="margin-top:14px">${[...o.history].reverse().map((h) => `
            <li><div class="strong" style="color:var(--brand);font-weight:600">${esc(h.event)}</div>
            ${h.note ? `<div>${esc(h.note)}</div>` : ''}<div class="when">${fmtDateTime(h.at)}</div></li>`).join('')}</ol>
        </section>
      </div>
      <aside class="stack">
        ${steps.length ? `<section class="panel"><h2>Next step</h2><div class="next-steps" style="margin-top:14px">${steps.join('')}</div></section>` : ''}
        <section class="panel">
          <h2>Customer</h2>
          <div class="kv" style="margin-top:10px">
            <span style="color:var(--brand);font-weight:700">${esc(o.customer.name)}</span>
            ${o.customer.email ? `<a href="mailto:${esc(o.customer.email)}">${esc(o.customer.email)}</a>` : '<span class="muted">No email</span>'}
            ${o.customer.phone ? `<a href="tel:${esc(o.customer.phone)}">${esc(o.customer.phone)}</a>` : ''}
          </div>
          ${addrLines.length ? `<h3 style="margin-top:18px">Delivery address</h3><p style="margin-top:6px">${addrLines.map(esc).join('<br>')}</p>` : ''}
          ${o.trackingNumber ? `<h3 style="margin-top:18px">Tracking</h3><p style="margin-top:6px">${esc(o.carrier)} ${esc(o.trackingNumber)}</p>` : ''}
        </section>
        <section class="panel">
          <h2>Payment</h2>
          <div class="kv" style="margin-top:10px"><span>${esc(LABELS.method[o.paymentMethod])}</span><span class="k">${LABELS.payment[o.paymentStatus]}</span></div>
        </section>
        <section class="panel">
          <h2>Notes</h2>
          <textarea id="notes" rows="3" style="margin-top:10px" placeholder="Only visible to you">${esc(o.notes)}</textarea>
          <button class="btn small" id="saveNotes" style="margin-top:10px">Save notes</button>
        </section>
        ${o.emails.length ? `<section class="panel"><h2>Emails</h2><ul class="low-list" style="margin-top:6px">${o.emails.slice().reverse().map((m) => `
          <li><span>${esc(m.to)}<br><span class="muted" style="font-size:13px">${fmtDateTime(m.at)}</span></span>
          <span class="${m.ok ? 'pos' : 'neg'}" style="font-size:13px">${m.ok ? 'Sent' : 'Failed'}</span></li>`).join('')}</ul></section>` : ''}
      </aside>
    </div>`;

  const refresh = () => viewOrder(el, id);
  const act = {
    paid: () => api(`/orders/${o.id}/payment`, { method: 'PATCH', body: { status: 'paid' } }).then(() => toast('Marked as paid.')),
    delivered: () => api(`/orders/${o.id}/fulfillment`, { method: 'PATCH', body: { status: 'delivered' } }).then(() => toast('Marked as delivered.')),
    ship: () => new Promise((resolve) => {
      const { dlg } = openDialog({
        title: `Ship order ${o.orderNumber}`,
        body: `<form id="shipForm" class="form-grid">
          <label class="field">Courier<input name="carrier" placeholder="Domex, Pronto, Koombiyo…"></label>
          <label class="field">Tracking number<input name="trackingNumber"></label>
          <div class="form-foot span-2" style="margin-top:0"><span class="grow"></span><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Mark as shipped</button></div>
        </form>`,
        onMount: (d, close) => {
          $('#shipForm', d).onsubmit = (e) => {
            e.preventDefault();
            busy(e.submitter, async () => {
              try {
                await api(`/orders/${o.id}/fulfillment`, { method: 'PATCH', body: { status: 'shipped', ...formData(e.target) } });
                toast('Marked as shipped.');
                close();
              } catch (err) { toast(err.message, 'error'); }
            });
          };
        },
      });
      dlg.addEventListener('close', resolve);
    }),
    refund: async () => {
      const r = await confirmDialog({
        title: `Refund ${o.orderNumber}?`,
        message: `This records a refund of ${money(o.total)} and removes the order from your sales and profit. Pay the money back through your bank or payment provider separately.`,
        confirmLabel: 'Refund order', danger: true, checkbox: { label: 'Put the items back in stock', checked: true },
      });
      if (!r) return;
      await api(`/orders/${o.id}/payment`, { method: 'PATCH', body: { status: 'refunded', restock: r.checked } });
      toast('Order refunded.');
    },
    cancel: async () => {
      const r = await confirmDialog({
        title: `Cancel ${o.orderNumber}?`,
        message: 'A cancelled order is closed and no longer counts towards sales or profit. This can’t be undone.',
        confirmLabel: 'Cancel order', danger: true, checkbox: { label: 'Put the items back in stock', checked: true },
      });
      if (!r) return;
      await api(`/orders/${o.id}/cancel`, { method: 'POST', body: { restock: r.checked } });
      toast('Order cancelled.');
    },
    preview: async () => {
      await receiptDialog(o);
      return 'no-refresh';
    },
    label: async () => {
      await shippingLabelDialog(o);
      return 'no-refresh';
    },
    pdf: async () => {
      await downloadReceiptPdf(o);
      return 'no-refresh';
    },
    email: async () => {
      const { email } = await api(`/orders/${o.id}/send-receipt`, { method: 'POST' });
      emailToast(email);
    },
  };

  // onclick (not addEventListener) so re-rendering after an action doesn't stack handlers
  el.onclick = (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    busy(btn, async () => {
      try {
        const r = await act[btn.dataset.act]();
        if (r !== 'no-refresh') await refresh();
      } catch (err) { toast(err.message, 'error'); }
    });
  };
  $('#saveNotes', el).onclick = (e) => busy(e.currentTarget, async () => {
    try {
      await api(`/orders/${o.id}`, { method: 'PATCH', body: { notes: $('#notes', el).value } });
      toast('Notes saved.');
    } catch (err) { toast(err.message, 'error'); }
  });
}

/* ================= Products ================= */

async function viewProducts(el) {
  el.innerHTML = `
    ${pageHead('Products', '', '<button class="btn primary" id="add">Add product</button>')}
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search name, category or SKU" aria-label="Search products">
      <select id="st" aria-label="Filter by status"><option value="">All statuses</option>${options(LABELS.status)}</select>
    </div>
    <div id="list" class="table-wrap"><p class="loading" style="padding:20px">Loading…</p></div>`;
  const list = $('#list', el);
  let categories = [];

  const load = async () => {
    const { products, categories: cats } = await api(`/products?search=${enc($('#q', el).value.trim())}&status=${$('#st', el).value}`);
    categories = cats;
    list.innerHTML = products.length
      ? `<table class="table"><thead><tr><th class="shrink"><span class="sr">Photo</span></th><th>Product</th><th>Sizes and colours</th><th class="num">In stock</th><th class="num">Price</th><th class="num">Cost</th><th class="num">Margin</th><th>Status</th></tr></thead>
        <tbody>${products.map((p) => `<tr data-id="${p.id}" style="cursor:pointer" tabindex="0">
          <td class="shrink">${thumbCell(p.thumb, p.name)}</td>
          <td><div class="strong">${esc(p.name)}</div><div class="sub">${esc(p.category || 'No category')}</div></td>
          <td class="sub">${p.variants.length} variant${p.variants.length === 1 ? '' : 's'}${p.lowStockVariants ? `, <span style="color:var(--amber)">${p.lowStockVariants} low</span>` : ''}</td>
          <td class="num"><span class="${stockClass(p.totalStock, 0)}">${p.totalStock}</span></td>
          <td class="num">${money(p.price)}</td>
          <td class="num sub">${money(p.costPrice)}</td>
          <td class="num">${p.margin}%</td>
          <td><span class="pill ${p.status === 'active' ? 'paid' : p.status}">${LABELS.status[p.status]}</span></td>
        </tr>`).join('')}</tbody></table>`
      : empty($('#q', el).value ? 'No products match that search.' : 'No products yet. Add your first piece to start tracking stock.', '<button class="btn primary" data-add>Add product</button>');
  };

  const openProduct = async (id) => {
    try {
      const product = id ? (await api(`/products/${id}`)).product : null;
      productDialog(product, categories, load);
    } catch (err) { toast(err.message, 'error'); }
  };
  list.addEventListener('click', (e) => {
    if (e.target.closest('[data-add]')) return openProduct(null);
    const row = e.target.closest('tr[data-id]');
    if (row) openProduct(row.dataset.id);
  });
  list.addEventListener('keydown', (e) => {
    const row = e.target.closest('tr[data-id]');
    if (row && e.key === 'Enter') openProduct(row.dataset.id);
  });
  $('#add', el).onclick = () => openProduct(null);
  $('#q', el).addEventListener('input', debounce(() => load().catch((e) => toast(e.message, 'error'))));
  $('#st', el).onchange = () => load().catch((e) => toast(e.message, 'error'));
  await load();
}

function variantRow(v = {}) {
  return `<tr data-vid="${esc(v.id || '')}">
    <td><input name="size" value="${esc(v.size || '')}" aria-label="Size" placeholder="M"></td>
    <td><input name="color" value="${esc(v.color || '')}" aria-label="Colour" placeholder="Black"></td>
    <td><input name="sku" value="${esc(v.sku || '')}" aria-label="SKU" placeholder="Automatic"></td>
    <td class="num"><input name="stock" type="number" min="0" step="1" value="${v.stock ?? 0}" aria-label="In stock" style="width:90px;text-align:right"></td>
    <td class="num"><button type="button" class="icon-btn" data-rmv aria-label="Remove this variant">&times;</button></td>
  </tr>`;
}

/* ================= Product photos =================
   Photos are resized and compressed in the browser before they're stored, so a
   picture straight off a phone (3-5 MB) becomes about 60 KB, plus a small
   square thumbnail for lists. */

const PHOTO = { full: 900, thumb: 180, fullQuality: 0.78, thumbQuality: 0.7 };

function readImage(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('That file isn’t an image. Choose a JPG, PNG or WebP.'));
    if (file.size > 25 * 1024 * 1024) return reject(new Error('That image is very large. Choose one under 25 MB.'));
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image couldn’t be opened. It may be damaged.')); };
    img.src = url;
  });
}

/** Longest side capped at `max`, keeping the shape. */
function resizeToDataUrl(img, max, quality) {
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF'; // transparent PNGs would turn black in a JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

/** Centre-cropped square, for the small thumbnails in lists. */
function squareToDataUrl(img, size, quality) {
  const side = Math.min(img.width, img.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', quality);
}

async function preparePhoto(file) {
  const img = await readImage(file);
  return {
    image: resizeToDataUrl(img, PHOTO.full, PHOTO.fullQuality),
    thumb: squareToDataUrl(img, PHOTO.thumb, PHOTO.thumbQuality),
  };
}

/** Thumbnail for a list row, or a neutral placeholder when there's no photo. */
const thumbCell = (src, name) => src
  ? `<img class="thumb" src="${esc(src)}" alt="" loading="lazy">`
  : `<span class="thumb empty" aria-hidden="true">${esc((name || '?').trim().charAt(0).toUpperCase())}</span>`;

function productDialog(product, categories, onSaved) {
  const p = product || { status: 'active', lowStockThreshold: state.settings.lowStockThreshold, variants: [] };
  openDialog({
    title: product ? `Edit ${product.name}` : 'Add product',
    wide: true,
    body: `<form id="pf" novalidate>
      <div class="form-grid">
        <label class="field span-2">Name<input name="name" value="${esc(p.name || '')}" required placeholder="Horizon Linen Shirt"></label>
        <label class="field">Category<input name="category" value="${esc(p.category || '')}" list="catList" placeholder="Shirts"></label>
        <label class="field">Status<select name="status">${options(LABELS.status, p.status)}</select><small>Only active products appear on a storefront.</small></label>
        <label class="field">Selling price<input name="price" type="number" min="0" step="0.01" value="${p.price ?? ''}" required></label>
        <label class="field">Cost per piece<input name="costPrice" type="number" min="0" step="0.01" value="${p.costPrice ?? ''}" required><small>What one piece costs you to make or buy. Used for profit.</small></label>
        <label class="field">Compare-at price<input name="compareAtPrice" type="number" min="0" step="0.01" value="${p.compareAtPrice ?? ''}"><small>Optional. The original price, shown when on sale.</small></label>
        <label class="field">Low stock alert at<input name="lowStockThreshold" type="number" min="0" step="1" value="${p.lowStockThreshold}"><small>Warn when any size drops to this many.</small></label>
        <label class="field span-2">Description<textarea name="description" rows="2">${esc(p.description || '')}</textarea></label>
      </div>
      <p class="hint" id="marginNote" style="margin-top:12px"></p>

      <fieldset>
        <legend>Photo</legend>
        <div class="photo-row">
          <div class="photo-preview" id="photoPreview">${p.image || p.thumb
            ? `<img src="${esc(p.image || p.thumb)}" alt="Current photo of ${esc(p.name || 'this product')}">`
            : '<span>No photo</span>'}</div>
          <div class="photo-actions">
            <label class="btn" style="cursor:pointer">Choose photo<input type="file" id="photoFile" accept="image/*" hidden></label>
            <button type="button" class="btn ghost" id="photoRemove" ${p.image || p.thumb ? '' : 'hidden'}>Remove photo</button>
            <p class="hint" id="photoNote" style="margin:0">Any photo works; it's resized automatically. A square shot of the piece on a plain background looks best in lists and on the PDF receipt.</p>
          </div>
        </div>
      </fieldset>
      <datalist id="catList">${categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>

      <fieldset>
        <legend>Sizes and colours</legend>
        <p class="hint">Type your sizes and colours to add every combination at once. Stock changes you make here are logged as count corrections; use Inventory for deliveries.</p>
        <div class="form-grid" style="grid-template-columns:1fr 1fr auto;align-items:end;margin-bottom:14px">
          <label class="field">Sizes<input id="gSizes" placeholder="S, M, L, XL"></label>
          <label class="field">Colours<input id="gColors" placeholder="Black, Sand"></label>
          <button type="button" class="btn" id="gen">Add combinations</button>
        </div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Size</th><th>Colour</th><th>SKU</th><th class="num">In stock</th><th><span class="sr">Remove</span></th></tr></thead>
          <tbody id="vrows">${p.variants.map(variantRow).join('')}</tbody></table></div>
        <button type="button" class="btn ghost" id="addV">Add one variant</button>
      </fieldset>
      <p class="form-error" id="pErr"></p>
      <div class="form-foot">
        ${product ? '<button type="button" class="btn danger" id="del">Delete product</button>' : ''}
        <span class="grow"></span>
        <button type="button" class="btn" data-close>Cancel</button>
        <button class="btn primary" type="submit">${product ? 'Save changes' : 'Add product'}</button>
      </div>
    </form>`,
    onMount: (d, close) => {
      const form = $('#pf', d);
      const rows = $('#vrows', d);
      if (!p.variants.length) rows.innerHTML = variantRow({ size: '', color: '', stock: 0 });

      const margin = () => {
        const price = Number(form.price.value);
        const cost = Number(form.costPrice.value);
        $('#marginNote', d).textContent = price > 0 && form.costPrice.value !== ''
          ? `Each sale makes ${money(price - cost)} before expenses, a ${Math.round(((price - cost) / price) * 100)}% margin.`
          : '';
      };
      form.price.addEventListener('input', margin);
      form.costPrice.addEventListener('input', margin);
      margin();

      // Photo: chosen, dropped, or removed
      let photo;   // undefined = unchanged, '' = remove, object = new photo
      const preview = $('#photoPreview', d);
      const showPhoto = (src) => {
        preview.innerHTML = src ? `<img src="${src}" alt="Selected photo">` : '<span>No photo</span>';
        $('#photoRemove', d).hidden = !src;
      };
      const takeFile = async (file) => {
        if (!file) return;
        $('#photoNote', d).textContent = 'Preparing the photo…';
        try {
          const made = await preparePhoto(file);
          photo = made;
          showPhoto(made.image);
          $('#photoNote', d).textContent = `Ready, about ${Math.round(made.image.length * 0.75 / 1024)} KB. It saves when you save the product.`;
        } catch (err) {
          $('#photoNote', d).textContent = err.message;
        }
      };
      $('#photoFile', d).onchange = (e) => { takeFile(e.target.files[0]); e.target.value = ''; };
      $('#photoRemove', d).onclick = () => {
        photo = '';
        showPhoto('');
        $('#photoNote', d).textContent = 'The photo will be removed when you save.';
      };
      preview.addEventListener('dragover', (e) => { e.preventDefault(); preview.classList.add('over'); });
      preview.addEventListener('dragleave', () => preview.classList.remove('over'));
      preview.addEventListener('drop', (e) => {
        e.preventDefault();
        preview.classList.remove('over');
        takeFile(e.dataTransfer.files[0]);
      });

      $('#gen', d).onclick = () => {
        const split = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
        const sizes = split($('#gSizes', d).value);
        const colors = split($('#gColors', d).value);
        if (!sizes.length && !colors.length) return toast('Type at least one size or colour.', 'error');
        const have = new Set($$('tr', rows).map((r) => `${r.querySelector('[name=size]').value.trim().toLowerCase()}|${r.querySelector('[name=color]').value.trim().toLowerCase()}`));
        // Drop the single blank starter row if it's untouched
        $$('tr', rows).forEach((r) => { if (!r.dataset.vid && !r.querySelector('[name=size]').value && !r.querySelector('[name=color]').value && !r.querySelector('[name=sku]').value) r.remove(); });
        let added = 0;
        for (const size of sizes.length ? sizes : ['']) {
          for (const color of colors.length ? colors : ['']) {
            const key = `${size.toLowerCase()}|${color.toLowerCase()}`;
            if (have.has(key)) continue;
            rows.insertAdjacentHTML('beforeend', variantRow({ size, color, stock: 0 }));
            have.add(key);
            added++;
          }
        }
        toast(added ? `Added ${added} variant${added === 1 ? '' : 's'}.` : 'Those combinations are already listed.');
      };
      $('#addV', d).onclick = () => { rows.insertAdjacentHTML('beforeend', variantRow()); rows.lastElementChild.querySelector('input').focus(); };
      rows.addEventListener('click', (e) => { if (e.target.closest('[data-rmv]')) e.target.closest('tr').remove(); });

      form.onsubmit = (e) => {
        e.preventDefault();
        const body = formData(form);
        if (photo === '') { body.image = ''; body.thumb = ''; }
        else if (photo) { body.image = photo.image; body.thumb = photo.thumb; }
        body.variants = $$('tr', rows).map((r) => ({
          id: r.dataset.vid || undefined,
          size: r.querySelector('[name=size]').value,
          color: r.querySelector('[name=color]').value,
          sku: r.querySelector('[name=sku]').value,
          stock: r.querySelector('[name=stock]').value,
        }));
        busy(e.submitter, async () => {
          try {
            await api(product ? `/products/${product.id}` : '/products', { method: product ? 'PUT' : 'POST', body });
            toast(product ? 'Product saved.' : 'Product added.');
            close();
            onSaved();
          } catch (err) { $('#pErr', d).textContent = err.message; }
        });
      };

      if (product) {
        $('#del', d).onclick = async () => {
          const r = await confirmDialog({
            title: `Delete ${product.name}?`,
            message: 'Products that appear in past orders are archived instead, so your sales history stays complete.',
            confirmLabel: 'Delete product', danger: true,
          });
          if (!r) return;
          try {
            const res = await api(`/products/${product.id}`, { method: 'DELETE' });
            toast(res.archived ? 'Product archived, since it has past orders.' : 'Product deleted.');
            close();
            onSaved();
          } catch (err) { toast(err.message, 'error'); }
        };
      }
    },
  });
}

/* ================= Inventory ================= */

const ADJUST_TYPES = {
  delivery: { label: 'New stock arrived', mode: 'add', reason: 'restock', qty: 'How many arrived?' },
  return: { label: 'Customer return', mode: 'add', reason: 'return', qty: 'How many came back?' },
  damage: { label: 'Damaged or faulty', mode: 'remove', reason: 'damage', qty: 'How many to remove?' },
  lost: { label: 'Lost or missing', mode: 'remove', reason: 'lost', qty: 'How many to remove?' },
  count: { label: 'I counted the stock', mode: 'set', reason: 'adjustment', qty: 'How many are on the shelf?' },
};

async function viewInventory(el) {
  el.innerHTML = `
    ${pageHead('Inventory', 'Every size and colour, with a record of why stock changed.')}
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search product or SKU" aria-label="Search inventory">
      <label class="check"><input type="checkbox" id="lowOnly"> Only show low stock</label>
      <span class="grow"></span>
      <button type="button" class="btn" id="printBarcodes">Print barcode labels</button>
    </div>
    <div id="list" class="table-wrap"></div>
    <section class="panel" style="margin-top:24px">
      <div class="panel-head"><h2>Stock history</h2></div>
      <div id="moves"></div>
    </section>`;

  let items = [];
  const draw = () => {
    const q = $('#q', el).value.trim().toLowerCase();
    const low = $('#lowOnly', el).checked;
    const rows = items.filter((i) => (!low || i.low) && (!q || `${i.productName} ${i.sku} ${i.label}`.toLowerCase().includes(q)));
    const units = rows.reduce((s, i) => s + i.stock, 0);
    const value = rows.reduce((s, i) => s + i.valueAtCost, 0);
    $('#list', el).innerHTML = rows.length
      ? `<table class="table"><thead><tr><th class="shrink"><span class="sr">Photo</span></th><th>Product</th><th>Size and colour</th><th>SKU</th><th class="num">In stock</th><th class="num">Value at cost</th><th><span class="sr">Actions</span></th></tr></thead>
        <tbody>${rows.map((i) => `<tr>
          <td class="shrink">${thumbCell(i.thumb, i.productName)}</td>
          <td class="strong">${esc(i.productName)}</td><td>${esc(i.label)}</td><td class="sub">${esc(i.sku)}</td>
          <td class="num"><span class="${stockClass(i.stock, i.threshold)}">${i.stock}</span></td>
          <td class="num sub">${money(i.valueAtCost)}</td>
          <td class="num"><button class="btn small" data-adj="${i.variantId}">Update stock</button></td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="4">${rows.length} variant${rows.length === 1 ? '' : 's'}</td><td class="num">${units}</td><td class="num">${money(value)}</td><td></td></tr></tfoot></table>`
      : empty(items.length ? 'Nothing matches. Clear the search or filter.' : 'No stock yet. Add products first.', items.length ? '' : '<a class="btn primary" href="#/products">Go to products</a>');
  };
  const loadMoves = async () => {
    const { movements } = await api('/inventory/movements?limit=40');
    $('#moves', el).innerHTML = movements.length
      ? `<table class="table"><thead><tr><th>When</th><th>Item</th><th>Reason</th><th class="num">Change</th><th class="num">Left after</th></tr></thead>
        <tbody>${movements.map((m) => `<tr>
          <td class="sub">${fmtDateTime(m.createdAt)}</td>
          <td><div class="strong">${esc(m.productName)}</div><div class="sub">${esc(m.variantLabel)}</div></td>
          <td>${esc(LABELS.reason[m.reason] || m.reason)}${m.reference ? ` <span class="sub">${esc(m.reference)}</span>` : ''}${m.note ? `<div class="sub">${esc(m.note)}</div>` : ''}</td>
          <td class="num ${m.change > 0 ? 'pos' : 'neg'}" style="font-weight:700">${m.change > 0 ? '+' : ''}${m.change}</td>
          <td class="num">${m.stockAfter}</td></tr>`).join('')}</tbody></table>`
      : empty('Stock changes will be listed here.');
  };
  const load = async () => {
    items = (await api('/inventory')).items;
    draw();
    await loadMoves();
  };

  $('#q', el).addEventListener('input', debounce(draw, 120));
  $('#lowOnly', el).onchange = draw;
  $('#printBarcodes', el).onclick = (e) => busy(e.currentTarget, async () => {
    if (!items.length) return toast('Add a product first, then you can print its barcodes.', 'error');
    await barcodeSheetDialog(items);
  });
  $('#list', el).addEventListener('click', (e) => {
    const btn = e.target.closest('[data-adj]');
    if (!btn) return;
    const item = items.find((i) => i.variantId === btn.dataset.adj);
    openDialog({
      title: 'Update stock',
      body: `<p><strong style="color:var(--brand)">${esc(item.productName)}</strong>, ${esc(item.label)}. Currently <strong>${item.stock}</strong> in stock.</p>
        <form id="adjForm" class="stack" style="margin-top:18px">
          <label class="field">What happened?<select name="type">${Object.entries(ADJUST_TYPES).map(([k, t]) => `<option value="${k}">${t.label}</option>`).join('')}</select></label>
          <label class="field"><span id="qtyLabel">${ADJUST_TYPES.delivery.qty}</span><input name="quantity" type="number" min="0" step="1" required></label>
          <label class="field">Note (optional)<input name="note" placeholder="Supplier invoice number, reason…"></label>
          <p class="hint" id="adjPreview"></p>
          <p class="form-error" id="adjErr"></p>
          <div class="form-foot" style="margin-top:0"><span class="grow"></span><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Update stock</button></div>
        </form>`,
      onMount: (d, close) => {
        const f = $('#adjForm', d);
        const preview = () => {
          const t = ADJUST_TYPES[f.type.value];
          $('#qtyLabel', d).textContent = t.qty;
          const q = Math.floor(Number(f.quantity.value));
          if (f.quantity.value === '' || Number.isNaN(q)) { $('#adjPreview', d).textContent = ''; return; }
          const after = t.mode === 'add' ? item.stock + q : t.mode === 'remove' ? item.stock - q : q;
          $('#adjPreview', d).textContent = after < 0 ? `You only have ${item.stock} to remove.` : `Stock will be ${after}.`;
        };
        f.type.onchange = preview;
        f.quantity.oninput = preview;
        f.quantity.focus();
        f.onsubmit = (e) => {
          e.preventDefault();
          const t = ADJUST_TYPES[f.type.value];
          busy(e.submitter, async () => {
            try {
              await api('/inventory/adjust', { method: 'POST', body: { productId: item.productId, variantId: item.variantId, mode: t.mode, reason: t.reason, quantity: f.quantity.value, note: f.note.value } });
              toast('Stock updated.');
              close();
              await load();
            } catch (err) { $('#adjErr', d).textContent = err.message; }
          });
        };
      },
    });
  });
  await load();
}

/* ================= Customers ================= */

async function viewCustomers(el) {
  el.innerHTML = `
    ${pageHead('Customers', '', '<button class="btn primary" id="add">Add customer</button>')}
    <div class="toolbar"><input type="search" id="q" placeholder="Search name, email, phone or city" aria-label="Search customers"></div>
    <div id="list" class="table-wrap"></div>`;
  const list = $('#list', el);
  const load = async () => {
    const { customers } = await api(`/customers?search=${enc($('#q', el).value.trim())}`);
    list.innerHTML = customers.length
      ? `<table class="table"><thead><tr><th>Name</th><th>Contact</th><th>City</th><th class="num">Orders</th><th class="num">Total spent</th><th>Last order</th></tr></thead>
        <tbody>${customers.map((c) => `<tr data-id="${c.id}" style="cursor:pointer" tabindex="0">
          <td class="strong">${esc(c.name)}</td>
          <td><div>${esc(c.email || '')}</div><div class="sub">${esc(c.phone || '')}</div></td>
          <td class="sub">${esc(c.address?.city || '')}</td>
          <td class="num">${c.ordersCount}</td>
          <td class="num strong">${money(c.totalSpent)}</td>
          <td class="sub">${c.lastOrderAt ? fmtDate(c.lastOrderAt) : 'None yet'}</td></tr>`).join('')}</tbody></table>`
      : empty($('#q', el).value ? 'No customers match that search.' : 'Customers are added automatically when you record an order, or you can add them here.');
  };
  const open = async (id) => {
    try {
      const data = id ? await api(`/customers/${id}`) : { customer: null, orders: [] };
      customerDialog(data.customer, data.orders, load);
    } catch (err) { toast(err.message, 'error'); }
  };
  list.addEventListener('click', (e) => { const r = e.target.closest('tr[data-id]'); if (r) open(r.dataset.id); });
  list.addEventListener('keydown', (e) => { const r = e.target.closest('tr[data-id]'); if (r && e.key === 'Enter') open(r.dataset.id); });
  $('#add', el).onclick = () => open(null);
  $('#q', el).addEventListener('input', debounce(() => load().catch((e) => toast(e.message, 'error'))));
  await load();
}

function customerDialog(c, orders, onSaved) {
  const a = c?.address || {};
  openDialog({
    title: c ? c.name : 'Add customer',
    wide: Boolean(c),
    body: `
      ${c ? `<dl class="facts" style="margin-bottom:22px">
        <div><dt>Orders</dt><dd>${c.ordersCount}</dd></div>
        <div><dt>Total spent</dt><dd>${money(c.totalSpent)}</dd></div>
        <div><dt>Customer since</dt><dd>${fmtDate(c.createdAt)}</dd></div></dl>` : ''}
      <form id="cf" class="form-grid" novalidate>
        <label class="field span-2">Full name<input name="name" value="${esc(c?.name || '')}" required></label>
        <label class="field">Email<input name="email" type="email" value="${esc(c?.email || '')}"></label>
        <label class="field">Phone<input name="phone" type="tel" value="${esc(c?.phone || '')}"></label>
        <label class="field span-2">Address<input name="line1" value="${esc(a.line1 || '')}"></label>
        <label class="field span-2">Apartment, landmark<input name="line2" value="${esc(a.line2 || '')}"></label>
        <label class="field">City<input name="city" value="${esc(a.city || '')}"></label>
        <label class="field">Postal code<input name="postalCode" value="${esc(a.postalCode || '')}"></label>
        <label class="field span-2">Country<input name="country" value="${esc(a.country || 'Sri Lanka')}"></label>
        <label class="field span-2">Notes<textarea name="notes" rows="2" placeholder="Sizes they usually buy, preferences…">${esc(c?.notes || '')}</textarea></label>
        <p class="form-error span-2" id="cErr"></p>
        <div class="form-foot span-2">
          ${c ? '<button type="button" class="btn danger" id="del">Delete customer</button>' : ''}
          <span class="grow"></span><button type="button" class="btn" data-close>Cancel</button>
          <button class="btn primary">${c ? 'Save changes' : 'Add customer'}</button>
        </div>
      </form>
      ${c && orders.length ? `<h3 style="margin-top:26px">Order history</h3><div style="margin-top:8px">${ordersTable(orders, { compact: true })}</div>` : ''}`,
    onMount: (d, close) => {
      const f = $('#cf', d);
      f.onsubmit = (e) => {
        e.preventDefault();
        const v = formData(f);
        const body = { name: v.name, email: v.email, phone: v.phone, notes: v.notes, address: { line1: v.line1, line2: v.line2, city: v.city, postalCode: v.postalCode, country: v.country } };
        busy(e.submitter, async () => {
          try {
            await api(c ? `/customers/${c.id}` : '/customers', { method: c ? 'PUT' : 'POST', body });
            toast(c ? 'Customer saved.' : 'Customer added.');
            close();
            onSaved();
          } catch (err) { $('#cErr', d).textContent = err.message; }
        });
      };
      d.addEventListener('click', (e) => {
        const row = e.target.closest('tr[data-href]');
        if (row) { close(); location.hash = row.dataset.href; }
      });
      if (c) {
        $('#del', d).onclick = async () => {
          const r = await confirmDialog({ title: `Delete ${c.name}?`, message: 'This removes their details. Customers with orders on record can’t be deleted.', confirmLabel: 'Delete customer', danger: true });
          if (!r) return;
          try {
            await api(`/customers/${c.id}`, { method: 'DELETE' });
            toast('Customer deleted.');
            close();
            onSaved();
          } catch (err) { toast(err.message, 'error'); }
        };
      }
    },
  });
}

/* ================= Expenses ================= */

async function viewExpenses(el) {
  const now = new Date();
  el.innerHTML = `
    ${pageHead('Expenses', 'Costs of running the brand, used to work out net profit.', '<button class="btn primary" id="add">Add expense</button>')}
    <div class="toolbar">
      <label class="field">From<input type="date" id="from" value="${dayKey(new Date(now.getFullYear(), now.getMonth(), 1))}"></label>
      <label class="field">To<input type="date" id="to" value="${dayKey()}"></label>
      <label class="field">Category<select id="cat"><option value="">All categories</option>${options(LABELS.expense)}</select></label>
    </div>
    <div id="list" class="table-wrap"></div>`;
  const list = $('#list', el);
  let rows = [];
  const load = async () => {
    const { expenses, total } = await api(`/expenses?from=${$('#from', el).value}&to=${$('#to', el).value}&category=${$('#cat', el).value}`);
    rows = expenses;
    list.innerHTML = expenses.length
      ? `<table class="table"><thead><tr><th>Date</th><th>What for</th><th>Category</th><th class="num">Amount</th><th><span class="sr">Edit</span></th></tr></thead>
        <tbody>${expenses.map((x) => `<tr>
          <td class="sub">${fmtDate(x.date)}</td><td class="strong">${esc(x.description)}</td>
          <td>${esc(LABELS.expense[x.category] || x.category)}</td><td class="num strong">${money(x.amount)}</td>
          <td class="num"><button class="btn small" data-edit="${x.id}">Edit</button></td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="3">Total for this period</td><td class="num">${money(total)}</td><td></td></tr></tfoot></table>`
      : empty('No expenses in this period.', '<button class="btn primary" data-new>Add expense</button>');
  };
  const reload = () => load().catch((e) => toast(e.message, 'error'));
  ['#from', '#to', '#cat'].forEach((id) => ($(id, el).onchange = reload));
  $('#add', el).onclick = () => expenseDialog(null, reload);
  list.addEventListener('click', (e) => {
    if (e.target.closest('[data-new]')) return expenseDialog(null, reload);
    const b = e.target.closest('[data-edit]');
    if (b) expenseDialog(rows.find((x) => x.id === b.dataset.edit), reload);
  });
  await load();
}

function expenseDialog(x, onSaved) {
  openDialog({
    title: x ? 'Edit expense' : 'Add expense',
    body: `<form id="ef" class="form-grid" novalidate>
      <label class="field span-2">What was it for?<input name="description" value="${esc(x?.description || '')}" placeholder="Instagram ads for the new drop" required></label>
      <label class="field">Amount<input name="amount" type="number" min="0.01" step="0.01" value="${x?.amount ?? ''}" required></label>
      <label class="field">Date<input name="date" type="date" value="${x?.date || dayKey()}" max="${dayKey()}" required></label>
      <label class="field span-2">Category<select name="category">${options(LABELS.expense, x?.category || 'marketing')}</select></label>
      <p class="hint span-2">Don't add the cost of stock you buy or produce. That's already counted through each product's cost per piece.</p>
      <p class="form-error span-2" id="eErr"></p>
      <div class="form-foot span-2" style="margin-top:0">
        ${x ? '<button type="button" class="btn danger" id="del">Delete</button>' : ''}
        <span class="grow"></span><button type="button" class="btn" data-close>Cancel</button>
        <button class="btn primary">${x ? 'Save changes' : 'Add expense'}</button>
      </div>
    </form>`,
    onMount: (d, close) => {
      $('#ef', d).description.focus();
      $('#ef', d).onsubmit = (e) => {
        e.preventDefault();
        busy(e.submitter, async () => {
          try {
            await api(x ? `/expenses/${x.id}` : '/expenses', { method: x ? 'PUT' : 'POST', body: formData(e.target) });
            toast(x ? 'Expense saved.' : 'Expense added.');
            close();
            onSaved();
          } catch (err) { $('#eErr', d).textContent = err.message; }
        });
      };
      if (x) {
        $('#del', d).onclick = async () => {
          try {
            await api(`/expenses/${x.id}`, { method: 'DELETE' });
            toast('Expense deleted.');
            close();
            onSaved();
          } catch (err) { toast(err.message, 'error'); }
        };
      }
    },
  });
}

/* ================= Reports ================= */

function presetRange(key) {
  const t = new Date();
  const y = t.getFullYear();
  const m = t.getMonth();
  switch (key) {
    case 'this-month': return [new Date(y, m, 1), t];
    case 'last-month': return [new Date(y, m - 1, 1), new Date(y, m, 0)];
    case '90': return [daysAgo(89), t];
    case 'this-year': return [new Date(y, 0, 1), t];
    default: return [daysAgo(29), t];
  }
}

function bars(rows, { label, value, fmt = money, alt = false }) {
  if (!rows.length) return '<p class="muted">Nothing in this period.</p>';
  const max = Math.max(...rows.map(value), 1);
  return `<div class="bars">${rows.map((r) => `
    <div class="bar-row"><span>${esc(label(r))}</span>
    <span class="track"><span class="fill${alt ? ' alt' : ''}" style="width:${(value(r) / max) * 100}%;display:block"></span></span>
    <span class="val">${fmt(value(r))}</span></div>`).join('')}</div>`;
}

async function viewReports(el) {
  el.innerHTML = `
    ${pageHead('Reports', '', '<button class="btn" id="csv">Export orders CSV</button>')}
    <div class="toolbar">
      <label class="field">Period<select id="preset">
        <option value="this-month">This month</option><option value="last-month">Last month</option>
        <option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option>
        <option value="this-year">This year</option><option value="custom">Custom dates</option>
      </select></label>
      <label class="field">From<input type="date" id="from"></label>
      <label class="field">To<input type="date" id="to"></label>
    </div>
    <div id="out"><p class="loading">Loading…</p></div>`;

  const setPreset = () => {
    const key = $('#preset', el).value;
    if (key === 'custom') return;
    const [f, t] = presetRange(key);
    $('#from', el).value = dayKey(f);
    $('#to', el).value = dayKey(t);
  };

  const load = async () => {
    const from = $('#from', el).value;
    const to = $('#to', el).value;
    const r = await api(`/reports/overview?from=${from}&to=${to}`);
    const s = r.summary;
    const row = (label, v, cls = '', extra = '') => `<tr class="${cls}"><td>${label}${extra}</td><td class="num">${v}</td></tr>`;
    $('#out', el).innerHTML = `
      <div class="split" style="margin-top:0">
        <section class="panel">
          <div class="panel-head"><h2>Profit and loss</h2><span class="muted">${fmtDate(from)} to ${fmtDate(to)}</span></div>
          <table class="statement">
            ${row('Sales from products', money(s.grossSales))}
            ${row('Discounts given', `&minus;${money(s.discounts)}`, 'indent')}
            ${row('Shipping charged to customers', money(s.shipping), 'indent')}
            ${row('Revenue', money(s.revenue), 'total')}
            ${row('Cost of the pieces sold', `&minus;${money(s.cogs)}`, 'indent')}
            ${row('Gross profit', money(s.grossProfit), 'total', `<span class="margin">${s.grossMargin}% margin</span>`)}
            ${row('Expenses', `&minus;${money(s.expenses)}`, 'indent')}
            ${row('Net profit', `<span class="${s.netProfit < 0 ? 'neg' : ''}">${money(s.netProfit)}</span>`, 'final', `<span class="margin">${s.netMargin}% margin</span>`)}
          </table>
          ${s.tax ? `<p class="hint" style="margin-top:14px">${money(s.tax)} of tax was collected and is not included in revenue.</p>` : ''}
        </section>
        <section class="panel">
          <h2>At a glance</h2>
          <dl class="facts" style="margin-top:16px;grid-template-columns:1fr 1fr">
            <div><dt>Orders</dt><dd>${s.orders}</dd></div>
            <div><dt>Pieces sold</dt><dd>${s.itemsSold}</dd></div>
            <div><dt>Average order</dt><dd>${money(s.averageOrderValue)}</dd></div>
            <div><dt>Awaiting payment</dt><dd>${money(s.awaitingPayment)}</dd></div>
            <div><dt>Cancelled orders</dt><dd>${s.cancelledOrders}</dd></div>
            <div><dt>Refunded</dt><dd>${money(s.refundedAmount)}</dd></div>
          </dl>
        </section>
      </div>
      <section class="panel" style="margin-top:20px">
        <h2>Best-selling products</h2>
        ${r.topProducts.length ? `<table class="table" style="margin-top:10px"><thead><tr><th>Product</th><th class="num">Pieces</th><th class="num">Sales</th><th class="num">Profit</th><th class="num">Margin</th></tr></thead>
          <tbody>${r.topProducts.map((p) => `<tr><td class="strong">${esc(p.label)}</td><td class="num">${p.units}</td><td class="num">${money(p.sales)}</td><td class="num">${money(p.profit)}</td><td class="num">${p.margin}%</td></tr>`).join('')}</tbody></table>` : '<p class="muted" style="margin-top:10px">No sales in this period.</p>'}
      </section>
      <div class="split" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        <section class="panel"><h2>Sizes sold</h2><div style="margin-top:16px">${bars(r.bySize, { label: (x) => x.label, value: (x) => x.units, fmt: (n) => `${n} pcs` })}</div></section>
        <section class="panel"><h2>Sales by channel</h2><div style="margin-top:16px">${bars(r.byChannel, { label: (x) => LABELS.channel[x.channel] || x.channel, value: (x) => x.revenue, alt: true })}</div></section>
        <section class="panel"><h2>Expenses by category</h2><div style="margin-top:16px">${bars(r.expensesByCategory, { label: (x) => LABELS.expense[x.category] || x.category, value: (x) => x.amount })}</div></section>
      </div>`;
  };
  const reload = () => load().catch((e) => { $('#out', el).innerHTML = `<div class="error-state">${esc(e.message)}</div>`; });

  $('#preset', el).onchange = () => { setPreset(); reload(); };
  ['#from', '#to'].forEach((id) => ($(id, el).onchange = () => { $('#preset', el).value = 'custom'; reload(); }));
  $('#csv', el).onclick = (e) => busy(e.currentTarget, () => downloadCsv($('#from', el).value, $('#to', el).value).catch((err) => toast(err.message, 'error')));
  setPreset();
  await load();
}


/* ================= Settings ================= */

async function viewSettings(el) {
  await refreshState();
  const s = state.settings;
  const counts = await api('/products').then((r) => r.products.length);
  const age = backupAge();
  el.innerHTML = `
    ${pageHead('Settings')}
    <div class="split" style="margin-top:0">
      <section class="panel">
        <h2>Store details</h2>
        <p class="hint" style="margin-top:6px">These appear on every receipt.</p>
        <form id="sf" class="form-grid" novalidate>
          <label class="field">Store name<input name="storeName" value="${esc(s.storeName)}" required></label>
          <label class="field">Customer service email<input name="email" type="email" value="${esc(s.email)}"></label>
          <label class="field">Phone<input name="phone" value="${esc(s.phone)}"></label>
          <label class="field">Instagram<input name="instagram" value="${esc(s.instagram)}"></label>
          <label class="field span-2">Website<input name="website" value="${esc(s.website)}"></label>
          <label class="field span-2">Business address<input name="address" value="${esc(s.address)}"></label>
          <label class="field">Currency<input name="currency" value="${esc(s.currency)}" maxlength="3" style="text-transform:uppercase"><small>3-letter code, for example LKR or USD.</small></label>
          <label class="field">Tax rate %<input name="taxRate" type="number" min="0" max="100" step="0.01" value="${s.taxRate}"><small>Added on top of prices. Use 0 if prices include tax.</small></label>
          <label class="field">Default low stock alert<input name="lowStockThreshold" type="number" min="0" step="1" value="${s.lowStockThreshold}"><small>Used for new products.</small></label>
          <label class="field span-2">Thank-you line on receipts<textarea name="receiptNote" rows="2">${esc(s.receiptNote)}</textarea></label>
          <p class="form-error span-2" id="sErr"></p>
          <div class="form-foot span-2"><span class="grow"></span><button class="btn primary">Save store details</button></div>
        </form>
      </section>

      <section class="panel">
        <h2>Email receipts</h2>
        <p style="margin-top:10px">${state.emailConfigured
          ? '<span class="pill paid">Connected</span> Receipts can be emailed to customers.'
          : '<span class="pill unpaid">Not connected</span> Websites can’t send email on their own, so this uses <a href="https://www.emailjs.com" target="_blank" rel="noopener">EmailJS</a>, which has a free plan. Until it’s connected you can still print, download or WhatsApp receipts.'}</p>
        <details style="margin-top:14px" ${state.emailConfigured ? '' : 'open'}>
          <summary class="strong" style="cursor:pointer;color:var(--brand);font-weight:600">How to connect it (about 10 minutes)</summary>
          <ol class="steps">
            <li>Create a free account at emailjs.com.</li>
            <li>Under Email Services, add your Gmail (or other) account. Copy the <strong>Service ID</strong>.</li>
            <li>Under Email Templates, create a template. Open its <strong>Settings</strong> tab (next to Content) and set <em>To Email</em> to <code>{{to_email}}</code>, <em>Subject</em> to <code>{{subject}}</code>, <em>From Name</em> to <code>{{store_name}}</code> and <em>Reply To</em> to <code>{{reply_to}}</code>. In the content, switch to the code (HTML) editor and replace everything with <code>{{{receipt_html}}}</code> (three braces). Save and copy the <strong>Template ID</strong>.</li>
            <li>Under Account, copy your <strong>Public Key</strong>.</li>
            <li>Paste all three below, save, and send a test.</li>
          </ol>
        </details>
        <form id="ef" class="stack" style="margin-top:16px" novalidate>
          <label class="field">Service ID<input name="emailServiceId" value="${esc(s.emailServiceId)}" placeholder="service_xxxxxxx" autocomplete="off"></label>
          <label class="field">Template ID<input name="emailTemplateId" value="${esc(s.emailTemplateId)}" placeholder="template_xxxxxxx" autocomplete="off"></label>
          <label class="field">Public Key<input name="emailPublicKey" value="${esc(s.emailPublicKey)}" autocomplete="off"></label>
          <button class="btn">Save email settings</button>
        </form>
        <form id="tf" class="stack" style="margin-top:22px;padding-top:18px;border-top:1px solid var(--line)">
          <label class="field">Send a test email to<input name="to" type="email" placeholder="you@example.com" required></label>
          <button class="btn" ${state.emailConfigured ? '' : 'disabled'}>Send test email</button>
        </form>
      </section>
    </div>

    <div class="split">
      <section class="panel">
        <h2>Your data</h2>
        <p style="margin-top:10px">${isCloud()
          ? `Saved in Firebase (project <strong>${esc(window.PLAENS_FIREBASE.config.projectId)}</strong>, store <strong>${esc(window.PLAENS_FIREBASE.storeId || 'plaens')}</strong>) and synced live to every device you sign in on. A backup file each month still protects you against accidental deletes.`
          : 'Everything is saved in this browser on this device, not online. Clearing your browsing data, or using a different browser or computer, won’t show it. Download a backup regularly and keep it somewhere safe like Google Drive. Restore it to move your store to another computer. To use the store on several devices, connect Firebase (see README).'}</p>
        <p class="hint" style="margin-top:10px">${age === null ? 'You haven’t downloaded a backup yet.' : `Last backup downloaded ${fmtDateTime(state.meta.lastBackupAt)}.`}</p>
        <div class="share-row" style="margin-top:14px">
          <button type="button" class="btn primary" data-backup>Download backup</button>
          <label class="btn" style="cursor:pointer">Restore from backup<input type="file" id="restore" accept=".json,application/json" hidden></label>
          ${counts ? '' : '<button type="button" class="btn" id="sample">Load sample data</button>'}
          <button type="button" class="btn danger" id="wipe">Delete all store data</button>
        </div>
      </section>

      ${isCloud() ? `<section class="panel">
        <h2>Account</h2>
        <p style="margin-top:10px">Signed in as <strong>${esc(state.user)}</strong>.</p>
        <p class="hint" style="margin-top:8px">To let someone else use the store, add them in Firebase > Authentication and add their email to your Firestore rules (see README).</p>
        <div class="share-row"><button type="button" class="btn" id="signOutSettings">Sign out</button></div>
      </section>` : `      <section class="panel">
        <h2>Passcode</h2>
        <p style="margin-top:10px">${getLock()
          ? 'The dashboard asks for a passcode when it opens in a new browser session.'
          : 'No passcode set. Anyone using this browser can open the dashboard.'}</p>
        <p class="hint" style="margin-top:8px">This keeps casual visitors out on a shared computer. It doesn’t encrypt your data.</p>
        <form id="pf" class="stack" style="margin-top:14px" novalidate>
          <label class="field">${getLock() ? 'New passcode' : 'Passcode'}<input name="code" type="password" autocomplete="new-password"></label>
          <label class="field">Type it again<input name="code2" type="password" autocomplete="new-password"></label>
          <p class="form-error" id="pErr"></p>
          <div class="share-row">
            <button class="btn">${getLock() ? 'Change passcode' : 'Set passcode'}</button>
            ${getLock() ? '<button type="button" class="btn danger" id="removeCode">Remove passcode</button>' : ''}
          </div>
        </form>
      </section>
`}
    </div>`;

  const saveSettings = (form, btn, errEl, message) => busy(btn, async () => {
    try {
      await api('/settings', { method: 'PUT', body: formData(form) });
      await refreshState();
      mountShell();
      if (errEl) errEl.textContent = '';
      toast(message);
      return true;
    } catch (err) {
      if (errEl) errEl.textContent = err.message; else toast(err.message, 'error');
      return false;
    }
  });

  $('#sf', el).onsubmit = (e) => { e.preventDefault(); saveSettings(e.target, e.submitter, $('#sErr', el), 'Store details saved.'); };
  $('#ef', el).onsubmit = async (e) => {
    e.preventDefault();
    if (await saveSettings(e.target, e.submitter, null, 'Email settings saved.')) viewSettings(el);
  };
  $('#tf', el).onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      try {
        await api('/settings/test-email', { method: 'POST', body: formData(e.target) });
        toast('Test email sent. Check the inbox (and spam folder).');
      } catch (err) { toast(err.message, 'error'); }
    });
  };

  $('#restore', el).onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const r = await confirmDialog({
      title: 'Restore this backup?',
      message: `Everything currently in this browser will be replaced with the contents of <strong>${esc(file.name)}</strong>. Download a backup of the current data first if you might need it.`,
      confirmLabel: 'Replace with backup', danger: true,
    });
    if (r && await restoreFromFile(file)) render();
  };
  $('#wipe', el).onclick = async () => {
    const r = await confirmDialog({
      title: 'Delete all store data?',
      message: 'This permanently removes every product, order, customer and expense from this browser. Your store details and email settings are kept. This can’t be undone without a backup file.',
      confirmLabel: 'Delete everything', danger: true, typeToConfirm: 'DELETE',
    });
    if (!r) return;
    await api('/reset', { method: 'POST', body: { sample: false } });
    toast('All store data deleted.');
    render();
  };
  $('#sample', el)?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
    await api('/reset', { method: 'POST', body: { sample: true } });
    toast('Sample data loaded.');
    location.hash = '#/dashboard';
  }));

  $('#signOutSettings', el)?.addEventListener('click', () => window.PlaensServer.auth.signOut());
  if (!$('#pf', el)) return;
  $('#pf', el).onsubmit = async (e) => {
    e.preventDefault();
    const { code, code2 } = formData(e.target);
    if (code.length < 4) { $('#pErr', el).textContent = 'Use at least 4 characters.'; return; }
    if (code !== code2) { $('#pErr', el).textContent = 'The two passcodes don’t match.'; return; }
    await setPasscode(code);
    toast('Passcode saved.');
    viewSettings(el);
    mountShell();
  };
  $('#removeCode', el)?.addEventListener('click', async () => {
    await setPasscode('');
    toast('Passcode removed.');
    viewSettings(el);
    mountShell();
  });
}

/* ================= Barcodes, shipping labels and scanning =================
   Barcodes are drawn to a canvas and used as images, which prints reliably and
   survives the html2canvas step that builds the PDFs. Every label carries the
   same value twice: a Code 128 barcode for barcode scanners, and a QR code,
   which phone cameras read far more easily. */

async function ensureBarcodeLibs() {
  if (!window.JsBarcode) await loadScript('js/vendor/jsbarcode.code128.min.js');
  if (!window.qrcode) await loadScript('js/vendor/qrcode.min.js');
}

/** Code 128 barcode as a PNG data URL. */
function barcodeDataUrl(text, { height = 60, width = 2, fontSize = 15, displayValue = true } = {}) {
  const canvas = document.createElement('canvas');
  window.JsBarcode(canvas, String(text), {
    format: 'CODE128',
    height,
    width,
    fontSize,
    displayValue,
    // 10 clear modules each side is the Code 128 minimum; without it scanners
    // often fail to see the barcode at all
    margin: Math.max(12, Math.ceil(width * 12)),
    background: '#FFFFFF',
    lineColor: '#000000',
    font: 'Arial',
    textMargin: 2,
  });
  return canvas.toDataURL('image/png');
}

/** QR code as a PNG data URL, drawn at a size that stays crisp when printed. */
function qrDataUrl(text, { moduleSize = 5, margin = 2 } = {}) {
  const qr = window.qrcode(0, 'M'); // version 0 = pick the smallest that fits
  qr.addData(String(text));
  qr.make();
  const count = qr.getModuleCount();
  const size = (count + margin * 2) * moduleSize;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + margin) * moduleSize, (r + margin) * moduleSize, moduleSize, moduleSize);
    }
  }
  return canvas.toDataURL('image/png');
}

/* ---------- Shipping label ---------- */

const LABEL = { width: 100, height: 150 }; // millimetres, the standard 4x6in courier label

function labelHtml(order, settings, { barcode, qr, logo }) {
  const addr = order.shippingAddress;
  const lines = addr ? [addr.line1, addr.line2, [addr.city, addr.postalCode].filter(Boolean).join(' '), addr.country].filter(Boolean) : [];
  const cod = order.paymentStatus === 'unpaid';
  const items = order.items.map((i) => `
    <tr>
      <td style="padding:2px 6px 2px 0;font-weight:bold;">${i.quantity}&times;</td>
      <td style="padding:2px 0;">${esc(i.name)}<span style="color:#555;"> ${esc(variantLabel(i))}</span></td>
      <td style="padding:2px 0 2px 6px;text-align:right;color:#555;white-space:nowrap;">${esc(i.sku)}</td>
    </tr>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${LABEL.width}mm ${LABEL.height}mm; margin: 0; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff; }
    .label { width: ${LABEL.width}mm; height: ${LABEL.height}mm; padding: 4mm; display: flex; flex-direction: column; }
    .box { border: 1.5px solid #000; }
    .pad { padding: 2.5mm 3mm; }
    .t { font-size: 7.5pt; text-transform: uppercase; letter-spacing: .06em; color: #333; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 3mm; }
    .cod { font-size: 20pt; font-weight: bold; line-height: 1; text-align: center; }
    .name { font-size: 13pt; font-weight: bold; line-height: 1.2; }
    .addr { font-size: 10pt; line-height: 1.35; }
    .small { font-size: 8pt; line-height: 1.35; color: #333; }
    table { width: 100%; border-collapse: collapse; font-size: 8pt; }
  </style></head><body>
  <div class="label">

    <div class="row" style="margin-bottom:2mm;">
      <div class="row" style="gap:2mm;">
        ${logo ? `<img src="${logo}" style="height:9mm;">` : ''}
        <div style="font-size:11pt;font-weight:bold;letter-spacing:.22em;">${esc(settings.storeName.toUpperCase())}</div>
      </div>
      <div style="text-align:right;">
        <div class="t">Order</div>
        <div style="font-size:11pt;font-weight:bold;">${esc(order.orderNumber)}</div>
      </div>
    </div>

    <div class="box" style="margin-bottom:2mm;">
      <img src="${barcode}" style="display:block;width:100%;height:auto;">
    </div>

    <div class="row box pad" style="margin-bottom:2mm;">
      <div>
        <div class="t">Payment</div>
        <div class="cod">${cod ? 'COD' : 'PAID'}</div>
        ${cod ? `<div style="font-size:11pt;font-weight:bold;text-align:center;">${esc(money(order.total))}</div>`
              : `<div class="small" style="text-align:center;">${esc(LABELS.method[order.paymentMethod] || order.paymentMethod)}</div>`}
      </div>
      <img src="${qr}" style="width:24mm;height:24mm;">
    </div>

    <div class="box pad" style="margin-bottom:2mm;flex:none;">
      <div class="t">Deliver to</div>
      <div class="name">${esc(order.customer.name)}</div>
      <div class="addr">${lines.map(esc).join('<br>') || 'No address on this order'}</div>
      ${order.customer.phone ? `<div class="addr" style="font-weight:bold;margin-top:1mm;">${esc(order.customer.phone)}</div>` : ''}
    </div>

    <div class="box pad" style="margin-bottom:2mm;">
      <div class="t">From</div>
      <div class="small"><strong>${esc(settings.storeName)}</strong>${settings.address ? `, ${esc(settings.address)}` : ''}${settings.phone ? `, ${esc(settings.phone)}` : ''}</div>
    </div>

    <div class="box pad" style="flex:1;overflow:hidden;">
      <div class="row" style="margin-bottom:1mm;">
        <span class="t">Contents</span>
        <span class="small">${order.items.reduce((s, i) => s + i.quantity, 0)} piece${order.items.reduce((s, i) => s + i.quantity, 0) === 1 ? '' : 's'}</span>
      </div>
      <table>${items}</table>
    </div>

    <div class="row" style="margin-top:2mm;">
      <div class="small">${fmtDate(order.createdAt)}</div>
      <div class="small">${order.trackingNumber ? `${esc(order.carrier)} ${esc(order.trackingNumber)}` : 'Tracking number not set'}</div>
    </div>

  </div></body></html>`;
}

async function buildLabel(order) {
  await ensureBarcodeLibs();
  let logo = '';
  try { logo = await receiptLogoDataUrl(); } catch { /* opened from disk: label without the logo */ }
  return labelHtml(order, state.settings, {
    barcode: barcodeDataUrl(order.orderNumber, { height: 70, width: 2.4, fontSize: 17 }),
    qr: qrDataUrl(order.orderNumber, { moduleSize: 6 }),
    logo,
  });
}

/** Renders label HTML into a PDF sized exactly for a 4x6in courier label. */
async function labelPdf(order) {
  if (!window.html2canvas) await loadScript('js/vendor/html2canvas.min.js');
  if (!window.jspdf) await loadScript('js/vendor/jspdf.umd.min.js');
  const html = await buildLabel(order);

  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  // 100mm at 96dpi ~ 378px; render larger, then scale, so text stays sharp
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:378px;height:567px;border:0;';
  document.body.append(frame);
  try {
    await new Promise((resolve) => { frame.onload = resolve; frame.srcdoc = html; });
    const doc = frame.contentDocument;
    await Promise.all([...doc.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = r; img.onerror = r; }))));
    const canvas = await window.html2canvas(doc.querySelector('.label'), { scale: 4, backgroundColor: '#FFFFFF', logging: false });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'mm', format: [LABEL.width, LABEL.height], orientation: 'portrait', compress: true });
    pdf.setProperties({ title: `Shipping label ${order.orderNumber}`, author: state.settings.storeName });
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, LABEL.width, LABEL.height);
    return pdf.output('blob');
  } finally {
    frame.remove();
  }
}

function printHtml(html) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  frame.onload = () => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 60000);
  };
  document.body.append(frame);
  frame.srcdoc = html;
}

async function shippingLabelDialog(order) {
  const html = await buildLabel(order);
  openDialog({
    title: `Shipping label for ${order.orderNumber}`,
    wide: true,
    body: `<div class="label-preview"><iframe title="Shipping label preview" sandbox></iframe></div>
      <div class="share-row">
        <button type="button" class="btn primary" id="lPdf">Download PDF</button>
        <button type="button" class="btn" id="lPrint">Print label</button>
        ${order.fulfillmentStatus === 'unfulfilled' ? '<button type="button" class="btn" id="lHandover">Hand to courier…</button>' : ''}
      </div>
      <p class="hint" style="margin-top:12px">Sized for a 4&times;6 inch courier label. On an ordinary printer, choose “Fit to page”. Scanning the barcode or QR code on the Scan page marks the order as handed over.</p>`,
    onMount: (d, close) => {
      $('iframe', d).srcdoc = html;
      $('#lPdf', d).onclick = (e) => busy(e.currentTarget, async () => {
        try {
          downloadFile(`${state.settings.storeName}-${order.orderNumber}-label.pdf`, await labelPdf(order), 'application/pdf');
          toast('Label downloaded.');
        } catch (err) { toast(err.message, 'error'); }
      });
      $('#lPrint', d).onclick = () => printHtml(html);
      $('#lHandover', d)?.addEventListener('click', () => { close(); handoverDialog(order); });
    },
  });
}

/* ---------- Barcode labels for products ---------- */

const STICKER = { cols: 4, rows: 10 }; // 40 labels on an A4 sheet

function stickerSheetHtml(rows, settings) {
  const cells = rows.map((r) => `
    <div class="sticker">
      <div class="nm">${esc(r.productName)}</div>
      <div class="vr">${esc(r.label)}${r.price ? ` &middot; ${esc(money(r.price))}` : ''}</div>
      <img src="${r.barcode}" alt="${esc(r.sku)}">
    </div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 8mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #000; background: #fff; }
    .sheet { display: grid; grid-template-columns: repeat(${STICKER.cols}, 1fr); gap: 2mm; }
    .sticker { border: 1px dashed #bbb; padding: 2mm; height: 26mm; display: flex; flex-direction: column; justify-content: center; text-align: center; overflow: hidden; page-break-inside: avoid; }
    .nm { font-size: 7.5pt; font-weight: bold; line-height: 1.15; overflow: hidden; }
    .vr { font-size: 7pt; color: #444; margin-bottom: 0.5mm; }
    .sticker img { width: 100%; height: auto; max-height: 12mm; }
  </style></head><body><div class="sheet">${cells}</div>
  <p style="font-size:8pt;color:#666;margin-top:4mm;">${esc(settings.storeName)} &middot; ${rows.length} label${rows.length === 1 ? '' : 's'} &middot; ${fmtDate(new Date())}</p>
  </body></html>`;
}

async function barcodeSheetDialog(items) {
  await ensureBarcodeLibs();
  openDialog({
    title: 'Print barcode labels',
    wide: true,
    body: `<p class="hint">One label per sticker, ${STICKER.cols * STICKER.rows} to an A4 sheet. Set how many of each you need, then print onto sticker paper or plain paper and cut along the dashed lines.</p>
      <div class="toolbar" style="margin:14px 0">
        <button type="button" class="btn small" id="bcAll">All to 1</button>
        <button type="button" class="btn small" id="bcNone">All to 0</button>
        <button type="button" class="btn small" id="bcStock">Match stock</button>
      </div>
      <div class="table-wrap" style="max-height:44vh;overflow:auto">
        <table class="table"><thead><tr><th>Product</th><th>Size and colour</th><th>SKU</th><th class="num">In stock</th><th class="num">Labels</th></tr></thead>
        <tbody>${items.map((i, n) => `<tr>
          <td class="strong">${esc(i.productName)}</td><td>${esc(i.label)}</td><td class="sub">${esc(i.sku)}</td>
          <td class="num sub">${i.stock}</td>
          <td class="num"><input type="number" min="0" max="200" step="1" value="0" data-n="${n}" style="width:80px;text-align:right"></td>
        </tr>`).join('')}</tbody></table>
      </div>
      <p class="form-error" id="bcErr"></p>
      <div class="form-foot"><span class="grow"></span>
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="button" class="btn" id="bcPdf">Download PDF</button>
        <button type="button" class="btn primary" id="bcPrint">Print sheet</button>
      </div>`,
    onMount: (d) => {
      const inputs = $$('input[data-n]', d);
      const setAll = (fn) => inputs.forEach((el, n) => { el.value = fn(items[n]); });
      $('#bcAll', d).onclick = () => setAll(() => 1);
      $('#bcNone', d).onclick = () => setAll(() => 0);
      $('#bcStock', d).onclick = () => setAll((i) => Math.min(200, Math.max(0, i.stock)));

      const collect = () => {
        const rows = [];
        inputs.forEach((el, n) => {
          const count = Math.min(200, Math.max(0, Math.floor(Number(el.value) || 0)));
          for (let k = 0; k < count; k++) rows.push(items[n]);
        });
        if (!rows.length) {
          $('#bcErr', d).textContent = 'Set how many labels you need for at least one item.';
          return null;
        }
        $('#bcErr', d).textContent = '';
        return rows.map((r) => ({ ...r, barcode: barcodeDataUrl(r.sku, { height: 40, width: 1.6, fontSize: 12 }) }));
      };

      $('#bcPrint', d).onclick = (e) => busy(e.currentTarget, async () => {
        const rows = collect();
        if (rows) printHtml(stickerSheetHtml(rows, state.settings));
      });
      $('#bcPdf', d).onclick = (e) => busy(e.currentTarget, async () => {
        const rows = collect();
        if (!rows) return;
        try {
          if (!window.html2canvas) await loadScript('js/vendor/html2canvas.min.js');
          if (!window.jspdf) await loadScript('js/vendor/jspdf.umd.min.js');
          const frame = document.createElement('iframe');
          frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0;';
          document.body.append(frame);
          try {
            await new Promise((resolve) => { frame.onload = resolve; frame.srcdoc = stickerSheetHtml(rows, state.settings); });
            const doc = frame.contentDocument;
            await Promise.all([...doc.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = r; img.onerror = r; }))));
            const canvas = await window.html2canvas(doc.body, { scale: 2.5, backgroundColor: '#FFFFFF', logging: false });
            const { jsPDF } = window.jspdf;
            const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
            const w = 194;
            const h = (canvas.height * w) / canvas.width;
            const usable = 281;
            const img = canvas.toDataURL('image/jpeg', 0.95);
            for (let offset = 0; offset < h; offset += usable) {
              if (offset > 0) pdf.addPage();
              pdf.addImage(img, 'JPEG', 8, 8 - offset, w, h);
              pdf.setFillColor(255, 255, 255);
              pdf.rect(0, 0, 210, 8, 'F');
              pdf.rect(0, 289, 210, 8, 'F');
            }
            downloadFile(`${state.settings.storeName}-barcode-labels.pdf`, pdf.output('blob'), 'application/pdf');
            toast(`${rows.length} label${rows.length === 1 ? '' : 's'} downloaded.`);
          } finally { frame.remove(); }
        } catch (err) { toast(err.message, 'error'); }
      });
    },
  });
}

/* ================= Scan =================
   Uses the browser's built-in barcode reader where it exists (Android Chrome,
   desktop Chrome and Edge), and falls back to jsQR for QR codes, which covers
   iPhones. Cameras only work over https or on localhost, so this works on
   GitHub Pages and with Live Server, but not from a file opened off the disk. */

const scanner = { stream: null, raf: null, stop: null };

function stopScanner() {
  if (scanner.raf) cancelAnimationFrame(scanner.raf);
  if (scanner.stream) scanner.stream.getTracks().forEach((t) => t.stop());
  scanner.raf = null;
  scanner.stream = null;
}
window.addEventListener('hashchange', stopScanner);

async function viewScan(el) {
  el.innerHTML = `
    ${pageHead('Scan', 'Scan a label before it goes out, to record the handover and add the tracking number.')}
    <div class="split" style="margin-top:0;grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
      <section class="panel">
        <h2>Camera</h2>
        <div class="scan-stage" id="stage">
          <video id="cam" playsinline muted></video>
          <div class="scan-frame" aria-hidden="true"></div>
          <p class="scan-msg" id="camMsg">Press Start camera and hold the label steady in the frame.</p>
        </div>
        <div class="share-row">
          <button type="button" class="btn primary" id="startCam">Start camera</button>
          <button type="button" class="btn" id="stopCam" hidden>Stop camera</button>
        </div>
        <p class="hint" id="scanHint" style="margin-top:12px"></p>
      </section>

      <section class="panel">
        <h2>Or type the code</h2>
        <form id="manual" class="stack" style="margin-top:12px">
          <label class="field">Order number or SKU<input name="code" placeholder="PL-1042 or PL-HLS-M-SAN" autocomplete="off"></label>
          <button class="btn">Look it up</button>
        </form>
        <div id="result" style="margin-top:20px"></div>
      </section>
    </div>`;

  const msg = $('#camMsg', el);
  const video = $('#cam', el);

  const handle = async (code) => {
    stopScanner();
    $('#startCam', el).hidden = false;
    $('#stopCam', el).hidden = true;
    $('#stage', el).classList.remove('live');
    await showScanResult($('#result', el), code);
  };

  $('#startCam', el).onclick = async (e) => {
    const btn = e.currentTarget;
    if (!navigator.mediaDevices?.getUserMedia) {
      msg.textContent = 'This browser can’t use the camera here. Type the code instead.';
      return;
    }
    if (!window.isSecureContext) {
      msg.textContent = 'Cameras only work on a secure (https) address or on localhost. Type the code instead.';
      return;
    }
    await busy(btn, async () => {
      try {
        scanner.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      } catch (err) {
        msg.textContent = err && err.name === 'NotAllowedError'
          ? 'Camera access was blocked. Allow it in your browser settings, or type the code instead.'
          : 'No camera was available. Type the code instead.';
        return;
      }
      video.srcObject = scanner.stream;
      await video.play();
      $('#stage', el).classList.add('live');
      btn.hidden = true;
      $('#stopCam', el).hidden = false;
      msg.textContent = '';

      if ('BarcodeDetector' in window) {
        const detector = new window.BarcodeDetector({ formats: ['code_128', 'qr_code', 'code_39', 'ean_13'] });
        $('#scanHint', el).textContent = 'Point the camera at the barcode or the QR code on the label.';
        const tick = async () => {
          if (!scanner.stream) return;
          try {
            const found = await detector.detect(video);
            if (found.length) return handle(found[0].rawValue);
          } catch { /* a dropped frame; try the next one */ }
          scanner.raf = requestAnimationFrame(tick);
        };
        scanner.raf = requestAnimationFrame(tick);
      } else {
        // iPhones and older browsers: read the QR code instead
        if (!window.jsQR) await loadScript('js/vendor/jsqr.min.js');
        $('#scanHint', el).textContent = 'This browser reads the QR code on the label rather than the barcode. Point the camera at the QR square.';
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const tick = () => {
          if (!scanner.stream) return;
          if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const found = window.jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
            if (found && found.data) return handle(found.data);
          }
          scanner.raf = requestAnimationFrame(tick);
        };
        scanner.raf = requestAnimationFrame(tick);
      }
    });
  };

  $('#stopCam', el).onclick = () => {
    stopScanner();
    $('#startCam', el).hidden = false;
    $('#stopCam', el).hidden = true;
    $('#stage', el).classList.remove('live');
    msg.textContent = 'Camera stopped.';
  };

  $('#manual', el).onsubmit = (e) => {
    e.preventDefault();
    const code = formData(e.target).code.trim();
    if (code) showScanResult($('#result', el), code);
  };
}

async function showScanResult(box, code) {
  box.innerHTML = '<p class="loading">Looking up…</p>';
  let found;
  try {
    found = await api(`/lookup?code=${enc(code)}`);
  } catch (err) {
    box.innerHTML = `<div class="error-state">${esc(err.message)}</div>`;
    return;
  }

  if (found.type === 'order') {
    const o = found.order;
    const closed = o.cancelled || o.paymentStatus === 'refunded';
    box.innerHTML = `
      <div class="scan-hit">
        <div class="row-between">
          <div><a href="#/orders/${o.id}" class="strong" style="font-size:17px">${esc(o.orderNumber)}</a>
            <div class="sub">${esc(o.customer.name)} &middot; ${money(o.total)}</div></div>
          <div>${statusPills(o)}</div>
        </div>
        ${closed
          ? '<p class="hint" style="margin-top:12px">This order is closed, so it shouldn’t be going out. Check before handing it over.</p>'
          : o.fulfillmentStatus === 'unfulfilled'
            ? '<button type="button" class="btn primary block" id="doHandover" style="margin-top:14px">Hand to courier</button>'
            : `<p class="hint" style="margin-top:12px">Already marked as ${esc(LABELS.fulfillment[o.fulfillmentStatus].toLowerCase())}${o.trackingNumber ? `, tracking ${esc(o.trackingNumber)}` : ''}.</p>
               <button type="button" class="btn block" id="doHandover" style="margin-top:10px">Update courier details</button>`}
      </div>`;
    $('#doHandover', box)?.addEventListener('click', () => handoverDialog(o, () => showScanResult(box, code)));
  } else if (found.type === 'variant') {
    const v = found.variant;
    box.innerHTML = `
      <div class="scan-hit">
        <div class="row-between">
          <div><span class="strong" style="font-size:17px">${esc(v.productName)}</span>
            <div class="sub">${esc(v.label)} &middot; ${esc(v.sku)}</div></div>
          <span class="${stockClass(v.stock, v.threshold)}" style="font-size:20px">${v.stock}</span>
        </div>
        <p class="hint" style="margin-top:12px">${v.stock === 0 ? 'Sold out.' : `${v.stock} in stock`} at ${money(v.price)}.</p>
        <a class="btn block" href="#/inventory" style="margin-top:10px">Open inventory</a>
      </div>`;
  } else {
    box.innerHTML = `<div class="empty"><p>Nothing matches <strong>${esc(code)}</strong>. It may belong to another store, or the order may have been deleted.</p></div>`;
  }
}

function handoverDialog(order, onDone) {
  const delivered = order.fulfillmentStatus === 'delivered';
  openDialog({
    title: delivered ? `Courier details for ${order.orderNumber}` : `Hand ${order.orderNumber} to the courier`,
    body: `<p>${esc(order.customer.name)} &middot; ${order.items.reduce((s, i) => s + i.quantity, 0)} piece${order.items.reduce((s, i) => s + i.quantity, 0) === 1 ? '' : 's'} &middot; ${money(order.total)}
      ${order.paymentStatus === 'unpaid' ? `<br><strong>Cash on delivery: collect ${money(order.total)}</strong>` : ''}</p>
      <form id="hoForm" class="form-grid" style="margin-top:18px" novalidate>
        <label class="field">Courier<input name="carrier" value="${esc(order.carrier || '')}" placeholder="Domex, Pronto, Koombiyo…" autocomplete="off"></label>
        <label class="field">Tracking number<input name="trackingNumber" value="${esc(order.trackingNumber || '')}" placeholder="From the courier" autocomplete="off"></label>
        <p class="hint span-2" style="margin:0">${delivered
          ? 'This order is already marked as delivered, so only the courier details change.'
          : 'This marks the order as shipped and records the handover in its history. You can add the tracking number later if the courier hasn’t given it yet.'}</p>
        <p class="form-error span-2" id="hoErr"></p>
        <div class="form-foot span-2" style="margin-top:0"><span class="grow"></span>
          <button type="button" class="btn" data-close>Cancel</button>
          <button class="btn primary">${delivered ? 'Save courier details' : 'Confirm handover'}</button>
        </div>
      </form>`,
    onMount: (d, close) => {
      const f = $('#hoForm', d);
      f.carrier.focus();
      f.onsubmit = (e) => {
        e.preventDefault();
        busy(e.submitter, async () => {
          try {
            // An already-delivered order keeps that status; this just corrects the courier details.
            const delivered = order.fulfillmentStatus === 'delivered';
            await api(`/orders/${order.id}/fulfillment`, {
              method: 'PATCH',
              body: { status: delivered ? 'delivered' : 'shipped', handover: !delivered, ...formData(f) },
            });
            toast(delivered ? 'Courier details updated.' : `${order.orderNumber} handed to the courier.`);
            close();
            if (onDone) onDone();
            else if (location.hash.includes(order.id)) render();
          } catch (err) { $('#hoErr', d).textContent = err.message; }
        });
      };
    },
  });
}
