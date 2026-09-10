'use strict';

const test = require('node:test');
const assert = require('node:assert');
const M = require('../cli/match.js');
const F = require('../cli/format.js');
const S = require('../cli/sources.js');

test('关键词按子串匹配，分隔符无关', () => {
  const tokens = M.tokenize('pawn stars s03');
  assert.deepStrictEqual(tokens, ['pawn', 'stars', 's03']);
  assert.ok(M.matchesTokens('Pawn.Stars.S03E07.HDTV.XviD-MOMENTUM', tokens));
  assert.ok(M.matchesTokens('Pawn Stars S03E26 Wise Guys 480p x264', tokens));
  assert.ok(!M.matchesTokens('Pawn.Stars.S04E01.720p', tokens));
  assert.ok(!M.matchesTokens('Cajun.Stars.S03E01', tokens)); // 少了 pawn
});

test('放宽查询只留片名，季集号和规格词摘掉', () => {
  assert.strictEqual(M.broadQuery('pawn stars s03 1080p x264'), 'pawn stars');
  assert.strictEqual(M.broadQuery('Pawn.Stars.S03E07.HDTV'), 'pawn stars');
  // 全是规格词时保留原样，不然就没得搜了
  assert.strictEqual(M.broadQuery('s03'), 's03');
});

test('裸季号才展开逐集查询', () => {
  assert.strictEqual(M.bareSeason(M.tokenize('pawn stars s03')), 's03');
  assert.strictEqual(M.bareSeason(M.tokenize('pawn stars s03e01')), '');
  assert.deepStrictEqual(M.episodeQueries('pawn stars s03', 's03', 3), [
    'pawn stars s03e01',
    'pawn stars s03e02',
    'pawn stars s03e03',
  ]);
});

test('同一 infohash 跨站合并：种子数取最大，来源都记下', () => {
  const merged = M.mergeResults([
    { title: 'Show S03E01 720p', hash: 'AABB', seeders: 3, leechers: 1, size: 100, source: 'TPB' },
    {
      title: 'Show S03E01 720p x264-GRP',
      hash: 'aabb',
      seeders: 46,
      leechers: 29,
      size: 100,
      magnet: 'magnet:?xt=urn:btih:aabb',
      source: 'EZTV',
    },
  ]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].seeders, 46);
  assert.strictEqual(merged[0].leechers, 29);
  assert.strictEqual(merged[0].seedFrom, 'EZTV');
  assert.deepStrictEqual(merged[0].sources, ['TPB', 'EZTV']);
  assert.strictEqual(merged[0].magnet, 'magnet:?xt=urn:btih:aabb');
  assert.strictEqual(merged[0].title, 'Show S03E01 720p x264-GRP'); // 取更长的标题
});

test('没有 infohash 时按归一化标题去重', () => {
  const merged = M.mergeResults([
    { title: 'Show.S03E01.720p', seeders: 1, source: 'a' },
    { title: 'show s03e01 720p', seeders: 5, source: 'b' },
  ]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].seeders, 5);
});

test('默认按种子数从多到少排', () => {
  const list = M.sortResults(
    [
      { title: 'a', seeders: 1, leechers: 0, size: 1 },
      { title: 'b', seeders: 46, leechers: 0, size: 1 },
      { title: 'c', seeders: 0, leechers: 9, size: 1 },
    ],
    'seeds'
  );
  assert.deepStrictEqual(list.map((x) => x.title), ['b', 'a', 'c']);
});

test('IMDb id 取出现最多的那个，tt 前缀去掉', () => {
  assert.strictEqual(
    M.guessImdb([
      { imdb: 'tt1492088' },
      { imdb: 'tt1492088' },
      { imdb: 'tt0000001' },
      { imdb: '' },
      { imdb: 'nope' },
    ]),
    '1492088'
  );
  assert.strictEqual(M.guessImdb([{ imdb: '' }]), '');
});

test('裸 infohash 能拼出带 tracker 的磁力', () => {
  const mag = M.magnetFrom('AABBCCDD', 'Some Show S03E01');
  assert.ok(mag.startsWith('magnet:?xt=urn:btih:aabbccdd'));
  assert.ok(mag.includes('&dn=Some%20Show%20S03E01'));
  assert.ok(mag.includes('tracker.opentrackr.org'));
});

