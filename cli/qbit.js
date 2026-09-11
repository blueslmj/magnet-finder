/**
 * qBittorrent Web API 客户端（API v2）。
 *
 * 为什么要放在服务端而不是让浏览器直接调：
 *   1. qBittorrent 不发 CORS 头，浏览器 fetch 会被跨域拦掉
 *   2. 它有 CSRF 防护 —— 会校验 Referer/Origin 是否跟 WebUI 同源，
 *      浏览器发出去的请求带的是我们页面的 Origin，必被 403
 * 服务端代发就没这两个问题：我们能自己把 Referer 设成 qBittorrent 自己的地址。
 *
 * c0re100/qBittorrent-Enhanced-Edition 是上游的分支，Web API 完全一致，
 * 这个客户端两个都能用，不需要区分。
 *
 * fetch 通过参数注入，方便测试时替换成假的。
 */
'use strict';

/** 把用户填的地址收拾成 http://host:port 的形式（去掉末尾斜杠和路径） */
function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    return u.origin;
  } catch (e) {
    return '';
  }
}

/** 从 set-cookie 里取出 SID */
function readSid(res) {
  let list = [];
  try {
    // Node 18.14+ / 20+ 才有 getSetCookie；老版本退回单个头
    list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  } catch (e) {
    list = [];
  }
  if (!list.length) {
    const one = res.headers.get && res.headers.get('set-cookie');
    if (one) list = [one];
  }
  for (const c of list) {
    const m = /(?:^|;\s*)SID=([^;]+)/.exec(c);
    if (m) return m[1];
  }
  return '';
}

class QbitError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'QbitError';
    this.kind = kind || 'unknown'; // network | auth | banned | csrf | api
  }
}

function magnetHash(magnet) {
  try {
    const url = new URL(magnet);
    if (url.protocol !== 'magnet:') return '';
    for (const xt of url.searchParams.getAll('xt')) {
      const match = /^urn:btih:([a-f0-9]{40}|[a-z2-7]{32})$/i.exec(xt);
      if (!match) continue;
      const hash = match[1].toUpperCase();
      if (hash.length === 40) return hash.toLowerCase();
      let bits = 0, value = 0, hex = '';
      for (const ch of hash) {
        value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(ch);
        bits += 5;
        if (bits >= 8) {
          bits -= 8;
          hex += ((value >>> bits) & 255).toString(16).padStart(2, '0');
        }
      }
      return hex;
    }
  } catch (_) { /* 无效磁力交给发送结果逐条报告 */ }
  return '';
}

/**
 * 顺着 error.cause 链和 AggregateError.errors 把底层 errno 挖出来。
 *
 * fetch 抛的永远是一句没用的 "fetch failed"，真正的原因埋在 cause 里。
 * 而且填 localhost 时会同时解析出 ::1 和 127.0.0.1，两个都连不上就抛
 * AggregateError —— 这时 cause.code 是 undefined，只看一层会漏掉。
 */
function findErrorCode(e, depth) {
  if (!e || (depth || 0) > 6) return '';
  if (e.code) return e.code;
  if (Array.isArray(e.errors)) {
    for (const sub of e.errors) {
      const code = findErrorCode(sub, (depth || 0) + 1);
      if (code) return code;
    }
  }
  return findErrorCode(e.cause, (depth || 0) + 1);
}

/** 把底层异常翻译成能直接给用户看的话 */
function describeNetworkError(e, url) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return new QbitError('连接 ' + url + ' 超时 —— 地址能通但没响应，确认端口是 WebUI 的端口', 'network');
  }

  const code = findErrorCode(e);
  if (code === 'ECONNREFUSED') {
    return new QbitError(
      '连不上 ' + url + ' —— qBittorrent 没开，或者 WebUI 没启用、端口不对',
      'network'
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new QbitError('域名解析不了: ' + url + ' —— 检查主机名拼写', 'network');
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return new QbitError('连接被对方断开: ' + url + ' —— 如果 WebUI 开了 HTTPS，地址要写 https://', 'network');
  }
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return new QbitError('网络不可达: ' + url, 'network');
  }

  const detail = (e && e.message) || String(e);
  const inner = e && e.cause && e.cause.message;
  return new QbitError(
    '连接 ' + url + ' 失败: ' + (inner && inner !== detail ? inner : detail),
    'network'
  );
}

