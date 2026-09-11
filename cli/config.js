/**
 * qBittorrent 连接配置的读写。
 *
 * 存在服务端的 qbit.config.json（已 gitignore），不放浏览器 localStorage ——
 * 密码没必要进浏览器存储，而且这样命令行版也能共用同一份配置。
 * 环境变量优先级最高，方便临时覆盖或在容器里跑。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'qbit.config.json');

const DEFAULTS = {
  url: 'http://127.0.0.1:8080',
  username: '',
  password: '',
  savepath: '',
  category: '',
};

function fromEnv() {
  const e = process.env;
  const out = {};
  if (e.QB_URL) out.url = e.QB_URL;
  if (e.QB_USER) out.username = e.QB_USER;
  if (e.QB_PASS) out.password = e.QB_PASS;
  if (e.QB_SAVEPATH) out.savepath = e.QB_SAVEPATH;
  if (e.QB_CATEGORY) out.category = e.QB_CATEGORY;
  return out;
}

/** 读配置。文件不存在或内容坏掉都不抛错，退回默认值 —— 这只是个便利功能，不该拖垮整个服务 */
function load(file) {
  const target = file || FILE;
  let onDisk = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!onDisk || typeof onDisk !== 'object') onDisk = {};
  } catch (e) {
    onDisk = {};
  }
  return Object.assign({}, DEFAULTS, onDisk, fromEnv());
}

/**
 * 写配置。密码留空表示「不改」——
 * 因为界面上回填时不会把已存的密码发给浏览器，留空是常态而不是「清空密码」。
 * 真要清空，传 password: null。
 */
function save(patch, file) {
  const target = file || FILE;
  const current = load(target);
  const next = Object.assign({}, DEFAULTS);

  for (const k of Object.keys(DEFAULTS)) {
    if (k === 'password') continue;
    next[k] = patch && patch[k] !== undefined ? String(patch[k]) : current[k];
  }

  if (patch && patch.password === null) next.password = '';
  else if (patch && patch.password) next.password = String(patch.password);
  else next.password = current.password;

  fs.writeFileSync(target, JSON.stringify(next, null, 2) + '\n');
  return next;
}

/** 给浏览器看的版本：密码换成一个布尔值，别把明文发过去 */
function forClient(cfg) {
  const c = cfg || load();
  return {
    url: c.url,
    username: c.username,
    savepath: c.savepath,
    category: c.category,
    hasPassword: !!c.password,
  };
}

module.exports = { load, save, forClient, DEFAULTS, FILE };
