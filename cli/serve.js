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
const qbit = require('./qbit.js');
const config = require('./config.js');

const WEB_DIR = path.join(__dirname, 'web');

function parsePort(argv) {
  let port = 5173;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') port = parseInt(argv[i + 1], 10) || port;
  }
  return port;
}

/**
 * 监听地址。默认只绑回环 —— 这服务能替你发请求、还能控制 qBittorrent，
 * 不该默认对外可见。--host 0.0.0.0 或 --lan 才放开到局域网。
 */
function parseHost(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host') return String(argv[i + 1] || '127.0.0.1');
    if (argv[i] === '--lan') return '0.0.0.0';
  }
  return '127.0.0.1';
}

function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

// VMware / Hyper-V / VirtualBox / WSL 的虚拟网卡也算「非内部 IPv4」，
// 会跟真实局域网地址混在一起列出来。按接口名认出来标注掉，
// 否则用户面对四五个地址根本不知道该用哪个。
const VIRTUAL_IFACE_RE =
  /vmware|vmnet|virtualbox|vboxnet|hyper-?v|vethernet|wsl|loopback|tailscale|zerotier|docker|tap-?windows|npcap/i;

/**
 * 列出本机可供局域网访问的 IPv4 地址。
 * 返回 { ip, iface, virtual }，virtual 为真表示多半是虚拟网卡、不是你要的那个。
 * 真实网卡排在前面。
 */
function lanAddresses() {
  const out = [];
  const ifaces = require('os').networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      out.push({ ip: ni.address, iface: name, virtual: VIRTUAL_IFACE_RE.test(name) });
    }
  }
  out.sort((a, b) => Number(a.virtual) - Number(b.virtual));
  return out;
}

/**
 * 跨站请求防护。绑到局域网后，你浏览器打开的任意外部网页都可能
 * 让浏览器向本服务发请求（DNS rebinding / CSRF）—— 而本服务能控制 qBittorrent。
 *
 * 两道检查，任一不过就拒：
 *   1. Origin 存在但跟请求的 Host 不一致 → 跨站，拒。浏览器的跨站请求一定带 Origin
 *   2. 写接口必须是 application/json → 这类请求会触发 CORS 预检，
 *      而我们不返回放行头，浏览器自己就把它拦了。
 *      text/plain 的 POST 属于「简单请求」不走预检，所以必须在这里挡住
 */
function crossSiteReject(req) {
  const origin = req.headers.origin;
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch (e) {
      return '请求来源(Origin)格式不对';
    }
    if (originHost !== req.headers.host) {
      return '拒绝跨站请求：Origin ' + origin + ' 与本服务地址不符';
    }
  }
  if (req.method !== 'GET') {
    const ct = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/.test(ct)) {
      return '写接口要求 Content-Type: application/json';
    }
  }
  return '';
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

/** 读 JSON 请求体，带大小上限 —— 别让一个畸形请求把内存吃光 */
function readJson(req, limit) {
  const max = limit || 256 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/** 错误分类映射到 HTTP 状态码，前端好按类型提示 */
const KIND_STATUS = { network: 502, auth: 401, banned: 429, csrf: 403, api: 400 };

function sendError(res, e) {
  const kind = (e && e.kind) || 'unknown';
  sendJson(res, KIND_STATUS[kind] || 500, {
    ok: false,
    kind: kind,
    message: (e && e.message) || String(e),
  });
}

/**
 * qBittorrent 相关接口。
 * 全部由服务端代发 —— 浏览器直接调 qBittorrent 会被 CORS 和它的 CSRF 防护双重拦下。
 */
async function handleQbit(req, res, url) {
  const action = url.pathname.slice('/api/qb/'.length);

  if (action === 'config' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, config: config.forClient() });
  }

  if (action === 'config' && req.method === 'POST') {
    const body = await readJson(req);
    const saved = config.save(body);
    return sendJson(res, 200, { ok: true, config: config.forClient(saved) });
  }

  if (action === 'test' && req.method === 'POST') {
    // 允许带上还没保存的表单值，这样「测试连接」能在保存前先验证
    const body = await readJson(req);
    const cfg = Object.assign({}, config.load(), stripEmpty(body));
    const client = qbit.createClient(cfg);
    const info = await client.test();
    return sendJson(res, 200, Object.assign({ ok: true }, info));
  }

  if (action === 'add' && req.method === 'POST') {
    const body = await readJson(req);
    const magnets = (body.magnets || []).filter((m) => typeof m === 'string' && m.startsWith('magnet:'));
    if (!magnets.length) {
      return sendJson(res, 400, { ok: false, kind: 'api', message: '没有可推送的磁力链接' });
    }
    const cfg = config.load();
    const client = qbit.createClient(cfg);
    await client.login();
    const r = await client.addMagnets(magnets, {
      savepath: body.savepath || cfg.savepath,
      category: body.category || cfg.category,
      paused: !!body.paused,
    });
    return sendJson(res, 200, { ok: true, count: r.count });
  }

  return sendJson(res, 404, { ok: false, message: '没有这个接口' });
}

/** 表单里没填的字段不要覆盖已保存的配置 */
function stripEmpty(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    if (obj[k] !== '' && obj[k] !== null && obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
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
    if (url.pathname.startsWith('/api/qb/')) {
      const reject = crossSiteReject(req);
      if (reject) return sendJson(res, 403, { ok: false, kind: 'csrf', message: reject });
      return handleQbit(req, res, url).catch((e) => sendError(res, e));
    }
    return serveStatic(req, res, url.pathname);
  });
}

if (require.main === module) {
  const port = parsePort(process.argv.slice(2));
  const host = parseHost(process.argv.slice(2));
  createServer().listen(port, host, () => {
    process.stdout.write('磁力搜索已启动  http://127.0.0.1:' + port + '\n');
    if (!isLoopback(host)) {
      for (const a of lanAddresses()) {
        process.stdout.write(
          '局域网内访问      http://' + a.ip + ':' + port +
            (a.virtual ? '   (虚拟网卡 ' + a.iface + '，多半不是这个)' : '   (' + a.iface + ')') + '\n'
        );
      }
      process.stdout.write(
        '\n注意：已开放到局域网。同网络内的任何设备都能用这个服务搜索，\n' +
          '      并往你的 qBittorrent 里添加下载任务。仅在可信网络下这么用。\n'
      );
    }
    process.stdout.write('\nCtrl+C 停止\n');
  });
}

module.exports = { createServer, parseHost, isLoopback, lanAddresses, crossSiteReject };
