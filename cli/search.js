#!/usr/bin/env node
/**
 * 多站点磁力搜索 CLI（独立于插件，只需要 Node）。
 *
 * 搜索流程本体在 engine.js（和网页版共用），这里只管参数解析和输出。
 *
 *   node cli/search.js "pawn stars s03"
 *   node cli/search.js "pawn stars s03" --min-seeds 1 --csv out.csv
 *   node cli/search.js --help
 */
'use strict';

const fs = require('fs');
const F = require('./format.js');
const { runSearch, normalizeOptions, ALL_SITES, DEFAULT_SITES } = require('./engine.js');

const USAGE = [
  '用法: node cli/search.js "关键词" [选项]',
  '',
  '  标题必须包含全部关键词（空格分隔，不区分大小写和 . _ - 等分隔符）。',
  '  例: "pawn stars s03" 能命中 Pawn.Stars.S03E07.720p.x264',
  '',
  '选项:',
  '  --sites a,b        数据源，默认 ' + DEFAULT_SITES.join(',') + '（可选: ' + ALL_SITES.join(',') + '，或 all）',
  '  --min-seeds N      只保留种子数 >= N 的（默认 0，全部显示）',
  '  --pages N          分页型数据源翻几页（therarbg/rargb，默认 2）',
  '  --eztv-pages N     EZTV 翻几页，每页 100 条（默认 15）',
  '  --episodes N       逐集补搜到第 N 集（默认 30）',
  '  --no-expand        关掉逐集补搜',
  '  --exact            完全匹配：查询必须从标题开头连续对上。搜 friends 不再命中',
  '                     Your.Friends.and.Neighbors 这种中间夹关键词的剧',
  '  --loose            宽松匹配：只要标题包含第一个关键词（适合只看剧名、不限季）',
  '  --send-qb [N]      把结果推送到 qBittorrent。跟数字则只推种子最多的前 N 条，',
  '                     不跟则全推。连接配置见 qbit.config.json 或网页版的设置面板',
  '  --top N            表格只显示前 N 行（默认 40，0 = 全部）',
  '  --sort X           seeds(默认) | size | date | title',
  '  --imdb ttXXXXXXX   指定 IMDb id 给 EZTV 用；不指定从其它源结果里自动推断',
  '  --csv 文件         导出 CSV（种子数、来源、磁力、详情页都在里面）',
  '  --txt 文件         导出「标题<Tab>磁力」',
  '  --magnets 文件     只导出磁力，一行一个，可整段粘进 qBittorrent',
  '  --json 文件        导出完整 JSON',
  '  -h, --help         显示本帮助',
  '',
  '说明: rargb 没有 API，需要抓 HTML 且逐个进详情页取磁力，很慢也容易 429，',
  '      默认不启用；要用就 --sites all 或 --sites rargb。',
  '      网页版: node cli/serve.js',
].join('\n');

function parseArgs(argv) {
  const opt = {
    query: '',
    sites: undefined,
    minSeeds: 0,
    pages: 2,
    eztvPages: 15,
    episodes: 30,
    expand: true,
    top: 40,
    sort: 'seeds',
    imdb: '',
    csv: '',
    txt: '',
    magnets: '',
    json: '',
    help: false,
  };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '-h' || a === '--help') opt.help = true;
    else if (a === '--sites') opt.sites = String(next() || '');
    else if (a === '--min-seeds') opt.minSeeds = int(next(), 0);
    else if (a === '--pages') opt.pages = int(next(), 2);
    else if (a === '--eztv-pages') opt.eztvPages = int(next(), 15);
    else if (a === '--episodes') opt.episodes = int(next(), 30);
    else if (a === '--no-expand') opt.expand = false;
    else if (a === '--exact') opt.match = 'exact';
    else if (a === '--loose') opt.match = 'loose';
    else if (a === '--send-qb') {
      // 后面跟数字就是「只推前 N 条」，不跟就是全推
      const n = parseInt(argv[i + 1], 10);
      if (Number.isFinite(n) && n > 0) { opt.sendQb = n; i++; }
      else opt.sendQb = true;
    }
    else if (a === '--top') opt.top = int(next(), 40);
    else if (a === '--sort') opt.sort = String(next() || 'seeds');
    else if (a === '--imdb') opt.imdb = String(next() || '');
    else if (a === '--csv') opt.csv = String(next() || '');
    else if (a === '--txt') opt.txt = String(next() || '');
    else if (a === '--magnets') opt.magnets = String(next() || '');
    else if (a === '--json') opt.json = String(next() || '');
    else if (a.startsWith('-')) throw new Error('未知选项: ' + a);
    else words.push(a);
  }
  opt.query = words.join(' ').trim();
  return opt;
}