function createClient(opts) {
  const o = opts || {};
  const base = normalizeUrl(o.url);
  const username = String(o.username || '');
  const password = String(o.password || '');
  const doFetch = o.fetch || globalThis.fetch;
  const timeout = o.timeout || 15000;
  let sid = '';

  if (!base) throw new QbitError('qBittorrent 地址没填或格式不对', 'api');

  /**
   * 所有请求都带 Referer —— qBittorrent 的 CSRF 防护会拿它跟自己的地址比对，
   * 不带或者对不上就直接 403。这是接 qBittorrent 最常踩的坑。
   */
  async function call(pathname, init) {
    const url = base + pathname;
    const headers = Object.assign(
      {
        Referer: base,
        Origin: base,
      },
      (init && init.headers) || {}
    );
    if (sid) headers.Cookie = 'SID=' + sid;

    let res;
    try {
      res = await doFetch(url, {
        method: (init && init.method) || 'GET',
        headers: headers,
        body: init && init.body,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      throw describeNetworkError(e, base);
    }

    if (res.status === 403) {
      throw new QbitError(
        '被 qBittorrent 拒绝(403) —— 通常是未登录/会话过期，或 WebUI 开了「启用跨站请求伪造保护」而地址对不上',
        'csrf'
      );
    }
    return res;
  }

  /**
   * 登录。用户名留空表示依赖 qBittorrent 的「对本机跳过认证」选项。
   */
  async function login() {
    if (!username) return { skipped: true };

    const body = new URLSearchParams({ username: username, password: password }).toString();
    const res = await call('/api/v2/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body,
    });

    const text = (await res.text()).trim();
    if (/banned/i.test(text)) {
      throw new QbitError(
        'IP 已被 qBittorrent 临时封禁（连续登录失败触发）。等几分钟，或在 WebUI 设置里解除',
        'banned'
      );
    }
    if (text !== 'Ok.') {
      throw new QbitError('登录失败：用户名或密码不对', 'auth');
    }

    sid = readSid(res);
    if (!sid) {
      throw new QbitError('登录返回成功但没拿到会话 cookie(SID)，无法继续', 'auth');
    }
    return { skipped: false };
  }

  async function version() {
    const res = await call('/api/v2/app/version');
    if (!res.ok) throw new QbitError('取版本失败: HTTP ' + res.status, 'api');
    return (await res.text()).trim();
  }

  /**
   * 推送磁力。qBittorrent 的 /torrents/add 收 multipart，
   * urls 字段里多条磁力用换行分隔，一次可以提交一批。
   */
  async function addMagnets(magnets, addOpts) {
    const list = (Array.isArray(magnets) ? magnets : [magnets]).filter(Boolean);
    if (!list.length) throw new QbitError('没有可推送的磁力链接', 'api');

    const a = addOpts || {};
    const form = new FormData();
    form.append('urls', list.join('\n'));
    if (a.savepath) form.append('savepath', String(a.savepath));
    if (a.category) form.append('category', String(a.category));
    if (a.tags) form.append('tags', String(a.tags));
    // 4.x 使用 paused，5.x 使用 stopped；显式覆盖客户端的默认暂停设置。
    form.append('paused', String(!!a.paused));
    form.append('stopped', String(!!a.paused));
    if (!a.paused) form.append('stopCondition', 'None');

    const res = await call('/api/v2/torrents/add', { method: 'POST', body: form });
    const text = (await res.text()).trim();

    if (!res.ok) throw new QbitError('推送失败: HTTP ' + res.status + ' ' + text, 'api');
    // qBittorrent 对已存在的种子也返回 Ok.，这里无法区分「新增」和「已存在」
    if (text && text !== 'Ok.') {
      throw new QbitError('qBittorrent 拒绝了这批磁力: ' + text, 'api');
    }
    return { count: list.length };
  }

  async function torrentInfo(hashes) {
    const found = new Map();
    for (let i = 0; i < hashes.length; i += 50) {
      const query = new URLSearchParams({ hashes: hashes.slice(i, i + 50).join('|') });
      const res = await call('/api/v2/torrents/info?' + query);
      if (!res.ok) throw new QbitError('核对任务失败: HTTP ' + res.status, 'api');
      let rows;
      try { rows = JSON.parse(await res.text()); } catch (_) { /* 下方统一校验 */ }
      if (!Array.isArray(rows)) throw new QbitError('qBittorrent 返回了无效的任务列表', 'api');
      for (const row of rows) found.set(String(row.hash).toLowerCase(), row);
    }
    return found;
  }

  async function startTorrents(hashes) {
    if (!hashes.length) return;
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ hashes: hashes.join('|') }).toString(),
    };
    let res = await call('/api/v2/torrents/start', init);
    if (res.status === 404) res = await call('/api/v2/torrents/resume', init);
    if (!res.ok) throw new QbitError('启动任务失败: HTTP ' + res.status, 'api');
  }

  /** Ok. 只表示请求被接收；查任务列表才能确认每条磁力是否已添加。 */
  async function sendMagnets(magnets, addOpts) {
    const items = [];
    const seen = new Set();
    for (const magnet of magnets) {
      const hash = magnetHash(magnet);
      const key = hash || magnet;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ magnet, hash, status: hash ? 'pending' : 'failed',
        message: hash ? '' : '无效或暂不支持的磁力 infohash' });
    }
    if (!items.length) throw new QbitError('没有可推送的磁力链接', 'api');
    const hashes = items.filter((i) => i.hash).map((i) => i.hash);
    const before = await torrentInfo(hashes);
    const fresh = items.filter((i) => i.hash && !before.has(i.hash));
    let addError = null;
    if (fresh.length) {
      try { await addMagnets(fresh.map((i) => i.magnet), addOpts); }
      catch (e) { addError = e; }
    }
    let after = new Map(before), verifyError = null;
    const sleep = o.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(700);
      try { after = await torrentInfo(hashes); verifyError = null; }
      catch (e) { verifyError = e; break; }
      if (hashes.every((hash) => after.has(hash))) break;
    }
    const stopped = (row) => /^(paused|stopped)(DL|UP)$/.test(row.state);
    const toStart = hashes.filter((hash) => {
      const row = after.get(hash);
      return row && stopped(row) && Number(row.progress) < 1;
    });
    let startError = null;
    if (!addOpts?.paused && toStart.length) {
      try {
        await startTorrents(toStart);
        for (let attempt = 0; attempt < 3; attempt++) {
          await sleep(400);
          after = await torrentInfo(hashes);
          if (toStart.every((hash) => after.has(hash) && !stopped(after.get(hash)))) break;
        }
      } catch (e) { startError = e; }
    }
    for (const item of items) {
      if (!item.hash) continue;
      const row = after.get(item.hash);
      if (!row) {
        item.status = addError && addError.kind !== 'network' && !verifyError ? 'failed' : 'pending';
        item.message = verifyError ? '已尝试发送，但无法核对：' + verifyError.message
          : addError ? addError.message : '请求已接收，暂未在任务列表确认；可再次发送核对';
        continue;
      }
      item.status = before.has(item.hash) ? 'existing' : 'added';
      item.name = row.name || '';
      item.state = row.state;
      item.progress = row.progress;
      if (verifyError) item.message = '状态核对失败：' + verifyError.message;
      if (startError && toStart.includes(item.hash)) item.message = startError.message;
      else if (!addOpts?.paused && stopped(row) && Number(row.progress) < 1) {
        item.message = '任务仍处于停止状态，请检查 qBittorrent 的任务设置';
      }
      if (row.state === 'error' || row.state === 'missingFiles') {
        item.message = 'qBittorrent 报告文件或磁盘错误，请检查保存路径、空间和权限';
      }
    }
    const result = { count: items.length, added: 0, existing: 0, failed: 0, pending: 0, items };
    for (const item of items) result[item.status]++;
    return result;
  }

  /** 连接测试：登录 + 取版本，把结果打包成给用户看的信息 */
  async function test() {
    const auth = await login();
    const v = await version();
    return {
      ok: true,
      version: v,
      url: base,
      auth: auth.skipped ? '未登录（依赖本机免认证）' : '已登录 ' + username,
    };
  }

  return {
    base: base,
    login: login,
    version: version,
    addMagnets: addMagnets,
    sendMagnets: sendMagnets,
    test: test,
    get sid() {
      return sid;
    },
  };
}

module.exports = { createClient, normalizeUrl, readSid, QbitError, magnetHash };
