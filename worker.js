/**
 * FlipCloud Cloudflare Worker v5
 * Bindings: KV → FLIPCLOUD_KV, R2 → FLIPCLOUD_R2
 * Env vars: R2_PUBLIC_URL, ADMIN_KEY
 *
 * New in v5:
 *   - GET  /api/search?q=         full-text search
 *   - POST /api/book/:id/stat     record read time + page views
 *   - GET  /api/book/:id/stats    get stats (admin)
 *   - password field on books (bcrypt-lite SHA-256 hash)
 *   - POST /api/book/:id/auth     verify book password → token
 *   - embed mode handled in frontend (?embed=1)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Admin-Key, X-Bookshelf-Key, X-Book-Token',
};


const j = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });
const err = (m, s = 400) => j({ error: m }, s);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// 檢查是否為管理員 (需同時符合 API 金鑰與管理員密碼)
const isAdmin = (req, env) => {
  const apiKey = req.headers.get('X-API-Key');
  const adminKey = req.headers.get('X-Admin-Key');
  return apiKey === env.API_KEY && adminKey === (env.ADMIN_KEY || 'Jet#7748');
};

// 檢查是否可查看書架清單 (管理員密碼 或 書架專用密碼 皆可)
const canViewList = (req, env) => {
  const apiKey = req.headers.get('X-API-Key');
  const adminKey = req.headers.get('X-Admin-Key');
  const shelfKey = req.headers.get('X-Bookshelf-Key');

  if (apiKey !== env.API_KEY) return false;
  return adminKey === (env.ADMIN_KEY) || shelfKey === (env.BOOKSHELF_KEY);
};

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function isVisible(b) {
  if (!b.published) return false;
  const n = Date.now();
  if (b.publishAt && new Date(b.publishAt).getTime() > n) return false;
  if (b.unpublishAt && new Date(b.unpublishAt).getTime() <= n) return false;
  return true;
}

function randomId(len = 6) {
  const c = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(len))).map(b => c[b % c.length]).join('');
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const m = request.method;
    if (m === 'OPTIONS') return new Response(null, { headers: CORS });

    // Short link
    const rM = path.match(/^\/r\/([^/]+)$/);
    if (rM) return shortLink(rM[1], request, env);

    // Search
    if (path === '/api/search' && m === 'GET') return searchBooks(url, request, env);

    // Upload
    if (path === '/api/upload' && m === 'POST') return upload(request, env);

    // Categories
    if (path === '/api/categories') {
      if (m === 'GET') return getCategories(env);
      if (m === 'POST') { if (!isAdmin(request, env)) return err('Unauthorized', 401); return addCategory(request, env); }
      if (m === 'DELETE') { if (!isAdmin(request, env)) return err('Unauthorized', 401); return delCategory(request, env); }
    }

    // Book list (書架清單)
    if (path === '/api/books' && m === 'GET') {
      if (!canViewList(request, env)) return err('Unauthorized', 401); // 改用 canViewList
      return listBooks(env);
    }

    // Single book
    const bM = path.match(/^\/api\/book\/([^/]+)$/);
    if (bM) {
      const id = bM[1];
      if (m === 'GET') return getBook(id, request, env);
      if (m === 'PATCH') { if (!isAdmin(request, env)) return err('Unauthorized', 401); return updateBook(request, id, env); }
      if (m === 'DELETE') { if (!isAdmin(request, env)) return err('Unauthorized', 401); return deleteBook(id, env); }
    }

    // Book stats (admin)
    const stM = path.match(/^\/api\/book\/([^/]+)\/stats$/);
    if (stM && m === 'GET') {
      if (!isAdmin(request, env)) return err('Unauthorized', 401);
      return getBookStats(stM[1], env);
    }

    // Record stat (public — called by reader)
    const recM = path.match(/^\/api\/book\/([^/]+)\/stat$/);
    if (recM && m === 'POST') return recordStat(request, recM[1], env);

    // Password auth
    const authM = path.match(/^\/api\/book\/([^/]+)\/auth$/);
    if (authM && m === 'POST') return authBook(request, authM[1], env);

    // Cover upload
    const cvM = path.match(/^\/api\/book\/([^/]+)\/cover$/);
    if (cvM && m === 'POST') {
      if (!isAdmin(request, env)) return err('Unauthorized', 401);
      return uploadCover(request, cvM[1], env);
    }

    // R2 assets
    if (path.startsWith('/assets/')) return serveAsset(path.slice(8), env);

    return err('Not found', 404);
  }
};

/* ── Search ── */
async function searchBooks(url, request, env) {
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  if (!q) return j([]);
  const raw = await env.KV.get('index:books');
  if (!raw) return j([]);
  const all = JSON.parse(raw);
  const admin = isAdmin(request, env);

  const results = all.filter(b => {
    if (!admin && !isVisible(b)) return false;
    return b.title.toLowerCase().includes(q) ||
      (b.category || '').toLowerCase().includes(q);
  }).slice(0, 30);

  return j(results);
}

