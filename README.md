# dsh-window-focus

点击 DeepSeek Harness 的系统通知时，把桌面窗口恢复并带到前台。

## 解决什么问题

审批请求（`approval/requested`）、提问（`question/requested`）、对话完成等通知由已安装的
`dsh-pet` 插件用 Web Notification 发出。原来的点击处理只执行页面里的 `window.focus()`，
这不会提升 Electron 的原生窗口：窗口最小化或在其他窗口后面时，点了通知仍然看不到
Harness 界面。

本插件在页面里给每个通知补一个点击监听：点击时向 Host 发一个 `POST
/dsh-window-focus/focus`。Host 侧（桌面模式）会重新拉起一次
`DeepSeek Harness.exe`。桌面应用是单实例的，第二次启动会触发主实例的
`second-instance` 事件，主实例随即 `restore() + show() + focus()` 主窗口；新进程自己
马上退出，不会留下第二个窗口。

## 行为细节

- 只在桌面应用（`dsh-app://app`）里接管通知；普通浏览器标签页里不做任何事，点击通知
  由浏览器自己切换窗口/标签页。
- 只添加点击监听，不覆盖 `dsh-pet` 等插件原有的 `onclick` 逻辑。
- 在插件卸载时恢复原生 `Notification`。
- 所有系统通知的点击都会聚焦窗口（当前 Harness 里只有 `dsh-pet` 会发通知）。

## 安装

在 DSH 的插件市场里从本地安装本目录，或使用 `plugin_manager` 的 `install_bundle`
指向本目录的绝对路径。安装后本包会以 `link:` 依赖写进 profile，并出现在市场“已安装”列表。

安装后 **Host 半侧立即生效**（路由已注册），但页面里的客户端半侧要等页面重新加载：

- 快速方式：聚焦 Harness 窗口，按 `F12` 打开开发者工具，再按 `Ctrl+R` 重新加载页面；
- 稳妥方式：从托盘完全退出 DeepSeek Harness，再重新打开。

## 验证

1. 把 Harness 窗口最小化（或切到别的窗口）；
2. 触发一次需要审批的工具调用，等系统通知弹出；
3. 点击通知，Harness 窗口应恢复并来到前台。

若点击后只闪烁任务栏或没有反应，请确认自己点的是桌面应用弹出的通知，而不是浏览器
标签页（`http://127.0.0.1:<端口>`）的通知——浏览器窗口的前置由浏览器自身控制，网页脚本
无法强拉。

## 文件

- `index.js`：Host 半侧，注册 `/dsh-window-focus/focus` 路由并重新拉起应用。
- `client.js`：浏览器半侧，包装 `window.Notification` 以补点击监听。
- `cordis.patch.yml`：bundle 挂载声明。
- `locale/`：插件市场里的标题与描述。
