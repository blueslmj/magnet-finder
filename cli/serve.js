#!/usr/bin/env node
/**
 * 本地搜索网页（独立于插件，零依赖 —— 只用 Node 内置模块）。
 *
 *   node cli/serve.js          # 默认 http://127.0.0.1:5173
 *   node cli/serve.js --port 8080
 *
 * 页面在浏览器里用，抓取在服务端做（浏览器跨域调 apibay 等会被 CORS 拦）。
 * 搜索走 Server-Sent Events 流式返回进度，一次跑 30~60 秒也不憋着。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { runSearch, normalizeOptions } = require('./engine.js');

const WEB_DIR = path.join(__dirname, 'web');

function parsePort(argv) {
  let port = 5173;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') port = parseInt(argv[i + 1], 10) || port;
  }
  return port;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(WEB_DIR, pathname));
  if (!file.startsWith(path.normalize(WEB_DIR))) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 — 没找到这个文件');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

/**
 * 搜索接口：Server-Sent Events。
 * 一次搜索要跑 30~60 秒（逐集补搜 + EZTV 翻十几页），一次性返回的话页面只能干等，
 * 所以每个源出结果就推一条 event，最后推一条 done 带完整结果。
 */
function streamSearch(req, res, url) {
  const headers = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
  res.writeHead(200, headers);
  res.write('retry: 3000\n\n');

  let opt;
  try {
    opt = normalizeOptions({
      query: url.searchParams.get('query') || '',
      sites: url.searchParams.get('sites') || undefined,
      minSeeds: url.searchParams.get('minSeeds') || 0,
      pages: url.searchParams.get('pages') || 2,
      eztvPages: url.searchParams.get('eztvPages') || 15,
      episodes: url.searchParams.get('episodes') || 30,
      expand: url.searchParams.get('expand') !== '0',
      sort: url.searchParams.get('sort') || 'seeds',
      imdb: url.searchParams.get('imdb') || '',
      match: url.searchParams.get('match') || 'smart',
    });
  } catch (e) {
    res.write('event: error\ndata: ' + JSON.stringify({ message: e.message }) + '\n\n');
    res.end();
    return;
  }

  const send = (event, payload) => {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n');
  };

  let aborted = false;
  req.on('close', () => (aborted = true));

  runSearch(opt, (ev) => {
    if (aborted) return;
    if (ev.kind === 'start' || ev.kind === 'source' || ev.kind === 'expand' || ev.kind === 'summary') {
      send(ev.kind, { message: ev.message, source: ev.source, ok: ev.ok, total: ev.total, kept: ev.kept });
    }
  })
    .then((out) => send('done', out))
    .catch((e) => send('error', { message: e && e.message ? e.message : String(e) }))
    .finally(() => res.end());
}

function createServer() {
  return http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    } catch (e) {
      res.writeHead(400);
      return res.end('bad request');
    }
    if (url.pathname === '/api/stream') return streamSearch(req, res, url);
    return serveStatic(req, res, url.pathname);
  });
}

// 只监听回环地址：这东西本质是个能替你发请求的代理，别暴露到局域网
if (require.main === module) {
  const port = parsePort(process.argv.slice(2));
  createServer().listen(port, '127.0.0.1', () => {
    process.stdout.write('磁力搜索已启动  http://127.0.0.1:' + port + '\n');
    process.stdout.write('Ctrl+C 停止\n');
  });
}

module.exports = { createServer };