function int(v, dft) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dft;
}

// 进度走 stderr，表格走 stdout，重定向时只拿到结果
const info = (msg) => process.stderr.write(msg + '\n');

async function main() {
  let raw;
  try {
    raw = parseArgs(process.argv.slice(2));
  } catch (e) {
    info(e.message + '\n' + USAGE);
    process.exit(2);
  }
  if (raw.help || !raw.query) {
    process.stdout.write(USAGE + '\n');
    process.exit(raw.query ? 0 : 1);
  }

  const opt = normalizeOptions(raw);
  info('搜索: ' + opt.query);

  const out = await runSearch(opt, (ev) => {
    if (ev.kind === 'source' || ev.kind === 'expand') info('  ' + ev.message);
    if (ev.kind === 'summary' && ev.message) info(ev.message);
  });

  const dead = out.results.filter((it) => it.seeders === 0).length;
  info(
    '删除结果: ' +
      out.results.length +
      ' 条' +
      (opt.minSeeds > 0 ? '（已过滤到 >= ' + opt.minSeeds + ' 种子）' : '') +
      (dead ? '，其中 ' + dead + ' 条 0 种子（下不动）' : '')
  );

  if (!out.results.length) {
    info('没有命中。试试更短的关键词，或 --sites all，或 --no-expand');
    process.exit(0);
  }

  const shown = raw.top > 0 ? out.results.slice(0, raw.top) : out.results;
  process.stdout.write(F.renderTable(shown) + '\n');
  if (shown.length < out.results.length) {
    info('（只显示前 ' + shown.length + ' 条，共 ' + out.results.length + ' 条；--top 0 显示全部）');
  }

  write(raw.csv, () => F.toCsv(out.results), 'CSV');
  write(raw.txt, () => F.toTxt(out.results, true), 'txt');
  write(raw.magnets, () => F.toTxt(out.results, false), '磁力');
  write(raw.json, () => JSON.stringify(out.results, null, 2) + '\n', 'JSON');

  if (raw.sendQb) await sendToQbittorrent(out.results, raw.sendQb);
}

/**
 * 把结果推给 qBittorrent。
 * --send-qb 不带值就推全部；带数字就只推种子数最多的前 N 条 ——
 * 一次搜索动辄几百条，全推进去多半不是你想要的。
 */
async function sendToQbittorrent(results, howMany) {
  const qbit = require('./qbit.js');
  const config = require('./config.js');

  const limit = howMany === true ? results.length : howMany;
  const picked = results.filter((r) => r.magnet).slice(0, limit);
  if (!picked.length) return info('没有可推送的磁力');

  const cfg = config.load();
  info('推送 ' + picked.length + ' 条到 qBittorrent (' + cfg.url + ') …');
  try {
    const client = qbit.createClient(cfg);
    await client.login();
    const r = await client.sendMagnets(picked.map((x) => x.magnet), {
      savepath: cfg.savepath,
      category: cfg.category,
    });
    info('新增 ' + r.added + ' 条，已存在 ' + r.existing + ' 条，失败 ' + r.failed + ' 条，待确认 ' + r.pending + ' 条');
    for (const item of r.items) {
      if (item.message) info((item.name || item.hash || '无效磁力') + ': ' + item.message);
    }
    if (r.failed || r.pending || r.items.some((item) => item.message)) process.exitCode = 1;
  } catch (e) {
    info('推送失败: ' + (e.message || e));
    info('用网页版的 qBittorrent 设置面板可以测试连接，或直接编辑 qbit.config.json');
    process.exitCode = 1;
  }
}

function write(file, build, label) {
  if (!file) return;
  try {
    fs.writeFileSync(file, build());
    info('已写入 ' + label + ': ' + file);
  } catch (e) {
    info('写 ' + label + ' 失败: ' + (e.message || e));
  }
}

main().catch((e) => {
  info('出错: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
