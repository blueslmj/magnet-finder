/**
 * 纯解析层：只处理 HTML 字符串，不依赖 DOM。
 * 这样 content script 和 node 测试可以共用同一份实现。
 */
(function (root) {
  'use strict';

  const MAGNET_RE = /magnet:\?[^\s"'`<>\\]+/gi;
  const BTIH_RE = /xt=urn:btih:([A-Za-z0-9]{32,40})/;
  const SIZE_RE = /\b\d+(?:\.\d+)?\s?[KMGT]i?B\b/i;

  // 各镜像的帖子详情页路径特征
  // 不锚死开头：代理站会把整个站点套在一层路径下，
  // 例如 knaben 的 /thepiratebay/description.php、/thepiratebay/torrent/123
  const DETAIL_RES = [
    /(?:^|\/)torrent\/[^/]+/i, // rargb.to / rarbg.to 等经典布局：/torrent/xxxxxxx
    /\/description\.php$/i, // The Pirate Bay 及其代理（knaben 的 /thepiratebay/ 走这个）
    /(?:^|\/)post\/detail\/[^/]+/i, // therarbg.com
    /(?:^|\/)ep\/\d+\//i, // eztvx.to
    /(?:^|\/)torrents\/\d+/i,
  ];

  // 明显不是详情页的路径（列表页、导航等）
  const DENY_RES = [
    /\.torrent$/i,
    /\/torrents\.php$/i,
    /\/get-posts\//i,
    /^\/search\/?$/i,
    /^\/(login|register|about-us|catalog|top10|box-office)\b/i,
  ];

  // 分页链接里的页码 token
  // rargb.to 是 /search/2/?search=Pawn%20Stars 这种把页码放路径里的形式
  const PAGE_TOKEN_RES = [
    /([?&]page=)(\d+)/i,
    /([?&]p=)(\d+)/i,
    /(\/page\/)(\d+)(?=\/|$|\?)/i,
    /(\/page_)(\d+)(?=\/|$|\?)/i, // eztvx.to
    /(\/(?:search|browse|list|catalog)\/)(\d+)(?=\/|$|\?)/i,
  ];

  // Cloudflare / DDoS-Guard 之类的校验页特征。撞上这个说明是被拦了，
  // 不是页面用 JS 渲染，别去开 iframe 重试。
  const BLOCKED_RES = [
    /just a moment/i,
    /checking your browser/i,
    /cf-browser-verification/i,
    /attention required/i,
    /enable javascript and cookies to continue/i,
    /ddos-guard/i,
    /protected by go-away/i, // knaben 的反爬
    /loading challenge/i,
  ];

  const NAMED_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };

  const reCache = new Map();

  function safeRe(src) {
    if (!src) return null;
    if (reCache.has(src)) return reCache.get(src);
    let re = null;
    try {
      re = new RegExp(src, 'i');
    } catch (e) {
      re = null;
    }
    reCache.set(src, re);
    return re;
  }

  function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, g) {
      if (g[0] === '#') {
        const code =
          g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
      }
      const v = NAMED_ENTITIES[g.toLowerCase()];
      return v === undefined ? m : v;
    });
  }

  function cleanText(html) {
    return decodeEntities(String(html).replace(/<[^>]*>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
  }

  function attr(attrs, name) {
    const re = new RegExp(
      '\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s">]+))',
      'i'
    );
    const m = re.exec(attrs || '');
    if (!m) return '';
    return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] || '';
  }

  /** 抽出所有 <a>，返回 { href, text } */
  function extractAnchors(html) {
    const out = [];
    const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html))) {
      const href = attr(m[1], 'href');
      if (!href) continue;
      out.push({
        href: decodeEntities(href),
        text: cleanText(m[2]) || decodeEntities(attr(m[1], 'title')),
      });
    }
    return out;
  }

  function toAbsolute(href, base) {
    if (!href) return '';
    if (href.charAt(0) === '#' || /^(javascript|mailto|magnet|data):/i.test(href)) return '';
    try {
      const u = new URL(href, base);
      u.hash = '';
      return u.href;
    } catch (e) {
      return '';
    }
  }

  function isDetailUrl(absUrl, opts) {
    let u;
    try {
      u = new URL(absUrl);
    } catch (e) {
      return false;
    }
    const path = u.pathname;
    const extra = safeRe((opts && opts.detailPattern) || '');
    if (extra && extra.test(path + u.search)) return true;
    if (DENY_RES.some((re) => re.test(path))) return false;
    return DETAIL_RES.some((re) => re.test(path));
  }

  /** 是不是反爬校验页（而不是正常内容页） */
  function looksBlocked(html) {
    const head = String(html).slice(0, 4000);
    return BLOCKED_RES.some((re) => re.test(head));
  }

  function infoHash(magnet) {
    const m = BTIH_RE.exec(magnet || '');
    return m ? m[1].toLowerCase() : '';
  }

  /** 从任意 HTML 片段里抽磁力链接，按 infohash 去重 */
  function extractMagnets(html) {
    const out = [];
    const seen = new Set();
    const hits = String(html).match(MAGNET_RE) || [];
    for (const raw of hits) {
      const magnet = decodeEntities(raw).replace(/[&?]+$/, '');
      const h = infoHash(magnet);
      if (!h || seen.has(h)) continue;
      seen.add(h);
      out.push(magnet);
    }
    return out;
  }

  /** 从 HTML 里抽 .torrent 文件下载地址 */
  function extractTorrentFileUrls(html, base) {
    const out = [];
    const seen = new Set();
    for (const a of extractAnchors(html)) {
      const abs = toAbsolute(a.href, base);
      if (!abs) continue;
      let u;
      try {
        u = new URL(abs);
      } catch (e) {
        continue;
      }
      const hit =
        /\.torrent$/i.test(u.pathname) ||
        /download\.php$/i.test(u.pathname) ||
        /\/download\//i.test(u.pathname);
      if (hit && !seen.has(abs)) {
        seen.add(abs);
        out.push(abs);
      }
    }
    return out;
  }

  /** 把一行切成各个 <td> 的纯文本 */
  function rowCells(rowHtml) {
    const out = [];
    const re = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let m;
    while ((m = re.exec(rowHtml))) out.push(cleanText(m[1]));
    return out;
  }

  /**
   * 取种子数 / 下载数：定位到「大小」那一列，它后面的前两个纯整数列就是
   * S. 和 L. —— rargb、EZTV、TPB 代理的表格都是这个排法。
   * 拿不准就返回 0，宁可显示 0 也别瞎猜。
   */
  function rowPeers(rowHtml) {
    const cells = rowCells(rowHtml);
    let at = -1;
    for (let i = 0; i < cells.length; i++) {
      if (SIZE_RE.test(cells[i])) {
        at = i;
        break;
      }
    }
    if (at < 0) return { seeders: 0, leechers: 0 };
    const nums = [];
    for (let i = at + 1; i < cells.length && nums.length < 2; i++) {
      const t = cells[i].replace(/,/g, '');
      if (/^\d{1,7}$/.test(t)) nums.push(parseInt(t, 10));
    }
    return { seeders: nums[0] || 0, leechers: nums[1] || 0 };
  }

  /** 把 HTML 切成 <tr> 块，一行一个帖子 */
  function extractRows(html) {
    const out = [];
    const re = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let m;
    while ((m = re.exec(html))) out.push(m[0]);
    return out;
  }

  function guessTitleFromUrl(url) {
    try {
      const parts = new URL(url).pathname.split('/').filter(Boolean);
      return decodeURIComponent(parts[parts.length - 1] || '').replace(/[-_+]+/g, ' ');
    } catch (e) {
      return '';
    }
  }

  /**
   * 一行里最多提取一个帖子。
   * 标题必须来自指向同一个 URL 的链接 —— 否则会被站点塞进结果表的推荐海报条
   * （一个 <tr> 里好几部不相干的电影）串成「A 的标题 + B 的链接」。
   */
  function postFromRow(rowHtml, base, opts) {
    const byUrl = new Map();
    let magnetTitle = '';
    for (const a of extractAnchors(rowHtml)) {
      if (/^magnet:/i.test(a.href)) {
        if (a.text.length > magnetTitle.length) magnetTitle = a.text;
        continue;
      }
      const abs = toAbsolute(a.href, base);
      if (!abs || !isDetailUrl(abs, opts)) continue;
      // 正常结果行里封面链接和标题链接指向同一帖子，取文字最长的当标题
      const prev = byUrl.get(abs) || '';
      if (a.text.length > prev.length) byUrl.set(abs, a.text);
    }
    // 一行里出现多个不同帖子，那是推荐海报条，不是搜索结果
    if (byUrl.size > 1) return null;
    const url = byUrl.size ? byUrl.keys().next().value : '';
    const linkTitle = url ? byUrl.get(url) : '';
    const magnets = extractMagnets(rowHtml);
    if (!url && !magnets.length) return null;
    // 三个候选里挑最长的：详情链接文字、磁力链接文字、磁力 dn 参数。
    // 谁都可能是对的 —— knaben 的详情链接文字是来源站名「The Pirate Bay」，
    // therarbg 的磁力链接文字是「磁力」，rargb 压根没有行内磁力。
    const title = pickTitle([
      linkTitle,
      magnetTitle,
      magnets[0] ? titleFromMagnet(magnets[0]) : '',
    ]);

    const sizeHit = SIZE_RE.exec(cleanText(rowHtml));
    const peers = rowPeers(rowHtml);
    return {
      url: url,
      title: title || guessTitleFromUrl(url),
      size: sizeHit ? sizeHit[0] : '',
      magnet: magnets[0] || '',
      // EZTV 这类站点行内就有 .torrent 链接；行内已有磁力就不会去抓详情页，
      // 这里不收下的话「下载 .torrent」会一直是空的
      torrent: extractTorrentFileUrls(rowHtml, base)[0] || '',
      seeders: peers.seeders,
      leechers: peers.leechers,
    };
  }

  // 「磁力」「Get this torrent」这类按钮文字不是标题
  const GENERIC_TITLE_RE =
    /^(?:magnet(?:s*link)?|磁力(?:链接)?|下载|download(?:s+thiss+torrent)?(?:s+usings+magnet)?|gets+thiss+torrent|torrent|dl)$/i;

  /** 候选标题里挑最靠谱的：去掉按钮文字，取最长的 */
  function pickTitle(cands) {
    let best = '';
    for (const c of cands) {
      const t = String(c || '').trim();
      if (!t || GENERIC_TITLE_RE.test(t)) continue;
      if (t.length > best.length) best = t;
    }
    return best;
  }

  function titleFromMagnet(magnet) {
    const m = /[?&]dn=([^&]+)/.exec(magnet || '');
    if (!m) return '';
    try {
      return decodeURIComponent(m[1].replace(/\+/g, ' '));
    } catch (e) {
      return m[1];
    }
  }

  /**
   * 从列表页 HTML 抽出所有帖子。
   * 优先按 <tr> 分组（能把标题/大小/内联磁力配对准确），
   * 没有表格结构时退化为「按详情链接去重」。
   */
  function extractPosts(html, base, opts) {
    const rows = extractRows(html);
    const out = [];
    const seen = new Set();
    const push = (p) => {
      if (!p) return;
      const key = p.url || 'ih:' + infoHash(p.magnet);
      if (key === 'ih:' || seen.has(key)) return;
      seen.add(key);
      out.push(p);
    };

    if (rows.length) {
      for (const row of rows) push(postFromRow(row, base, opts));
      if (out.length) return out;
    }

    for (const a of extractAnchors(html)) {
      const abs = toAbsolute(a.href, base);
      if (!abs || !isDetailUrl(abs, opts)) continue;
      if (seen.has(abs)) {
        // 已存在则补一个更长的标题
        const prev = out.find((p) => p.url === abs);
        if (prev && a.text.length > prev.title.length) prev.title = a.text;
        continue;
      }
      push({
        url: abs,
        title: a.text || guessTitleFromUrl(abs),
        size: '',
        magnet: '',
        torrent: '',
        seeders: 0,
        leechers: 0,
      });
    }
    return out;
  }

  /** 从 URL 里解析页码，并给出把页码换成 {n} 的模板（差异比对失败时的兜底） */
  function pageInfo(url) {
    for (const re of PAGE_TOKEN_RES) {
      const m = re.exec(url);
      if (!m) continue;
      return {
        n: parseInt(m[2], 10),
        template: url.slice(0, m.index) + m[1] + '{n}' + url.slice(m.index + m[0].length),
      };
    }
    return null;
  }

  const isDigits = (s) => typeof s === 'string' && /^\d+$/.test(s);

  /**
   * 把候选链接和当前页 URL 逐 token（路径段 + 查询参数）比对，
   * 只有「恰好一个 token 不同、且是数字」的才算同一批列表的分页链接。
   *
   * 这样才躲得开真实站点的干扰：knaben 侧栏的 /browse/2001000/1 分类链接、
   * rargb 表头的 ?order=data&by=ASC 排序链接，都不会再被当成页码。
   * 返回 { n: 链接指向第几页, curN: 当前页是第几页(未知为 null), template }
   */
  function diffPageInfo(currentUrl, linkUrl) {
    let cur, link;
    try {
      cur = new URL(currentUrl);
      link = new URL(linkUrl);
    } catch (e) {
      return null;
    }
    if (cur.origin !== link.origin) return null;

    const curSegs = cur.pathname.split('/');
    const linkSegs = link.pathname.split('/');
    if (curSegs.length !== linkSegs.length) return null;

    let hit = null;
    for (let i = 0; i < curSegs.length; i++) {
      if (sameToken(curSegs[i], linkSegs[i])) continue;
      if (hit || !isDigits(curSegs[i]) || !isDigits(linkSegs[i])) return null;
      hit = { kind: 'seg', key: i, raw: linkSegs[i], curRaw: curSegs[i] };
    }

    const keys = new Set();
    cur.searchParams.forEach((v, k) => keys.add(k));
    link.searchParams.forEach((v, k) => keys.add(k));
    for (const k of keys) {
      const a = cur.searchParams.get(k);
      const b = link.searchParams.get(k);
      if (a !== null && b !== null && sameToken(a, b)) continue;
      if (a === b) continue;
      // 链接里新增/改动的那个数字参数才是页码，其它差异一律否决
      if (hit || !isDigits(b) || (a !== null && !isDigits(a))) return null;
      hit = { kind: 'param', key: k, raw: b, curRaw: a };
    }
    if (!hit) return null;

    // 模板用字符串替换生成，不走 URL 序列化 —— 否则 %20 会被改写成 +
    let template = null;
    if (hit.kind === 'seg') {
      const segs = link.pathname.split('/');
      segs[hit.key] = '{n}';
      const at = link.href.indexOf(link.pathname);
      template = link.href.slice(0, at) + segs.join('/') + link.href.slice(at + link.pathname.length);
    } else {
      const re = new RegExp('([?&]' + escapeRe(hit.key) + '=)' + escapeRe(hit.raw) + '(?=&|#|$)');
      if (!re.test(link.href)) return null;
      template = link.href.replace(re, '$1{n}');
    }
    return {
      n: parseInt(hit.raw, 10),
      curN: hit.curRaw === null || hit.curRaw === undefined ? null : parseInt(hit.curRaw, 10),
      template: template,
    };
  }

  /** token 比较忽略大小写和百分号转义 —— 站点分页链接常把关键词小写化 */
  function sameToken(a, b) {
    if (a === b) return true;
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const norm = (v) => {
      try {
        return decodeURIComponent(v).toLowerCase();
      } catch (e) {
        return v.toLowerCase();
      }
    };
    return norm(a) === norm(b);
  }

  const NAV_TEXT_RE =
    /^(?:»|›|>>|>|«|‹|<<|<|next|prev|previous|last|first|下一页|上一页|下页|上页|末页|首页|尾页)$/i;

  /**
   * 分页链接的文字要么是页码，要么是「下一页」这类导航词。
   * 光看 URL 不够：TPB 的 ?orderby=7（排序）、knaben 的 /browse/2001000/1（分类）
   * 在 URL 上都长得像「只差一个数字」，只有文字能把它们和真分页区分开。
   */
  function looksLikePageLink(text) {
    const t = String(text || '').replace(/[\[\]()（）\s]/g, '');
    if (!t) return false;
    return /^\d{1,6}$/.test(t) || NAV_TEXT_RE.test(t);
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 收集页面里的分页链接，返回 Map<页码, { url, template, curN }>。
   * 优先用差异比对的结果；一个都没比对上时（例如分页指向另一个路径的脚本页），
   * 才退回正则识别的宽松结果。
   */
  function collectPageLinks(html, base, currentUrl) {
    const strict = new Map();
    const loose = new Map();
    for (const a of extractAnchors(html)) {
      const abs = toAbsolute(a.href, base);
      if (!abs || isDetailUrl(abs)) continue;
      if (!looksLikePageLink(a.text)) continue;
      const d = diffPageInfo(currentUrl, abs);
      if (d && Number.isFinite(d.n)) {
        if (!strict.has(d.n)) strict.set(d.n, { url: abs, template: d.template, curN: d.curN });
        continue;
      }
      const info = pageInfo(abs);
      if (info && Number.isFinite(info.n) && !loose.has(info.n)) {
        loose.set(info.n, { url: abs, template: info.template, curN: null });
      }
    }
    return strict.size ? strict : loose;
  }

  /**
   * 探测分页：{ maxPage, template, current, pageBase }。
   * 页码一律是站点自己的编号 —— 有的站从 0 开始（TPB 的 ?page=0 就是第一页），
   * pageBase 告诉调用方该怎么换算成给人看的「第 1 页」。
   */
  function findPagination(html, base, currentUrl) {
    const cur = pageInfo(currentUrl);
    const links = collectPageLinks(html, base, currentUrl);

    let current = cur && Number.isFinite(cur.n) ? cur.n : null;
    for (const hit of links.values()) {
      if (hit.curN !== null && Number.isFinite(hit.curN)) {
        current = hit.curN;
        break;
      }
    }

    let maxPage = current === null ? 1 : current;
    let minPage = current === null ? 1 : current;
    let template = cur ? cur.template : '';
    for (const [n, hit] of links) {
      if (n < minPage) minPage = n;
      if (n >= maxPage) {
        maxPage = n;
        template = hit.template;
      } else if (!template) {
        template = hit.template;
      }
    }
    return {
      maxPage: maxPage,
      template: template,
      current: current === null ? (minPage <= 0 ? 0 : 1) : current,
      pageBase: minPage <= 0 ? 0 : 1,
    };
  }

  /**
   * 在某一页的 HTML 里找出指向第 n 页的链接（n 是站点自己的编号）。
   * 用站点自己的链接翻页，比照模板拼 URL 靠谱得多。
   */
  function findPageUrl(html, base, currentUrl, n) {
    const hit = collectPageLinks(html, base, currentUrl).get(n);
    return hit ? hit.url : '';
  }

  function currentPageNo(url) {
    const info = pageInfo(url);
    return info && Number.isFinite(info.n) ? info.n : 1;
  }

  /** 拼出第 n 页的 URL */
  function buildPageUrl(currentUrl, n, template) {
    if (template) return template.replace('{n}', String(n));
    const info = pageInfo(currentUrl);
    if (info) return info.template.replace('{n}', String(n));
    try {
      const u = new URL(currentUrl);
      u.searchParams.set('page', String(n));
      return u.href;
    } catch (e) {
      return currentUrl;
    }
  }

  const api = {
    decodeEntities: decodeEntities,
    cleanText: cleanText,
    extractAnchors: extractAnchors,
    extractRows: extractRows,
    extractPosts: extractPosts,
    rowPeers: rowPeers,
    extractMagnets: extractMagnets,
    extractTorrentFileUrls: extractTorrentFileUrls,
    isDetailUrl: isDetailUrl,
    infoHash: infoHash,
    looksBlocked: looksBlocked,
    titleFromMagnet: titleFromMagnet,
    pageInfo: pageInfo,
    currentPageNo: currentPageNo,
    findPagination: findPagination,
    findPageUrl: findPageUrl,
    collectPageLinks: collectPageLinks,
    buildPageUrl: buildPageUrl,
  };

  root.RarbgParse = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
