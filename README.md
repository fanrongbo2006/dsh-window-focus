# dsh-window-focus

> 点击 DeepSeek Harness 桌面端的系统通知（权限审批、提问、对话完成），窗口立即恢复并跳到前台；审批通知还带「允许一次 / 拒绝」按钮，可以直接在通知里完成授权。

**dsh-window-focus** 是一个 DeepSeek Harness（DSH）桌面端插件（bundle）。它解决一个很小但很烦的问题：Harness 在后台或最小化时弹出了审批通知，你点了通知，界面却不会来到你面前。

---

## 目录

- [功能](#功能)
- [为什么需要它](#为什么需要它)
- [工作原理](#工作原理)
- [兼容性](#兼容性)
- [安装](#安装)
- [使用](#使用)
- [验证](#验证)
- [故障排查](#故障排查)
- [卸载](#卸载)
- [开发](#开发)
- [安全与隐私](#安全与隐私)
- [已知限制](#已知限制)
- [许可证](#许可证)

---

## 功能

- 点击 Harness 的系统通知 → 恢复最小化 / 从托盘显示 / 把窗口提到前台并聚焦。
- **审批通知可直接点「允许一次 / 拒绝」**（Windows 桌面端 1.1.0+）：宿主先收到审批请求，弹出一条原生 toast，按钮通过自定义协议回调 Host 完成授权；按钮只完成授权、不切换窗口，点通知正文才回到 DSH。
- 30 秒内没有选择时，toast 自动关闭，审批卡片回退到应用内等待处理；已有 toast 未决时，新请求直接走应用内卡片，不会堆积。
- 只接管 Harness 自己发出的通知（标题含 `正在申请权限`、`模型在等你回答`、`对话完成`、`生成失败`、`输出被截断`）；页面上其它来源的通知原样放行，不会附加任何行为。
- 不修改 `dsh-pet` 等通知发送方：只在通知对象上追加一个 `click` 监听，原有 `onclick` 逻辑照常执行。
- 只在桌面应用内生效；浏览器标签页里完全不做干预（由浏览器自己切换窗口/标签页）。
- 插件卸载时自动还原原生 `window.Notification`，不留副作用。
- 通知发出前会改写审批/提问通知的文案（见下节）。

### 通知内容与严重级

审批和提问通知在到达系统通知中心之前会被改写：

| 通知 | 标题 | 正文 |
| --- | --- | --- |
| 审批 · 只读类 | `👁️ <原会话名> · 正在申请权限` | `工具「…」：原因前 48 字…` |
| 审批 · 本地写入类 | `✏️ …` | 同上 |
| 审批 · 破坏性 / 工作区外写入 | `⚠️ …` | 同上 |
| 审批 · 凭证 / 对外副作用 / 配置变更 | `⛔ …` | 同上 |
| 模型提问 | `❓ 模型在等你回答` | `需要你回答一个问题，点击回到 DeepSeek Harness。` |
| 其它（完成、失败等） | 不改 | 不改 |

- 原因超过 48 个字符时只保留前半段并以 `…` 结尾；提问内容完全不进通知。
- 等级由「工具名 + 原因」共同判断，取两者中更高的等级：`Write`/`Edit` 一律算本地写入，`WebFetch`/`WebSearch`/`Bash` 中的 `rm`、`plugin_manager`/`install` 等工具名优先于模糊的原因文案；原因关键词（读取/hosts、写入/创建、删除/工作区外、SSH/私钥/POST/安装插件 等）作为兜底。审批事件本身不携带危险等级字段，所以这仍然是推断，无法保证对任意第三方工具 100% 准确。
- 渲染进程无法给 Windows 系统通知设置边框颜色，因此等级用标题前缀表示（`👁️` / `✏️` / `⚠️` / `⛔`）；通知图标保留 `dsh-pet` 原来的鲸鱼形象，不会被替换。
- 同一请求的通知带稳定的 `tag`：发送方短时间内重复触发时，系统替换旧通知而不是叠加一屏；点击过的请求在 90 秒内不再弹出。
- 通知正文在交给系统前会修复非法 UTF-16 代理项并截断到安全长度，避免构造通知时报 `InvalidStateError`。
- 桌面端审批通知由本插件独家接管：`dsh-pet` 的审批副本会被客户端直接丢弃，通知栏只保留一条带按钮的 toast，不会出现两条重复通知。
- 原生 toast 路径按严重级加前缀，正文取请求原因前 64 字；「允许一次」为系统绿色样式，点击正文回到 DSH，点击按钮直接完成授权（不切换窗口）。
- 两条通知路径分工：Windows 桌面端审批由 Host 弹原生 toast（带按钮）；提问与完成类通知仍来自 `dsh-pet`，由客户端改写文案并补点击聚焦。
- 点击通知的正文只负责回到 DSH，不会替用户做决定；需要授权时请按「允许一次」或「拒绝」按钮。

## 为什么需要它

Harness 的审批/提醒通知由插件（默认是 `dsh-pet`）通过 Web Notification 发出。它原来的点击处理只有一行：

```js
n.onclick = () => { window.focus(); n.close(); };
```

`window.focus()` 只会操作渲染进程里的页面，**不会**提升 Electron 的原生窗口。所以当窗口被最小化、隐藏到托盘、或被其它窗口盖住时，点击通知不会有任何可见效果——这正是本插件要补上的那一环。

## 工作原理

```
点击通知
   │
   ▼
client.js（页面内，dsh-app://app）
   包装后的 Notification 触发 click 监听
   │  fetch POST /dsh-window-focus/focus
   ▼
index.js（Host 进程）
   确认自己运行在桌面应用中
   以“普通 GUI 进程”身份重新启动 DeepSeek Harness.exe
   │
   ▼
第二个实例启动 → 发现已有主实例 → 立刻退出
   │ 触发主实例的 second-instance 事件
   ▼
主实例 focusPrimaryWindow()
   restore() + show() + focus()
```

关键点：

1. **Host 路由**：`POST /dsh-window-focus/focus`，注册在 DSH Host 的 webServer 上，随应用启动加载。
2. **重新拉起应用**：桌面应用是单实例的。新进程拿不到实例锁会自己退出，但退出前会把 `second-instance` 事件交给主实例，主实例借此恢复并聚焦窗口。
3. **只在需要时做了这件事**：页面里先判断 `location.protocol === 'dsh-app:'`，浏览器打开的 Harness（`http://127.0.0.1:<端口>`）不会注册任何监听。

### 审批按钮（1.1.0）

```
agent 请求审批
   │
   ▼
index.js（Host，global + prepend 监听 approval/request）
   生成随机 id + token
   用 PowerShell + WinRT 弹原生 toast（两个按钮，协议激活）
   │  ── 30 秒内没操作 ──▶ 关闭 toast，next() 回退到应用内审批卡片
   ▼
用户点击「允许一次 / 拒绝」
   协议激活 dsh-window-focus:allow|reject?id=…&token=…&endpoint=…
   │
   ▼
scripts/toast-action.vbs（wscript 启动，隐藏窗口，不弹终端）
   → toast-action.ps1 解析 URI，POST /dsh-window-focus/result   │  宿主校验 id + token，决定 outcome
   ▼
返回 allowed-once / rejected；只有点击通知正文才把窗口带到前台
```

- toast 的 AppUserModelId 为 `Fanrongbo.DSH.WindowFocus`，协议 `dsh-window-focus:` 由 `wscript.exe` 启动 `scripts/toast-action.vbs`，再用隐藏窗口调起 `toast-action.ps1`（直接启动 powershell.exe 会闪一个终端窗口）；
- 结果路由校验一次性 token，外部网页无法伪造审批结果；
- 同一时间只弹一个可操作 toast，避免多个审批堆叠。

## 兼容性

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11（当前只在 Windows 11 上验证过） |
| Harness | DeepSeek Harness **桌面端**（页面为 `dsh-app://app`），已在 0.2.2-rc.3 验证 |
| 浏览器版 | 不支持——浏览器窗口的前置由浏览器控制，网页脚本无法强拉 |
| 通知来源 | 任意使用 Web Notification 的插件；默认配置下是 `dsh-pet` |

> 桌面端和浏览器版可以同时开着，但只有桌面端弹出的通知会走本插件的聚焦逻辑。

## 安装

有三种方式：npm 安装（推荐，需要联网）、手动安装（离线可用）、让 agent 代劳。包已发布到 npm（包名 `dsh-window-focus`）。

> **版本提示**：npm 上的 1.0.0 只有“点击聚焦 + 文案改写”；带「允许一次 / 拒绝」按钮的 1.1.0 需要从 GitHub 仓库手动安装，或等 npm 更新后再用方式一。

### 方式一：npm 安装（推荐）

```powershell
dsh plugin --profile desktop add dsh-window-focus
```

安装后重启 DeepSeek Harness（托盘图标 → 退出 → 重新打开）。也可以打开 **设置 → 插件市场**，搜索 `dsh-window-focus` 一键安装。

> 国内网络默认走 npm 镜像，镜像的 `latest` 偶尔会滞后几分钟；如果报 404，稍等或改用方式二手动安装。

### 方式二：手动安装（离线可用）

#### 0. 准备

- 已安装并至少启动过一次 DeepSeek Harness 桌面端（这样 `desktop` profile 目录才会存在）。
- 建议把插件放在**固定且不含空格**的目录，例如 `C:\dsh\plugins\dsh-window-focus`。

#### 1. 获取插件文件

```powershell
git clone https://github.com/fanrongbo2006/dsh-window-focus.git C:\dsh\plugins\dsh-window-focus
```

也可以直接下载 ZIP 解压到该目录。解压后目录里应能看到 `package.json`、`index.js`、`client.js`、`cordis.patch.yml`。

#### 2. 找到 desktop profile 目录

```powershell
$profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
Test-Path $profile    # 应输出 True
```

如果输出 `False`，先启动一次桌面端再关掉，让它生成 profile。

#### 3. 在 profile 的 `package.json` 里登记插件

用任意文本编辑器打开：

```
%USERPROFILE%\.dsh\profiles\desktop\package.json
```

在 `dependencies` 里加一行（路径按你实际的安装位置改）：

```json
{
  "dependencies": {
    "dsh-window-focus": "link:C:/dsh/plugins/dsh-window-focus"
  }
}
```

再在 `dsh.profile.bundles` 末尾加一项：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-window-focus"
      ]
    }
  }
}
```

> 注意：JSON 不能有注释和多余的逗号；改完保存。

#### 4. 让 profile 的 `node_modules` 认识这个包

在 profile 目录下创建目录联接（junction，不需要管理员权限）：

```powershell
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-window-focus" "C:\dsh\plugins\dsh-window-focus"
```

看到 `为 ... 创建的联接` 即成功。

> 为什么不用 `pnpm install`？`link:` 依赖本身没问题，但 pnpm 在安装时会做 lockfile 供应链校验、需要联网访问 registry；手动安装不需要，更适合离线环境。

#### 5. 重启应用

- 右键任务栏托盘里的 DeepSeek Harness 图标 → **退出**；
- 重新打开 DeepSeek Harness。

打开后：**设置 → 插件市场 → 已安装**里应该能看到 `dsh-window-focus`。

#### 6. 检查页面半侧是否加载

在 Harness 窗口里按 `F12` 打开开发者工具，在 Console 输入：

```js
window.__dshWindowFocusInstalled;
```

返回 `true` 表示客户端包装已生效。返回 `undefined` 说明页面还没重新加载，按 `Ctrl+R` 刷新页面（或再重启一次应用）。

### 方式三：让 DSH 里的 agent 安装

如果你在用 DSH 的编码 agent，直接让它安装即可：把 npm 包名交给 `plugin_manager` 的 `install_bundle`，或者让它按上面的 `dsh plugin add` 执行。

也可以让它安装本地目录（离线场景）：把目录绝对路径传给 `install_bundle`，它会自动完成方式二的第 3～4 步——把 `link:` 依赖写进 profile、把插件加进 `dsh.profile.bundles`、在 `node_modules` 建联接，并应用 bundle 补丁。安装结果里 `application: "applied"` 表示成功。

## 使用

安装并重启后不需要任何额外配置：

1. 正常使用 Harness；
2. 把窗口最小化、关到托盘，或切到别的窗口；
3. 当 agent 申请权限、向你提问、或一轮对话结束时，系统通知会弹出；
4. **点击通知**，Harness 窗口就会恢复并出现在最前面，通知自动关闭。

系统通知中心里的历史通知同样有效——只要应用还在运行。

如果点了没反应，先确认你点的是**桌面端**发出的通知：桌面端和浏览器版同时运行时，两边的通知长得一样，但来源不同。

## 验证

不依赖真实审批也能验证：

**A. 页面侧检查**

```js
// F12 Console
window.__dshWindowFocusInstalled   // true
```

**B. 直接调用路由**

```js
// F12 Console（页面与 Host 同源，自动带认证 Cookie）
await fetch('/dsh-window-focus/focus', { method: 'POST' }).then(r => r.json())
// { ok: true }
```

此时窗口会被拉到前台。若返回 `{ ok: false, reason: 'not-desktop' }`，说明 Host 没认出自己在桌面应用里（见故障排查）。

**C. 真实通知测试**

1. 把 Harness 窗口最小化；
2. 让 agent 执行一个需要审批的命令（或等一轮对话结束）；
3. 点击弹出的系统通知；
4. 窗口应恢复并聚焦。

**D. 审批按钮测试（1.1.0+）**

1. 触发任意一次需要审批的操作（或让 agent 执行一条会请求权限的命令）；
2. 通知应以原生 toast 形式出现，带「允许一次」「拒绝」两个按钮，标题前有等级前缀；
3. 点「允许一次」→ 审批直接通过（窗口不切换，可继续做别的事）；点「拒绝」→ 审批被拒绝；点通知正文 → 回到 DSH 应用内卡片；
4. 什么都不点，等 30 秒 → toast 消失，应用内出现审批卡片。

Host 侧日志：`%TEMP%\dsh-window-focus-debug.log`（记录 `apply`、`approval`、`toast exit`、`finish`）。

## 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 完全收不到通知 | `dsh-pet` 没装 / 通知总开关关闭 / Windows 通知权限被拒 / 专注助手拦截 | 检查 `dsh-pet` 的设置与 Windows「设置 → 系统 → 通知」 |
| 有通知，点击无反应 | 页面半侧没加载 | Console 看 `window.__dshWindowFocusInstalled`，不是 `true` 就 `Ctrl+R` 或重启应用 |
| 有通知，点击无反应 | 点的是浏览器版的通知 | 浏览器页面无法前置原生窗口；只对桌面端通知有效 |
| 窗口不出现或只闪任务栏 | 系统前台锁定 / 应用被判定为后台进程 | 先点任务栏图标确认窗口本身能出现；必要时在 Windows 隐私设置里允许应用请求注意力 |
| 返回 `{"ok":false,"reason":"not-desktop"}` | Host 不在桌面环境，或 `ELECTRON_RUN_AS_NODE` 缺失 | 确认是从桌面端（`dsh-app://app`）打开，而不是浏览器 |
| 应用启动失败 | profile 的 `package.json` JSON 语法错误 | 用 JSON 校验工具检查，或恢复备份 |
| 插件市场“已安装”里没有 | 只加了 `bundles`，没加 `dependencies`，或没建 `node_modules` 联接 | 按安装步骤 3、4 补齐 |
| 更新插件代码后行为没变 | 页面还缓存着旧客户端模块 | `F12` + `Ctrl+R`，或重启应用 |

**查看日志**

- 渲染进程：`F12` → Console；
- Host 侧：`%APPDATA%\@deepseek-ai\dsh-desktop\logs\`（如存在）。

## 卸载

1. 退出 DeepSeek Harness；
2. 从 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 里删掉 `dsh-window-focus` 的依赖和 `dsh.profile.bundles` 中的条目；
3. 删除联接（注意用 `rmdir` 只删链接，不会删源码）：

   ```powershell
   cmd /c rmdir "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-window-focus"
   ```

4. 重新打开应用；
5. 如需彻底清理，删除源码目录 `C:\dsh\plugins\dsh-window-focus`。

卸载后，点击通知会回到原生行为（即 `dsh-pet` 自己的 `window.focus()`）。

## 开发

### 文件结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半侧：拦截审批、弹原生 toast、注册 focus/result 路由、重新拉起桌面应用 |
| `client.js` | 浏览器半侧：用 Proxy 包装 `window.Notification`，补点击监听、改写文案 |
| `scripts/toast.ps1` | 用 WinRT 弹带按钮的 toast（协议激活） |
| `scripts/toast-action.vbs` | 协议入口：wscript 启动，隐藏窗口调起 PowerShell（不弹终端） |
| `scripts/toast-action.ps1` | 协议回调：解析按钮 URI，POST 结果到 Host |
| `scripts/close-toast.ps1` | 超时或取消时关闭/清除通知 |
| `cordis.patch.yml` | bundle 挂载声明，让 DSH 在启动时加载本插件 |
| `locale/zh.json`、`locale/en.json` | 插件市场里的标题与描述 |
| `icon.svg` | 市场卡片图标 |
| `package.json` | bundle 清单：`dsh.bundle.patch`、`dsh.client`、exports |

### 路由协议

```
POST /dsh-window-focus/focus
POST /dsh-window-focus/result
```

| 状态码 | 响应 | 含义 |
| --- | --- | --- |
| `200` | `{"ok":true}` | 已请求拉起窗口 / 已记录审批结果 |
| `405` | `{"allow":"POST"}` | 用了非 POST 方法 |
| `400` | `{"ok":false,"error":"bad-request"}` | 缺少 id / token / 非法 decision |
| `403` | `{"ok":false,"error":"forbidden"}` | id 不存在或 token 不匹配 |

客户端只在 `location.protocol === 'dsh-app:'` 时注册监听，因此浏览器版不会发出这些请求。

### 本地检查

```powershell
cd C:\dsh\plugins\dsh-window-focus
node --check index.js
node --check client.js
```

改完代码后按 `F12` → `Ctrl+R` 重新加载页面即可；改动 Host 半侧则需要重启应用。

### 客户端实现要点

- 用 `new Proxy(NativeNotification, { construct })`，构造时创建原生实例并追加 `click` 监听，不替换原型；
- `get` 陷阱把 `requestPermission` 绑定回原构造器，避免 WebIDL 静态成员因 `this` 是 Proxy 而抛 `Illegal invocation`；
- 用 `ctx.effect(() => cleanup)` 注册，插件卸载时恢复原生 `Notification` 并清除标记。

## 安全与隐私

- 路由只监听本机，只接受 `POST`；
- 审批结果路由要求一次性随机 `id + token` 匹配，页面或外部程序猜不到，也无法伪造「允许」；
- 不收集、不上传任何数据；
- 不修改 `dsh-pet` 或其它插件的代码，只给通知对象追加监听；
- Host 侧的外部动作只有两个：启动**同一个应用的可执行文件**（路径取自环境变量或 `process.execPath`），以及通过 PowerShell 弹系统通知；
- 协议 `dsh-window-focus:` 与 AUMID 都写在 `HKCU` 下，卸载插件后可手动删除这两个注册表项。

## 已知限制

- 仅 Windows 桌面端验证；macOS / Linux 的窗口聚焦机制不同，未测试。
- 浏览器版（`http://127.0.0.1:<端口>`）无效——这是浏览器的安全边界，不是插件能绕过的。
- 若系统处于「阻止应用抢占前台」状态，聚焦可能被降级为任务栏闪烁；这与 Windows 的前台锁策略有关。
- 多显示器 / 多虚拟桌面下，窗口会恢复并聚焦，但不会主动切换到它所在的虚拟桌面。
- 通知栏里的「允许一次 / 拒绝」按钮只在 **Windows 桌面端 1.1.0+** 可用；浏览器版（`http://127.0.0.1:<端口>`）的 Web Notification 不支持按钮。
- toast 按钮外观由 Windows 决定，**无法自定义白色填充**；系统只提供默认、`Success`（绿色）、`Critical`（红色）三种样式，本插件把「允许一次」设为绿色（`Success`）。应用内审批卡片的白色按钮无法复制到系统通知里。
- toast 通过 HKCU 的 AppUserModelId + 自定义协议实现（未打包应用没有包标识）。个别系统上通知可能显示在「Windows PowerShell」分组下，或需要在系统通知设置里允许该来源。
- 通知边框颜色无法从插件设置，等级用标题前缀（`👁️` / `✏️` / `⚠️` / `⛔`）表示。
- 同一时间只保留一个可操作 toast：上一个未决时，新审批直接回退到应用内卡片；toast 超过 30 秒未操作也会回退。

## 许可证

MIT © fanrongbo2006
