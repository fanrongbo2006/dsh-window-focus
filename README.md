# dsh-window-focus

> 点击 DeepSeek Harness 桌面端的系统通知（权限审批、提问、对话完成），窗口立即恢复并跳到前台。

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

- 点击系统通知 → 恢复最小化 / 从托盘显示 / 把窗口提到前台并聚焦。
- 不修改 `dsh-pet` 等通知发送方：只在通知对象上追加一个 `click` 监听，原有 `onclick` 逻辑照常执行。
- 只在桌面应用内生效；浏览器标签页里完全不做干预（由浏览器自己切换窗口/标签页）。
- 插件卸载时自动还原原生 `window.Notification`，不留副作用。

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
| `index.js` | Host 半侧：注册 focus 路由，重新拉起桌面应用 |
| `client.js` | 浏览器半侧：用 Proxy 包装 `window.Notification`，补点击监听 |
| `cordis.patch.yml` | bundle 挂载声明，让 DSH 在启动时加载本插件 |
| `locale/zh.json`、`locale/en.json` | 插件市场里的标题与描述 |
| `icon.svg` | 市场卡片图标 |
| `package.json` | bundle 清单：`dsh.bundle.patch`、`dsh.client`、exports |

### 路由协议

```
POST /dsh-window-focus/focus
```

| 状态码 | 响应 | 含义 |
| --- | --- | --- |
| `200` | `{"ok":true}` | 已请求拉起窗口 |
| `405` | `{"allow":"POST"}` | 用了非 POST 方法 |
| `409` | `{"ok":false,"reason":"not-desktop"}` | 当前 Host 不是桌面环境 |

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
- 不收集、不上传任何数据；
- 不修改 `dsh-pet` 或其它插件的代码，只给通知对象追加监听；
- Host 侧唯一的外部动作是启动**同一个应用的可执行文件**（路径取自环境变量或 `process.execPath`）。

## 已知限制

- 仅 Windows 桌面端验证；macOS / Linux 的窗口聚焦机制不同，未测试。
- 浏览器版（`http://127.0.0.1:<端口>`）无效——这是浏览器的安全边界，不是插件能绕过的。
- 若系统处于「阻止应用抢占前台」状态，聚焦可能被降级为任务栏闪烁；这与 Windows 的前台锁策略有关。
- 多显示器 / 多虚拟桌面下，窗口会恢复并聚焦，但不会主动切换到它所在的虚拟桌面。

## 许可证

MIT © fanrongbo2006
