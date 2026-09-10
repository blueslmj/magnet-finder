/**
 * 输出格式化：终端表格、CSV、txt。纯函数。
 */
'use strict';

function humanSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
}

/** 终端显示宽度：中日韩字符占两格，不然表格会歪 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s == null ? '' : s)) {
    const c = ch.codePointAt(0);
    w +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
        ? 2
        : 1;
  }
  return w;
}

/** 截断到指定显示宽度；省略号本身也占一格，不然表格会被挤歪 */
function clip(s, max) {
  const str = String(s == null ? '' : s);
  if (dispWidth(str) <= max) return str;
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = dispWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

function padEnd(s, w) {
  const pad = w - dispWidth(s);
  return s + (pad > 0 ? ' '.repeat(pad) : '');
}

function padStart(s, w) {
  const pad = w - dispWidth(s);
  return (pad > 0 ? ' '.repeat(pad) : '') + s;
}

const COLS = [
  { key: 'seeders', head: '种子', align: 'right' },
  { key: 'leechers', head: '下载', align: 'right' },
  { key: 'size', head: '大小', align: 'right', map: (v) => humanSize(v) },
  { key: 'sources', head: '来源', align: 'left', map: (v) => (v || []).join('+') },
  { key: 'title', head: '标题', align: 'left' },
];

function renderTable(list, titleWidth) {
  const maxTitle = titleWidth || 74;
  const rows = list.map((it) =>
    COLS.map((c) => {
      const raw = c.map ? c.map(it[c.key]) : it[c.key];
      const s = raw == null ? '' : String(raw);
      return c.key === 'title' ? clip(s, maxTitle) : s;
    })
  );

  const widths = COLS.map((c, i) =>
    Math.max(dispWidth(c.head), ...rows.map((r) => dispWidth(r[i])), 2)
  );

  const line = (cells) =>
    cells
      .map((s, i) => (COLS[i].align === 'right' ? padStart(s, widths[i]) : padEnd(s, widths[i])))
      .join('  ')
      .replace(/\s+$/, '');

  const out = [line(COLS.map((c) => c.head)), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

function csvCell(v) {
  return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
}

function toCsv(list) {
  const head = ['种子', '下载', '大小', '字节', '来源', '发布时间', '标题', '磁力', 'infohash', '详情页'];
  const rows = list.map((it) =>
    [
      it.seeders,
      it.leechers,
      humanSize(it.size),
      it.size || '',
      (it.sources || []).join('+'),
      it.date || '',
      it.title,
      it.magnet || '',
      it.hash || '',
      it.details || '',
    ]
      .map(csvCell)
      .join(',')
  );
  // 带 BOM，Excel 打开中文才不乱码
  return '﻿' + head.map(csvCell).join(',') + '\r\n' + rows.join('\r\n') + '\r\n';
}

/** 每行「标题 + Tab + 磁力」，去掉标题就能整段粘进 qBittorrent */
function toTxt(list, withTitle) {
  return (
    list
      .filter((it) => it.magnet)
      .map((it) => (withTitle === false ? it.magnet : it.title + '\t' + it.magnet))
      .join('\r\n') + '\r\n'
  );
}

module.exports = { humanSize, dispWidth, clip, renderTable, toCsv, toTxt };
