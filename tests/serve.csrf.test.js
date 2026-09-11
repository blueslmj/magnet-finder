'use strict';

const test = require('node:test');
const assert = require('node:assert');
const S = require('../cli/serve.js');

async function withServer(fn) {
  const server = S.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    return await fn('http://127.0.0.1:' + port, '127.0.0.1:' + port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('--host / --lan 解析；默认只绑回环', () => {
  assert.strictEqual(S.parseHost([]), '127.0.0.1');
  assert.strictEqual(S.parseHost(['--port', '8080']), '127.0.0.1');
  assert.strictEqual(S.parseHost(['--lan']), '0.0.0.0');
  assert.strictEqual(S.parseHost(['--host', '192.168.1.10']), '192.168.1.10');
  assert.strictEqual(S.parseHost(['--host']), '127.0.0.1'); // 后面没值也别崩
});

test('isLoopback 认得几种写法', () => {
  assert.ok(S.isLoopback('127.0.0.1'));
  assert.ok(S.isLoopback('localhost'));
  assert.ok(S.isLoopback('::1'));
  assert.ok(!S.isLoopback('0.0.0.0'));
  assert.ok(!S.isLoopback('192.168.1.10'));
});

test('外部网页发来的跨站请求被拒 —— 靠 Origin 不匹配识别', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/qb/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example.com' },
      body: JSON.stringify({ magnets: ['magnet:?xt=urn:btih:' + 'a'.repeat(40)] }),
    });
    assert.strictEqual(res.status, 403);
    const j = await res.json();
    assert.strictEqual(j.kind, 'csrf');
    assert.match(j.message, /跨站/);
  });
});

test('text/plain 的 POST 被拒 —— 这类请求不走 CORS 预检，是真正的绕过口子', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/qb/add', {
      method: 'POST',
      // 恶意页面会用这个 Content-Type：浏览器视为「简单请求」，不发预检
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ magnets: ['magnet:?xt=urn:btih:' + 'a'.repeat(40)] }),
    });
    assert.strictEqual(res.status, 403);
    const j = await res.json();
    assert.match(j.message, /application\/json/);
  });
});

test('同源请求正常放行（带上匹配的 Origin 也照过）', async () => {
  await withServer(async (base, hostHeader) => {
    const res = await fetch(base + '/api/qb/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://' + hostHeader },
      body: JSON.stringify({ magnets: [] }),
    });
    // 过了 CSRF 关卡，被业务逻辑以「没有磁力」拒绝 —— 400 而不是 403
    assert.strictEqual(res.status, 400);
    const j = await res.json();
    assert.match(j.message, /没有可推送的磁力/);
  });
});

test('读接口不受 Content-Type 限制', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/qb/config');
    assert.strictEqual(res.status, 200);
  });
});

test('不透明来源（Origin: null）被拒 —— 沙箱 iframe 和 data: URL 会发这个', async () => {
  await withServer(async (base) => {
    // 浏览器对沙箱 iframe、data: URL 页面发出的请求就是字面量 null
    const res = await fetch(base + '/api/qb/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'null' },
      body: '{}',
    });
    assert.strictEqual(res.status, 403);
    const j = await res.json();
    assert.strictEqual(j.kind, 'csrf');
  });
});

test('Origin 是合法 URL 但主机不对时也拒（含端口不同）', async () => {
  await withServer(async (base, hostHeader) => {
    const otherPort = String(Number(hostHeader.split(':')[1]) + 1);
    const res = await fetch(base + '/api/qb/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:' + otherPort,
      },
      body: '{}',
    });
    assert.strictEqual(res.status, 403);
  });
});

test('能列出本机 IPv4 局域网地址', () => {
  const list = S.lanAddresses();
  assert.ok(Array.isArray(list));
  for (const a of list) {
    assert.match(a.ip, /^\d+\.\d+\.\d+\.\d+$/);
    assert.ok(!a.ip.startsWith('127.'));
    assert.strictEqual(typeof a.iface, 'string');
    assert.strictEqual(typeof a.virtual, 'boolean');
  }
  // 真实网卡要排在虚拟网卡前面 —— 不然用户面对一串地址不知道用哪个
  const firstVirtual = list.findIndex((x) => x.virtual);
  if (firstVirtual >= 0) assert.ok(list.slice(firstVirtual).every((x) => x.virtual));
});
