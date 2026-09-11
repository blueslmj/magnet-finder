# magnet-finder

> 多站点磁力搜索：输入关键词，同时问 4 个站点的 API，按种子数排序去重。
> Multi-site torrent search with seeder counts. Web UI + CLI, zero dependencies.

**零依赖**（连 `node_modules` 都没有），只要 Node.js 18+。有网页版和命令行两种用法。

核心问题很简单：**搜出来一堆结果，但大半是 0 种子下不动的。** 这个工具把各站结果合并去重，
把种子数摆在最显眼的位置，让你一眼看出哪些还活着。

```
种子  下载     大小  来源           标题
  46    29   146 MB  therarbg+EZTV  Pawn Stars S03E06 Ready Set Pawn iNTERNAL HDTV x264 W4F
  42    46  95.4 MB  therarbg+EZTV  Pawn Stars S03E26 Wise Guys iNTERNAL 480p x264 mSD
  41    11   126 MB  therarbg+EZTV  Pawn Stars S03E13 Never Surrender iNTERNAL HDTV x264 W4F
```

## 快速开始

**Windows 用户**：双击 `启动搜索.bat`，它会起服务并自动打开浏览器。没装 Node.js 会提示你去装。

其他系统 / 手动启动：

```bash
git clone https://github.com/blueslmj/magnet-finder.git
cd magnet-finder

npm start                          # 网页版，浏览器打开 http://127.0.0.1:5173
npm run search -- "pawn stars s03" # 命令行版
```

不需要 `npm install` —— 这个项目真的没有依赖。

## 网页版

界面是本地网页，**抓取在服务端做**（浏览器直接调 apibay 等会被 CORS 拦）。搜索过程通过
Server-Sent Events 实时推进度 —— 一次搜索要跑几十秒（逐集补搜 + EZTV 翻十几页），
不用憋着干等。只监听 `127.0.0.1`，不会暴露给局域网。

- **数据源开关**在顶部一排：TPB / therarbg / knaben / EZTV（rargb 慢，默认关）
- **匹配模式**：智能（关键词出现即可）/ 完全（从标题开头连续对上）。
  搜 `friends s01` 时选「完全」，就不会再混进 `Your.Friends.and.Neighbors` 了
- **存活条**：绿=≥5 种子、黄=1-4、红=0。点某一段只看那一类
- 表格点表头换排序；点标题**直接复制磁力**；勾选后可批量复制
- 「至少 N 种子」输入框过滤死种

想换端口：`node cli/serve.js --port 8080`

## 命令行版

```bash
node cli/search.js "pawn stars s03"
node cli/search.js "friends s01" --exact --min-seeds 1
node cli/search.js "pawn stars s03" --csv out.csv
node cli/search.js "pawn stars s03" --magnets m.txt   # 只导磁力，整段粘进 qBittorrent
node cli/search.js --help
```

进度信息走 stderr、表格走 stdout，所以 `node cli/search.js "x" > list.txt` 只会拿到结果。

### 匹配模式

输入不区分大小写，`.` `_` `-` `+` 等分隔符都当空格 —— 所以**可以直接粘发布名**：
`pawn.stars.s24` 和 `pawn stars s24` 等价。

| 模式 | 规则 | 适合 |
| --- | --- | --- |
| 智能（默认） | 每个关键词在标题里出现即可 | 不确定完整片名，想广撒网 |
| `--exact` | 从标题**开头**连续对上 | 明确要找某个剧，别被别的剧干扰 |
| `--loose` | 标题含第一个关键词即可 | 只看剧名、不限定季 |

完全匹配为什么按「开头连续」判定：发布名的规范是 `剧名.SxxExx.质量.小组`，**剧名永远在开头**。
开头的 `the/a/an` 会先剥掉，所以 `big bang theory` 照样命中 `The.Big.Bang.Theory.S01E01`。

实测 `friends s01`：智能模式 297 条（其中 258 条是别的剧），完全模式 35 条、**0 条误命中**。

### 数据源

| 源 | 接口 | 说明 |
| --- | --- | --- |
| `tpb` | apibay.org | The Pirate Bay 官方接口，一次返回全部命中 |
| `therarbg` | therarbg.com `?format=json` | RARBG 数据库的延续，带分页 |
| `knaben` | api.knaben.org/v1 | 聚合几十个站点的索引，返回里带 `tracker` 说明来自哪个站 |
| `eztv` | eztvx.to/api | 只能按 IMDb id 查，id 会从其它源的结果里自动推断 |
| `rargb` | 抓 HTML | 没有 API，列表页也没磁力，要逐个进详情页，**默认不启用**（`--sites all` 才开） |

