'use strict';

const test = require('node:test');
const assert = require('node:assert');
const P = require('../cli/parse.js');

// 经典 rarbg / rargb 镜像布局：服务端渲染，列表页没有磁力，详情页在 /torrent/<id>
const CLASSIC_URL = 'https://rargb.to/search/?search=pawn+stars';
const CLASSIC_HTML = `
<table class="lista2t">
<tr class="lista2">
  <td class="lista"><a href="/torrents.php?category=41"><img src="/images/cat41.gif" alt=""></a></td>
  <td class="lista">
    <a href="/torrent/hy1cbpk" title="Pawn.Stars.S24.1080p.WEB.h264-EDITH"><img src="/covers/a.jpg"></a>
    <a href="/torrent/hy1cbpk">Pawn.Stars.S24.1080p.WEB.h264-EDITH</a>
  </td>
  <td class="lista"><a href="/torrents.php?category=41">TV/HD</a></td>
  <td class="lista">2026-07-17 04:17:41</td>
  <td class="lista">15.9 GB</td>
  <td class="lista"><font color="#ff0000">1</font></td>
  <td class="lista">21</td>
  <td class="lista"><a href="/torrents.php?author=FileLeaker">FileLeaker</a></td>
</tr>
<tr class="lista2">
  <td class="lista"><a href="/torrents.php?category=44"><img src="/images/cat44.gif" alt=""></a></td>
  <td class="lista"><a href="/torrent/9qk2m1z">Pawn Stars S22E01 1080p HEVC x265-MeGusta</a></td>
  <td class="lista"><a href="/torrents.php?category=44">TV/HEVC/x265</a></td>
  <td class="lista">2024-07-14 19:26:11</td>
  <td class="lista">458 MB</td>
  <td class="lista">9</td>
  <td class="lista">6</td>
  <td class="lista"><a href="/torrents.php?author=philo138">philo138</a></td>
</tr>
</table>
<div id="pager_links">Pages: 1
  <a href="/search/?search=pawn+stars&amp;page=2">2</a>
  <a href="/search/?search=pawn+stars&amp;page=3">3</a>
  <a href="/search/?search=pawn+stars&amp;page=2">&gt;&gt;</a>
  <a href="/search/?search=pawn+stars&amp;page=71">71</a>
</div>`;

// therarbg 类布局：详情页 /post/detail/...，行内直接带磁力
const MODERN_URL = 'https://therarbg.com/get-posts/keywords:pawn+stars/?page=3';
const MODERN_HTML = `
<tr class="list-entry">
  <td><a href="/get-posts/category:TV/">TV</a></td>
  <td><a href="/post/detail/1234567/pawn-stars-s24-1080p-web/">Pawn Stars S24 1080p WEB</a></td>
  <td>458 MB</td>
  <td><a href="magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567&amp;dn=Pawn+Stars+S24">磁力</a></td>
</tr>
<div class="pagination">
  <a href="?page=1">1</a><a href="?page=2">2</a><a href="?page=25">25</a>
</div>`;

const DETAIL_HTML = `
<div class="download">
  <a href="magnet:?xt=urn:btih:1234567890abcdef1234567890abcdef12345678&amp;dn=Pawn.Stars.S24&amp;tr=udp%3A%2F%2Ftracker.example%3A80">Magnet</a>
  <a href="/download.php?id=hy1cbpk&amp;f=Pawn.Stars.S24.torrent">Torrent 文件</a>
</div>`;

test('经典布局：按表格行提取帖子，标题与大小配对正确', () => {
  const posts = P.extractPosts(CLASSIC_HTML, CLASSIC_URL);
  assert.strictEqual(posts.length, 2);
  assert.strictEqual(posts[0].url, 'https://rargb.to/torrent/hy1cbpk');
  assert.strictEqual(posts[0].title, 'Pawn.Stars.S24.1080p.WEB.h264-EDITH');
  assert.strictEqual(posts[0].size, '15.9 GB');
  assert.strictEqual(posts[0].magnet, ''); // 列表页无磁力，需要进详情页
  assert.strictEqual(posts[1].url, 'https://rargb.to/torrent/9qk2m1z');
  assert.strictEqual(posts[1].size, '458 MB');
});

test('分类/上传者等 torrents.php 链接不会被当成帖子', () => {
  const posts = P.extractPosts(CLASSIC_HTML, CLASSIC_URL);
  assert.ok(posts.every((p) => !p.url.includes('torrents.php')));
});

test('分页探测：拿到最大页码和可复用的页码模板', () => {
  const { maxPage, template } = P.findPagination(CLASSIC_HTML, CLASSIC_URL, CLASSIC_URL);
  assert.strictEqual(maxPage, 71);
  assert.strictEqual(template, 'https://rargb.to/search/?search=pawn+stars&page={n}');
  assert.strictEqual(
    P.buildPageUrl(CLASSIC_URL, 5, template),
    'https://rargb.to/search/?search=pawn+stars&page=5'
  );
});

