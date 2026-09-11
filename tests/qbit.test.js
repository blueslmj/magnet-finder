'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Q = require('../cli/qbit.js');

/** 造一个假 fetch：按路径返回预设响应，并把收到的请求记下来供断言 */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: url, init: init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const r = key ? routes[key] : { status: 404, body: 'Not found' };
    if (r.throw) throw r.throw;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => r.body || '',
      headers: {
        getSetCookie: () => r.cookies || [],
        get: (h) => (h.toLowerCase() === 'set-cookie' ? (r.cookies || [])[0] : null),
      },
    };
  };
  fn.calls = calls;
  return fn;
}

test('地址归一化：补协议、去路径和末尾斜杠', () => {
  assert.strictEqual(Q.normalizeUrl('127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.strictEqual(Q.normalizeUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  assert.strictEqual(Q.normalizeUrl('https://nas.local:8443/web/'), 'https://nas.local:8443');
  assert.strictEqual(Q.normalizeUrl(''), '');
  assert.strictEqual(Q.normalizeUrl('  '), '');
});

test('地址没填直接报错，不要等发请求才失败', () => {
  assert.throws(() => Q.createClient({ url: '' }), /地址没填/);
});

test('登录成功后带上 SID cookie', async () => {
  const f = fakeFetch({
    '/auth/login': { status: 200, body: 'Ok.', cookies: ['SID=abc123; path=/; HttpOnly'] },
    '/app/version': { status: 200, body: 'v4.6.5' },
  });
  const c = Q.createClient({ url: '127.0.0.1:8080', username: 'admin', password: 'pw', fetch: f });
  await c.login();
  assert.strictEqual(c.sid, 'abc123');

  await c.version();
  // 登录后的请求必须带上会话 cookie
  assert.strictEqual(f.calls[1].init.headers.Cookie, 'SID=abc123');
});

test('每个请求都带 Referer —— 不带会被 qBittorrent 的 CSRF 防护 403', async () => {
  const f = fakeFetch({ '/app/version': { status: 200, body: 'v5.0.0' } });
  const c = Q.createClient({ url: 'http://127.0.0.1:8080', fetch: f });
  await c.version();
  assert.strictEqual(f.calls[0].init.headers.Referer, 'http://127.0.0.1:8080');
  assert.strictEqual(f.calls[0].init.headers.Origin, 'http://127.0.0.1:8080');
});

test('用户名留空则跳过登录（依赖 qBittorrent 的本机免认证）', async () => {
  const f = fakeFetch({ '/app/version': { status: 200, body: 'v4.6.5' } });
  const c = Q.createClient({ url: '127.0.0.1:8080', fetch: f });
  const r = await c.login();
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(f.calls.length, 0); // 根本没发登录请求
});

test('密码错误报「用户名或密码不对」，不是一句含糊的失败', async () => {
  const f = fakeFetch({ '/auth/login': { status: 200, body: 'Fails.' } });
  const c = Q.createClient({ url: '127.0.0.1:8080', username: 'admin', password: 'x', fetch: f });
  await assert.rejects(() => c.login(), (e) => e.kind === 'auth' && /用户名或密码不对/.test(e.message));
});

test('连续登录失败被封 IP 时给出明确提示', async () => {
  const f = fakeFetch({
    '/auth/login': { status: 200, body: 'Your IP address has been banned after too many failed authentication attempts.' },
  });
  const c = Q.createClient({ url: '127.0.0.1:8080', username: 'admin', password: 'x', fetch: f });
  await assert.rejects(() => c.login(), (e) => e.kind === 'banned' && /封禁/.test(e.message));
});

test('登录说成功却没给 SID 时要报错，而不是揣着空会话继续', async () => {
  const f = fakeFetch({ '/auth/login': { status: 200, body: 'Ok.', cookies: [] } });
  const c = Q.createClient({ url: '127.0.0.1:8080', username: 'admin', password: 'pw', fetch: f });
  await assert.rejects(() => c.login(), (e) => e.kind === 'auth' && /SID/.test(e.message));
});

test('403 归类为 csrf 并说明可能原因', async () => {
  const f = fakeFetch({ '/app/version': { status: 403, body: 'Forbidden' } });
  const c = Q.createClient({ url: '127.0.0.1:8080', fetch: f });
  await assert.rejects(() => c.version(), (e) => e.kind === 'csrf' && /403/.test(e.message));
});

test('连接被拒时提示去查 WebUI 是否开启，而不是抛原始 ECONNREFUSED', async () => {
  const err = new Error('fetch failed');
  err.cause = { code: 'ECONNREFUSED' };
  const f = fakeFetch({ '/app/version': { throw: err } });
  const c = Q.createClient({ url: '127.0.0.1:8080', fetch: f });
  await assert.rejects(
    () => c.version(),
    (e) => e.kind === 'network' && /WebUI 没启用|没开/.test(e.message)
  );
});

test('推送磁力：多条用换行拼进 urls 字段', async () => {
  const f = fakeFetch({ '/torrents/add': { status: 200, body: 'Ok.' } });
  const c = Q.createClient({ url: '127.0.0.1:8080', fetch: f });
  const r = await c.addMagnets(['magnet:?xt=urn:btih:aaa', 'magnet:?xt=urn:btih:bbb']);
  assert.strictEqual(r.count, 2);

  const form = f.calls[0].init.body;
  assert.strictEqual(form.get('urls'), 'magnet:?xt=urn:btih:aaa\nmagnet:?xt=urn:btih:bbb');
  assert.strictEqual(f.calls[0].init.method, 'POST');
});

test('保存路径/分类只在填了的时候才发出去', async () => {
  const f = fakeFetch({ '/torrents/add': { status: 200, body: 'Ok.' } });
  const c = Q.createClient({ url: '127.0.0.1:8080', fetch: f });

  await c.addMagnets(['magnet:?xt=urn:btih:aaa']);
  assert.strictEqual(f.calls[0].init.body.get('savepath'), null);
  assert.strictEqual(f.calls[0].init.body.get('category'), null);

  await c.addMagnets(['magnet:?xt=urn:btih:aaa'], { savepath: 'D:/dl', category: '剧集' });
  assert.strictEqual(f.calls[1].init.body.get('savepath'), 'D:/dl');
  assert.strictEqual(f.calls[1].init.body.get('category'), '剧集');
});

test('空列表直接报错，不发无意义的请求', async () => {
  const f = fakeFetch({});
  const c = Q.createClient({ url: '127.0.0.1:8080', fetch: f });
  await assert.rejects(() => c.addMagnets([]), /没有可推送的磁力/);
  assert.strictEqual(f.calls.length, 0);
});

test('qBittorrent 返回非 Ok. 时当作失败并把原文带出来', async () => {
  const f = fakeFetch({ '/torrents/add': { status: 200, body: 'Fails.' } });
  const c = Q.createClient({ url: '127.0.0.1:8080', fetch: f });
  await assert.rejects(() => c.addMagnets(['magnet:?xt=urn:btih:aaa']), /Fails\./);
});

test('连接测试返回版本和认证方式', async () => {
  const f = fakeFetch({
    '/auth/login': { status: 200, body: 'Ok.', cookies: ['SID=zz'] },
    '/app/version': { status: 200, body: 'v5.0.4' },
  });
  const c = Q.createClient({ url: '127.0.0.1:8080', username: 'admin', password: 'pw', fetch: f });
  const r = await c.test();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.version, 'v5.0.4');
  assert.strictEqual(r.url, 'http://127.0.0.1:8080');
  assert.match(r.auth, /已登录 admin/);
});