test('体积格式化与解析能对上', () => {
  assert.strictEqual(F.humanSize(0), '-');
  assert.strictEqual(F.humanSize(1024), '1.0 KB');
  assert.strictEqual(F.humanSize(146 * 1024 * 1024), '146 MB');
  assert.strictEqual(S.parseSize('188.4 MiB'), Math.round(188.4 * 1024 * 1024));
  assert.strictEqual(S.parseSize('15.9 GB'), Math.round(15.9 * 1024 ** 3));
  assert.strictEqual(S.parseSize('不是体积'), 0);
});

test('中文按两格宽算，表格才不会歪', () => {
  assert.strictEqual(F.dispWidth('中文'), 4);
  assert.strictEqual(F.dispWidth('abc'), 3);
  assert.strictEqual(F.clip('abcdefgh', 5), 'abcd…');
});

test('表格输出含表头和数据', () => {
  const out = F.renderTable([
    { seeders: 46, leechers: 29, size: 146 * 1024 * 1024, sources: ['therarbg', 'EZTV'], title: 'Pawn Stars S03E06' },
  ]);
  const lines = out.split('\n');
  assert.ok(lines[0].includes('种子'));
  assert.ok(lines[2].includes('Pawn Stars S03E06'));
  assert.ok(lines[2].includes('therarbg+EZTV'));
});

test('CSV 带 BOM 和全部字段；txt 可选带标题', () => {
  const list = [
    { seeders: 5, leechers: 1, size: 1024, sources: ['TPB'], title: 'X S03E01', magnet: 'magnet:?xt=urn:btih:ab', hash: 'ab' },
  ];
  const csv = F.toCsv(list);
  assert.ok(csv.charCodeAt(0) === 0xfeff);
  assert.ok(csv.includes('"种子"'));
  assert.ok(csv.includes('"magnet:?xt=urn:btih:ab"'));

  assert.strictEqual(F.toTxt(list, true).trim(), 'X S03E01\tmagnet:?xt=urn:btih:ab');
  assert.strictEqual(F.toTxt(list, false).trim(), 'magnet:?xt=urn:btih:ab');
  // 没有磁力的不导出
  assert.strictEqual(F.toTxt([{ title: 'no magnet' }], true).trim(), '');
});

test('完全匹配：查询从标题开头连续对上，不误伤中间夹关键词的剧', () => {
  const t = 'Your.Friends.and.Neighbors.S01E39.1080p.x265-ELiTE';
  // 智能匹配会命中（friends 是子串），完全匹配必须排除
  assert.ok(M.matchesTokens(t, M.tokenize("friends s01")));
  assert.strictEqual(M.matchesExact(t, M.tokenize("friends s01")), false);
});

test('完全匹配：带 the 的剧名和裸季号都能对上', () => {
  assert.ok(M.matchesExact('The.Big.Bang.Theory.S01E01.1080p', M.tokenize('big bang theory')));
  assert.ok(M.matchesExact('The.Walking.Dead.S01E02', M.tokenize('walking dead s01')));
  assert.ok(M.matchesExact('Pawn.Stars.S03E07.HDTV', M.tokenize('pawn stars')));
});

test('完全匹配：顺序错、少词、词不连贯都该排除', () => {
  assert.strictEqual(M.matchesExact('Stars.Pawn.S03E07', M.tokenize('pawn stars')), false);
  assert.strictEqual(M.matchesExact('Friends.S01', M.tokenize('friends s02')), false);
  assert.strictEqual(M.matchesExact('The.Big.Bang.Theory', M.tokenize('big theory')), false);
});

test('matchesAny 三种模式：smart 子串 / exact 开头连续 / loose 只要首词', () => {
  const title = 'Your.Friends.and.Neighbors.S01E39';
  const tokens = M.tokenize("friends s01");
  assert.ok(M.matchesAny(title, tokens, "smart"));
  assert.strictEqual(M.matchesAny(title, tokens, "exact"), false);
  assert.ok(M.matchesAny(title, tokens, "loose"));
  assert.strictEqual(M.matchesAny('Nothing.To.Do.With.Friends', M.tokenize('nothing s01'), 'loose'), true);
  assert.strictEqual(M.matchesAny('Nothing', M.tokenize("'friends"), "loose"), false);
});