test('当前页 URL 自带 page 参数时，无分页链接也能拼出目标页', () => {
  const url = 'https://rargb.to/search/?search=x&page=4';
  assert.strictEqual(P.currentPageNo(url), 4);
  assert.strictEqual(P.buildPageUrl(url, 9, ''), 'https://rargb.to/search/?search=x&page=9');
});

test('当前页 URL 没有 page 参数时，回退为追加 page 参数', () => {
  assert.strictEqual(
    P.buildPageUrl('https://rargb.to/search/?search=x', 2, ''),
    'https://rargb.to/search/?search=x&page=2'
  );
});

test('therarbg 布局：详情页链接 + 行内磁力都能取到', () => {
  const posts = P.extractPosts(MODERN_HTML, MODERN_URL);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].url, 'https://therarbg.com/post/detail/1234567/pawn-stars-s24-1080p-web/');
  assert.strictEqual(posts[0].title, 'Pawn Stars S24 1080p WEB');
  assert.strictEqual(P.infoHash(posts[0].magnet), '0123456789abcdef0123456789abcdef01234567');
  assert.ok(posts[0].magnet.includes('&dn=Pawn+Stars+S24')); // &amp; 已解码
});

test('详情页：磁力和 .torrent 下载地址都能取到', () => {
  const magnets = P.extractMagnets(DETAIL_HTML);
  assert.strictEqual(magnets.length, 1);
  assert.strictEqual(P.infoHash(magnets[0]), '1234567890abcdef1234567890abcdef12345678');
  assert.ok(magnets[0].includes('&tr=udp%3A%2F%2Ftracker.example%3A80'));

  const files = P.extractTorrentFileUrls(DETAIL_HTML, 'https://rargb.to/torrent/hy1cbpk');
  assert.deepStrictEqual(files, [
    'https://rargb.to/download.php?id=hy1cbpk&f=Pawn.Stars.S24.torrent',
  ]);
});

test('磁力按 infohash 去重', () => {
  const html = `<a href="magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&dn=a">a</a>
                <a href="magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=b">b</a>`;
  assert.strictEqual(P.extractMagnets(html).length, 1);
});

test('没有表格结构时退化为按详情链接去重', () => {
  const html = `<div>
    <a href="/torrent/aaa">One</a><a href="/torrent/aaa"><img></a>
    <a href="/torrent/bbb">Two</a>
    <a href="/torrents.php?category=1">TV</a>
  </div>`;
  const posts = P.extractPosts(html, 'https://rargb.to/search/?search=x');
  assert.deepStrictEqual(posts.map((p) => p.title), ['One', 'Two']);
});

test('自定义详情页正则可以适配未知镜像', () => {
  const html = '<div><a href="/detail.php?tid=42">Some Post</a></div>';
  const base = 'https://example.org/list.php?q=x';
  assert.strictEqual(P.extractPosts(html, base).length, 0);
  const posts = P.extractPosts(html, base, { detailPattern: '^/detail\\.php\\?tid=' });
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].title, 'Some Post');
});

test('分页链接路径与当前页不同时也能用（/search/ 页分页指向 torrents.php）', () => {
  const html = `<div><a href="/torrent/aaa">One</a>
    <a href="/torrents.php?search=x&amp;page=2">2</a>
    <a href="/torrents.php?search=x&amp;page=12">12</a></div>`;
  const { maxPage, template } = P.findPagination(
    html,
    'https://rargb.to/search/?search=x',
    'https://rargb.to/search/?search=x'
  );
  assert.strictEqual(maxPage, 12);
  assert.strictEqual(template, 'https://rargb.to/torrents.php?search=x&page={n}');
});

test('同路径分页链接优先于异路径', () => {
  const html = `<div>
    <a href="/torrents.php?search=x&amp;page=99">99</a>
    <a href="/search/?search=x&amp;page=7">7</a></div>`;
  const { maxPage, template } = P.findPagination(
    html,
    'https://rargb.to/search/?search=x',
    'https://rargb.to/search/?search=x'
  );
  assert.strictEqual(maxPage, 7);
  assert.strictEqual(template, 'https://rargb.to/search/?search=x&page={n}');
});

test('磁力标题可从 dn 参数还原', () => {
  assert.strictEqual(
    P.titleFromMagnet('magnet:?xt=urn:btih:' + 'a'.repeat(40) + '&dn=Pawn+Stars+S24E01'),
    'Pawn Stars S24E01'
  );
});

