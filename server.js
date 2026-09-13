/*
 * PLAENS store engine (runs entirely in the browser)
 *
 * This file is the "backend": products, stock, orders, customers, expenses,
 * profit reports and the email receipt. It stores everything in the browser's
 * IndexedDB, or in Firebase when js/firebase-config.js is switched on.
 *
 * It's organised as small modules (config, utils, db, inventory, products,
 * customers, orders, receipt, cloud, reports, mailer, sample, api). Each one is
 * wrapped in define() below and they load each other with require(), just
 * like Node. The dashboard (app.js) only talks to window.PlaensServer.
 */
(function () {
  'use strict';

  const factories = {};
  const cache = {};
  function define(name, factory) { factories[name] = factory; }
  function require(path) {
    const name = path.split('/').pop().replace(/\.js$/, '');
    if (cache[name]) return cache[name].exports;
    if (!factories[name]) throw new Error(`Module not found: ${path}`);
    const module = { exports: {} };
    cache[name] = module;
    factories[name](module, module.exports, require);
    return module.exports;
  }

  /* ============================================================
     config
     ============================================================ */
  define('config', function (module, exports, require) {
    // Defaults used when the store is first set up. Everything here can be changed in Settings.
    module.exports = {
      storeDefaults: {
        storeName: 'PLAENS',
        email: 'hello@plaens.com',
        phone: '',
        address: '',
        website: 'https://plaens.com',
        instagram: '@plaens',
        currency: 'LKR',
        taxRate: 0,
        lowStockThreshold: 5,
        receiptNote: 'Thank you for shopping with PLAENS.',
        // EmailJS (emailjs.com) lets a website send email without a server
        emailServiceId: '',
        emailTemplateId: '',
        emailPublicKey: '',
      },
    };
  });

  /* ============================================================
     utils
     ============================================================ */
  define('utils', function (module, exports, require) {
    class HttpError extends Error {
      constructor(status, message, details) {
        super(message);
        this.status = status;
        if (details) this.details = details;
      }
    }

    /** Round to 2 decimal places, handling float noise (1.005 -> 1.01). */
    const money = (value) => {
      const n = Number(value) || 0;
      return Math.round((n + Math.sign(n) * Number.EPSILON) * 100) / 100;
    };

    const now = () => new Date().toISOString();

    /** Lets async route handlers pass errors to Express's error handler. */
    const wrap = (fn) => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);

    const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

    function str(value, field, { required = false, max = 500 } = {}) {
      if (isBlank(value)) {
        if (required) throw new HttpError(400, `${field} is required.`);
        return '';
      }
      const s = String(value).trim();
      if (s.length > max) throw new HttpError(400, `${field} must be ${max} characters or fewer.`);
      return s;
    }

    function num(value, field, { required = false, min = 0, max = Infinity, integer = false, fallback = 0 } = {}) {
      if (isBlank(value)) {
        if (required) throw new HttpError(400, `${field} is required.`);
        return fallback;
      }
      const n = Number(value);
      if (!Number.isFinite(n)) throw new HttpError(400, `${field} must be a number.`);
      if (integer && !Number.isInteger(n)) throw new HttpError(400, `${field} must be a whole number.`);
      if (n < min) throw new HttpError(400, `${field} must be at least ${min}.`);
      if (n > max) throw new HttpError(400, `${field} must be ${max} or less.`);
      return n;
    }

    function email(value, field = 'Email', { required = false } = {}) {
      const s = str(value, field, { required, max: 200 });
      if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new HttpError(400, `${field} isn't a valid email address.`);
      return s.toLowerCase();
    }

    function oneOf(value, field, allowed, fallback) {
      if (isBlank(value)) {
        if (fallback === undefined) throw new HttpError(400, `${field} is required.`);
        return fallback;
      }
      if (!allowed.includes(value)) throw new HttpError(400, `${field} must be one of: ${allowed.join(', ')}.`);
      return value;
    }

    function address(value) {
      const a = value && typeof value === 'object' ? value : {};
      return {
        line1: str(a.line1, 'Address line 1', { max: 200 }),
        line2: str(a.line2, 'Address line 2', { max: 200 }),
        city: str(a.city, 'City', { max: 100 }),
        postalCode: str(a.postalCode, 'Postal code', { max: 20 }),
        country: str(a.country, 'Country', { max: 80 }),
      };
    }

    const hasAddress = (a) => Boolean(a && (a.line1 || a.city));

    /* ---------- Dates (all in server local time; set TZ in .env) ---------- */

    /** Parses 'YYYY-MM-DD' as a local date (not UTC), or any ISO string. */
    function parseDay(value) {
      if (value instanceof Date) return new Date(value);
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
      if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return new Date(value);
    }

    const pad = (n) => String(n).padStart(2, '0');
    const dayKey = (d) => {
      const x = d instanceof Date ? d : new Date(d);
      return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
    };
    const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
    const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
    const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

    function dateRange(query = {}, defaultDays = 30) {
      const to = query.to ? endOfDay(parseDay(query.to)) : endOfDay(new Date());
      const from = query.from ? startOfDay(parseDay(query.from)) : startOfDay(addDays(to, -(defaultDays - 1)));
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        throw new HttpError(400, 'Dates must use the YYYY-MM-DD format.');
      }
      if (from > to) throw new HttpError(400, 'The start date must be on or before the end date.');
      return { from, to };
    }

    const inRange = (value, { from, to }) => {
      const d = parseDay(value);
      return d >= from && d <= to;
    };

    module.exports = {
      HttpError, money, now, wrap, isBlank, str, num, email, oneOf, address, hasAddress,
      parseDay, dayKey, startOfDay, endOfDay, addDays, dateRange, inRange,
    };
  });

  /* ============================================================
     db
     ============================================================ */
  define('db', function (module, exports, require) {
    /**
     * Storage.
     *
     * Two modes, chosen by js/firebase-config.js:
     *   Browser mode (default)  Data is saved in this browser's IndexedDB. Works offline,
     *                           no account needed, but lives on this one device.
     *   Firebase mode           Data is saved in your Firestore database and syncs live
     *                           across every device you sign in on.
     *
     * Either way, all data is kept in memory while the app is open, and changes are
     * written at the end of each action (flush).
     */
    const config = require('./config');
    const cloud = require('./cloud');
    const { HttpError } = require('./utils');

    const DB_NAME = 'plaens-admin';
    const STORE = 'kv';
    const KEY = 'state';
    const LS_KEY = 'plaens_admin_state';

    const EMPTY = {
      products: [],
      customers: [],
      orders: [],
      stockMovements: [],
      expenses: [],
      images: [],   // one entry per product: { id: productId, data: <data URL> }
      counters: { order: 1000 },
      settings: null,
      meta: { setupComplete: false, createdAt: null, lastBackupAt: null },
    };

    let state = null;
    let dirty = false;
    let mode = 'local';
    let backend = 'indexeddb';
    let idb = null;
    let busyDepth = 0;
    let remoteWaiting = false;
    const changeListeners = new Set();
    const statusListeners = new Set();

    const emitChange = () => changeListeners.forEach((fn) => fn());
    const emitStatus = (s, detail) => statusListeners.forEach((fn) => fn(s, detail));

    /* ---------- Browser storage (IndexedDB, falling back to localStorage) ---------- */

    function openIdb() {
      if (idb) return idb;
      idb = new Promise((resolve, reject) => {
        if (!('indexedDB' in self)) return reject(new Error('IndexedDB not available'));
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return idb;
    }

    async function readLocal() {
      try {
        const d = await openIdb();
        return await new Promise((resolve, reject) => {
          const q = d.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
          q.onsuccess = () => resolve(q.result || null);
          q.onerror = () => reject(q.error);
        });
      } catch {
        backend = 'localstorage';
        const raw = localStorage.getItem(LS_KEY);
        return raw ? JSON.parse(raw) : null;
      }
    }

    async function writeLocal(value) {
      if (backend === 'indexeddb') {
        try {
          const d = await openIdb();
          await new Promise((resolve, reject) => {
            const tx = d.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(value, KEY);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
          });
          return;
        } catch {
          backend = 'localstorage';
        }
      }
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(value));
      } catch {
        throw new HttpError(507, 'Browser storage is full. Download a backup, then delete old data to free up space.');
      }
    }

    /* ---------- Shared ---------- */

    function normalize(raw) {
      const s = { ...structuredClone(EMPTY), ...(raw || {}) };
      s.settings = { ...config.storeDefaults, ...(s.settings || {}) };
      s.meta = { ...EMPTY.meta, ...(s.meta || {}) };
      s.counters = { ...EMPTY.counters, ...(s.counters || {}) };
      return s;
    }

    function applyRemote() {
      if (!cloud.applyPending()) return;
      state = normalize(cloud.assemble());
      emitChange();
    }

    async function load() {
      if (cloud.enabled()) {
        mode = 'cloud';
        cloud.onRemote(() => {
          if (busyDepth === 0) applyRemote();
          else remoteWaiting = true; // don't swap data out from under an action in progress
        });
        cloud.onStatus(emitStatus);
        state = normalize(await cloud.load());
        emitStatus('saved');
        return state;
      }
      mode = 'local';
      state = normalize(await readLocal());
      return state;
    }

    /** Marks data as changed. It's written at the end of the current action. */
    function save() { dirty = true; }

    async function flush() {
      if (!dirty) return false;
      dirty = false;
      if (mode === 'cloud') {
        emitStatus('saving');
        try {
          await cloud.save(state);
          emitStatus('saved');
        } catch (err) {
          const { state: good, error } = await cloud.recover(err);
          state = normalize(good);
          emitStatus(error.status === 503 ? 'offline' : 'error', error.message);
          emitChange();
          throw error;
        }
        return true;
      }
      await writeLocal(state);
      return true;
    }

    function begin() { busyDepth += 1; }
    function end() {
      busyDepth -= 1;
      if (busyDepth === 0 && remoteWaiting) {
        remoteWaiting = false;
        applyRemote();
      }
    }

    function replace(raw) {
      state = normalize(raw);
      dirty = true;
    }

    function id(prefix) {
      const bytes = crypto.getRandomValues(new Uint8Array(6));
      return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    }

    function nextOrderNumber() {
      state.counters.order += 1;
      return `PL-${state.counters.order}`;
    }

    module.exports = {
      EMPTY, load, save, flush, begin, end, replace, id, nextOrderNumber, readLocal,
      onChange: (fn) => changeListeners.add(fn),
      onStatus: (fn) => statusListeners.add(fn),
      get mode() { return mode; },
      get backend() { return mode === 'cloud' ? 'firebase' : backend; },
      get data() {
        if (!state) throw new Error('Storage not loaded yet.');
        return state;
      },
    };
  });

  /* ============================================================
     inventory
     ============================================================ */
  define('inventory', function (module, exports, require) {
    /**
     * Every stock change goes through adjust(), so there is always a record of
     * why stock moved: opening stock, restocks, sales, returns, damage, counts.
     */
    const db = require('../db');
    const { HttpError, now } = require('../utils');

    const REASONS = ['initial', 'restock', 'sale', 'return', 'cancelled', 'damage', 'lost', 'adjustment'];

    const variantLabel = (v) => [v.size, v.color].filter(Boolean).join(' / ') || 'Default';

    function locate(productId, variantId) {
      const product = db.data.products.find((p) => p.id === productId);
      if (!product) throw new HttpError(404, 'Product not found.');
      const variant = product.variants.find((v) => v.id === variantId);
      if (!variant) throw new HttpError(404, 'That size or colour no longer exists on this product.');
      return { product, variant };
    }

    function findVariant(variantId) {
      for (const product of db.data.products) {
        const variant = product.variants.find((v) => v.id === variantId);
        if (variant) return { product, variant };
      }
      return null;
    }

    /** Changes stock and records a movement. Does not call db.save(); the caller does. */
    function adjust(product, variant, change, reason, { reference = null, note = '' } = {}) {
      if (!REASONS.includes(reason)) throw new HttpError(400, `Unknown stock reason: ${reason}.`);
      if (!Number.isInteger(change)) throw new HttpError(400, 'Stock changes must be whole numbers.');
      const after = variant.stock + change;
      if (after < 0) {
        throw new HttpError(409, `Not enough stock of ${product.name} (${variantLabel(variant)}). Available: ${variant.stock}.`);
      }
      variant.stock = after;
      product.updatedAt = now();
      const movement = {
        id: db.id('mov'),
        productId: product.id,
        variantId: variant.id,
        productName: product.name,
        variantLabel: variantLabel(variant),
        sku: variant.sku,
        change,
        stockAfter: after,
        reason,
        reference,
        note,
        createdAt: now(),
      };
      db.data.stockMovements.push(movement);
      return movement;
    }

    /** Flat list of every variant, which is what an inventory screen needs. */
    function listStock() {
      const rows = [];
      for (const p of db.data.products) {
        if (p.status === 'archived') continue;
        for (const v of p.variants) {
          const costPrice = v.costPrice ?? p.costPrice;
          rows.push({
            productId: p.id,
            productName: p.name,
            thumb: p.thumb || '',
            category: p.category,
            variantId: v.id,
            size: v.size,
            color: v.color,
            label: variantLabel(v),
            sku: v.sku,
            stock: v.stock,
            threshold: p.lowStockThreshold,
            low: v.stock <= p.lowStockThreshold,
            costPrice,
            price: v.price ?? p.price,
            valueAtCost: Math.round(v.stock * costPrice * 100) / 100,
          });
        }
      }
      return rows.sort((a, b) => a.productName.localeCompare(b.productName) || a.label.localeCompare(b.label));
    }

    module.exports = { REASONS, variantLabel, locate, findVariant, adjust, listStock };
  });

  /* ============================================================
     products
     ============================================================ */
  define('products', function (module, exports, require) {
    const db = require('../db');
    const inventory = require('./inventory');
    const { HttpError, str, num, oneOf, money, now, isBlank } = require('../utils');

    const STATUSES = ['active', 'draft', 'archived'];

    const clean = (s, n) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, n);

    /** e.g. "Horizon Linen Shirt", M, Sand -> PL-HLS-M-SAN */
    function makeSku(name, size, color, taken) {
      const initials = String(name).split(/\s+/).map((w) => w[0]).join('');
      const base = ['PL', clean(initials, 4), clean(size, 4), clean(color, 3)].filter(Boolean).join('-');
      let sku = base;
      let i = 2;
      while (taken.has(sku.toLowerCase())) sku = `${base}-${i++}`;
      return sku;
    }

    function skusInUse(exceptProductId) {
      const set = new Set();
      for (const p of db.data.products) {
        if (p.id === exceptProductId) continue;
        for (const v of p.variants) set.add(v.sku.toLowerCase());
      }
      return set;
    }

    function parseBase(body, existing) {
      const settings = db.data.settings;
      return {
        name: str(body.name, 'Name', { required: true, max: 120 }),
        category: str(body.category, 'Category', { max: 60 }),
        description: str(body.description, 'Description', { max: 2000 }),
        price: money(num(body.price, 'Selling price', { required: true })),
        costPrice: money(num(body.costPrice, 'Cost per item', { required: true })),
        compareAtPrice: isBlank(body.compareAtPrice) ? null : money(num(body.compareAtPrice, 'Compare-at price')),
        status: oneOf(body.status, 'Status', STATUSES, existing?.status || 'active'),
        lowStockThreshold: num(body.lowStockThreshold, 'Low stock alert', {
          integer: true,
          fallback: existing?.lowStockThreshold ?? settings.lowStockThreshold,
        }),
      };
    }

    function parseVariants(list, productName, exceptProductId) {
      let input = Array.isArray(list) ? list : [];
      if (input.length === 0) input = [{ size: 'One size', color: '', stock: 0 }];
      if (input.length > 200) throw new HttpError(400, 'A product can have at most 200 variants.');

      const parsed = input.map((v, i) => {
        const n = i + 1;
        return {
          id: v.id || null,
          size: str(v.size, `Variant ${n} size`, { max: 30 }),
          color: str(v.color, `Variant ${n} colour`, { max: 40 }),
          sku: str(v.sku, `Variant ${n} SKU`, { max: 60 }).toUpperCase(),
          stock: num(v.stock, `Variant ${n} stock`, { integer: true }),
          price: isBlank(v.price) ? null : money(num(v.price, `Variant ${n} price`)),
          costPrice: isBlank(v.costPrice) ? null : money(num(v.costPrice, `Variant ${n} cost`)),
        };
      });

      const combos = new Set();
      for (const v of parsed) {
        const key = `${v.size.toLowerCase()}|${v.color.toLowerCase()}`;
        if (combos.has(key)) throw new HttpError(400, `There are two variants for ${inventory.variantLabel(v)}. Remove one.`);
        combos.add(key);
      }

      const taken = skusInUse(exceptProductId);
      const seen = new Set();
      for (const v of parsed) {
        if (!v.sku) continue;
        const k = v.sku.toLowerCase();
        if (taken.has(k)) throw new HttpError(409, `SKU ${v.sku} is already used by another product.`);
        if (seen.has(k)) throw new HttpError(400, `SKU ${v.sku} is used twice on this product.`);
        seen.add(k);
      }
      for (const v of parsed) {
        if (v.sku) continue;
        v.sku = makeSku(productName, v.size, v.color, new Set([...taken, ...seen]));
        seen.add(v.sku.toLowerCase());
      }
      return parsed;
    }

    function present(p) {
      const totalStock = p.variants.reduce((s, v) => s + v.stock, 0);
      return {
        ...p,
        totalStock,
        lowStockVariants: p.variants.filter((v) => v.stock <= p.lowStockThreshold).length,
        margin: p.price > 0 ? Math.round(((p.price - p.costPrice) / p.price) * 1000) / 10 : 0,
      };
    }

    function find(id) {
      const product = db.data.products.find((p) => p.id === id);
      if (!product) throw new HttpError(404, 'Product not found.');
      return product;
    }

    /**
     * Product photos.
     *
     * Two sizes are kept, because lists must stay light:
     *   product.thumb           small square, stored on the product itself, shown in every list
     *   images[{id, data}]      the larger photo, one record per product, loaded only when needed
     *
     * The browser resizes and compresses before sending (see app.js), so a photo
     * costs roughly 6 KB in lists and 60 KB in its own record. In Firebase each
     * photo is written to its own document, well inside Firestore's size limit.
     */
    const MAX_IMAGE_BYTES = 700000;

    function imageFor(productId) {
      const rec = db.data.images.find((i) => i.id === productId);
      return rec ? rec.data : '';
    }

    function checkImage(value, field) {
      const v = str(value, field, { max: MAX_IMAGE_BYTES });
      if (v && !/^data:image\/(png|jpeg|webp);base64,/.test(v)) {
        throw new HttpError(400, 'That photo could not be read. Use a JPG, PNG or WebP image.');
      }
      return v;
    }

    /** image === '' removes the photo; undefined leaves it as it is. */
    function setImage(productId, image, thumb) {
      if (image === undefined) return;
      db.data.images = db.data.images.filter((i) => i.id !== productId);
      if (image) db.data.images.push({ id: productId, data: image, updatedAt: now() });
      const product = db.data.products.find((p) => p.id === productId);
      if (product) product.thumb = image ? thumb || '' : '';
    }

    function create(body) {
      const base = parseBase(body);
      const variants = parseVariants(body.variants, base.name, null);
      const image = checkImage(body.image, 'Photo');
      const thumb = checkImage(body.thumb, 'Photo');
      const stamp = now();
      const product = { id: db.id('prd'), ...base, thumb: '', variants: [], createdAt: stamp, updatedAt: stamp };
      db.data.products.push(product);
      if (image) setImage(product.id, image, thumb);
      for (const v of variants) {
        const variant = { id: db.id('var'), size: v.size, color: v.color, sku: v.sku, price: v.price, costPrice: v.costPrice, stock: 0 };
        product.variants.push(variant);
        if (v.stock > 0) inventory.adjust(product, variant, v.stock, 'initial');
      }
      db.save();
      return product;
    }

    function update(product, body) {
      const base = parseBase({ ...product, ...body }, product);

      if (body.variants !== undefined) {
        const incoming = parseVariants(body.variants, base.name, product.id);
        const existing = new Map(product.variants.map((v) => [v.id, v]));
        const kept = new Set();
        const next = [];
        const stockChanges = [];

        for (const v of incoming) {
          const current = v.id ? existing.get(v.id) : null;
          if (current) {
            kept.add(current.id);
            Object.assign(current, { size: v.size, color: v.color, sku: v.sku, price: v.price, costPrice: v.costPrice });
            if (v.stock !== current.stock) stockChanges.push([current, v.stock - current.stock, 'adjustment', 'Edited in product form']);
            next.push(current);
          } else {
            const variant = { id: db.id('var'), size: v.size, color: v.color, sku: v.sku, price: v.price, costPrice: v.costPrice, stock: 0 };
            if (v.stock > 0) stockChanges.push([variant, v.stock, 'initial', 'New variant']);
            next.push(variant);
          }
        }

        for (const old of product.variants) {
          if (!kept.has(old.id) && old.stock > 0) {
            inventory.adjust(product, old, -old.stock, 'adjustment', { note: 'Variant removed from product' });
          }
        }
        product.variants = next;
        for (const [variant, change, reason, note] of stockChanges) inventory.adjust(product, variant, change, reason, { note });
      }

      if (body.image !== undefined) {
        setImage(product.id, checkImage(body.image, 'Photo'), checkImage(body.thumb, 'Photo'));
      }
      Object.assign(product, base, { thumb: product.thumb || '', updatedAt: now() });
      db.save();
      return product;
    }

    /** Products that appear in past orders are archived, not deleted, so sales history stays intact. */
    function remove(product) {
      const sold = db.data.orders.some((o) => o.items.some((i) => i.productId === product.id));
      if (sold) {
        product.status = 'archived';
        product.updatedAt = now();
        db.save();
        return { archived: true };
      }
      db.data.products = db.data.products.filter((p) => p.id !== product.id);
      db.data.images = db.data.images.filter((i) => i.id !== product.id);
      db.save();
      return { deleted: true };
    }

    module.exports = { STATUSES, present, find, create, update, remove, imageFor };
  });

  /* ============================================================
     customers
     ============================================================ */
  define('customers', function (module, exports, require) {
    const db = require('../db');
    const { HttpError, str, email, address, money, now, hasAddress } = require('../utils');

    const isCounted = (o) => !o.cancelled && o.paymentStatus !== 'refunded';

    function parse(body) {
      return {
        name: str(body.name, 'Customer name', { required: true, max: 120 }),
        email: email(body.email, 'Customer email'),
        phone: str(body.phone, 'Phone', { max: 40 }),
        address: address(body.address),
        notes: str(body.notes, 'Notes', { max: 1000 }),
      };
    }

    function assertEmailFree(value, exceptId) {
      if (!value) return;
      const clash = db.data.customers.find((c) => c.email === value && c.id !== exceptId);
      if (clash) throw new HttpError(409, `${value} already belongs to ${clash.name}.`);
    }

    function find(id) {
      const c = db.data.customers.find((x) => x.id === id);
      if (!c) throw new HttpError(404, 'Customer not found.');
      return c;
    }

    /** Map of customerId -> { ordersCount, totalSpent, lastOrderAt } */
    function stats() {
      const map = new Map();
      for (const o of db.data.orders) {
        if (!o.customerId || !isCounted(o)) continue;
        const s = map.get(o.customerId) || { ordersCount: 0, totalSpent: 0, lastOrderAt: null };
        s.ordersCount += 1;
        s.totalSpent = money(s.totalSpent + o.total);
        if (!s.lastOrderAt || o.createdAt > s.lastOrderAt) s.lastOrderAt = o.createdAt;
        map.set(o.customerId, s);
      }
      return map;
    }

    const blankStats = { ordersCount: 0, totalSpent: 0, lastOrderAt: null };

    function create(body) {
      const input = parse(body);
      assertEmailFree(input.email);
      const stamp = now();
      const customer = { id: db.id('cus'), ...input, createdAt: stamp, updatedAt: stamp };
      db.data.customers.push(customer);
      return customer;
    }

    function update(customer, body) {
      const input = parse({ ...customer, ...body });
      assertEmailFree(input.email, customer.id);
      Object.assign(customer, input, { updatedAt: now() });
      return customer;
    }

    /**
     * Works out who an order belongs to:
     *   customerId          -> existing customer
     *   customer {...}      -> matched by email, otherwise created
     *   nothing             -> walk-in sale (null)
     */
    function resolveForOrder(body) {
      if (body.customerId) return find(body.customerId);
      const c = body.customer;
      if (!c || !(c.name || c.email || c.phone)) return null;

      const input = parse(c);
      if (input.email) {
        const existing = db.data.customers.find((x) => x.email === input.email);
        if (existing) {
          if (!existing.phone && input.phone) existing.phone = input.phone;
          if (!hasAddress(existing.address) && hasAddress(input.address)) existing.address = input.address;
          existing.updatedAt = now();
          return existing;
        }
      }
      return create(input);
    }

    function remove(customer) {
      const hasOrders = db.data.orders.some((o) => o.customerId === customer.id);
      if (hasOrders) {
        throw new HttpError(409, `${customer.name} has orders on record, so they can't be deleted. Their details stay linked to those orders.`);
      }
      db.data.customers = db.data.customers.filter((c) => c.id !== customer.id);
    }

    module.exports = { find, stats, blankStats, create, update, resolveForOrder, remove, isCounted };
  });

  /* ============================================================
     orders
     ============================================================ */
  define('orders', function (module, exports, require) {
    /**
     * How the money is calculated on every order:
     *
     *   subtotal     = sum of (unit price x quantity)
     *   discount     = capped at the subtotal
     *   tax          = (subtotal - discount) x tax rate           (0 by default)
     *   total        = subtotal - discount + shipping + tax       (what the customer pays)
     *   revenue      = total - tax                                (tax isn't your money)
     *   cogs         = sum of (unit cost x quantity)              (cost of goods sold)
     *   grossProfit  = revenue - cogs
     *
     * Net profit (in reports) = gross profit - expenses in that period.
     * Unit cost is snapshotted onto each line, so changing a product's cost later
     * never rewrites the profit on old orders.
     */
    const db = require('../db');
    const inventory = require('./inventory');
    const customers = require('./customers');
    const { HttpError, str, num, oneOf, money, now, address, hasAddress, parseDay, dayKey } = require('../utils');

    const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'cod', 'online'];
    const PAYMENT_STATUSES = ['unpaid', 'paid', 'refunded'];
    const FULFILLMENT_STATUSES = ['unfulfilled', 'shipped', 'delivered'];
    const CHANNELS = ['online', 'instagram', 'facebook', 'whatsapp', 'store', 'other'];

    const isCounted = customers.isCounted;

    function find(idOrNumber) {
      const o = db.data.orders.find((x) => x.id === idOrNumber || x.orderNumber === idOrNumber);
      if (!o) throw new HttpError(404, 'Order not found.');
      return o;
    }

    function log(order, event, note = '') {
      const at = now();
      order.history.push({ at, event, note });
      order.updatedAt = at;
    }

    function buildLines(items) {
      if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'Add at least one item to the order.');
      if (items.length > 100) throw new HttpError(400, 'An order can have at most 100 lines.');

      const lines = items.map((item, i) => {
        const n = i + 1;
        const found = inventory.findVariant(item.variantId);
        if (!found) throw new HttpError(400, `Item ${n}: that product size or colour wasn't found.`);
        const { product, variant } = found;
        if (product.status === 'archived') throw new HttpError(400, `${product.name} is archived and can't be sold.`);
        const quantity = num(item.quantity, `Item ${n} quantity`, { required: true, min: 1, max: 10000, integer: true });
        const listPrice = variant.price ?? product.price;
        const unitPrice = money(num(item.unitPrice, `Item ${n} price`, { fallback: listPrice }));
        const unitCost = money(variant.costPrice ?? product.costPrice);
        return {
          product,
          variant,
          line: {
            productId: product.id,
            variantId: variant.id,
            name: product.name,
            sku: variant.sku,
            size: variant.size,
            color: variant.color,
            quantity,
            unitPrice,
            unitCost,
            lineTotal: money(unitPrice * quantity),
          },
        };
      });

      // Check stock per variant across all lines before touching anything.
      const needed = new Map();
      for (const l of lines) needed.set(l.variant.id, (needed.get(l.variant.id) || 0) + l.line.quantity);
      for (const l of lines) {
        const want = needed.get(l.variant.id);
        if (l.variant.stock < want) {
          const left = l.variant.stock;
          throw new HttpError(409, `Only ${left} left of ${l.product.name} (${inventory.variantLabel(l.variant)}), but the order needs ${want}.`);
        }
      }
      return lines;
    }

    function resolveCreatedAt(orderDate) {
      if (!orderDate) return now();
      const d = parseDay(orderDate);
      if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Order date must use the YYYY-MM-DD format.');
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(orderDate))) {
        if (dayKey(d) === dayKey(new Date())) return now();
        d.setHours(12, 0, 0, 0); // back-dated entry: record at midday
      }
      if (d > new Date(Date.now() + 60 * 1000)) throw new HttpError(400, "Order date can't be in the future.");
      return d.toISOString();
    }

    function create(body) {
      const settings = db.data.settings;

      // 1. Validate everything first; nothing is changed until all checks pass.
      const lines = buildLines(body.items);
      const subtotal = money(lines.reduce((s, l) => s + l.line.lineTotal, 0));
      const discount = money(Math.min(num(body.discount, 'Discount'), subtotal));
      const shipping = money(num(body.shipping, 'Shipping'));
      const taxRate = Number(settings.taxRate) || 0;
      const tax = money((subtotal - discount) * (taxRate / 100));
      const total = money(subtotal - discount + shipping + tax);
      const revenue = money(total - tax);
      const cogs = money(lines.reduce((s, l) => s + l.line.unitCost * l.line.quantity, 0));
      const paymentMethod = oneOf(body.paymentMethod, 'Payment method', PAYMENT_METHODS, 'cash');
      const paymentStatus = oneOf(body.paymentStatus, 'Payment status', ['unpaid', 'paid'], 'paid');
      const fulfillmentStatus = oneOf(body.fulfillmentStatus, 'Fulfilment status', FULFILLMENT_STATUSES, 'unfulfilled');
      const channel = oneOf(body.channel, 'Sales channel', CHANNELS, 'online');
      const notes = str(body.notes, 'Notes', { max: 2000 });
      const createdAt = resolveCreatedAt(body.orderDate);
      const shipTo = address(body.shippingAddress);

      // 2. Customer (may create a new customer record).
      const customer = customers.resolveForOrder(body);

      // 3. Commit.
      const order = {
        id: db.id('ord'),
        orderNumber: db.nextOrderNumber(),
        customerId: customer ? customer.id : null,
        customer: customer
          ? { name: customer.name, email: customer.email, phone: customer.phone }
          : { name: 'Walk-in customer', email: '', phone: '' },
        shippingAddress: hasAddress(shipTo) ? shipTo : customer && hasAddress(customer.address) ? { ...customer.address } : null,
        items: lines.map((l) => l.line),
        subtotal,
        discount,
        shipping,
        taxRate,
        tax,
        total,
        revenue,
        cogs,
        grossProfit: money(revenue - cogs),
        currency: settings.currency,
        paymentMethod,
        paymentStatus,
        fulfillmentStatus,
        channel,
        carrier: '',
        trackingNumber: '',
        notes,
        cancelled: false,
        cancelledAt: null,
        restocked: false,
        history: [{ at: createdAt, event: 'Order placed', note: '' }],
        emails: [],
        createdAt,
        updatedAt: now(),
      };
      if (paymentStatus === 'paid') order.history.push({ at: createdAt, event: 'Payment received', note: '' });

      for (const l of lines) {
        inventory.adjust(l.product, l.variant, -l.line.quantity, 'sale', { reference: order.orderNumber });
      }
      db.data.orders.push(order);
      db.save();
      return order;
    }

    /** Puts items back on the shelf once, no matter how many times it's called. */
    function restock(order, reason) {
      if (order.restocked) return;
      for (const item of order.items) {
        const found = inventory.findVariant(item.variantId);
        if (!found) continue; // variant was deleted since; nothing to put back
        inventory.adjust(found.product, found.variant, item.quantity, reason, { reference: order.orderNumber });
      }
      order.restocked = true;
    }

    function assertOpen(order) {
      if (order.cancelled) throw new HttpError(409, 'This order is cancelled and closed.');
      if (order.paymentStatus === 'refunded') throw new HttpError(409, 'This order was refunded and is closed.');
    }

    function setPayment(order, body) {
      assertOpen(order);
      const status = oneOf(body.status, 'Payment status', PAYMENT_STATUSES);
      if (status === order.paymentStatus) return order;

      if (status === 'refunded') {
        if (order.paymentStatus !== 'paid') throw new HttpError(409, 'Only paid orders can be refunded. Cancel unpaid orders instead.');
        if (body.restock !== false) restock(order, 'return');
        log(order, 'Refunded', str(body.note, 'Note', { max: 500 }) || (body.restock !== false ? 'Items returned to stock' : ''));
      } else {
        log(order, status === 'paid' ? 'Payment received' : 'Marked as unpaid');
      }
      order.paymentStatus = status;
      db.save();
      return order;
    }

    function setFulfillment(order, body) {
      assertOpen(order);
      const status = oneOf(body.status, 'Fulfilment status', FULFILLMENT_STATUSES);
      if (body.carrier !== undefined) order.carrier = str(body.carrier, 'Courier', { max: 80 });
      if (body.trackingNumber !== undefined) order.trackingNumber = str(body.trackingNumber, 'Tracking number', { max: 120 });
      const events = { unfulfilled: 'Marked as unfulfilled', shipped: body.handover ? 'Handed to courier' : 'Shipped', delivered: 'Delivered' };
      const note = status === 'shipped' ? [order.carrier, order.trackingNumber].filter(Boolean).join(', tracking ') : '';
      order.fulfillmentStatus = status;
      log(order, events[status], note);
      db.save();
      return order;
    }

    function cancel(order, body) {
      assertOpen(order);
      order.cancelled = true;
      order.cancelledAt = now();
      if (body.restock !== false) restock(order, 'cancelled');
      log(order, 'Cancelled', str(body.reason, 'Reason', { max: 500 }));
      db.save();
      return order;
    }

    function updateDetails(order, body) {
      if (body.notes !== undefined) order.notes = str(body.notes, 'Notes', { max: 2000 });
      if (body.shippingAddress !== undefined) {
        const a = address(body.shippingAddress);
        order.shippingAddress = hasAddress(a) ? a : null;
      }
      order.updatedAt = now();
      db.save();
      return order;
    }

    const present = (o) => ({ ...o, itemsCount: o.items.reduce((s, i) => s + i.quantity, 0) });

    module.exports = {
      PAYMENT_METHODS, PAYMENT_STATUSES, FULFILLMENT_STATUSES, CHANNELS,
      isCounted, find, create, setPayment, setFulfillment, cancel, updateDetails, present, log,
    };
  });

  /* ============================================================
     receipt
     ============================================================ */
  define('receipt', function (module, exports, require) {
    /**
     * PLAENS order confirmation receipt.
     *
     * Email clients ignore most modern CSS, so this uses nested tables and inline
     * styles, which render consistently in Gmail, Outlook, Apple Mail and phones.
     * The brand mark is the heavy "horizon" rule under the wordmark.
     */
    const db = require('../db');
    const mailer = require('./mailer');
    const { HttpError, now } = require('../utils');

    const C = {
      paper: '#F6F1EA',
      white: '#FFFFFF',
      moss: '#45291D', // PLAENS brown
      body: '#4A3A33',
      muted: '#7A6A60',
      line: '#E6DCD1',
      field: '#F3ECE4',
    };

    // Absolute address of the logo, set by the dashboard (email clients need a full https:// URL).
    let logoUrl = '';
    const setLogoUrl = (url) => { logoUrl = url; };
    const FONT = "Arial, 'Helvetica Neue', Helvetica, sans-serif";

    const PAYMENT_LABELS = {
      cash: 'Cash',
      card: 'Card',
      bank_transfer: 'Bank transfer',
      cod: 'Cash on delivery',
      online: 'Online payment',
    };

    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function formatter(currency) {
      try {
        const f = new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 });
        return (n) => f.format(n || 0);
      } catch {
        return (n) => `${currency} ${Number(n || 0).toFixed(2)}`;
      }
    }

    const addressLines = (a) =>
      a ? [a.line1, a.line2, [a.city, a.postalCode].filter(Boolean).join(' '), a.country].filter(Boolean) : [];

    function introFor(order, fmt) {
      if (order.cancelled) return 'This order has been cancelled.';
      if (order.paymentStatus === 'refunded') return `This order was refunded (${fmt(order.total)}).`;
      const parts = [];
      if (order.paymentStatus === 'paid') {
        parts.push("We've received your payment and your order is confirmed.");
      } else if (order.paymentMethod === 'cod') {
        parts.push(`Your order is confirmed. Please have ${fmt(order.total)} ready to pay when it arrives.`);
      } else if (order.paymentMethod === 'bank_transfer') {
        parts.push(`Your order is confirmed. Please transfer ${fmt(order.total)} and use ${order.orderNumber} as the payment reference.`);
      } else {
        parts.push(`Your order is confirmed. We'll start preparing it as soon as your payment of ${fmt(order.total)} comes through.`);
      }
      if (order.fulfillmentStatus === 'shipped') {
        const track = order.trackingNumber ? ` Tracking number: ${order.trackingNumber}${order.carrier ? ` (${order.carrier})` : ''}.` : '';
        parts.push(`It's on its way.${track}`);
      } else if (order.fulfillmentStatus === 'delivered') {
        parts.push('Our records show it has been delivered.');
      } else if (order.channel !== 'store') {
        parts.push("We'll let you know as soon as it ships.");
      }
      return parts.join(' ');
    }

    /**
     * `images` maps productId -> data URL. Passed in only when building the PDF:
     * email clients block data-URL images, so emailed receipts stay text-only.
     */
    function render(order, settings, images = null) {
      const fmt = formatter(order.currency || settings.currency);
      const store = settings.storeName || 'PLAENS';
      const isWalkIn = !order.customerId;
      const firstName = isWalkIn ? '' : (order.customer.name || '').trim().split(/\s+/)[0];
      const greeting = firstName ? `Thank you, ${firstName}.` : 'Thank you for your order.';
      const orderDate = new Date(order.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
      const payment = `${PAYMENT_LABELS[order.paymentMethod] || order.paymentMethod}${order.paymentStatus === 'paid' ? ', paid' : ', awaiting payment'}`;
      const intro = introFor(order, fmt);
      const subject = `Your ${store} order ${order.orderNumber} is confirmed`;
      const shipLines = addressLines(order.shippingAddress);

      const variantText = (i) => [i.size && (/^one size$/i.test(i.size) ? 'One size' : `Size ${i.size}`), i.color].filter(Boolean).join(', ');

      const photo = (i) => {
        const src = images && images[i.productId];
        if (!src) return '';
        return `<td valign="top" style="padding:16px 14px 16px 0;width:62px;border-bottom:1px solid ${C.line};">
              <img src="${esc(src)}" width="62" height="62" alt="" style="display:block;width:62px;height:62px;border:0;border-radius:4px;object-fit:cover;background:${C.field};">
            </td>`;
      };

      const itemRows = order.items
        .map(
          (i) => `
          <tr>
            ${photo(i)}
            <td style="padding:16px 0;border-bottom:1px solid ${C.line};font-family:${FONT};">
              <div style="font-size:15px;line-height:1.4;font-weight:bold;color:${C.moss};">${esc(i.name)}</div>
              <div style="font-size:13px;line-height:1.5;color:${C.muted};padding-top:3px;">
                ${esc(variantText(i))}${variantText(i) ? '<br>' : ''}${i.quantity} &times; ${esc(fmt(i.unitPrice))}
              </div>
            </td>
            <td align="right" valign="top" style="padding:16px 0;border-bottom:1px solid ${C.line};font-family:${FONT};font-size:15px;color:${C.moss};white-space:nowrap;">
              ${esc(fmt(i.lineTotal))}
            </td>
          </tr>`
        )
        .join('');

      const totalRow = (label, value, { strong = false } = {}) => `
          <tr>
            <td style="padding:${strong ? '14px' : '5px'} 0 ${strong ? '0' : '5px'};font-family:${FONT};font-size:${strong ? '17px' : '14px'};color:${strong ? C.moss : C.body};${strong ? `font-weight:bold;border-top:3px solid ${C.moss};` : ''}">${label}</td>
            <td align="right" style="padding:${strong ? '14px' : '5px'} 0 ${strong ? '0' : '5px'};font-family:${FONT};font-size:${strong ? '17px' : '14px'};color:${strong ? C.moss : C.body};white-space:nowrap;${strong ? `font-weight:bold;border-top:3px solid ${C.moss};` : ''}">${value}</td>
          </tr>`;

      const totals = [
        totalRow('Subtotal', esc(fmt(order.subtotal))),
        order.discount > 0 ? totalRow('Discount', `&minus;${esc(fmt(order.discount))}`) : '',
        order.channel === 'store' && !order.shipping ? '' : totalRow('Shipping', order.shipping > 0 ? esc(fmt(order.shipping)) : 'Free'),
        order.tax > 0 ? totalRow(`Tax (${order.taxRate}%)`, esc(fmt(order.tax))) : '',
        '<tr><td colspan="2" style="height:10px;line-height:10px;font-size:0;">&nbsp;</td></tr>',
        totalRow('Total', esc(fmt(order.total)), { strong: true }),
      ].join('');

      const metaCell = (label, value) => `
          <td class="stack" width="33%" valign="top" style="padding:14px 16px;font-family:${FONT};">
            <div style="font-size:12px;line-height:1.4;color:${C.muted};">${label}</div>
            <div style="font-size:14px;line-height:1.4;font-weight:bold;color:${C.moss};padding-top:4px;">${esc(value)}</div>
          </td>`;

      const deliveryBlock = shipLines.length
        ? `<div style="font-size:12px;color:${C.muted};padding-bottom:6px;">Delivering to</div>
           <div style="font-size:14px;line-height:1.6;color:${C.body};">${esc(order.customer.name)}<br>${shipLines.map(esc).join('<br>')}</div>`
        : `<div style="font-size:12px;color:${C.muted};padding-bottom:6px;">Delivery</div>
           <div style="font-size:14px;line-height:1.6;color:${C.body};">${order.channel === 'store' ? 'Purchased in store' : 'No delivery address on this order'}</div>`;

      const contactBits = [order.customer.email, order.customer.phone].filter(Boolean);
      const contactBlock = contactBits.length
        ? `<div style="font-size:12px;color:${C.muted};padding-bottom:6px;">Your details</div>
           <div style="font-size:14px;line-height:1.6;color:${C.body};">${contactBits.map(esc).join('<br>')}</div>`
        : '';

      const footerLinks = [
        settings.website && `<a href="${esc(settings.website)}" style="color:${C.moss};text-decoration:underline;">${esc(settings.website.replace(/^https?:\/\//, ''))}</a>`,
        settings.instagram && `Instagram ${esc(settings.instagram)}`,
        settings.phone && esc(settings.phone),
      ].filter(Boolean).join('&nbsp;&nbsp;|&nbsp;&nbsp;');

      const html = `<!doctype html>
    <html lang="en">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="x-apple-disable-message-reformatting">
    <meta name="color-scheme" content="light">
    <title>${esc(subject)}</title>
    <style>
      @media (max-width: 620px) {
        .px { padding-left: 22px !important; padding-right: 22px !important; }
        .stack { display: block !important; width: 100% !important; box-sizing: border-box; }
        .gap { padding-top: 20px !important; }
        .h1 { font-size: 24px !important; }
      }
    </style>
    </head>
    <body style="margin:0;padding:0;background:${C.paper};-webkit-text-size-adjust:100%;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.paper};">
      Order ${esc(order.orderNumber)} for ${esc(fmt(order.total))}. ${esc(intro)}
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.paper};">
    <tr><td align="center" style="padding:32px 12px;">

      <table id="receipt-card" role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${C.white};border:1px solid ${C.line};">

        <!-- Wordmark -->
        <tr><td class="px" style="padding:38px 48px 18px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td valign="middle" style="font-family:${FONT};">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                ${logoUrl ? `<td valign="middle" style="padding-right:14px;"><img src="${esc(logoUrl)}" width="46" height="48" alt="${esc(store)}" style="display:block;border:0;width:46px;height:48px;"></td>` : ''}
                <td valign="middle" style="font-family:${FONT};font-size:17px;font-weight:bold;letter-spacing:6px;color:${C.moss};">${esc(store.toUpperCase())}</td>
              </tr></table>
            </td>
            <td align="right" valign="middle" style="font-family:${FONT};font-size:13px;color:${C.muted};white-space:nowrap;">Order ${esc(order.orderNumber)}</td>
          </tr></table>
        </td></tr>

        <!-- Horizon rule -->
        <tr><td class="px" style="padding:0 48px;">
          <div style="height:4px;line-height:4px;font-size:0;background:${C.moss};">&nbsp;</div>
        </td></tr>

        <!-- Greeting -->
        <tr><td class="px" style="padding:34px 48px 6px;font-family:${FONT};">
          <h1 class="h1" style="margin:0 0 12px;font-size:28px;line-height:1.2;font-weight:bold;color:${C.moss};">${esc(greeting)}</h1>
          <p style="margin:0;font-size:15px;line-height:1.65;color:${C.body};">${esc(intro)}</p>
        </td></tr>

        <!-- Order details -->
        <tr><td class="px" style="padding:26px 48px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.field};"><tr>
            ${metaCell('Order number', order.orderNumber)}
            ${metaCell('Order date', orderDate)}
            ${metaCell('Payment', payment)}
          </tr></table>
        </td></tr>

        <!-- Items -->
        <tr><td class="px" style="padding:0 48px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td ${images ? 'colspan="2"' : ''} style="padding:0 0 10px;border-bottom:1px solid ${C.moss};font-family:${FONT};font-size:12px;color:${C.muted};">What you ordered</td>
              <td align="right" style="padding:0 0 10px;border-bottom:1px solid ${C.moss};font-family:${FONT};font-size:12px;color:${C.muted};">Amount</td>
            </tr>
            ${itemRows}
          </table>
        </td></tr>

        <!-- Totals -->
        <tr><td class="px" style="padding:14px 48px 6px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${totals}</table>
        </td></tr>

        <!-- Delivery and contact -->
        <tr><td class="px" style="padding:30px 48px 8px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td class="stack" width="50%" valign="top" style="font-family:${FONT};padding-right:16px;">${deliveryBlock}</td>
            <td class="stack gap" width="50%" valign="top" style="font-family:${FONT};">${contactBlock}</td>
          </tr></table>
        </td></tr>

        <!-- Note -->
        <tr><td class="px" style="padding:26px 48px 34px;font-family:${FONT};font-size:14px;line-height:1.65;color:${C.body};">
          ${settings.receiptNote ? `${esc(settings.receiptNote)}<br>` : ''}
          Questions about your order? Reply to this email${settings.email ? ` or write to <a href="mailto:${esc(settings.email)}" style="color:${C.moss};">${esc(settings.email)}</a>` : ''}.
        </td></tr>

        <!-- Footer -->
        <tr><td class="px" style="padding:22px 48px 30px;border-top:1px solid ${C.line};font-family:${FONT};font-size:12px;line-height:1.7;color:${C.muted};">
          <strong style="color:${C.moss};letter-spacing:3px;">${esc(store.toUpperCase())}</strong>
          ${settings.address ? `<br>${esc(settings.address)}` : ''}
          ${footerLinks ? `<br>${footerLinks}` : ''}
        </td></tr>

      </table>

    </td></tr>
    </table>
    </body>
    </html>`;

      const text = [
        `${store.toUpperCase()}`,
        '',
        greeting,
        intro,
        '',
        `Order number: ${order.orderNumber}`,
        `Order date: ${orderDate}`,
        `Payment: ${payment}`,
        '',
        ...order.items.map((i) => `${i.name}${variantText(i) ? ` (${variantText(i)})` : ''}  ${i.quantity} x ${fmt(i.unitPrice)} = ${fmt(i.lineTotal)}`),
        '',
        `Subtotal: ${fmt(order.subtotal)}`,
        order.discount > 0 ? `Discount: -${fmt(order.discount)}` : null,
        `Shipping: ${order.shipping > 0 ? fmt(order.shipping) : 'Free'}`,
        order.tax > 0 ? `Tax (${order.taxRate}%): ${fmt(order.tax)}` : null,
        `Total: ${fmt(order.total)}`,
        '',
        shipLines.length ? `Delivering to:\n${order.customer.name}\n${shipLines.join('\n')}` : null,
        '',
        settings.receiptNote || null,
        settings.email ? `Questions? Reply to this email or write to ${settings.email}.` : null,
        settings.website || null,
      ]
        .filter((l) => l !== null)
        .join('\n');

      return { subject, html, text };
    }

    function recipientFor(order) {
      if (order.customerId) {
        const c = db.data.customers.find((x) => x.id === order.customerId);
        if (c && c.email) return c.email;
      }
      return order.customer.email || '';
    }

    /** Emails the receipt and records the attempt on the order. */
    /**
     * Fields for EmailJS templates that lay the receipt out themselves
     * (the "order receipt" style template, with {{order_id}}, {{#orders}} and {{cost.total}}).
     * Templates that use {{{receipt_html}}} ignore all of this.
     */
    function templateParams(order, settings) {
      const raw = formatter(order.currency || settings.currency);
      // Intl puts a non-breaking space after the currency code; a plain space
      // survives every email client's encoding.
      const fmt = (n) => raw(n).replace(/\u00A0/g, ' ');
      const ship = addressLines(order.shippingAddress);
      const site = settings.website || '';
      return {
        order_id: order.orderNumber,
        order_date: new Date(order.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
        customer_name: order.customer.name || '',
        intro: introFor(order, fmt),
        payment: `${PAYMENT_LABELS[order.paymentMethod] || order.paymentMethod}${order.paymentStatus === 'paid' ? ', paid' : ', awaiting payment'}`,
        store_name: settings.storeName,
        receipt_note: settings.receiptNote || '',

        orders: order.items.map((i) => ({
          name: i.name,
          variant: [i.size && `Size ${i.size}`, i.color].filter(Boolean).join(', '),
          units: i.quantity,
          price: fmt(i.unitPrice),
          amount: fmt(i.lineTotal),
        })),

        cost: { subtotal: fmt(order.subtotal), shipping: order.shipping ? fmt(order.shipping) : 'Free', total: fmt(order.total) },

        /* Optional blocks. Each is an object or false, never a bare string:
           a template section over an object can read its fields in every
           template engine, which a section over a string can't. */
        logo: logoUrl ? { url: logoUrl } : false,
        discount: order.discount ? { amount: fmt(order.discount) } : false,
        tax: order.tax ? { amount: fmt(order.tax), rate: String(order.taxRate) } : false,
        delivery: ship.length ? { html: [order.customer.name, ...ship].map(esc).join('<br>') } : false,
        tracking: order.trackingNumber ? { text: `${order.carrier} ${order.trackingNumber}`.trim() } : false,
        store_email: settings.email ? { address: settings.email } : false,
        website: site ? { url: site, label: site.replace(/^https?:\/\//, '') } : false,
        instagram: settings.instagram ? { handle: settings.instagram } : false,
        phone: settings.phone ? { number: settings.phone } : false,
      };
    }

    async function sendForOrder(order) {
      if (order.cancelled || order.paymentStatus === 'refunded') {
        throw new HttpError(409, "This order is closed, so a confirmation receipt can't be sent.");
      }
      const to = recipientFor(order);
      if (!to) throw new HttpError(400, 'This order has no customer email. Add an email to the customer, then send the receipt.');

      if (!mailer.isConfigured()) {
        throw new HttpError(400, "Email isn't connected yet. Add your EmailJS details in Settings, or download the PDF to share the receipt.");
      }
      const settings = db.data.settings;
      const { subject, html, text } = render(order, settings);
      try {
        const result = await mailer.send({
          to, subject, html, text, replyTo: settings.email, tag: order.orderNumber,
          params: templateParams(order, settings),
        });
        order.emails.push({ at: now(), to, ok: true, mode: result.mode, detail: result.messageId });
        order.history.push({ at: now(), event: 'Receipt emailed', note: to });
        db.save();
        return { ok: true, to, ...result };
      } catch (err) {
        order.emails.push({ at: now(), to, ok: false, error: err.message });
        db.save();
        throw new HttpError(502, `The receipt couldn't be sent: ${err.message}`);
      }
    }

    module.exports = { render, sendForOrder, formatter, setLogoUrl, PAYMENT_LABELS };
  });

  /* ============================================================
     cloud
     ============================================================ */
  define('cloud', function (module, exports, require) {
    /**
     * Firebase (Firestore + Authentication) storage for PLAENS.
     *
     * How data is laid out in Firestore:
     *   stores/{storeId}/chunks/main            settings, counters, meta
     *   stores/{storeId}/chunks/orders~0        orders 1-150
     *   stores/{storeId}/chunks/orders~1        orders 151-300 ... and so on
     *
     * Each chunk holds a JSON string plus a revision number. Splitting into chunks
     * keeps every document well under Firestore's 1 MB limit, and opening the app
     * reads a few dozen documents instead of thousands (cheap on the free plan).
     *
     * Every save runs in a transaction that checks each chunk's revision. If
     * another device changed the same chunk a moment earlier, the save is refused,
     * the latest data is loaded, and you're asked to try again, so nothing is
     * silently overwritten. Changes from other devices arrive live.
     */
    const { HttpError } = require('./utils');

    const SIZES = { products: 25, customers: 400, orders: 150, stockMovements: 800, expenses: 800, images: 1 };
    const COLLECTIONS = Object.keys(SIZES);
    const MAX_BYTES = 950000;
    const SAVE_TIMEOUT_MS = 25000;
    const LOAD_TIMEOUT_MS = 20000;

    let colRef = null;
    let unsubscribe = null;
    let chunks = new Map(); // id -> { json, rev }
    let pending = [];
    let remoteHandler = () => {};
    let statusHandler = () => {};
    let online = true;

    const cfg = () => self.PLAENS_FIREBASE || {};
    const enabled = () => Boolean(cfg().enabled && cfg().config && cfg().config.projectId);
    const sdkLoaded = () => Boolean(self.firebase && self.firebase.firestore && self.firebase.auth);

    function init() {
      if (!sdkLoaded()) throw new HttpError(503, "Firebase didn't load. Check that the js/vendor folder is uploaded with the site.");
      if (!self.firebase.apps.length) self.firebase.initializeApp(cfg().config);
    }

    /* ---------- Friendly errors ---------- */

    const AUTH_MESSAGES = {
      'auth/invalid-credential': "That email and password don't match.",
      'auth/wrong-password': "That email and password don't match.",
      'auth/user-not-found': "That email and password don't match.",
      'auth/invalid-email': "That email address isn't valid.",
      'auth/missing-password': 'Enter your password.',
      'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again, or reset your password.',
      'auth/network-request-failed': "Can't reach Firebase. Check your internet connection.",
      'auth/operation-not-allowed': 'Email and password sign-in is turned off. Enable it in Firebase > Authentication > Sign-in method.',
      'auth/unauthorized-domain': 'This website address isn’t allowed yet. Add it in Firebase > Authentication > Settings > Authorized domains.',
      'auth/user-disabled': 'This account has been disabled in Firebase.',
    };

    function friendly(err) {
      if (err instanceof HttpError) return err;
      const code = err && err.code ? String(err.code) : '';
      if (AUTH_MESSAGES[code]) return new HttpError(400, AUTH_MESSAGES[code]);
      if (code.includes('api-key')) return new HttpError(400, 'The Firebase settings in js/firebase-config.js look wrong. Copy them again from the Firebase console.');
      if (code.includes('permission-denied')) {
        return new HttpError(403, "This account isn't allowed to open the store. Make sure its email is listed in your Firestore rules (see README).");
      }
      if (code.includes('unavailable') || code.includes('deadline-exceeded') || code.includes('network')) {
        return new HttpError(503, "You're offline or Firebase can't be reached. Your last change wasn't saved. Try again when you're back online.");
      }
      if (code.includes('not-found') && String(err.message || '').toLowerCase().includes('database')) {
        return new HttpError(503, 'No Firestore database found. Create one in Firebase > Firestore Database.');
      }
      return new HttpError(500, `Firebase error: ${err && err.message ? err.message : 'unknown problem'}`);
    }

    /* ---------- Authentication ---------- */

    const auth = {
      onChange(fn) { init(); return self.firebase.auth().onAuthStateChanged(fn); },
      user() { return sdkLoaded() && self.firebase.apps.length ? self.firebase.auth().currentUser : null; },
      async signIn(email, password) {
        init();
        try { await self.firebase.auth().signInWithEmailAndPassword(String(email || '').trim(), String(password || '')); } catch (e) { throw friendly(e); }
      },
      async resetPassword(email) {
        init();
        try { await self.firebase.auth().sendPasswordResetEmail(String(email || '').trim()); } catch (e) { throw friendly(e); }
      },
      async signOut() {
        stop();
        await self.firebase.auth().signOut();
      },
    };

    /* ---------- Chunking ---------- */

    function split(state) {
      const out = new Map();
      out.set('main', JSON.stringify({ settings: state.settings, counters: state.counters, meta: state.meta }));
      for (const c of COLLECTIONS) {
        const arr = state[c] || [];
        const n = SIZES[c];
        for (let i = 0; i * n < arr.length; i++) out.set(`${c}~${i}`, JSON.stringify(arr.slice(i * n, (i + 1) * n)));
      }
      return out;
    }

    function assemble() {
      if (!chunks.has('main')) return null; // brand-new store
      const state = { ...JSON.parse(chunks.get('main').json) };
      for (const c of COLLECTIONS) {
        const parts = [...chunks.keys()]
          .filter((k) => k.startsWith(`${c}~`))
          .map((k) => [Number(k.split('~')[1]), k])
          .sort((a, b) => a[0] - b[0]);
        state[c] = parts.flatMap(([, k]) => JSON.parse(chunks.get(k).json));
      }
      return state;
    }

    const readDoc = (d) => ({ json: d.data().json, rev: d.data().rev || 0 });

    /* ---------- Loading and live updates ---------- */

    function stop() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      chunks = new Map();
      pending = [];
    }

    async function load() {
      init();
      const user = self.firebase.auth().currentUser;
      if (!user) throw new HttpError(401, 'Sign in first.');
      stop();
      colRef = self.firebase.firestore().collection('stores').doc(cfg().storeId || 'plaens').collection('chunks');

      await new Promise((resolve, reject) => {
        let first = true;
        const timer = setTimeout(() => {
          if (!first) return;
          first = false;
          reject(new HttpError(503, "Can't reach Firebase. Check your internet connection and reload the page."));
        }, LOAD_TIMEOUT_MS);

        unsubscribe = colRef.onSnapshot({ includeMetadataChanges: true }, (snap) => {
          if (first) {
            if (snap.metadata.fromCache) return; // wait for the real server answer, never an empty offline cache
            first = false;
            clearTimeout(timer);
            snap.docs.forEach((d) => chunks.set(d.id, readDoc(d)));
            online = true;
            resolve();
            return;
          }
          const nowOnline = !snap.metadata.fromCache;
          if (nowOnline !== online) { online = nowOnline; statusHandler(online ? 'saved' : 'offline'); }
          const changes = snap.docChanges();
          if (!changes.length) return;
          changes.forEach((ch) => pending.push({ type: ch.type, id: ch.doc.id, data: ch.type === 'removed' ? null : readDoc(ch.doc) }));
          remoteHandler();
        }, (err) => {
          if (first) {
            first = false;
            clearTimeout(timer);
            reject(friendly(err));
          } else {
            statusHandler('error', friendly(err).message);
          }
        });
      });
      return assemble();
    }

    /** Applies queued changes from other devices. Returns true if anything changed. */
    function applyPending() {
      let changed = false;
      for (const p of pending) {
        const cur = chunks.get(p.id);
        if (p.type === 'removed') {
          if (cur) { chunks.delete(p.id); changed = true; }
        } else if (!cur || p.data.rev > cur.rev) {
          chunks.set(p.id, p.data);
          changed = true;
        }
      }
      pending = [];
      return changed;
    }

    /* ---------- Saving ---------- */

    class ConflictError extends Error {}

    async function save(state) {
      const next = split(state);
      const writes = [];
      for (const [id, json] of next) {
        const cur = chunks.get(id);
        if (!cur || cur.json !== json) writes.push({ id, json });
      }
      const deletes = [...chunks.keys()].filter((id) => !next.has(id));
      if (!writes.length && !deletes.length) return;

      for (const w of writes) {
        if (new Blob([w.json]).size > MAX_BYTES) {
          throw new HttpError(507, `Part of your data (${w.id}) is too large to save. Reduce the number of variants on one product.`);
        }
      }

      const who = self.firebase.auth().currentUser?.email || '';
      const ids = [...writes.map((w) => w.id), ...deletes];
      const transaction = self.firebase.firestore().runTransaction(async (tx) => {
        const snaps = await Promise.all(ids.map((id) => tx.get(colRef.doc(id))));
        snaps.forEach((snap, i) => {
          const serverRev = snap.exists ? snap.data().rev || 0 : 0;
          const expected = chunks.get(ids[i])?.rev ?? 0;
          if (serverRev !== expected) throw new ConflictError(ids[i]);
        });
        const revs = {};
        for (const w of writes) {
          revs[w.id] = (chunks.get(w.id)?.rev ?? 0) + 1;
          tx.set(colRef.doc(w.id), { json: w.json, rev: revs[w.id], updatedAt: new Date().toISOString(), updatedBy: who });
        }
        deletes.forEach((id) => tx.delete(colRef.doc(id)));
        return revs;
      });
      const timeout = new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'unavailable' })), SAVE_TIMEOUT_MS));

      const revs = await Promise.race([transaction, timeout]);
      writes.forEach((w) => chunks.set(w.id, { json: w.json, rev: revs[w.id] }));
      deletes.forEach((id) => chunks.delete(id));
    }

    /**
     * After a failed save, throws away the unsaved change and returns the latest
     * known good data (fetched fresh from the server after a conflict).
     */
    async function recover(err) {
      if (err instanceof ConflictError) {
        try {
          const snap = await colRef.get({ source: 'server' });
          chunks = new Map(snap.docs.map((d) => [d.id, readDoc(d)]));
          pending = [];
        } catch {
          applyPending();
        }
        return {
          state: assemble(),
          error: new HttpError(409, 'This was changed on another device at the same moment. The latest data is now loaded. Please try again.'),
        };
      }
      applyPending();
      return { state: assemble(), error: friendly(err) };
    }

    module.exports = {
      enabled,
      auth,
      load,
      save,
      recover,
      stop,
      applyPending,
      assemble,
      onRemote: (fn) => { remoteHandler = fn; },
      onStatus: (fn) => { statusHandler = fn; },
      storeId: () => cfg().storeId || 'plaens',
      _split: split, // exposed for tests
    };
  });

  /* ============================================================
     reports
     ============================================================ */
  define('reports', function (module, exports, require) {
    const db = require('../db');
    const { isCounted } = require('./orders');
    const { money, inRange, dayKey, addDays, startOfDay, endOfDay } = require('../utils');

    const sum = (arr, f) => money(arr.reduce((s, x) => s + (Number(f(x)) || 0), 0));
    const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

    function ordersIn(range) {
      return db.data.orders.filter((o) => inRange(o.createdAt, range));
    }

    function summary(range) {
      const all = ordersIn(range);
      const counted = all.filter(isCounted);
      const expenses = db.data.expenses.filter((e) => inRange(e.date, range));
      const refunded = all.filter((o) => !o.cancelled && o.paymentStatus === 'refunded');
      const unpaid = counted.filter((o) => o.paymentStatus === 'unpaid');

      const revenue = sum(counted, (o) => o.revenue);
      const cogs = sum(counted, (o) => o.cogs);
      const grossProfit = money(revenue - cogs);
      const expensesTotal = sum(expenses, (e) => e.amount);
      const netProfit = money(grossProfit - expensesTotal);

      return {
        orders: counted.length,
        itemsSold: counted.reduce((s, o) => s + o.items.reduce((t, i) => t + i.quantity, 0), 0),
        grossSales: sum(counted, (o) => o.subtotal),
        discounts: sum(counted, (o) => o.discount),
        shipping: sum(counted, (o) => o.shipping),
        tax: sum(counted, (o) => o.tax),
        revenue,
        cogs,
        grossProfit,
        grossMargin: pct(grossProfit, revenue),
        expenses: expensesTotal,
        netProfit,
        netMargin: pct(netProfit, revenue),
        averageOrderValue: counted.length ? money(revenue / counted.length) : 0,
        awaitingPayment: sum(unpaid, (o) => o.total),
        unpaidOrders: unpaid.length,
        cancelledOrders: all.filter((o) => o.cancelled).length,
        refundedOrders: refunded.length,
        refundedAmount: sum(refunded, (o) => o.total),
      };
    }

    function salesByDay(range) {
      const map = new Map();
      for (let d = startOfDay(range.from); d <= range.to; d = addDays(d, 1)) {
        map.set(dayKey(d), { date: dayKey(d), revenue: 0, profit: 0, orders: 0 });
      }
      for (const o of ordersIn(range).filter(isCounted)) {
        const row = map.get(dayKey(o.createdAt));
        if (!row) continue;
        row.revenue = money(row.revenue + o.revenue);
        row.profit = money(row.profit + o.grossProfit);
        row.orders += 1;
      }
      return [...map.values()];
    }

    function groupItems(range, keyFn, labelFn) {
      const map = new Map();
      for (const o of ordersIn(range).filter(isCounted)) {
        for (const i of o.items) {
          const key = keyFn(i);
          const row = map.get(key) || { key, label: labelFn(i), units: 0, sales: 0, cost: 0 };
          row.units += i.quantity;
          row.sales = money(row.sales + i.lineTotal);
          row.cost = money(row.cost + i.unitCost * i.quantity);
          map.set(key, row);
        }
      }
      return [...map.values()].map((r) => ({ ...r, profit: money(r.sales - r.cost), margin: pct(r.sales - r.cost, r.sales) }));
    }

    function topProducts(range, limit = 10) {
      return groupItems(range, (i) => i.productId, (i) => i.name)
        .sort((a, b) => b.sales - a.sales)
        .slice(0, limit);
    }

    const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', '4XL'];
    function bySize(range) {
      const rank = (s) => {
        const i = SIZE_ORDER.indexOf(String(s).toUpperCase());
        return i === -1 ? 100 : i;
      };
      return groupItems(range, (i) => i.size || 'One size', (i) => i.size || 'One size')
        .sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label, undefined, { numeric: true }));
    }

    function byChannel(range) {
      const map = new Map();
      for (const o of ordersIn(range).filter(isCounted)) {
        const row = map.get(o.channel) || { channel: o.channel, orders: 0, revenue: 0 };
        row.orders += 1;
        row.revenue = money(row.revenue + o.revenue);
        map.set(o.channel, row);
      }
      return [...map.values()].sort((a, b) => b.revenue - a.revenue);
    }

    function expensesByCategory(range) {
      const map = new Map();
      for (const e of db.data.expenses.filter((x) => inRange(x.date, range))) {
        map.set(e.category, money((map.get(e.category) || 0) + e.amount));
      }
      return [...map.entries()].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);
    }

    function inventorySnapshot() {
      let units = 0;
      let valueAtCost = 0;
      let valueAtRetail = 0;
      const lowStock = [];
      for (const p of db.data.products) {
        if (p.status === 'archived') continue;
        for (const v of p.variants) {
          units += v.stock;
          valueAtCost += v.stock * (v.costPrice ?? p.costPrice);
          valueAtRetail += v.stock * (v.price ?? p.price);
          if (p.status === 'active' && v.stock <= p.lowStockThreshold) {
            lowStock.push({
              productId: p.id,
              productName: p.name,
              variantId: v.id,
              size: v.size,
              color: v.color,
              sku: v.sku,
              stock: v.stock,
              threshold: p.lowStockThreshold,
            });
          }
        }
      }
      lowStock.sort((a, b) => a.stock - b.stock || a.productName.localeCompare(b.productName));
      return {
        units,
        valueAtCost: money(valueAtCost),
        valueAtRetail: money(valueAtRetail),
        lowStockCount: lowStock.length,
        outOfStockCount: lowStock.filter((l) => l.stock === 0).length,
        lowStock,
      };
    }

    function dashboard() {
      const to = endOfDay(new Date());
      const from = startOfDay(addDays(to, -29));
      const prevTo = endOfDay(addDays(from, -1));
      const prevFrom = startOfDay(addDays(prevTo, -29));
      const range = { from, to };
      const inventory = inventorySnapshot();
      return {
        range,
        summary: summary(range),
        previous: summary({ from: prevFrom, to: prevTo }),
        salesByDay: salesByDay(range),
        recentOrders: [...db.data.orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6),
        inventory: { ...inventory, lowStock: inventory.lowStock.slice(0, 8) },
      };
    }

    function overview(range) {
      return {
        range,
        summary: summary(range),
        salesByDay: salesByDay(range),
        topProducts: topProducts(range, 10),
        bySize: bySize(range),
        byChannel: byChannel(range),
        expensesByCategory: expensesByCategory(range),
      };
    }

    function ordersCsv(range) {
      const cell = (v) => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = [
        'Order', 'Date', 'Customer', 'Email', 'Phone', 'Channel', 'Payment method', 'Payment status',
        'Fulfilment', 'Cancelled', 'Items', 'Subtotal', 'Discount', 'Shipping', 'Tax', 'Total', 'Cost of goods', 'Gross profit',
      ];
      const rows = ordersIn(range)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((o) => [
          o.orderNumber, o.createdAt, o.customer.name, o.customer.email, o.customer.phone, o.channel, o.paymentMethod,
          o.paymentStatus, o.fulfillmentStatus, o.cancelled ? 'yes' : 'no',
          o.items.map((i) => `${i.quantity}x ${i.name} ${[i.size, i.color].filter(Boolean).join('/')}`).join('; '),
          o.subtotal, o.discount, o.shipping, o.tax, o.total, o.cogs, o.grossProfit,
        ]);
      return [header, ...rows].map((r) => r.map(cell).join(',')).join('\n');
    }

    module.exports = { summary, salesByDay, topProducts, bySize, byChannel, expensesByCategory, inventorySnapshot, dashboard, overview, ordersCsv };
  });

  /* ============================================================
     mailer
     ============================================================ */
  define('mailer', function (module, exports, require) {
    /**
     * Sends email through EmailJS (emailjs.com), which works from a static website.
     * The EmailJS template needs these fields (see README):
     *   To Email: {{to_email}}   Subject: {{subject}}   Reply To: {{reply_to}}
     *   From Name: {{store_name}}   Content (HTML): {{{receipt_html}}}
     */
    const db = require('./db');
    const { HttpError } = require('./utils');

    function isConfigured() {
      const s = db.data.settings;
      return Boolean(s.emailServiceId && s.emailTemplateId && s.emailPublicKey);
    }

    async function send({ to, subject, html, text, replyTo, params = {} }) {
      const s = db.data.settings;
      if (!isConfigured()) throw new HttpError(400, "Email isn't connected yet. Add your EmailJS details in Settings.");
      if (!self.emailjs) throw new HttpError(503, "The email service couldn't load. Check your internet connection and reload the page.");
      try {
        const res = await self.emailjs.send(
          s.emailServiceId,
          s.emailTemplateId,
          {
            ...params,
            // The same address under every name EmailJS templates commonly use,
            // so the template works whichever one its "To Email" field contains.
            to_email: to,
            email: to,
            user_email: to,
            to: to,
            recipient: to,
            subject,
            receipt_html: html,
            receipt_text: text,
            reply_to: replyTo || s.email || '',
            store_name: s.storeName,
          },
          { publicKey: s.emailPublicKey }
        );
        return { mode: 'email', messageId: `${res.status} ${res.text}` };
      } catch (err) {
        const detail = err && (err.text || err.message) ? err.text || err.message : 'unknown error';
        throw new Error(`EmailJS said: ${detail}`);
      }
    }

    module.exports = { send, isConfigured };
  });

  /* ============================================================
     sample
     ============================================================ */
  define('sample', function (module, exports, require) {
    /** Loads sample PLAENS products, customers, orders and expenses into an empty store. */
    const db = require('./db');
    const { dayKey, addDays } = require('./utils');

    function load() {
      const products = require('./products');
      const orders = require('./orders');
      const customers = require('./customers');

      let s = 20260910;
      const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
      const pick = (arr) => arr[Math.floor(rand() * arr.length)];
      const between = (a, b) => a + Math.floor(rand() * (b - a + 1));

      const catalog = [
        { name: 'Horizon Linen Shirt', category: 'Shirts', price: 8900, costPrice: 3400, sizes: ['S', 'M', 'L', 'XL'], colors: ['Sand', 'White'] },
        { name: 'Field Cargo Trousers', category: 'Trousers', price: 9500, costPrice: 3900, sizes: ['28', '30', '32', '34', '36'], colors: ['Olive', 'Black'] },
        { name: 'Prairie Oversized Tee', category: 'T-shirts', price: 4500, costPrice: 1500, sizes: ['S', 'M', 'L', 'XL'], colors: ['Black', 'Stone', 'Moss'] },
        { name: 'Meadow Knit Sweater', category: 'Knitwear', price: 12500, costPrice: 5200, sizes: ['S', 'M', 'L'], colors: ['Oat'] },
        { name: 'Ridge Overshirt', category: 'Outerwear', price: 11000, costPrice: 4600, sizes: ['M', 'L', 'XL'], colors: ['Charcoal', 'Olive'] },
        { name: 'Dune Drawstring Shorts', category: 'Shorts', price: 5500, costPrice: 2000, sizes: ['S', 'M', 'L', 'XL'], colors: ['Sand', 'Navy'] },
        { name: 'Plains Canvas Tote', category: 'Accessories', price: 3200, costPrice: 900, sizes: ['One size'], colors: ['Natural'] },
      ];
      const created = catalog.map((c) => products.create({
        name: c.name, category: c.category, price: c.price, costPrice: c.costPrice,
        description: `${c.name} from the PLAENS core range.`, lowStockThreshold: 4,
        variants: c.sizes.flatMap((size) => c.colors.map((color) => ({ size, color, stock: between(8, 26) }))),
      }));
      products.create({
        name: 'Solstice Linen Dress', category: 'Dresses', price: 13900, costPrice: 5600, status: 'draft',
        variants: ['XS', 'S', 'M', 'L'].map((size) => ({ size, color: 'Clay', stock: 0 })),
      });

      const people = [
        ['Amaya Perera', 'amaya.perera@example.com', '+94 77 123 4567', 'Colombo'],
        ['Nimal Fernando', 'nimal.f@example.com', '+94 71 222 3344', 'Kandy'],
        ['Sachini Jayawardena', 'sachini.j@example.com', '+94 76 555 1212', 'Galle'],
        ['Ravindu Silva', 'ravindu.silva@example.com', '+94 70 888 9090', 'Negombo'],
        ['Tharushi Wickramasinghe', 'tharushi.w@example.com', '+94 75 431 2765', 'Colombo'],
        ['Kavindu Rajapaksha', 'kavindu.r@example.com', '+94 77 900 1122', 'Kurunegala'],
        ['Dilini Gunasekara', 'dilini.g@example.com', '+94 71 604 3388', 'Matara'],
        ['Ishan Abeysekera', 'ishan.a@example.com', '+94 76 210 7788', 'Colombo'],
      ];
      const buyers = people.map(([name, email, phone, city], i) =>
        customers.create({ name, email, phone, address: { line1: `${12 + i * 7} Lake Road`, city, postalCode: '', country: 'Sri Lanka' } }));

      const channels = ['instagram', 'instagram', 'online', 'online', 'whatsapp', 'store'];
      const methods = { instagram: ['bank_transfer', 'cod'], online: ['card', 'online'], whatsapp: ['cod', 'bank_transfer'], store: ['cash', 'card'] };
      for (let ago = 44; ago >= 0; ago--) {
        const count = rand() < 0.25 ? 0 : between(1, 2);
        for (let n = 0; n < count; n++) {
          const channel = pick(channels);
          const lines = [];
          for (let k = 0; k < between(1, 3); k++) {
            const p = pick(created);
            const v = pick(p.variants.filter((x) => x.stock > 2));
            if (v && !lines.some((l) => l.variantId === v.id)) lines.push({ variantId: v.id, quantity: rand() < 0.8 ? 1 : 2 });
          }
          if (!lines.length) continue;
          const date = addDays(new Date(), -ago);
          date.setHours(between(9, 21), between(0, 59), 0, 0);
          if (date > new Date()) date.setTime(Date.now() - 60 * 1000);
          const method = pick(methods[channel]);
          const order = orders.create({
            items: lines,
            customerId: channel === 'store' && rand() < 0.5 ? undefined : pick(buyers).id,
            channel,
            paymentMethod: method,
            paymentStatus: method === 'cod' && ago < 5 ? 'unpaid' : 'paid',
            shipping: channel === 'store' ? 0 : 450,
            discount: rand() < 0.15 ? 1000 : 0,
            orderDate: date.toISOString(),
          });
          if (channel === 'store' || ago > 6) orders.setFulfillment(order, { status: 'delivered' });
          else if (ago > 2) orders.setFulfillment(order, { status: 'shipped', carrier: 'Domex', trackingNumber: `DX${between(100000, 999999)}` });
          if (rand() < 0.05) orders.cancel(order, { reason: 'Customer changed their mind', restock: true });
        }
      }

      const today = new Date();
      const add = (ago, category, description, amount) => db.data.expenses.push({
        id: db.id('exp'), date: dayKey(addDays(today, -ago)), category, description, amount, createdAt: new Date().toISOString(),
      });
      add(40, 'marketing', 'Instagram ads, new drop', 18000);
      add(33, 'packaging', 'Branded mailer bags (200)', 9500);
      add(30, 'rent', 'Studio rent', 35000);
      add(21, 'marketing', 'Photoshoot for lookbook', 25000);
      add(14, 'shipping', 'Courier account top-up', 12000);
      add(7, 'software', 'Website hosting', 4200);
      add(3, 'marketing', 'Instagram ads, restock campaign', 15000);
      add(0, 'rent', 'Studio rent', 35000);
      db.save();
    }

    module.exports = { load };
  });

  /* ============================================================
     api
     ============================================================ */
  define('api', function (module, exports, require) {
    /**
     * The in-browser "server". The dashboard calls handle('POST', '/orders', body)
     * exactly as it would call a real API, so moving to a hosted backend later
     * only means swapping this file for fetch() calls.
     */
    const db = require('./db');
    const products = require('./products');
    const inventory = require('./inventory');
    const customers = require('./customers');
    const orders = require('./orders');
    const receipt = require('./receipt');
    const reports = require('./reports');
    const mailer = require('./mailer');
    const cloud = require('./cloud');
    const sample = require('./sample');
    const {
      HttpError, str, num, email, oneOf, money, now, dateRange, inRange, dayKey, parseDay,
    } = require('./utils');

    const routes = [];
    function on(method, pattern, fn) {
      const re = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
      routes.push({ method, re, fn });
    }

    /* ---------- Products ---------- */

    on('GET', '/products', ({ query }) => {
      const search = String(query.search || '').trim().toLowerCase();
      let list = db.data.products;
      if (query.status) list = list.filter((p) => p.status === query.status);
      if (query.category) list = list.filter((p) => p.category === query.category);
      if (search) {
        list = list.filter((p) => [p.name, p.category, ...p.variants.map((v) => v.sku)]
          .some((v) => String(v || '').toLowerCase().includes(search)));
      }
      return {
        products: [...list].sort((a, b) => a.name.localeCompare(b.name)).map(products.present),
        categories: [...new Set(db.data.products.map((p) => p.category).filter(Boolean))].sort(),
      };
    });
    on('GET', '/products/:id', ({ params }) => {
      const product = products.find(params.id);
      return { product: { ...products.present(product), image: products.imageFor(product.id) } };
    });
    on('POST', '/products', ({ body }) => ({ product: products.present(products.create(body)) }));
    on('PUT', '/products/:id', ({ params, body }) => ({ product: products.present(products.update(products.find(params.id), body)) }));
    on('DELETE', '/products/:id', ({ params }) => products.remove(products.find(params.id)));

    /* ---------- Inventory ---------- */

    on('GET', '/inventory', () => ({ items: inventory.listStock() }));

    // Photos for a single order, used when building the PDF receipt
    on('GET', '/orders/:id/images', ({ params }) => {
      const order = orders.find(params.id);
      const out = {};
      for (const item of order.items) {
        const data = products.imageFor(item.productId);
        if (data) out[item.productId] = data;
      }
      return { images: out };
    });

    on('POST', '/inventory/adjust', ({ body }) => {
      const { product, variant } = inventory.locate(body.productId, body.variantId);
      const mode = oneOf(body.mode, 'Mode', ['add', 'remove', 'set']);
      const quantity = num(body.quantity, 'Quantity', { required: true, integer: true, min: mode === 'set' ? 0 : 1 });
      const note = str(body.note, 'Note', { max: 500 });
      let change;
      let reason;
      if (mode === 'add') {
        change = quantity;
        reason = oneOf(body.reason, 'Reason', ['restock', 'return'], 'restock');
      } else if (mode === 'remove') {
        change = -quantity;
        reason = oneOf(body.reason, 'Reason', ['damage', 'lost', 'adjustment'], 'adjustment');
      } else {
        change = quantity - variant.stock;
        reason = 'adjustment';
      }
      if (change === 0) throw new HttpError(400, `Stock is already ${variant.stock}. Nothing to change.`);
      const movement = inventory.adjust(product, variant, change, reason, { note });
      db.save();
      return { movement, stock: variant.stock };
    });

    on('GET', '/inventory/movements', ({ query }) => {
      const limit = Math.min(Number(query.limit) || 100, 1000);
      let list = db.data.stockMovements;
      if (query.productId) list = list.filter((m) => m.productId === query.productId);
      if (query.variantId) list = list.filter((m) => m.variantId === query.variantId);
      return { movements: list.slice(-limit).reverse() };
    });

    /* ---------- Customers ---------- */

    on('GET', '/customers', ({ query }) => {
      const search = String(query.search || '').trim().toLowerCase();
      const stats = customers.stats();
      let list = db.data.customers;
      if (search) list = list.filter((c) => [c.name, c.email, c.phone, c.address?.city].some((v) => String(v || '').toLowerCase().includes(search)));
      return {
        customers: [...list].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ ...c, ...(stats.get(c.id) || customers.blankStats) })),
      };
    });
    on('GET', '/customers/:id', ({ params }) => {
      const c = customers.find(params.id);
      return {
        customer: { ...c, ...(customers.stats().get(c.id) || customers.blankStats) },
        orders: db.data.orders.filter((o) => o.customerId === c.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      };
    });
    on('POST', '/customers', ({ body }) => { const c = customers.create(body); db.save(); return { customer: c }; });
    on('PUT', '/customers/:id', ({ params, body }) => { const c = customers.update(customers.find(params.id), body); db.save(); return { customer: c }; });
    on('DELETE', '/customers/:id', ({ params }) => { customers.remove(customers.find(params.id)); db.save(); return { deleted: true }; });

    /* ---------- Orders ---------- */

    const FILTERS = {
      all: () => true,
      unpaid: (o) => orders.isCounted(o) && o.paymentStatus === 'unpaid',
      unfulfilled: (o) => orders.isCounted(o) && o.fulfillmentStatus === 'unfulfilled',
      shipped: (o) => orders.isCounted(o) && o.fulfillmentStatus === 'shipped',
      delivered: (o) => orders.isCounted(o) && o.fulfillmentStatus === 'delivered',
      cancelled: (o) => o.cancelled,
      refunded: (o) => !o.cancelled && o.paymentStatus === 'refunded',
    };

    on('GET', '/orders', ({ query }) => {
      const search = String(query.search || '').trim().toLowerCase();
      let list = db.data.orders.filter(FILTERS[query.filter] || FILTERS.all);
      if (query.from || query.to) {
        const range = dateRange(query);
        list = list.filter((o) => inRange(o.createdAt, range));
      }
      if (search) {
        list = list.filter((o) => [o.orderNumber, o.customer.name, o.customer.email, o.customer.phone, o.trackingNumber]
          .some((v) => String(v || '').toLowerCase().includes(search)));
      }
      list = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const limit = Math.min(Number(query.limit) || 500, 5000);
      return { orders: list.slice(0, limit).map(orders.present), total: list.length };
    });
    on('GET', '/orders/:id', ({ params }) => ({ order: orders.present(orders.find(params.id)) }));

    on('POST', '/orders', async ({ body }) => {
      const order = orders.create(body);
      let emailResult = null;
      if (body.sendReceipt) {
        try {
          emailResult = await receipt.sendForOrder(order);
        } catch (err) {
          emailResult = { ok: false, error: err.message };
        }
      }
      return { order: orders.present(order), email: emailResult };
    });
    on('PATCH', '/orders/:id', ({ params, body }) => ({ order: orders.present(orders.updateDetails(orders.find(params.id), body)) }));
    on('PATCH', '/orders/:id/payment', ({ params, body }) => ({ order: orders.present(orders.setPayment(orders.find(params.id), body)) }));
    on('PATCH', '/orders/:id/fulfillment', ({ params, body }) => ({ order: orders.present(orders.setFulfillment(orders.find(params.id), body)) }));
    on('POST', '/orders/:id/cancel', ({ params, body }) => ({ order: orders.present(orders.cancel(orders.find(params.id), body)) }));
    on('GET', '/orders/:id/receipt', ({ params, query }) => {
      const order = orders.find(params.id);
      let images = null;
      if (query.images === '1') {
        images = {};
        for (const item of order.items) {
          const data = products.imageFor(item.productId);
          if (data) images[item.productId] = data;
        }
      }
      return receipt.render(order, db.data.settings, images);
    });
    on('POST', '/orders/:id/send-receipt', async ({ params }) => {
      const order = orders.find(params.id);
      const result = await receipt.sendForOrder(order);
      return { email: result, order: orders.present(order) };
    });

    /* ---------- Expenses ---------- */

    const CATEGORIES = ['marketing', 'packaging', 'shipping', 'rent', 'salaries', 'utilities', 'software', 'fees', 'other'];
    function parseExpense(b) {
      const date = str(b.date, 'Date', { required: true, max: 10 });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parseDay(date).getTime())) throw new HttpError(400, 'Date must use the YYYY-MM-DD format.');
      return {
        date,
        category: oneOf(b.category, 'Category', CATEGORIES, 'other'),
        description: str(b.description, 'Description', { required: true, max: 200 }),
        amount: money(num(b.amount, 'Amount', { required: true, min: 0.01 })),
      };
    }
    const findExpense = (id) => {
      const e = db.data.expenses.find((x) => x.id === id);
      if (!e) throw new HttpError(404, 'Expense not found.');
      return e;
    };
    on('GET', '/expenses', ({ query }) => {
      let list = db.data.expenses;
      if (query.from || query.to) {
        const range = dateRange(query);
        list = list.filter((e) => inRange(e.date, range));
      }
      if (query.category) list = list.filter((e) => e.category === query.category);
      list = [...list].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
      return { expenses: list, total: money(list.reduce((s, e) => s + e.amount, 0)), categories: CATEGORIES };
    });
    on('POST', '/expenses', ({ body }) => {
      const expense = { id: db.id('exp'), ...parseExpense({ date: dayKey(new Date()), ...body }), createdAt: now() };
      db.data.expenses.push(expense);
      db.save();
      return { expense };
    });
    on('PUT', '/expenses/:id', ({ params, body }) => {
      const e = findExpense(params.id);
      Object.assign(e, parseExpense({ ...e, ...body }), { updatedAt: now() });
      db.save();
      return { expense: e };
    });
    on('DELETE', '/expenses/:id', ({ params }) => {
      findExpense(params.id);
      db.data.expenses = db.data.expenses.filter((e) => e.id !== params.id);
      db.save();
      return { deleted: true };
    });

    /* ---------- Reports ---------- */

    /** Resolves a scanned or typed code to an order or a stock item. */
    on('GET', '/lookup', ({ query }) => {
      const code = str(query.code, 'Code', { required: true, max: 120 }).trim();
      const key = code.toUpperCase();
      const order = db.data.orders.find((o) => o.orderNumber.toUpperCase() === key || o.id === code);
      if (order) return { type: 'order', order: orders.present(order) };
      const item = inventory.listStock().find((i) => i.sku.toUpperCase() === key);
      if (item) return { type: 'variant', variant: item };
      return { type: null };
    });

    on('GET', '/reports/dashboard', () => reports.dashboard());
    on('GET', '/reports/overview', ({ query }) => reports.overview(dateRange(query)));
    on('GET', '/reports/inventory', () => reports.inventorySnapshot());
    on('GET', '/reports/orders.csv', ({ query }) => {
      const range = dateRange(query);
      return { filename: `plaens-orders-${dayKey(range.from)}-to-${dayKey(range.to)}.csv`, csv: `\uFEFF${reports.ordersCsv(range)}` };
    });

    /* ---------- Settings, setup and data ---------- */

    const settingsView = () => ({
      settings: db.data.settings,
      meta: db.data.meta,
      emailConfigured: mailer.isConfigured(),
      storage: db.backend,
      mode: db.mode,
      user: db.mode === 'cloud' ? (cloud.auth.user()?.email || '') : '',
    });

    on('GET', '/settings', settingsView);

    on('PUT', '/settings', ({ body }) => {
      const b = { ...db.data.settings, ...body };
      const currency = str(b.currency, 'Currency', { required: true, max: 3 }).toUpperCase();
      try {
        new Intl.NumberFormat('en-US', { style: 'currency', currency });
      } catch {
        throw new HttpError(400, `${currency} isn't a recognised currency code. Use a 3-letter code like LKR or USD.`);
      }
      db.data.settings = {
        storeName: str(b.storeName, 'Store name', { required: true, max: 80 }),
        email: email(b.email, 'Store email'),
        phone: str(b.phone, 'Phone', { max: 40 }),
        address: str(b.address, 'Address', { max: 300 }),
        website: str(b.website, 'Website', { max: 200 }),
        instagram: str(b.instagram, 'Instagram', { max: 80 }),
        currency,
        taxRate: num(b.taxRate, 'Tax rate', { max: 100 }),
        lowStockThreshold: num(b.lowStockThreshold, 'Low stock alert', { integer: true }),
        receiptNote: str(b.receiptNote, 'Receipt note', { max: 500 }),
        emailServiceId: str(b.emailServiceId, 'EmailJS Service ID', { max: 100 }),
        emailTemplateId: str(b.emailTemplateId, 'EmailJS Template ID', { max: 100 }),
        emailPublicKey: str(b.emailPublicKey, 'EmailJS Public Key', { max: 100 }),
      };
      db.save();
      return settingsView();
    });

    on('POST', '/settings/test-email', async ({ body }) => {
      const to = email(body.to, 'Email', { required: true });
      const s = db.data.settings;
      const html = `<p style="font-family:Arial,sans-serif">Email is working. ${s.storeName} order receipts will be delivered like this.</p>`;
      return mailer.send({ to, subject: `${s.storeName} test email`, html, text: 'Email is working.' });
    });

    on('POST', '/setup', ({ body }) => {
      if (db.data.meta.setupComplete) throw new HttpError(409, 'This store is already set up.');
      db.data.settings.storeName = str(body.storeName, 'Store name', { required: true, max: 80 });
      const currency = str(body.currency, 'Currency', { max: 3 }).toUpperCase() || db.data.settings.currency;
      try { new Intl.NumberFormat('en-US', { style: 'currency', currency }); } catch { throw new HttpError(400, `${currency} isn't a recognised currency code.`); }
      db.data.settings.currency = currency;
      if (body.sample) sample.load();
      db.data.meta.setupComplete = true;
      db.data.meta.createdAt = now();
      db.save();
      return settingsView();
    });

    on('GET', '/backup', () => {
      db.data.meta.lastBackupAt = now();
      db.save();
      return { app: 'plaens-admin', version: 1, exportedAt: now(), data: db.data };
    });

    on('POST', '/restore', ({ body }) => {
      const file = body.backup;
      if (!file || file.app !== 'plaens-admin' || !file.data || !Array.isArray(file.data.products) || !Array.isArray(file.data.orders)) {
        throw new HttpError(400, "That file isn't a PLAENS backup. Choose a file downloaded from Settings > Download backup.");
      }
      db.replace(file.data);
      db.data.meta.setupComplete = true;
      const d = db.data;
      return { restored: { products: d.products.length, orders: d.orders.length, customers: d.customers.length } };
    });

    on('POST', '/reset', ({ body }) => {
      const keepSettings = { ...db.data.settings };
      db.replace(structuredClone(db.EMPTY));
      db.data.settings = keepSettings;
      db.data.meta.setupComplete = true;
      db.data.meta.createdAt = now();
      if (body.sample) sample.load();
      return { reset: true };
    });

    /* ---------- Dispatcher ---------- */

    const channel = 'BroadcastChannel' in self ? new BroadcastChannel('plaens-admin') : null;
    const externalListeners = new Set();
    db.onChange(() => externalListeners.forEach((fn) => fn())); // Firebase: changes from other devices
    if (channel) {
      // Browser mode: another tab changed the data, so reload it here.
      channel.onmessage = async () => {
        if (db.mode !== 'local') return;
        await db.load();
        externalListeners.forEach((fn) => fn());
      };
    }

    async function handle(method, url, body) {
      const [path, qs = ''] = url.split('?');
      const query = Object.fromEntries(new URLSearchParams(qs));
      const route = routes.find((r) => r.method === method && r.re.test(path));
      if (!route) throw new HttpError(404, `Nothing handles ${method} ${path}.`);
      const params = { ...(path.match(route.re).groups || {}) };
      Object.keys(params).forEach((k) => { params[k] = decodeURIComponent(params[k]); });
      db.begin();
      try {
        const result = await route.fn({ params, query, body: body || {} });
        return result === undefined ? {} : JSON.parse(JSON.stringify(result)); // hand back copies, never live data
      } finally {
        try {
          if ((await db.flush()) && db.mode === 'local') channel?.postMessage('changed');
        } finally {
          db.end();
        }
      }
    }

    module.exports = {
      init: db.load,
      handle,
      mode: () => db.mode,
      cloudEnabled: () => cloud.enabled(),
      auth: cloud.auth,
      onExternalChange: (fn) => externalListeners.add(fn),
      onStatus: (fn) => db.onStatus(fn),
      emailConfigured: () => mailer.isConfigured(),
      setLogoUrl: receipt.setLogoUrl,
      /** Data saved in this browser (used to copy it into Firebase). */
      readLocalData: db.readLocal,
    };
  });

  self.PlaensServer = require('api');
})();
