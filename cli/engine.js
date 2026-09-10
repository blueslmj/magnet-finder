/**
 * 搜索流程本体。命令行（search.js）和网页服务（serve.js）共用这一份。
 *
 * 三个源的关键词能力不一样，所以走三条互补的路：
 *   - knaben 的索引能匹配季号，用原查询就行
 *   - TPB / therarbg 按整词匹配，"s03" 搜不到，需要展开成 s03e01..e30 逐集补搜
 *   - EZTV 只认 IMDb id，用它能一次列出整部剧
 * 最后按 infohash 跨站去重，seeders 取各站最大值。
 */
'use strict';

const M = require('./match.js');
const S = require('./sources.js');

const ALL_SITES = ['tpb', 'therarbg', 'knaben', 'eztv', 'rargb'];
const DEFAULT_SITES = ['tpb', 'therarbg', 'knaben', 'eztv'];

const DEFAULTS = {
  query: '',
  sites: DEFAULT_SITES.slice(),
  minSeeds: 0,
  pages: 2,
  eztvPages: 15,
  limit: 300,
  episodes: 30,
  expand: true,
  sort: 'seeds',
  imdb: '',
  match: 'smart', // smart（子串，召回过宽）| exact（从标题开头连续对，精准）
};

const SORTS = ['seeds', 'size', 'date', 'title'];

/**
 * 把用户输入归一化成发给站点 API 的查询串。
 * 直接粘发布名（pawn.stars.s24 / Pawn_Stars_S24）和手打（pawn stars s24）等价。
 * 各站的关键词搜索都按词匹配，带点的串会被当成一个整词而搜不到。
 */
function normalizeQuery(s) {
  return M.tokenize(s).join(' ');
}

function clamp(v, lo, hi, dft) {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  if (!Number.isFinite(n)) return dft;
  return Math.min(hi, Math.max(lo, n));
}

/** 把外部传进来的参数收拾干净；不认识的数据源直接报错，别悄悄忽略 */
function normalizeOptions(raw) {
  const r = raw || {};
  const opt = Object.assign({}, DEFAULTS, {
    // 用户可能直接粘标题: "pawn.stars.s24"、"Pawn_Stars_S24"、"Pawn-Stars-S24"。
    // 本地匹配已经能把 . _ - + 当分隔符，但发给各站 API 的查询串必须也归一化，
    // 否则 therarbg 的 keywords:pawn.stars.s03 会返回 0 条。
    query: normalizeQuery(String(r.query == null ? '' : r.query)),
    minSeeds: clamp(r.minSeeds, 0, 100000, 0),
    pages: clamp(r.pages, 1, 30, 2),
    eztvPages: clamp(r.eztvPages, 1, 30, 15),
    limit: clamp(r.limit, 20, 300, 300),
    episodes: clamp(r.episodes, 1, 99, 30),
    expand: r.expand === undefined ? true : !!r.expand,
    sort: SORTS.indexOf(String(r.sort || '')) >= 0 ? String(r.sort) : 'seeds',
    imdb: String(r.imdb || '').replace(/^tt/i, ''),
    match: r.match === 'exact' ? 'exact' : r.match === 'loose' ? 'loose' : 'smart',
  });

  let sites = r.sites;
  if (typeof sites === 'string') {
    sites = sites.toLowerCase() === 'all' ? ALL_SITES.slice() : sites.split(',');
  }
  if (Array.isArray(sites) && sites.length) {
    opt.sites = sites.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  }
  const bad = opt.sites.filter((s) => ALL_SITES.indexOf(s) < 0);
  if (bad.length) {
    throw new Error('未知数据源: ' + bad.join(',') + '（可选: ' + ALL_SITES.join(',') + '）');
  }
  if (!opt.query.trim()) throw new Error('请输入关键词');
  opt.__normalized = true;
  return opt;
}

/** 限并发跑一批任务，结果顺序与输入一致 */
async function pool(inputs, size, fn) {
  const out = new Array(inputs.length);
  let next = 0;
  const workers = [];
  for (let i = 0; i < Math.max(1, size); i++) {
    workers.push(
      (async () => {
        while (next < inputs.length) {
          const at = next++;
          out[at] = await fn(inputs[at]);
        }
      })()
    );
  }
  await Promise.all(workers);
  return out;
}

/** 依次用几个查询去问同一个源，拿到非空结果就停 */
async function firstNonEmpty(fn, queries) {
  let list = [];
  let used = queries[0];
  for (const q of queries) {
    used = q;
    list = await fn(q);
    if (list.length) break;
  }
  return { list: list, used: used };
}

/**
 * 跑一次搜索。
 * @param {object} opt        原始选项（会先过 normalizeOptions），或已归一化的结果
 * @param {function} onEvent  进度回调，收到 { kind, message, ... }
 * @returns {{results: Array, tokens: Array, broad: string, sources: Array}}
 */
