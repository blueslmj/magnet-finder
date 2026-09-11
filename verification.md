# qBittorrent 发送反馈与自动启动验证

2026-09-11

- `npm test`：96 项通过，包括新增/重复任务、暂停任务恢复、4.x 接口回退、未确认结果、部分失败、启动失败和 HTTP 接口集成验证。
- 页面脚本语法检查与 `git diff --check` 通过。
- Playwright：验证批量发送中的禁用状态，新增/已存在/失败/待确认的持久结果，排序后的行内状态，认证失败提示和重试入口；检查 1440px 与 390px 布局。
- qBittorrent 接口测试使用模拟响应及本机模拟 HTTP 服务，没有向真实下载器添加测试任务。浏览器发送接口也使用拦截响应。

启动参数显式发送 `paused=false`、`stopped=false`、`stopCondition=None`。停止的未完成任务使用 `start`，仅在接口不存在（404）时回退 `resume`。依据：[官方接口文档](https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-%28qBittorrent-5.0%29)、[官方接口实现](https://github.com/qbittorrent/qBittorrent/blob/master/src/webui/api/torrentscontroller.cpp)。

发送结果来自任务列表核对；确认窗口内未出现的任务标为待确认，不能仅凭 `Ok.` 宣称新增成功。任务仍遵守下载队列，实际传输速度取决于资源可用性与客户端网络环境。

更新后需重启 magnet-finder 服务并刷新页面；无需修改配置文件。回退时恢复本次涉及的客户端、服务端和页面文件后重启，不删除 qBittorrent 任务或下载数据。