// rargb.to 的真实形式：页码在路径里 —— https://rargb.to/search/1/?search=Pawn%20Stars
const PATH_URL = 'https://rargb.to/search/1/?search=Pawn%20Stars';
const PATH_PAGER =
  '<div id="pager_links">Pages: 1 ' +
  '<a href="/search/2/?search=Pawn%20Stars">2</a> ' +
  '<a href="/search/71/?search=Pawn%20Stars">71</a></div>';

test('页码在路径里的分页（rargb.to /search/N/）能识别', () => {
  assert.strictEqual(P.currentPageNo(PATH_URL), 1);
  const { maxPage, template } = P.findPagination(PATH_PAGER, PATH_URL, PATH_URL);
  assert.strictEqual(maxPage, 71);
  assert.strictEqual(template, 'https://rargb.to/search/{n}/?search=Pawn%20Stars');
  assert.strictEqual(
    P.buildPageUrl(PATH_URL, 5, template),
    'https://rargb.to/search/5/?search=Pawn%20Stars'
  );
});

test('翻页优先用站点自己的分页链接，而不是拼 URL', () => {
  assert.strictEqual(
    P.findPageUrl(PATH_PAGER, PATH_URL, PATH_URL, 2),
    'https://rargb.to/search/2/?search=Pawn%20Stars'
  );
  assert.strictEqual(P.findPageUrl(PATH_PAGER, PATH_URL, PATH_URL, 9), ''); // 该页没有这个链接
});

test('帖子详情链接里的数字不会被当成页码', () => {
  const html = '<a href="/torrents/12345">Some Post</a><a href="/torrent/abc">B</a>';
  assert.strictEqual(P.findPagination(html, PATH_URL, PATH_URL).maxPage, 1);
});

// 下面两个用例来自 rargb.to 真实页面暴露的坑

test('结果表里的推荐海报条整行丢掉，不会串成「A 的标题 + B 的链接」', () => {
  const html = [
    '<tr><td class="lista">',
    '<a title="Enemy (2013)" href="/torrent/enemy-2013-6713723.html"><img src="/a.jpg"></a>',
    '</td><td class="lista">',
    '<a title="Gail Daughtry (2026)" href="/torrent/gail-daughtry-6713521.html"><img src="/b.jpg"></a>',
    '</td></tr>',
    '<tr class="lista2"><td class="lista">',
    '<a href="/torrent/pawn-stars-s24-6685358.html">Pawn.Stars.S24.1080p.WEB.h264-EDITH</a>',
    '</td><td class="lista">15.9 GB</td></tr>',
  ].join('');
  const posts = P.extractPosts(html, 'https://rargb.to/search/1/?search=Pawn%20Stars');
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].title, 'Pawn.Stars.S24.1080p.WEB.h264-EDITH');
  assert.strictEqual(posts[0].size, '15.9 GB');
});

test('表头排序链接（仍是第 1 页）不会把总页数压成 1', () => {
  const html = [
    '<a href="/search/1/?search=Pawn%20Stars&amp;order=data&amp;by=ASC">Added</a>',
    '<a href="/search/2/?search=Pawn%20Stars">2</a>',
    '<a href="/search/71/?search=Pawn%20Stars">71</a>',
  ].join('');
  const { maxPage, template } = P.findPagination(html, PATH_URL, PATH_URL);
  assert.strictEqual(maxPage, 71);
  assert.strictEqual(template, 'https://rargb.to/search/{n}/?search=Pawn%20Stars');
});

test('反爬校验页能被识别出来（用于区分「被拦」和「JS 渲染」）', () => {
  assert.ok(P.looksBlocked('<title>Just a moment...</title><div id="cf-wrapper">'));
  assert.ok(P.looksBlocked('<h1>Attention Required! | Cloudflare</h1>'));
  assert.strictEqual(P.looksBlocked(CLASSIC_HTML), false);
});

// knaben 的 TPB 代理：https://unblocked.knaben.info/thepiratebay/s/?q=..&page=0&orderby=99
const TPB_URL = 'https://unblocked.knaben.info/thepiratebay/s/?q=Pawn.Stars&video=on&page=0&orderby=99';
const TPB_PAGER = [
  '<a href="/thepiratebay/s/?q=Pawn.Stars&amp;video=on&amp;page=1&amp;orderby=99">2</a>',
  '<a href="/thepiratebay/s/?q=Pawn.Stars&amp;video=on&amp;page=2&amp;orderby=99">3</a>',
  '<a href="/thepiratebay/s/?q=Pawn.Stars&amp;video=on&amp;page=0&amp;orderby=7">Size</a>',
  '<a href="/browse/2001000/1">Movies</a>',
].join('');