/* ── Upload ── */
async function upload(request, env) {
  let body; try { body = await request.json(); } catch { return err('Invalid JSON'); }
  const { title, pages, category = '' } = body;
  if (!title || !Array.isArray(pages) || !pages.length) return err('Missing title or pages');
  if (pages.length > 50) return err('Maximum 50 pages');

  let id;
  for (let i = 0; i < 10; i++) { id = randomId(); if (!(await env.KV.get(`book:${id}`))) break; }

  const r2Base = env.R2_PUBLIC_URL || 'https://pub-placeholder.r2.dev';
  const pageUrls = [];

  for (let i = 0; i < pages.length; i++) {
    const raw = pages[i], b64 = raw.includes(',') ? raw.split(',')[1] : raw;
    const mime = raw.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    const key = `books/${id}/page_${String(i + 1).padStart(3, '0')}.jpg`;
    await env.R2.put(key, bytes, { httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000' } });
    pageUrls.push(`${r2Base}/${key}`);
  }

  const now = new Date().toISOString();
  const meta = {
    id, title, category: category || '',
    pageCount: pages.length, pageUrls, coverUrl: pageUrls[0], // 預設第一頁為封面
    createdAt: now, updatedAt: now,
    views: 0, totalReadTime: 0,
    published: false, publishAt: null, unpublishAt: null,
    notes: '', passwordHash: null,
  };
  await env.KV.put(`book:${id}`, JSON.stringify(meta), { expirationTtl: 60 * 60 * 24 * 365 * 3 });
  await indexAdd(env, { id, title, category: meta.category, pageCount: pages.length, createdAt: now, published: false, publishAt: null, unpublishAt: null, coverUrl: meta.coverUrl, views: 0, hasPassword: false });
  return j({ id, pageCount: pages.length, published: false });
}

/* ── Get book ── */
async function getBook(id, request, env) {
  if (!id || id.length > 20) return err('Invalid ID', 400);
  const raw = await env.KV.get(`book:${id}`);
  if (!raw) return err('Book not found', 404);
  const book = JSON.parse(raw);
  const admin = isAdmin(request, env);

  if (!admin) {
    if (!isVisible(book)) {
      const now = Date.now();
      let reason = 'unpublished';
      if (book.published && book.publishAt && new Date(book.publishAt).getTime() > now) reason = 'scheduled';
      if (book.published && book.unpublishAt && new Date(book.unpublishAt).getTime() <= now) reason = 'expired';
      return j({ unavailable: true, reason, publishAt: book.publishAt, title: book.title }, 403);
    }
    // If password protected, check token
    if (book.passwordHash) {
      const token = request.headers.get('X-Book-Token') || '';
      const expected = await sha256(id + book.passwordHash);
      if (token !== expected) return j({ passwordRequired: true, title: book.title, id }, 403);
    }
    // Increment views
    book.views = (book.views || 0) + 1;
    env.KV.put(`book:${id}`, JSON.stringify(book)).catch(() => { });
    // Record daily stat
    const dayKey = `stat:${id}:${todayKey()}`;
    const dayRaw = await env.KV.get(dayKey);
    const dayStat = dayRaw ? JSON.parse(dayRaw) : { views: 0, readTime: 0 };
    dayStat.views++;
    env.KV.put(dayKey, JSON.stringify(dayStat), { expirationTtl: 60 * 60 * 24 * 92 }).catch(() => { }); // 3 months

    const { notes, passwordHash, ...pub } = book;
    pub.hasPassword = !!book.passwordHash;
    return j(pub);
  }
  return j(book);
}

/* ── Update book ── */
async function updateBook(request, id, env) {
  const raw = await env.KV.get(`book:${id}`);
  if (!raw) return err('Book not found', 404);
  const book = JSON.parse(raw);
  let body; try { body = await request.json(); } catch { return err('Invalid JSON'); }
  if ('title' in body) book.title = String(body.title).trim() || book.title;
  if ('notes' in body) book.notes = String(body.notes);
  if ('category' in body) book.category = String(body.category);
  if ('published' in body) book.published = Boolean(body.published);
  if ('publishAt' in body) book.publishAt = body.publishAt || null;
  if ('unpublishAt' in body) book.unpublishAt = body.unpublishAt || null;
  if ('password' in body) {
    book.passwordHash = body.password ? await sha256(body.password) : null;
  }
  book.updatedAt = new Date().toISOString();
  await env.KV.put(`book:${id}`, JSON.stringify(book));
  const iRaw = await env.KV.get('index:books');
  if (iRaw) {
    const idx = JSON.parse(iRaw), e = idx.find(b => b.id === id);
    if (e) {
      Object.assign(e, { title: book.title, category: book.category, published: book.published, publishAt: book.publishAt, unpublishAt: book.unpublishAt, hasPassword: !!book.passwordHash });
      await env.KV.put('index:books', JSON.stringify(idx));
    }
  }
  return j({ success: true, book });
}

/* ── Delete book ── */
async function deleteBook(id, env) {
  const raw = await env.KV.get(`book:${id}`);
  if (!raw) return err('Book not found', 404);
  const book = JSON.parse(raw);
  for (let i = 1; i <= book.pageCount; i++)
    await env.R2.delete(`books/${id}/page_${String(i).padStart(3, '0')}.jpg`).catch(() => { });
  await env.R2.delete(`books/${id}/cover.jpg`).catch(() => { });
  await env.KV.delete(`book:${id}`);
  const iRaw = await env.KV.get('index:books');
  if (iRaw) await env.KV.put('index:books', JSON.stringify(JSON.parse(iRaw).filter(b => b.id !== id)));
  return j({ success: true, deleted: id });
}

/* ── List books ── */
async function listBooks(env) {
  const raw = await env.KV.get('index:books');
  return j(raw ? JSON.parse(raw) : []);
}

/* ── Record stat (read time) ── */
async function recordStat(request, id, env) {
  let body; try { body = await request.json(); } catch { return err('Invalid JSON'); }
  const { seconds = 0 } = body;
  if (seconds <= 0 || seconds > 3600) return j({ ok: true }); // ignore invalid

  const dayKey = `stat:${id}:${todayKey()}`;
  const [bookRaw, dayRaw] = await Promise.all([
    env.KV.get(`book:${id}`),
    env.KV.get(dayKey),
  ]);
  if (!bookRaw) return j({ ok: true });

  const book = JSON.parse(bookRaw);
  book.totalReadTime = (book.totalReadTime || 0) + seconds;
  env.KV.put(`book:${id}`, JSON.stringify(book)).catch(() => { });

  const dayStat = dayRaw ? JSON.parse(dayRaw) : { views: 0, readTime: 0 };
  dayStat.readTime = (dayStat.readTime || 0) + seconds;
  env.KV.put(dayKey, JSON.stringify(dayStat), { expirationTtl: 60 * 60 * 24 * 92 }).catch(() => { });

  return j({ ok: true });
}

/* ── Get book stats (admin) ── */
async function getBookStats(id, env) {
  const raw = await env.KV.get(`book:${id}`);
  if (!raw) return err('Book not found', 404);
  const book = JSON.parse(raw);

  // Collect last 14 days
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    days.push(d);
  }
  const dayStats = await Promise.all(
    days.map(async d => {
      const raw = await env.KV.get(`stat:${id}:${d}`);
      return { date: d, ...(raw ? JSON.parse(raw) : { views: 0, readTime: 0 }) };
    })
  );

  return j({
    id, title: book.title,
    totalViews: book.views || 0,
    totalReadTime: book.totalReadTime || 0,
    daily: dayStats,
  });
}

/* ── Password auth ── */
async function authBook(request, id, env) {
  const raw = await env.KV.get(`book:${id}`);
  if (!raw) return err('Book not found', 404);
  const book = JSON.parse(raw);
  if (!book.passwordHash) return j({ token: 'no-password' });
  let body; try { body = await request.json(); } catch { return err('Invalid JSON'); }
  const hash = await sha256(body.password || '');
  if (hash !== book.passwordHash) return err('Wrong password', 403);
  const token = await sha256(id + book.passwordHash);
  return j({ token });
}

/* ── Cover upload ── */
async function uploadCover(request, id, env) {
  const raw = await env.KV.get(`book:${id}`);
  if (!raw) return err('Book not found', 404);
  const book = JSON.parse(raw);
  let body; try { body = await request.json(); } catch { return err('Invalid JSON'); }
  const { image } = body;
  if (!image) return err('Missing image');
  const b64 = image.includes(',') ? image.split(',')[1] : image;
  const mime = image.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  const r2Base = env.R2_PUBLIC_URL || 'https://pub-placeholder.r2.dev';
  const key = `books/${id}/cover.jpg`;
  await env.R2.put(key, bytes, { httpMetadata: { contentType: mime, cacheControl: 'public, max-age=31536000' } });
  const coverUrl = `${r2Base}/${key}`;
  book.coverUrl = coverUrl; book.updatedAt = new Date().toISOString();
  await env.KV.put(`book:${id}`, JSON.stringify(book));
  const iRaw = await env.KV.get('index:books');
  if (iRaw) {
    const idx = JSON.parse(iRaw), e = idx.find(b => b.id === id);
    if (e) { e.coverUrl = coverUrl; await env.KV.put('index:books', JSON.stringify(idx)); }
  }
  return j({ success: true, coverUrl });
}

/* ── Categories ── */
async function getCategories(env) {
  const raw = await env.KV.get('categories');
  return j(raw ? JSON.parse(raw) : []);
}
async function addCategory(request, env) {
  let body; try { body = await request.json(); } catch { return err('Invalid JSON'); }
  const name = (body.name || '').trim();
  if (!name) return err('Name required');
  const raw = await env.KV.get('categories');
  const cats = raw ? JSON.parse(raw) : [];
  if (!cats.includes(name)) { cats.push(name); await env.KV.put('categories', JSON.stringify(cats)); }
  return j({ success: true, categories: cats });
}
async function delCategory(request, env) {
  let body; try { body = await request.json(); } catch { return err('Invalid JSON'); }
  const name = (body.name || '').trim();
  const raw = await env.KV.get('categories');
  const cats = (raw ? JSON.parse(raw) : []).filter(c => c !== name);
  await env.KV.put('categories', JSON.stringify(cats));
  return j({ success: true, categories: cats });
}

/* ── Short link ── */
async function shortLink(id, request, env) {
  const raw = await env.KV.get(`book:${id}`);
  if (!raw) return notAvailPage('找不到此書', '連結可能已失效或書籍已刪除。');
  const book = JSON.parse(raw);
  if (!book.published) return notAvailPage('尚未開放', '此書籍目前尚未公開上架。');
  const now = Date.now();
  if (book.publishAt && new Date(book.publishAt).getTime() > now)
    return notAvailPage('尚未到開放時間', `預定於 ${new Date(book.publishAt).toLocaleString('zh-TW')} 開放。`);
  if (book.unpublishAt && new Date(book.unpublishAt).getTime() <= now)
    return notAvailPage('已下架', '此書籍已結束公開閱讀期間。');
  const origin = new URL(request.url).origin;
  return new Response(`<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(book.title)} · FlipCloud</title>
<meta property="og:title" content="${esc(book.title)}">
<meta property="og:description" content="${book.pageCount} 頁翻頁書">
${book.coverUrl ? `<meta property="og:image" content="${esc(book.coverUrl)}">` : ''}
<style>body{font-family:serif;background:#12100a;color:#f5f0e8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.s{text-align:center}.sp{width:40px;height:40px;border:2px solid #ffffff11;border-top-color:#c8a96e;border-radius:50%;animation:s .8s linear infinite;margin:0 auto 16px}@keyframes s{to{transform:rotate(360deg)}}p{color:#c8a96e99;font-size:.9rem}</style>
</head><body><div class="s"><div class="sp"></div><p>載入《${esc(book.title)}》</p></div>
<script>window.location.href='${origin}/?book=${id}';<\/script></body></html>`,
    { headers: { 'Content-Type': 'text/html;charset=utf-8', ...CORS } });
}

function notAvailPage(title, sub) {
  return new Response(`<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · FlipCloud</title>
<style>body{font-family:serif;background:#12100a;color:#f5f0e8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px;text-align:center;padding:20px}h1{font-style:italic;color:#c8a96e;font-size:1.8rem}p{color:#ffffff44;font-size:.9rem;font-family:monospace;max-width:320px}a{color:#c8a96e77;font-size:.8rem;font-family:monospace;margin-top:8px}</style>
</head><body><h1>${esc(title)}</h1><p>${esc(sub)}</p><a href="/">← 返回書架</a></body></html>`,
    { status: 403, headers: { 'Content-Type': 'text/html;charset=utf-8', ...CORS } });
}

/* ── R2 asset ── */
async function serveAsset(key, env) {
  const obj = await env.R2.get(key);
  if (!obj) return err('Not found', 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000');
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(obj.body, { headers });
}

/* ── Index helper ── */
async function indexAdd(env, entry) {
  const raw = await env.KV.get('index:books');
  const idx = raw ? JSON.parse(raw) : [];
  idx.unshift(entry);
  if (idx.length > 500) idx.pop();
  await env.KV.put('index:books', JSON.stringify(idx));
}
