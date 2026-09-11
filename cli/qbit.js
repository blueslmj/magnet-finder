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
    if (a.paused) form.append('paused', 'true');

    const res = await call('/api/v2/torrents/add', { method: 'POST', body: form });
    const text = (await res.text()).trim();

    if (!res.ok) throw new QbitError('推送失败: HTTP ' + res.status + ' ' + text, 'api');
    // qBittorrent 对已存在的种子也返回 Ok.，这里无法区分「新增」和「已存在」
    if (text && text !== 'Ok.') {
      throw new QbitError('qBittorrent 拒绝了这批磁力: ' + text, 'api');
    }
    return { count: list.length };
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
    test: test,
    get sid() {
      return sid;
    },
  };
}

module.exports = { createClient, normalizeUrl, readSid, QbitError };
