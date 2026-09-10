/**
 * 各站点数据源适配器。
 *
 * 全部优先走站点自己的 JSON API —— 这些接口不挂 Cloudflare，
 * 直接返回 seeders，比抓 HTML 又快又准。只有 rargb 没有 API，
 * 才退回抓 HTML（而且它列表页没有磁力，得逐个进详情页，所以默认不启用）。
 */
'use strict';

const M = require('./match.js');
const P = require('./parse.js');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(url, opts) {
  opts = opts || {};
  const init = {
    method: opts.method || 'GET',
    headers: Object.assign({ 'User-Agent': UA, Accept: '*/*' }, opts.headers),
    signal: AbortSignal.timeout(opts.timeout || 25000),
  };
  if (opts.body) init.body = opts.body;
  const res = await fetch(url, init);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return opts.text ? res.text() : res.json();
}

async function retry(fn, tries) {
  let last;
  for (let i = 1; i <= (tries || 3); i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < (tries || 3)) await sleep(700 * i);
    }
  }
  throw last;
}

function isoFromUnix(sec) {
  const n = Number(sec);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString().slice(0, 10) : '';
}

// ------------------------------------------------------------ The Pirate Bay
// apibay 是 TPB 的官方接口，一次返回全部命中，不分页
async function tpb(query) {
  const url = 'https://apibay.org/q.php?q=' + encodeURIComponent(query) + '&cat=0';
  const arr = await retry(() => http(url));
  if (!Array.isArray(arr)) return [];
  return arr
    // 没结果时 apibay 会返回一条 id=0 的占位记录
    .filter((r) => r && r.id !== '0' && r.info_hash && !/^0+$/.test(r.info_hash))
    .map((r) => ({
      title: r.name,
      hash: String(r.info_hash).toLowerCase(),
      magnet: M.magnetFrom(r.info_hash, r.name),
      size: Number(r.size) || 0,
      seeders: Number(r.seeders) || 0,
      leechers: Number(r.leechers) || 0,
      date: isoFromUnix(r.added),
      imdb: r.imdb || '',
      details: r.id ? 'https://thepiratebay.org/description.php?id=' + r.id : '',
      source: 'TPB',
    }));
}

// ------------------------------------------------------------ therarbg
// RARBG 数据库的延续，?format=json 就是现成的 REST 接口
async function therarbg(query, opts) {
  const pages = Math.max(1, (opts && opts.pages) || 2);
  // 必须用 %20 而不是 +：多词查询用 + 时 therarbg 会返回 0 条
  const kw = encodeURIComponent(query);
  let url = 'https://therarbg.com/get-posts/keywords:' + kw + '/?format=json';
  const out = [];
  for (let i = 0; i < pages && url; i++) {
    const j = await retry(() => http(url));
    for (const r of j.results || []) {
      out.push({
        title: r.n,
        hash: String(r.h || '').toLowerCase(),
        magnet: M.magnetFrom(r.h, r.n),
        size: Number(r.s) || 0,
        seeders: Number(r.se) || 0,
        leechers: Number(r.le) || 0,
        date: isoFromUnix(r.a),
        imdb: r.i || '',
        details: r.pk ? 'https://therarbg.com/post-detail/' + r.pk + '/' : '',
        source: 'therarbg',
      });
    }
    url = (j.links && j.links.next) || '';
    if (url) await sleep(250);
  }
  return out;
}

// ------------------------------------------------------------ knaben
// 聚合了几十个站点的索引，返回里带 tracker 字段说明这条来自哪个站
async function knaben(query, opts) {
  const size = Math.min(300, Math.max(20, (opts && opts.limit) || 300));
  const j = await retry(() =>
    http('https://api.knaben.org/v1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        search_type: '100%',
        search_field: 'title',
        query: query,
        order_by: 'seeders',
        order_direction: 'desc',
        size: size,
        hide_unsafe: true,
        hide_xxx: true,
      }),
    })
  );
  return (j.hits || [])
    .filter((h) => h && h.title)
    .map((h) => ({
      title: h.title,
      hash: String(h.hash || '').toLowerCase(),
      magnet: h.magnetUrl || M.magnetFrom(h.hash, h.title),
      size: Number(h.bytes) || 0,
      seeders: Number(h.seeders) || 0,
      leechers: Number(h.peers) || 0,
      date: String(h.date || '').slice(0, 10),
      details: h.details || '',
      tracker: h.tracker || '',
      source: 'knaben',
    }));
}