前四个都走站点自己的 JSON API —— 这些接口**不挂 Cloudflare**（而 eztvx.to 的网页是挂的），
而且直接返回 seeders，比抓 HTML 又快又准。

## 为什么不是又一个种子搜索脚本

这些站点各有各的坑。代码里每一处绕路都对应一个实测踩出来的问题，且都有回归测试：

**1. 站点的关键词搜索按整词匹配。** 标题里是 `S03E07`，所以搜 `s03` 一条都搜不到，搜 `s03e07` 就有。
工具检测到裸季号会自动展开成 `s03e01..e30` 逐集补搜（`--no-expand` 关掉）。
实测 `pawn stars s03`：TPB 直接搜 **0 条**，逐集补搜后 **193 条**。

**2. 放宽查询会撞上分页天花板。** 把查询放宽成 `pawn stars` 确实有结果，但站点按新到旧
只给前 100 条，S03 这种老剧集根本翻不到。所以三条路互补：knaben 用原查询（它的索引能匹配季号）、
TPB 用逐集补搜、EZTV 用 IMDb id 直接列出全剧所有集。

**3. IMDb id 必须从未过滤的结果里推断。** 一开始只从「命中项」里找 id，结果季号一过滤就啥都不剩，
EZTV 永远拿不到 id 直接跳过。剧集的身份和季号无关。

**4. therarbg 的 `keywords:` 必须用 `%20` 编码**，用 `+` 的话多词查询直接返回 0 条。

**5. 结果按 infohash 跨站去重**，seeders 取各站最大值，`来源` 列显示 `therarbg+EZTV` 这样 ——
多站都收录通常也更容易连上。

## 输出

终端表格按种子数降序（`--sort size|date|title` 可改），末尾提示有多少条是 0 种子。

导出选项：

| 参数 | 内容 |
| --- | --- |
| `--csv` | 种子数/大小/来源/磁力/详情页全都有，带 BOM，Excel 不乱码 |
| `--txt` | 标题 + Tab + 磁力 |
| `--magnets` | 只有磁力，一行一个，可整段粘进 qBittorrent |
| `--json` | 完整字段 |

## 放到常开的机器上，局域网访问

装在一台 24 小时开机的机器上，平时用笔记本或手机浏览器访问它：

```bash
node cli/serve.js --lan          # 等价于 --host 0.0.0.0
node cli/serve.js --host 192.168.1.10   # 只绑指定网卡
```

Windows 上双击 **`启动搜索-局域网.bat`** 就是 `--lan` 模式。

启动时会把本机的局域网地址都列出来，并且**标注哪些是虚拟网卡**
（VMware / Hyper-V / WSL 的地址会混进来，真实网卡排在最前面）：

```
本机访问    http://127.0.0.1:5173
局域网访问  http://192.168.2.126:5173   (以太网)
局域网访问  http://192.168.192.1:5173   (虚拟网卡 VMware Network Adapter VMnet1，多半不是这个)
```

**默认只监听 `127.0.0.1`**，必须显式加 `--lan` / `--host` 才开放 —— 这服务能替你发请求、
还能控制 qBittorrent，不该默认对外可见。

### 开放到局域网时的跨站防护

一旦绑到局域网，你浏览器打开的**任意外部网页**都可能让浏览器向这个服务发请求
（DNS rebinding / CSRF）—— 而它能往你的 qBittorrent 里加任务。所以写接口有两道检查：

1. **`Origin` 与请求的 `Host` 不一致就拒。** 浏览器发跨站请求时一定带 `Origin`，
   包括沙箱 iframe 那种 `Origin: null`
2. **写接口必须是 `Content-Type: application/json`。** 这类请求会触发 CORS 预检，
   而本服务不返回放行头，浏览器自己就拦了。
   **`text/plain` 的 POST 属于「简单请求」不走预检**，所以必须在服务端挡住 ——
   这是真正会被利用的那个口子

这跟 qBittorrent 自己校验 Referer/Origin 是同一套思路。

注意这些只防"浏览器被别的网页利用"，**不防同网络里的人直接访问**。
局域网内的任何设备都能用这个服务搜索和加下载任务，所以只在可信网络下开。

## 推送到 qBittorrent

