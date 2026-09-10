'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

const { createServer } = require('../cli/serve.js');
const { runSearch, normalizeOptions, DEFAULTS, ALL_SITES, DEFAULT_SITES, SORTS } = require('../cli/engine.js');

function start() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, base: 'http://127.0.0.1:' + port });
    });
  });
}

/** 读取一个 SSE 流，把事件解析成 [{event, data}] */
function collectStream(url) {
  return new Promise((resolve, reject) => {
    const out = [];
    http
      .get(url, (res) => {
        res.setEncoding('utf8');
        let buf = '';
        let timer = 0;
        const flush = () => {
          const ev = /event: (\S+)\ndata: (.+?)\n\n/g;
          let m;
          while ((m = ev.exec(buf))) out.push({ event: m[1], data: JSON.parse(m[2]) });
          buf = '';
        };
        res.on('data', (chunk) => {
          buf += chunk;
          flush();
          // done / error 之后服务端会关闭连接
          if (out.length && /^(done|error)$/.test(out[out.length - 1].event)) {
            clearTimeout(timer);
            res.destroy();
            resolve(out);
          }
        });
        res.on('end', () => resolve(out));
        res.on('error', reject);
        timer = setTimeout(() => reject(new Error('SSE 超时')), 60000);
      })
      .on('error', reject);
  });
}

test('normalizeOptions：默认值与过滤', () => {
  const o = normalizeOptions({ query: 'pawn stars s03' });
  assert.strictEqual(o.query, 'pawn stars s03');
  assert.deepStrictEqual(o.sites, DEFAULT_SITES);
  assert.strictEqual(o.sort, 'seeds');
  assert.ok(o.expand);
});

test('normalizeOptions：异常值被钳制，未知数据源报错', () => {
  const o = normalizeOptions({ query: 'x', minSeeds: -5, pages: 999, limit: 10, sort: 'bogus' });
  assert.strictEqual(o.minSeeds, 0);
  assert.strictEqual(o.pages, 30);
  assert.strictEqual(o.limit, 20);
  assert.strictEqual(o.sort, 'seeds');
  assert.throws(() => normalizeOptions({ sites: 'nope' }), /未知数据源/);
  assert.throws(() => normalizeOptions({}), /请输入关键词/);
  assert.throws(() => normalizeOptions({ query: '   ' }), /请输入关键词/);
});

test('runSearch：空关键词直接抛错，不发起任何请求', async () => {
  await assert.rejects(runSearch({ query: '   ' }), /请输入关键词/);
  await assert.rejects(runSearch({ query: 'x', sites: 'nope' }), /未知数据源/);
});

test('静态页面：GET / 返回 HTML，且受目录限制', async () => {
  const { server, base } = await start();
  try {
    const get = (p) =>
      new Promise((resolve, reject) => {
        http.get(base + p, (res) => {
          let s = '';
          res.on('data', (d) => (s += d));
          res.on('end', () => resolve({ status: res.statusCode, body: s }));
        }).on('error', reject);
      });
    const ok = await get('/');
    assert.strictEqual(ok.status, 200);
    assert.ok(ok.body.includes('磁力搜索'));
    // 目录穿越会被拦下：%2f 先被 URL 解析器解码并归一化点段，
    // 落在 WEB_DIR 内就 404，越界就 403 —— 两种都不该读到文件
    const bad = await get('/..%2f..%2f..%2fetc%2fpasswd');
    assert.ok(bad.status === 403 || bad.status === 404);
  } finally {
    server.close();
  }
});

test('SSE：错误数据源走 error 事件，不崩服务', async () => {
  const { server, base } = await start();
  try {
    const events = await collectStream(base + '/api/stream?query=x&sites=nope');
    const last = events[events.length - 1];
    assert.strictEqual(last.event, 'error');
    assert.ok(last.data.message.includes('未知数据源'));
  } finally {
    server.close();
  }
});

test('SSE：合法搜索按 start→source→…→done 顺序，done 带结果', async () => {
  const { server, base } = await start();
  try {
    const events = await collectStream(base + '/api/stream?query=big%20buck%20bunny&sites=tpb');
    const kinds = events.map((e) => e.event);
    assert.ok(kinds[0] === 'start');
    assert.ok(kinds[kinds.length - 1] === 'done');
    const done = events[kinds.length - 1];
    assert.ok(Array.isArray(done.data.results));
    assert.ok(done.data.results.length > 0);
    assert.ok(done.data.results[0].title.includes('Big Buck Bunny') || done.data.results[0].title.includes('Big.Buck.Bunny'));
  } finally {
    server.close();
  }
});



test('模块导出是完整的（供 CLI / 服务共用）', () => {
  assert.ok(Array.isArray(ALL_SITES));
  assert.ok(Array.isArray(DEFAULT_SITES));
  assert.ok(Array.isArray(SORTS));
  assert.strictEqual(typeof runSearch, 'function');
  assert.strictEqual(typeof normalizeOptions, 'function');
  assert.strictEqual(typeof DEFAULTS, 'object');
});
