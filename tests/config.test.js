'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../cli/config.js');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mf-cfg-')), 'qbit.config.json');
}

function withoutEnv(fn) {
  const keys = ['QB_URL', 'QB_USER', 'QB_PASS', 'QB_SAVEPATH', 'QB_CATEGORY'];
  const saved = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of keys) if (saved[k] !== undefined) process.env[k] = saved[k];
  }
}

test('文件不存在时返回默认值，不抛错', () => {
  withoutEnv(() => {
    const cfg = C.load(path.join(os.tmpdir(), 'definitely-missing-' + Date.now() + '.json'));
    assert.strictEqual(cfg.url, 'http://127.0.0.1:8080');
    assert.strictEqual(cfg.username, '');
  });
});

test('配置文件内容损坏时退回默认值，而不是让整个服务起不来', () => {
  withoutEnv(() => {
    const f = tmpFile();
    fs.writeFileSync(f, '{ 这不是合法 JSON');
    const cfg = C.load(f);
    assert.strictEqual(cfg.url, 'http://127.0.0.1:8080');
  });
});

test('环境变量优先于配置文件', () => {
  const f = tmpFile();
  C.save({ url: 'http://from-file:8080', username: 'fileuser' }, f);
  process.env.QB_URL = 'http://from-env:9090';
  try {
    const cfg = C.load(f);
    assert.strictEqual(cfg.url, 'http://from-env:9090');
    assert.strictEqual(cfg.username, 'fileuser'); // 没被环境变量覆盖的照旧
  } finally {
    delete process.env.QB_URL;
  }
});

test('保存时密码留空表示不改 —— 界面回填本来就拿不到密码', () => {
  withoutEnv(() => {
    const f = tmpFile();
    C.save({ url: 'http://a:1', username: 'u', password: 'secret' }, f);

    // 只改地址，密码字段留空
    const after = C.save({ url: 'http://b:2', username: 'u', password: '' }, f);
    assert.strictEqual(after.url, 'http://b:2');
    assert.strictEqual(after.password, 'secret'); // 原密码保住了
  });
});

test('显式传 null 才清空密码', () => {
  withoutEnv(() => {
    const f = tmpFile();
    C.save({ password: 'secret' }, f);
    const after = C.save({ password: null }, f);
    assert.strictEqual(after.password, '');
  });
});

test('给浏览器的配置里不含明文密码', () => {
  withoutEnv(() => {
    const f = tmpFile();
    const saved = C.save({ url: 'http://a:1', username: 'u', password: 'secret' }, f);
    const client = C.forClient(saved);
    assert.strictEqual(client.hasPassword, true);
    assert.strictEqual(client.password, undefined);
    assert.ok(!JSON.stringify(client).includes('secret'));
  });
});