搜到了直接点「下载」推给 qBittorrent，不用再复制磁力去别的工具里粘。
上游 [qbittorrent/qBittorrent](https://github.com/qbittorrent/qBittorrent) 和
[c0re100/qBittorrent-Enhanced-Edition](https://github.com/c0re100/qBittorrent-Enhanced-Edition)
的 Web API 完全一致，两个都能用，不用区分。

**先在 qBittorrent 里开 WebUI**：选项 → Web UI → 勾选「Web 用户界面（远程控制）」，
记下地址和端口。然后在本工具页面点右上角的 **qBittorrent** 按钮，填地址和账号，
点「测试连接」确认通了再保存。

之后：

- 每行右侧的 **下载** 按钮 —— 推送这一条
- 勾选多行后点 **发送选中到 qBittorrent** —— 批量推送

发送后页面会持续显示本次结果：新增、已存在、失败、待确认，以及每条任务的实际状态。
结果来自发送前后的任务列表核对，不把接口返回 `Ok.` 直接当作新增成功。
任务列表暂未出现或网络中断时会明确标为待确认；再次发送会先检查已有任务。

默认自动开始下载，显式覆盖客户端的“添加后停止”和“收到元数据后停止”默认选项。
选中的已有任务如果未完成且已暂停/停止，也会尝试启动；已完成任务保持原状。
兼容 4.x 的 `resume` 和 5.x 的 `start` 接口，仍遵守 qBittorrent 的下载队列。
“排队等待”“获取元数据”“等待可用资源”不等于发送失败，也不保证马上有下载速度。
页面显示的是本次发送后的状态快照，不是持续刷新的下载监控。
- 命令行：`node cli/search.js "pawn stars s03" --send-qb 5`（只推种子最多的前 5 条）

配置存在 `qbit.config.json`（已 gitignore），也可以用环境变量覆盖：
`QB_URL` / `QB_USER` / `QB_PASS` / `QB_SAVEPATH` / `QB_CATEGORY`。

### 两个会卡住人的坑

**1. 浏览器不能直接调 qBittorrent。** 它不发 CORS 头，而且有 CSRF 防护 ——
会校验请求的 `Referer`/`Origin` 是不是跟自己同源，从网页直接发必被 403。
所以推送跟搜索一样由本地 Node 服务代发，服务端能把 `Referer` 设成 qBittorrent 自己的地址。

**2. 「对本机跳过认证」时用户名要留空。** qBittorrent 有个
「对 localhost 上的客户端跳过身份验证」选项，开了之后再去调登录接口反而多余。
本工具的规则是：用户名填了就登录，留空就直接调 API。

连接失败时会说明具体原因（连不上 / 密码错 / IP 被封 / 被 CSRF 拒），而不是笼统一句失败。
连续输错密码会被 qBittorrent 临时封 IP，这种情况等几分钟就行。

## 关于种子数

页面上的「种子」是**正在做种的人数**（seeders），「下载」是**正在下载的人数**（leechers）。
两者都是实时快照，不是累计下载次数。

这些数字来自各站点自己抓的 tracker 统计，所以**可能过时、也可能不全**（DHT 和 PEX 里的节点不算在内）。
0 种子不等于绝对下不动，但确实是很强的信号。

## 项目结构

```
cli/
  search.js    命令行入口
  serve.js     网页版 HTTP 服务（SSE 推进度）
  launch.js    双击启动器（起服务 + 开浏览器）
  engine.js    搜索流程本体，命令行和网页共用
  sources.js   各站点适配器
  match.js     关键词匹配、跨站去重合并（纯函数）
  format.js    终端表格 / CSV / txt 输出（纯函数）
  parse.js     HTML 解析层（rargb 源用；这是个通用的列表页解析器，搜索工具只用到其中一部分）
  web/         网页界面
tests/         48 个测试，全部不联网
```

## 测试

```bash
npm test
```

48 个测试，覆盖关键词匹配、放宽查询、逐集展开、跨站合并、体积格式化、表格对齐、HTML 解析层。
全部不联网，改规则前先跑一遍 —— 这些测试是拿真实页面的坑固化下来的。

## 贡献

站点结构变化很快。如果某个站点搜不出结果，欢迎提 issue 并附上：

1. 你搜的关键词和用的数据源
2. 终端输出或网页版的进度日志
3. 如果是 rargb（HTML 抓取），再附上那个页面 F12 控制台跑这行的输出：

```js
(()=>{const r=document.querySelectorAll('tr'),m=document.querySelectorAll('a[href^="magnet:"]');console.log('行数',r.length,'磁力',m.length);console.log(r[1]?.outerHTML.slice(0,800))})()
```

## 免责声明

本项目只做一件事：**聚合这些站点自己公开的搜索 API，把结果整理后展示出来**。
它不托管、不分发、不索引任何文件内容，也不参与任何数据传输 —— 拿到磁力链接之后的事情，
跟本项目无关。

请自行确认你下载的内容在你所在的司法管辖区是合法的。BitTorrent 本身是中性技术，
有大量正当用途（Linux 发行版、公共领域影音、开放数据集分发等）。
**使用者自行承担全部责任。**

## 致谢

- [Linux.do](https://linux.do) 社区 —— 开发者交流与灵感来源

## 许可证

[MIT](LICENSE)