test('TPB 代理：页码从 0 开始，排序和分类链接不会被当成分页', () => {
  const r = P.findPagination(TPB_PAGER, TPB_URL, TPB_URL);
  assert.strictEqual(r.pageBase, 0); // ?page=0 就是第一页
  assert.strictEqual(r.current, 0);
  assert.strictEqual(r.maxPage, 2); // 站点编号 0/1/2 共三页
  assert.ok(r.template.includes('page={n}'), r.template);
  assert.strictEqual(
    P.findPageUrl(TPB_PAGER, TPB_URL, TPB_URL, 1),
    'https://unblocked.knaben.info/thepiratebay/s/?q=Pawn.Stars&video=on&page=1&orderby=99'
  );
});

test('详情链接文字是来源站名时，标题取磁力自带的名字（knaben 结果行）', () => {
  const row = [
    '<tr data-id="abc">',
    '<td><a title="Pawn.Stars.S18E12.WEB.h264-BAE[TGx]" href="magnet:?xt=urn:btih:' +
      '6'.repeat(40) +
      '&amp;dn=Pawn.Stars.S18E12.WEB.h264-BAE%5BTGx%5D">Pawn.Stars.S18E12.WEB.h264-BAE[TGx]</a></td>',
    '<td>567.7 MB</td>',
    '<td><a href="https://knaben.xyz/thepiratebay/description.php?id=43339699">The Pirate Bay</a></td>',
    '</tr>',
  ].join('');
  const posts = P.extractPosts(row, 'https://knaben.org/search/pawn.stars/0/1/seeders');
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].title, 'Pawn.Stars.S18E12.WEB.h264-BAE[TGx]');
  assert.strictEqual(posts[0].size, '567.7 MB');
  assert.ok(posts[0].url.includes('description.php'));
});

test('knaben 的 go-away 挑战页能被识别成「被拦」', () => {
  assert.ok(P.looksBlocked('<title>One moment...</title><p>Protected by go-away :: Request Id abc</p>'));
});

// EZTV：剧集页 /shows/<id>/<slug>/，行内既有磁力也有 .torrent
const EZTV_URL = 'https://eztvx.to/shows/1252/pawn-stars/';
const EZTV_ROW = [
  '<tr name="hover" class="forum_header_border">',
  '<td class="forum_thread_post"><a href="/shows/1252/pawn-stars/"><img src="/i.gif"></a></td>',
  '<td class="forum_thread_post"><a href="/ep/1434578/pawn-stars-s17e17-480p-x264-msd/"',
  ' class="epinfo" title="Pawn Stars S17E17 480p x264-mSD [eztv]">Pawn Stars S17E17 480p x264-mSD</a></td>',
  '<td class="forum_thread_post" align="center">',
  '<a href="magnet:?xt=urn:btih:42A39EF0A704FA3CEB569D38DFC826015533EDBE&amp;dn=Pawn.Stars.S17E17.480p.x264-mSD%5Beztv%5D"',
  ' class="magnet" title="Magnet Link"><img src="/images/magnet.gif"></a>',
  '<a href="https://zoink.ch/torrent/Pawn.Stars.S17E17.480p.x264-mSD.torrent"',
  ' class="download_1" title="Download Torrent"><img src="/images/download.png"></a>',
  '</td>',
  '<td class="forum_thread_post" align="center">188.4 MB</td>',
  '<td class="forum_thread_post" align="center">12 Apr 2020</td>',
  '</tr>',
].join('');

test('EZTV 剧集页：一行同时有磁力和 .torrent，两者都收下', () => {
  const posts = P.extractPosts(EZTV_ROW, EZTV_URL);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(
    posts[0].url,
    'https://eztvx.to/ep/1434578/pawn-stars-s17e17-480p-x264-msd/'
  );
  // 标题取自磁力的 dn 参数：比锚文字长，而且和实际文件名一致
  assert.strictEqual(posts[0].title, 'Pawn.Stars.S17E17.480p.x264-mSD[eztv]');
  assert.strictEqual(posts[0].size, '188.4 MB');
  assert.strictEqual(
    P.infoHash(posts[0].magnet),
    '42a39ef0a704fa3ceb569d38dfc826015533edbe'
  );
  assert.strictEqual(
    posts[0].torrent,
    'https://zoink.ch/torrent/Pawn.Stars.S17E17.480p.x264-mSD.torrent'
  );
});

test('.torrent 文件地址不会被当成帖子详情页', () => {
  assert.strictEqual(P.isDetailUrl('https://zoink.ch/torrent/Some.Show.S01E01.torrent'), false);
  assert.strictEqual(P.isDetailUrl('https://eztvx.to/ep/123/some-show/'), true);
});

test('EZTV 的 /page_2 分页形式能识别', () => {
  const html = '<a href="/page_1">1</a><a href="/page_2">2</a><a href="/page_9">9</a>';
  const url = 'https://eztvx.to/page_0';
  const r = P.findPagination(html, url, url);
  assert.strictEqual(r.maxPage, 9);
  assert.strictEqual(P.buildPageUrl(url, 3, r.template), 'https://eztvx.to/page_3');
});