// ------------------------------------------------------------ EZTV
// EZTV 的 API 只能按 imdb_id 查（不支持关键词），
// 所以 id 要么由 --imdb 指定，要么从其它源的结果里推断出来
async function eztv(imdbId, opts) {
  const id = String(imdbId || '').replace(/^tt/i, '');
  if (!/^\d{5,}$/.test(id)) return [];
  const maxPages = Math.max(1, Math.min(30, (opts && opts.pages) || 15));
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const j = await retry(() =>
      http('https://eztvx.to/api/get-torrents?imdb_id=' + id + '&limit=100&page=' + page)
    );
    const list = j.torrents || [];
    for (const t of list) {
      const title = t.title || t.filename || '';
      out.push({
        title: title,
        hash: String(t.hash || '').toLowerCase(),
        magnet: t.magnet_url || M.magnetFrom(t.hash, title),
        size: Number(t.size_bytes) || 0,
        seeders: Number(t.seeds) || 0,
        leechers: Number(t.peers) || 0,
        date: isoFromUnix(t.date_released_unix),
        imdb: t.imdb_id || id,
        details: t.episode_url || '',
        source: 'EZTV',
      });
    }
    if (list.length < 100) break; // 最后一页
    await sleep(250);
  }
  return out;
}

// ------------------------------------------------------------ rargb（抓 HTML）
// 没有 API；而且列表页不含磁力，必须逐个进详情页拿，所以：
// 1) 先按关键词过滤，2) 跳过其它源已经找到的（按标题比对），3) 剩下的才去抓详情页
async function rargb(query, opts) {
  const o = opts || {};
  const pages = Math.max(1, o.pages || 2);
  const known = o.known || new Set();
  const tokens = o.tokens || [];
  const rows = [];

  for (let n = 1; n <= pages; n++) {
    const url =
      'https://rargb.to/search/' + n + '/?search=' + encodeURIComponent(query).replace(/%20/g, '+');
    let html;
    try {
      html = await retry(() => http(url, { text: true, headers: { Referer: 'https://rargb.to/' } }), 2);
    } catch (e) {
      break;
    }
    if (P.looksBlocked(html)) break;
    const posts = P.extractPosts(html, url);
    if (!posts.length) break;
    for (const p of posts) {
      if (!M.matchesTokens(p.title, tokens)) continue;
      if (known.has(M.normalize(p.title))) continue;
      rows.push(p);
    }
    await sleep(o.delay || 500);
  }

  const out = [];
  const limit = Math.max(0, o.detailLimit == null ? 40 : o.detailLimit);
  for (const p of rows.slice(0, limit)) {
    if (p.magnet) {
      out.push(toItem(p));
      continue;
    }
    try {
      const html = await http(p.url, { text: true, headers: { Referer: 'https://rargb.to/' } });
      p.magnet = P.extractMagnets(html)[0] || '';
      if (p.magnet) out.push(toItem(p));
    } catch (e) {
      /* 单条失败就跳过 */
    }
    await sleep(o.delay || 500);
  }
  return out;

  function toItem(p) {
    return {
      title: p.title,
      hash: P.infoHash(p.magnet),
      magnet: p.magnet,
      size: parseSize(p.size),
      seeders: Number(p.seeders) || 0,
      leechers: Number(p.leechers) || 0,
      date: '',
      details: p.url,
      source: 'rargb',
    };
  }
}

const UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

/** "15.9 GB" / "188.4 MiB" -> 字节数 */
function parseSize(text) {
  const m = /(\d+(?:\.\d+)?)\s*([KMGT]?)i?B/i.exec(String(text || ''));
  if (!m) return 0;
  const unit = (m[2] || '').toUpperCase() + 'B';
  return Math.round(parseFloat(m[1]) * (UNITS[unit] || 1));
}

module.exports = { tpb, therarbg, knaben, eztv, rargb, parseSize, http };
