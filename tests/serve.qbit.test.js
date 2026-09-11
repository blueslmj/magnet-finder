'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../cli/serve.js');

/** 在随机端口上起服务跑一次请求，跑完关掉 */
async function withServer(fn) {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('GET /api/qb/config 返回配置且不含明文密码', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/qb/config');
    assert.strictEqual(res.status, 200);
    const j = await res.json();
    assert.strictEqual(j.ok, true);
    assert.ok(typeof j.config.url === 'string');
    assert.strictEqual(j.config.password, undefined);
    assert.strictEqual(typeof j.config.hasPassword, 'boolean');
  });
});

test('推送时没有合法磁力返回 400，而不是连上去才失败', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/qb/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnets: ['不是磁力', 'http://example.com'] }),
    });
    assert.strictEqual(res.status, 400);
    const j = await res.json();
    assert.strictEqual(j.ok, false);
    assert.match(j.message, /没有可推送的磁力/);
  });
});

test('qBittorrent 连不上时返回 502 并带上可操作的原因', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/qb/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 用一个没人占的高位端口。注意别用 9 —— undici 把它当禁用端口，
      // 会在发起连接之前就拒掉，走的是另一条错误路径
      body: JSON.stringify({ url: 'http://127.0.0.1:45999', username: '', password: '' }),
    });
    assert.strictEqual(res.status, 502);
    const j = await res.json();
    assert.strictEqual(j.ok, false);
    assert.strictEqual(j.kind, 'network');
    assert.match(j.message, /连不上|超时/);
  });
});

test('不存在的 qb 子接口返回 404 而不是 500', async () => {
  await withServer(async (base) => {
    // 必须带 application/json —— 跨站防护会挡掉其它 Content-Type 的写请求
    const res = await fetch(base + '/api/qb/nonexistent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(res.status, 404);
  });
});

test('请求体不是合法 JSON 时报清楚的错', async () => {
  await withServer(async (base) => {
    const res = await fetch(base + '/api/qb/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ 坏掉的',
    });
    assert.ok(res.status >= 400);
    const j = await res.json();
    assert.match(j.message, /合法 JSON/);
  });
});
