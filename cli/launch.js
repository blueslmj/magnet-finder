#!/usr/bin/env node
/**
 * 双击启动器：起服务 + 自动打开浏览器。
 * Windows 上双击「启动搜索.bat」就能用，不用手动敲命令。
 *
 *   node cli/launch.js            # 默认端口 5173
 *   node cli/launch.js 8080       # 指定端口
 *   node cli/launch.js --no-open  # 只起服务，不自动开浏览器（测试用）
 */
'use strict';

const os = require('os');
const child = require('child_process');
const { createServer } = require('./serve.js');

const DEFAULT_PORT = 5173;
const NO_OPEN = process.argv.includes('--no-open');

function readPort() {
  const fromEnv = parseInt(process.env.PORT, 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const fromArg = parseInt(process.argv.filter((a) => /^\d+$/.test(a))[0], 10);
  return Number.isFinite(fromArg) && fromArg > 0 ? fromArg : DEFAULT_PORT;
}

function openBrowser(url) {
  if (NO_OPEN) return;
  try {
    const p = os.platform();
    const cmd =
      p === 'win32'
        ? 'start "" "' + url + '"'
        : p === 'darwin'
          ? 'open "' + url + '"'
          : 'xdg-open "' + url + '"';
    child.exec(cmd, () => {});
  } catch (e) {
    console.log('\n打不开浏览器？手动打开: ' + url + '\n');
  }
}

const port = readPort();
const url = 'http://127.0.0.1:' + port;
const server = createServer();

function onListenError(e) {
  if (e.code === 'EADDRINUSE') {
    console.log('端口 ' + port + ' 已被占用 —— 搜索服务可能已经在运行。');
    console.log('直接打开: ' + url);
    openBrowser(url);
    setTimeout(() => process.exit(0), 3000);
  } else {
    console.error('启动失败: ' + (e.message || e));
    process.exit(1);
  }
}

// 必须先挂 handler 再 listen，否则 EADDRINUSE 会以未捕获异常的方式崩掉整个进程
server.on('error', onListenError);
server.listen(port, '127.0.0.1', () => {
  console.log('');
  console.log('  磁力搜索');
  console.log('  ' + url);
  console.log('  关闭这个窗口就停止服务');
  console.log('');
  openBrowser(url);
});

// 进程被 SIGINT (Ctrl+C) 关闭时也给个提示
process.on('SIGINT', () => {
  console.log('\n停止服务');
  process.exit(0);
});