async function runSearch(opt, onEvent) {
  const emit = (kind, message, extra) =>
    typeof onEvent === 'function' && onEvent(Object.assign({ kind: kind, message: message }, extra));

  // 兼容两种调用：网页/CLI 传原始对象（这里归一化），测试可传已归一化的
  opt = opt && opt.__normalized ? opt : normalizeOptions(opt);
  const tokens = M.tokenize(opt.query);
  if (!tokens.length) throw new Error('请输入关键词');

  const broad = M.broadQuery(opt.query);
  const queries = broad && broad !== tokens.join(' ') ? [opt.query, broad] : [opt.query];
  emit('start', '关键词: ' + tokens.join(' + ') + (queries.length > 1 ? '（放宽备用: ' + broad + '）' : ''));

  const jobs = [];
  if (opt.sites.includes('tpb')) jobs.push(['TPB', (q) => S.tpb(q)]);
  if (opt.sites.includes('therarbg')) jobs.push(['therarbg', (q) => S.therarbg(q, { pages: opt.pages })]);
  if (opt.sites.includes('knaben')) jobs.push(['knaben', (q) => S.knaben(q, { limit: opt.limit })]);

  let items = [];
  const raw = []; // 未过滤的原始结果，只用来推断 IMDb id
  const hitCount = {};
  const report = [];

  const settled = await Promise.allSettled(jobs.map(([, fn]) => firstNonEmpty(fn, queries)));
  settled.forEach((r, i) => {
    const name = jobs[i][0];
    if (r.status === 'rejected') {
      hitCount[name] = 0;
      report.push({ source: name, ok: false, error: msgOf(r.reason) });
      emit('source', name + ' 失败: ' + msgOf(r.reason), { source: name, ok: false });
      return;
    }
    const hit = r.value.list.filter((it) => M.matchesAny(it.title, tokens, opt.match));
    hitCount[name] = hit.length;
    raw.push.apply(raw, r.value.list);
    items = items.concat(hit);
    report.push({ source: name, ok: true, returned: r.value.list.length, hit: hit.length });
    emit(
      'source',
      name + ' 返回 ' + r.value.list.length + ' 条，命中 ' + hit.length + ' 条' +
        (r.value.used === opt.query ? '' : '（用了放宽查询）'),
      { source: name, ok: true, returned: r.value.list.length, hit: hit.length }
    );
  });

  // 裸季号逐集补搜：这些站按整词匹配，标题里是 S03E07，搜 s03 一条都没有
  const season = M.bareSeason(tokens);
  if (season && opt.expand) {
    const need = jobs.filter(([name]) => !hitCount[name]);
    if (need.length) {
      const eq = M.episodeQueries(opt.query, season, opt.episodes);
      emit(
        'expand',
        '逐集补搜 ' + season + 'e01..e' + String(opt.episodes).padStart(2, '0') +
          '（' + need.map((j) => j[0]).join('/') + ' 搜不到裸季号）'
      );
      for (const [name, fn] of need) {
        const lists = await pool(eq, 5, (q) => fn(q).catch(() => []));
        const flat = [].concat.apply([], lists);
        const hit = flat.filter((it) => M.matchesAny(it.title, tokens, opt.match));
        raw.push.apply(raw, flat);
        items = items.concat(hit);
        report.push({ source: name + '(逐集)', ok: true, returned: flat.length, hit: hit.length });
        emit('source', name + ' 逐集补搜命中 ' + hit.length + ' 条', { source: name, ok: true, hit: hit.length });
      }
    }
  }

  // EZTV 只能按 imdb 查。id 要从**未过滤**的结果里推断 ——
  // 剧集身份跟季号无关，只看命中项的话季号一过滤就啥都不剩了
  if (opt.sites.includes('eztv')) {
    const imdb = opt.imdb || M.guessImdb(raw.concat(items));
    if (!imdb) {
      emit('source', 'EZTV 跳过: 没拿到 IMDb id（可以手填）', { source: 'EZTV', ok: false });
      report.push({ source: 'EZTV', ok: false, error: '没有 IMDb id' });
    } else {
      try {
        const list = await S.eztv(imdb, { pages: opt.eztvPages });
        const hit = list.filter((it) => M.matchesAny(it.title, tokens, opt.match));
        items = items.concat(hit);
        report.push({ source: 'EZTV', ok: true, returned: list.length, hit: hit.length, imdb: 'tt' + imdb });
        emit('source', 'EZTV(tt' + imdb + ') 返回 ' + list.length + ' 条，命中 ' + hit.length + ' 条', {
          source: 'EZTV',
          ok: true,
          returned: list.length,
          hit: hit.length,
        });
      } catch (e) {
        report.push({ source: 'EZTV', ok: false, error: msgOf(e) });
        emit('source', 'EZTV 失败: ' + msgOf(e), { source: 'EZTV', ok: false });
      }
    }
  }

  // rargb 放最后：它得逐个进详情页，先把已知标题传进去好跳过重复的
  if (opt.sites.includes('rargb')) {
    emit('source', 'rargb 抓 HTML（慢，要逐个进详情页取磁力）…');
    const known = new Set(items.map((it) => M.normalize(it.title)));
    try {
      const list = await S.rargb(opt.query, { pages: opt.pages, known: known, tokens: tokens });
      items = items.concat(list);
      report.push({ source: 'rargb', ok: true, returned: list.length, hit: list.length });
      emit('source', 'rargb 新增 ' + list.length + ' 条', { source: 'rargb', ok: true, hit: list.length });
    } catch (e) {
      report.push({ source: 'rargb', ok: false, error: msgOf(e) });
      emit('source', 'rargb 失败: ' + msgOf(e), { source: 'rargb', ok: false });
    }
  }

  let results = M.mergeResults(items);
  const total = results.length;
  if (opt.minSeeds > 0) results = results.filter((it) => it.seeders >= opt.minSeeds);
  results = M.sortResults(results, opt.sort);

  emit('summary', '去重后 ' + total + ' 条' + (opt.minSeeds > 0 ? '，过滤后 ' + results.length + ' 条' : ''), {
    total: total,
    kept: results.length,
  });

  return { results: results, tokens: tokens, broad: broad, sources: report, total: total };
}

function msgOf(e) {
  return e && e.message ? e.message : String(e);
}

module.exports = { runSearch, normalizeOptions, ALL_SITES, DEFAULT_SITES, DEFAULTS, SORTS };
