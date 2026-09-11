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
  assert.strictEqual(form.get('paused'), 'false');
  assert.strictEqual(form.get('stopped'), 'false');
  assert.strictEqual(form.get('stopCondition'), 'None');
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

const HASH_A = 'a'.repeat(40), HASH_B = 'b'.repeat(40);
const mag = (hash) => 'magnet:?xt=urn:btih:' + hash;
function task(hash, state = 'downloading', progress = 0) {
  return { hash, state, progress, name: 'Example ' + hash[0] };
}
function taskClient(options = {}) {
  const rows = new Map((options.existing || []).map((row) => [row.hash, { ...row }]));
  const calls = [];
  let reads = 0;
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: init.body });
    if (path.endsWith('/info')) {
      reads++;
      if (options.verifyFails && reads > 1) return new Response('down', { status: 500 });
      return new Response(JSON.stringify([...rows.values()]));
    }
    if (path.endsWith('/add')) {
      if (!options.ignoreAdd) {
        for (const link of init.body.get('urls').split('\n')) {
          const hash = Q.magnetHash(link);
          rows.set(hash, task(hash, options.addState || 'downloading'));
        }
      }
      if (options.addTimeout) throw new Error('connection lost');
      return new Response(options.addReply || 'Ok.');
    }
    if (path.endsWith('/start') && options.legacy) return new Response('', { status: 404 });
    if (/\/(start|resume)$/.test(path)) {
      if (options.startFails) return new Response('', { status: 500 });
      if (!options.ignoreStart) {
        for (const hash of new URLSearchParams(init.body).get('hashes').split('|')) {
          rows.get(hash).state = 'downloading';
        }
      }
      return new Response('');
    }
    throw new Error('unexpected ' + path);
  };
  return { client: Q.createClient({ url: 'http://localhost:8080', fetch, sleep: async () => {} }), calls };
}

test('新增和已存在分开计数；同 infohash 不重复添加', async () => {
  const { client, calls } = taskClient({ existing: [task(HASH_A)] });
  const result = await client.sendMagnets([mag(HASH_A), mag(HASH_B), mag(HASH_B) + '&dn=other']);
  assert.strictEqual(result.added, 1);
  assert.strictEqual(result.existing, 1);
  assert.strictEqual(result.count, 2);
  assert.strictEqual(calls.find((c) => c.path.endsWith('/add')).body.get('urls'), mag(HASH_B));
  assert.strictEqual(result.items[1].state, 'downloading');
});

test('已存在且停止的未完成任务自动启动，不重加、不启动无关或已完成任务', async () => {
  const { client, calls } = taskClient({ existing: [task(HASH_A, 'stoppedDL'), task(HASH_B, 'stoppedUP', 1)] });
  const result = await client.sendMagnets([mag(HASH_A), mag(HASH_B)]);
  assert.strictEqual(result.existing, 2);
  assert.ok(!calls.some((c) => c.path.endsWith('/add')));
  assert.strictEqual(new URLSearchParams(calls.find((c) => c.path.endsWith('/start')).body).get('hashes'), HASH_A);
  assert.strictEqual(result.items[0].state, 'downloading');
});

test('4.x 在 start 不存在时回退 resume，新增任务也会检查启动状态', async () => {
  const { client, calls } = taskClient({ addState: 'pausedDL', legacy: true });
  const result = await client.sendMagnets([mag(HASH_A)]);
  assert.ok(calls.some((c) => c.path.endsWith('/resume')));
  assert.strictEqual(result.items[0].state, 'downloading');
});

test('只收到 Ok. 但列表里没出现的任务标待确认，不能报新增成功', async () => {
  const { client } = taskClient({ ignoreAdd: true });
  const result = await client.sendMagnets([mag(HASH_A)]);
  assert.strictEqual(result.added, 0);
  assert.strictEqual(result.pending, 1);
});

test('混合无效磁力和有效任务逐条反馈', async () => {
  const { client } = taskClient();
  const result = await client.sendMagnets(['magnet:?xt=bad', mag(HASH_A)]);
  assert.strictEqual(result.failed, 1);
  assert.strictEqual(result.added, 1);
});

test('明确拒绝且未添加时报失败；网络中断但任务已出现时仍报告已添加', async () => {
  const rejected = taskClient({ ignoreAdd: true, addReply: 'Fails.' });
  assert.strictEqual((await rejected.client.sendMagnets([mag(HASH_A)])).failed, 1);
  const accepted = taskClient({ addTimeout: true });
  assert.strictEqual((await accepted.client.sendMagnets([mag(HASH_A)])).added, 1);
});

test('核对接口失败时不冒充新增成功', async () => {
  const { client } = taskClient({ verifyFails: true });
  const result = await client.sendMagnets([mag(HASH_A)]);
  assert.strictEqual(result.pending, 1);
  assert.match(result.items[0].message, /无法核对/);
});

test('启动失败保留已添加事实，并反馈启动错误', async () => {
  const { client, calls } = taskClient({ addState: 'stoppedDL', startFails: true });
  const result = await client.sendMagnets([mag(HASH_A)]);
  assert.strictEqual(result.added, 1);
  assert.match(result.items[0].message, /启动任务失败/);
  assert.ok(!calls.some((c) => c.path.endsWith('/resume')));
});

test('启动返回成功但仍停止时，不声称正在下载', async () => {
  const { client } = taskClient({ addState: 'stoppedDL', ignoreStart: true });
  const result = await client.sendMagnets([mag(HASH_A)]);
  assert.strictEqual(result.items[0].state, 'stoppedDL');
  assert.match(result.items[0].message, /仍处于停止/);
});

test('排队、等资源和磁盘错误保留实际状态，不强制插队', async () => {
  for (const state of ['queuedDL', 'stalledDL', 'metaDL', 'error', 'missingFiles']) {
    const { client, calls } = taskClient({ addState: state });
    const result = await client.sendMagnets([mag(HASH_A)]);
    assert.strictEqual(result.items[0].state, state);
    assert.ok(!calls.some((c) => /\/(start|resume|setForceStart)$/.test(c.path)));
    if (state === 'error' || state === 'missingFiles') assert.match(result.items[0].message, /磁盘/);
  }
});

test('明确要求暂停时保留暂停行为', async () => {
  const { client, calls } = taskClient({ addState: 'stoppedDL' });
  await client.sendMagnets([mag(HASH_A)], { paused: true });
  const form = calls.find((c) => c.path.endsWith('/add')).body;
  assert.strictEqual(form.get('paused'), 'true');
  assert.strictEqual(form.get('stopped'), 'true');
  assert.ok(!calls.some((c) => c.path.endsWith('/start')));
});

test('infohash 支持大小写、转义及 Base32；无效输入不误认', () => {
  assert.strictEqual(Q.magnetHash('magnet:?xt=urn%3Abtih%3A' + HASH_A.toUpperCase()), HASH_A);
  assert.strictEqual(Q.magnetHash(mag('A'.repeat(32))), '0'.repeat(40));
  assert.strictEqual(Q.magnetHash(mag('7'.repeat(32))), 'f'.repeat(40));
  assert.strictEqual(Q.magnetHash('magnet:?xt=urn:btih:abc'), '');
});
