/**
 * 关键词匹配与结果聚合。纯函数，不碰网络，方便测试。
 */
'use strict';

// 拼裸 infohash 磁力时补上的公共 tracker（apibay 只给 hash，不给磁力）
const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.dler.org:6969/announce',
];

/**
 * 标题归一化：小写，把各种分隔符统一成空格。
 * 这样 "Pawn.Stars.S03E01.720p" 和 "pawn stars s03" 才能对上。
 */
function normalize(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[._+\-[\](){}:,!?'"~/\\|@#$%^&*=<>;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 关键词切成 token，每个都必须出现在标题里 */
function tokenize(query) {
  return normalize(query).split(' ').filter(Boolean);
}

/** 标题是否包含全部关键词（子串匹配，所以 s03 能命中 S03E07） */
function matchesTokens(title, tokens) {
  if (!tokens.length) return true;
  const t = normalize(title);
  return tokens.every((tok) => t.indexOf(tok) >= 0);
}

/**
 * 完全匹配：查询必须从标题「开头」连续对上。
 *
 * 发布名的规范是 `剧名.SxxExx.质量.小组`，剧名永远在开头 ——
 * 所以按「开头连续匹配」就能挡掉那些只是中间夹了关键词的剧
 * （搜 friends 不再命中 Your.Friends.and.Neighbors）。
 *
 * 两个宽容点，避免误伤真实发布名：
 *   - 开头的 the / a / an 先剥掉：The.Big.Bang.Theory 仍命中 big bang theory
 *   - 查询里的裸季号 (s01) 允许命中 s01e01 这种带集号的 token
 *
 * 标题在匹配点后面的部分（分辨率、编码、小组名）不受限。
 */
function matchesExact(title, tokens) {
  if (!tokens.length) return true;
  let tt = tokenize(title);
  if (/^(the|a|an)$/.test(tt[0] || '')) tt = tt.slice(1);

  let at = 0;
  for (const q of tokens) {
    if (at >= tt.length) return false;
    const t = tt[at];
    const ok =
      t === q ||
      (t.length > q.length && t.indexOf(q) === 0); // s01 对上 s01e01 / s01e012
    if (!ok) return false;
    at++;
  }
  return true;
}

function matchesAny(title, tokens, mode) {
  if (mode === 'exact') return matchesExact(title, tokens);
  if (mode === 'loose') return tokens.length ? normalize(title).indexOf(tokens[0]) >= 0 : true;
  return matchesTokens(title, tokens);
}

// 季集号、分辨率、编码、来源这类词，站点的关键词搜索往往匹配不到
// （标题里是 S03E07，"s03" 不是一个独立的词），发给 API 前先摘掉
const NOISE_RE =
  /^(?:s\d{1,2}(?:e\d{1,3})?|e\d{1,3}|\d{3,4}p|x26[45]|h26[45]|hevc|xvid|divx|web|webrip|webdl|dl|hdtv|bluray|brrip|bdrip|dvdrip|remux|repack|proper|internal|amzn|dsnp|nf|hmax|aac|ac3|eac3|ddp\d?|dts|10bit|hdr|sdr|multi|complete|season|episode)$/i;

/**
 * 放宽后的查询：只留下「片名」部分发给站点 API，
 * 季集号等条件留给本地按标题过滤 —— 这样召回率高得多。
 * "pawn stars s03 1080p" -> "pawn stars"
 */
function broadQuery(query) {
  const tokens = tokenize(query);
  const kept = tokens.filter((t) => !NOISE_RE.test(t));
  return (kept.length ? kept : tokens).join(' ');
}

/** 取出裸季号（s03 这种不带集号的），没有就返回空串 */
function bareSeason(tokens) {
  for (const t of tokens) if (/^s\d{1,2}$/i.test(t)) return t;
  return '';
}

/**
 * 把裸季号展开成逐集查询。
 * apibay 和 therarbg 的关键词搜索都按整词匹配 —— 标题里是 "S03E07"，
 * 所以搜 "s03" 一条都没有，搜 "s03e07" 就有。
 */
function episodeQueries(query, season, count) {
  const rest = tokenize(query).filter((t) => t !== season);
  const base = rest.join(' ');
  const out = [];
  for (let i = 1; i <= count; i++) {
    out.push((base ? base + ' ' : '') + season + 'e' + String(i).padStart(2, '0'));
  }
  return out;
}

function magnetFrom(hash, name) {
  if (!hash) return '';
  let m = 'magnet:?xt=urn:btih:' + String(hash).toLowerCase();
  if (name) m += '&dn=' + encodeURIComponent(name);
  for (const tr of TRACKERS) m += '&tr=' + encodeURIComponent(tr);
  return m;
}

function hashOf(item) {
  return String(item.hash || '').toLowerCase();
}

/**
 * 按 infohash 去重合并。
 * 同一个种子在不同站点的 seeders 是各站各自抓的，取最大值，
 * 并记下它出现在哪些站 —— 多站都有通常意味着更容易连上。
 */
function mergeResults(items) {
  const byKey = new Map();
  for (const it of items) {
    if (!it || !it.title) continue;
    const key = hashOf(it) || 'title:' + normalize(it.title);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, Object.assign({}, it, {
        hash: hashOf(it),
        seeders: num(it.seeders),
        leechers: num(it.leechers),
        size: num(it.size),
        sources: [it.source],
        seedFrom: it.source,
      }));
      continue;
    }
    if (prev.sources.indexOf(it.source) < 0) prev.sources.push(it.source);
    if (num(it.seeders) > prev.seeders) {
      prev.seeders = num(it.seeders);
      prev.leechers = num(it.leechers);
      prev.seedFrom = it.source;
    }
    if (!prev.magnet && it.magnet) prev.magnet = it.magnet;
    if (!prev.hash && hashOf(it)) prev.hash = hashOf(it);
    if (!prev.size && num(it.size)) prev.size = num(it.size);
    if (!prev.date && it.date) prev.date = it.date;
    if (!prev.details && it.details) prev.details = it.details;
    if (!prev.imdb && it.imdb) prev.imdb = it.imdb;
    // 标题取更长的那个，通常信息更全（带组名、分辨率）
    if (it.title.length > prev.title.length) prev.title = it.title;
  }
  return Array.from(byKey.values());
}

function num(v) {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const SORTERS = {
  seeds: (a, b) => b.seeders - a.seeders || b.leechers - a.leechers || b.size - a.size,
  size: (a, b) => b.size - a.size,
  date: (a, b) => String(b.date || '').localeCompare(String(a.date || '')),
  title: (a, b) => normalize(a.title).localeCompare(normalize(b.title)),
};

function sortResults(list, by) {
  const cmp = SORTERS[by] || SORTERS.seeds;
  return list.slice().sort(cmp);
}

/** 从结果里推断最可能的 IMDb id（EZTV 只能按 imdb 搜） */
function guessImdb(list) {
  const tally = new Map();
  for (const it of list) {
    const id = String(it.imdb || '').replace(/^tt/i, '');
    if (!/^\d{5,}$/.test(id)) continue;
    tally.set(id, (tally.get(id) || 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [id, n] of tally) {
    if (n > bestN) {
      best = id;
      bestN = n;
    }
  }
  return best;
}

module.exports = {
  TRACKERS,
  normalize,
  tokenize,
  matchesTokens,
  matchesExact,
  matchesAny,
  broadQuery,
  bareSeason,
  episodeQueries,
  magnetFrom,
  mergeResults,
  sortResults,
  guessImdb,
};
