import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROUTE = '/dsh-window-focus/result'
const FOCUS_ROUTE = '/dsh-window-focus/focus'
const DISMISS_ROUTE = '/dsh-window-focus/dismiss'
const STATE_ROUTE = '/dsh-window-focus/state'
const APP_ID = 'Fanrongbo.DSH.WindowFocus'
const PROTOCOL = 'dsh-window-focus'
const APPROVAL_TIMEOUT_MS = 30000
const ACTIVE_KEY = Symbol.for('dsh-window-focus.active-instance')

const OUTCOME_ALLOW = 'allowed-once'
const OUTCOME_REJECT = 'rejected'

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = join(PACKAGE_DIR, 'scripts')
const APP_ICON = join(PACKAGE_DIR, 'assets', 'dsh.png')
const APP_ICO = join(PACKAGE_DIR, 'assets', 'dsh.ico')
const AVATAR_ICON = join(PACKAGE_DIR, 'assets', 'whale.png')
const TOAST_SCRIPT = join(SCRIPTS_DIR, 'toast.ps1')
const ACTION_LAUNCHER = join(SCRIPTS_DIR, 'toast-action.vbs')
const CLOSE_SCRIPT = join(SCRIPTS_DIR, 'close-toast.ps1')
const INSTALL_SHORTCUT_SCRIPT = join(SCRIPTS_DIR, 'install-shortcut.ps1')

export const name = 'dsh-window-focus'
export const inject = ['webServer']

function debug(line) {
  try {
    const file = join(process.env.TEMP || 'C:\\Windows\\Temp', 'dsh-window-focus-debug.log')
    // Keep the diagnostic log bounded; it is written on every approval.
    if (existsSync(file) && statSync(file).size > 512 * 1024) writeFileSync(file, '')
    appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    // ignore
  }
}

function isDesktopHost() {
  return process.versions.electron !== undefined && process.env.ELECTRON_RUN_AS_NODE === '1'
}

function powershellPath() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function wscriptPath() {
  const root = process.env.SystemRoot || 'C:\\Windows'
  return join(root, 'System32', 'wscript.exe')
}

function resolveAppExecutable() {
  const candidates = [
    process.env.DSH_DESKTOP_NODE_EXECUTABLE,
    process.env.DSH_NODE_EXECUTABLE,
    process.execPath,
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return undefined
}

function focusDesktopWindow() {
  const executable = resolveAppExecutable()
  if (!executable) return
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(executable, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env,
    })
    child.on('error', () => {})
    child.unref()
  } catch {
    // ignore
  }
}

function runReg(args) {
  try {
    const child = spawn('reg.exe', args, { stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // ignore
  }
}

function registerProtocol() {
  if (process.platform !== 'win32') return
  runReg([
    'add', `HKCU\\Software\\Classes\\${PROTOCOL}`, '/ve', '/d', 'URL:DSH Window Focus', '/f',
  ])
  runReg([
    'add', `HKCU\\Software\\Classes\\${PROTOCOL}`, '/v', 'URL Protocol', '/d', '', '/f',
  ])
  // Launch through wscript.exe (GUI subsystem) with a hidden PowerShell worker:
  // launching powershell.exe directly makes Windows flash a console window on click.
  const command = `"${wscriptPath()}" //nologo "${ACTION_LAUNCHER}" "%1"`
  runReg([
    'add',
    `HKCU\\Software\\Classes\\${PROTOCOL}\\shell\\open\\command`,
    '/ve',
    '/d',
    command,
    '/f',
  ])
}

function registerAppId() {
  if (process.platform !== 'win32') return
  runReg([
    'add',
    `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`,
    '/v', 'DisplayName', '/d', 'DeepSeek Harness', '/f',
  ])
  runReg([
    'add',
    `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`,
    '/v', 'ShowInSettings', '/d', '1', '/f',
  ])
  if (existsSync(APP_ICO) || existsSync(APP_ICON)) {
    // Windows does not resolve percent-encoded non-ASCII file URIs (the user
    // profile contains 范), so hand it the raw Unicode path. The AUMID header
    // icon expects an ICO; fall back to the PNG when the ICO is missing.
    const source = existsSync(APP_ICO) ? APP_ICO : APP_ICON
    const iconUri = 'file:///' + source.replaceAll('\\', '/')
    runReg([
      'add',
      `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`,
      '/v', 'IconUri', '/d', iconUri, '/f',
    ])
  }
}

function ensureShortcut() {
  if (process.platform !== 'win32') return
  const lnk = join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DSH Window Focus.lnk')
  try {
    if (!existsSync(INSTALL_SHORTCUT_SCRIPT)) return
    // (Re)create on every start: the target carries the executable path and the
    // icon, both of which can change between plugin versions.
    // An unpackaged app only gets a toast header icon when its AUMID is backed
    // by a Start Menu shortcut that carries the icon.
    const child = spawn(powershellPath(), [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', INSTALL_SHORTCUT_SCRIPT,
      '-LnkPath', lnk,
      '-AppId', APP_ID,
      // Clicking the Start Menu entry should open the app; the shortcut exists
      // mainly to give our unpackaged AUMID an icon, but a dead entry would be
      // confusing.
      '-Target', resolveAppExecutable() || wscriptPath(),
      '-IconPath', existsSync(APP_ICO) ? APP_ICO : APP_ICON,
    ], { stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.on('exit', (code) => debug(`shortcut exit ${code}`))
    child.unref()
  } catch {
    // the toast still works without the header icon
  }
}

function severityOf(toolName, reason) {
  const text = `${toolName || ''} ${reason || ''}`
  const rules = [
    [5, /(ssh|私钥|凭证|凭据|密钥|token|password|安装插件|配置变更|profile|webhook|上传|外发|post\s|https?:\/\/|secret|credential)/i],
    [4, /(删除|删掉|移除|delete|rm\s|工作区外|outside the workspace)/i],
    [3, /(写入|创建|新建|修改|覆盖|write|create|mkdir|touch)/i],
    [2, /(读取|只读|查看|read|hosts)/i],
  ]
  let level = 1
  for (const [ruleLevel, pattern] of rules) {
    if (pattern.test(text)) {
      level = Math.max(level, ruleLevel)
    }
  }
  // Tool names are a stronger signal than free-form reasons: `pwsh` can run
  // anything, so it always carries at least the "write / execute" level.
  const toolRules = [
    [5, /(secret|credential|keychain|ssh|password|token|env|vault|web_?fetch|web_?search|browser|http|fetch|curl|download|upload|webhook|network)/i],
    [5, /(plugin_?manager|install|profile|config|setting)/i],
    [3, /(bash|shell|pwsh|powershell|cmd|terminal|exec|run_?command|process)/i],
    [3, /(write|edit|multi_?edit|apply_?patch|create|mkdir|touch|notebook|delete|remove|move|copy|rename|patch)/i],
    [2, /(read|glob|grep|ls|list|view|cat|stat|find|search|dir|head|tail|open)/i],
  ]
  for (const [ruleLevel, pattern] of toolRules) {
    if (pattern.test(toolName || '')) {
      level = Math.max(level, ruleLevel)
    }
  }
  return level
}

function severityPrefix(level) {
  switch (level) {
    case 5: return '⛔ '
    case 4: return '⚠️ '
    case 3: return '✏️ '
    case 2: return '👁️ '
    default: return ''
  }
}

function shorten(text, limit = 64) {
  const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  const chars = Array.from(value)
  if (chars.length <= limit) return value
  return `${chars.slice(0, limit).join('')}…`
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(payload))
  res.end(payload)
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    let bytes = 0
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > 16384) {
        resolve(undefined)
        req.destroy()
        return
      }
      raw += chunk
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

// Requiring JSON keeps simple cross-site form posts (`text/plain`) away from
// the local-only control routes: they cannot send this content type without a
// CORS preflight, which this server never answers.
function hasJsonContentType(req) {
  const value = req.headers?.['content-type']
  const type = Array.isArray(value) ? value[0] : value
  return typeof type === 'string' && type.toLowerCase().includes('application/json')
}

// Windows limits a toast Tag to 16 characters, so the 36-char request id has
// to be shortened consistently for both Show and History.Remove.
const toastTag = (id) => String(id).replaceAll('-', '').slice(0, 16)

function showToast({ id, title, body, endpoint, token }) {
  if (!existsSync(TOAST_SCRIPT)) return false
  if (process.platform !== 'win32') return false
  const query = (action) => {
    const params = new URLSearchParams({ id, token, endpoint })
    return `${PROTOCOL}:${action}?${params.toString()}`
  }
  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', TOAST_SCRIPT,
    '-AppId', APP_ID,
    '-Title', title,
    '-Body', body,
    '-AllowUri', query('allow'),
    '-RejectUri', query('reject'),
    '-OpenUri', query('open'),
    '-AllowLabel', '允许一次',
    '-RejectLabel', '拒绝',
    '-Tag', toastTag(id),
  ]
  if (existsSync(AVATAR_ICON)) {
    args.push('-IconPath', AVATAR_ICON)
  }
  debug(`toast spawn icon=${String(existsSync(AVATAR_ICON))} title=${title}`)
  try {
    const child = spawn(powershellPath(), args, {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', (error) => debug(`toast error ${String(error)}`))
    child.on('exit', (code) => debug(`toast exit ${code}`))
    child.unref()
    return true
  } catch {
    return false
  }
}

function closeToast(id, { noClear = false } = {}) {
  if (!existsSync(CLOSE_SCRIPT)) return
  try {
    const args = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', CLOSE_SCRIPT,
      '-AppId', APP_ID,
      '-Tag', toastTag(id),
    ]
    if (noClear) args.push('-NoClear')
    const child = spawn(powershellPath(), args, { stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.on('exit', (code) => debug(`close exit ${String(code)} tag=${toastTag(id)}`))
    child.unref()
  } catch {
    // ignore
  }
}

function showQuestionToast(origin, { id, title, body }) {
  if (!existsSync(TOAST_SCRIPT) || !origin) return false
  const params = new URLSearchParams({ endpoint: `${origin}${FOCUS_ROUTE}` })
  const openUri = `${PROTOCOL}:focus?${params.toString()}`
  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', TOAST_SCRIPT,
    '-AppId', APP_ID,
    '-Title', title,
    '-Body', body,
    '-OpenUri', openUri,
    '-Tag', toastTag(id),
  ]
  if (existsSync(AVATAR_ICON)) args.push('-IconPath', AVATAR_ICON)
  debug(`question toast spawn title=${title}`)
  try {
    const child = spawn(powershellPath(), args, { stdio: 'ignore', windowsHide: true })
    child.on('error', (error) => debug(`question toast error ${String(error)}`))
    child.on('exit', (code) => debug(`question toast exit ${code}`))
    child.unref()
    return true
  } catch {
    return false
  }
}

export function apply(ctx) {
  debug(`apply electron=${String(process.versions.electron)} runAsNode=${String(process.env.ELECTRON_RUN_AS_NODE)}`)
  if (!isDesktopHost() || process.platform !== 'win32') return
  if (globalThis[ACTIVE_KEY] === true) {
    // The market and the profile bundle can load this package through two
    // entries in the same host process; only the first one may own the routes.
    debug('already active, skipping duplicate apply')
    return
  }
  globalThis[ACTIVE_KEY] = true
  ctx.effect(() => () => {
    globalThis[ACTIVE_KEY] = false
  }, 'dsh-window-focus: singleton')

  registerProtocol()
  registerAppId()
  ensureShortcut()

  const pending = new Map()
  // The browser half reports whether the app window is in the foreground; when
  // the user is already looking at the in-app card a toast would be noise.
  let windowFocused = false

  const finish = (id, outcome) => {
    const entry = pending.get(id)
    if (!entry) return false
    debug(`finish id=${id} outcome=${String(outcome)}`)
    pending.delete(id)
    clearTimeout(entry.timer)
    entry.settle(outcome)
    return true
  }

  // Windows clears the whole notification group when one toast is removed, so
  // when a toast disappears every still-pending request is moved to its in-app
  // card immediately instead of waiting for its own timeout.
  const promoteAll = () => {
    for (const entry of pending.values()) entry.promote?.()
  }

  const onApproval = async (request, next) => {
    debug(`approval tool=${request.toolName} pending=${pending.size}`)
    // The in-app card is only created when it is actually needed. While the
    // user is away a toast is offered first; if the toast answers the request,
    // no card is ever shown — so nothing can linger as a zombie. If the user
    // comes back, the toast expires, or the toast body is clicked, the request
    // is promoted to the normal in-app card and answered there.
    let sessionPromise = null
    const startSession = () => {
      if (sessionPromise === null) {
        sessionPromise = Promise.resolve()
          .then(() => next())
          .then((value) => ({ source: 'session', value }))
          .catch(() => ({ source: 'session', value: undefined }))
      }
      return sessionPromise
    }

    // While the user is looking at the app the card is enough. Otherwise every
    // request gets its own toast: several approvals can be queued in the
    // notification center and answered independently.
    if (windowFocused) {
      const early = await startSession()
      return early.value
    }

    const id = randomUUID()
    const token = randomBytes(16).toString('hex')
    const endpoint = (() => {
      try {
        return `${ctx.webServer.getOrigin()}${ROUTE}`
      } catch {
        return undefined
      }
    })()
    if (!endpoint) {
      const early = await startSession()
      return early.value
    }

    const level = severityOf(request.toolName, request.reason)
    const title = `${severityPrefix(level)}正在申请权限`
    const body = shorten(request.reason) || `工具「${request.toolName}」请求权限`

    if (!showToast({ id, title, body, endpoint, token })) {
      // No toast script (or not Windows): the in-app card is the only path.
      const early = await startSession()
      return early.value
    }
    debug(`toast shown title=${title}`)

    let resolveToast
    const toastResult = new Promise((resolve) => {
      resolveToast = resolve
    })
    let promoted
    const promotedResult = new Promise((resolve) => {
      promoted = () => resolve(startSession())
    })
    let promotedOnce = false
    let toastClosed = false
    // Windows clears the app's whole notification group on Remove, so closing
    // the same toast twice would wipe unrelated notifications. Close once.
    const closeOnce = () => {
      if (toastClosed) return
      toastClosed = true
      closeToast(id)
    }
    const promoteOnce = () => {
      if (promotedOnce) return
      promotedOnce = true
      closeOnce()
      promoted()
    }
    const timer = setTimeout(() => {
      debug(`timeout id=${id}`)
      promoteOnce()
      promoteAll()
    }, APPROVAL_TIMEOUT_MS)
    pending.set(id, {
      token,
      timer,
      settle: (value) => {
        clearTimeout(timer)
        resolveToast({ source: 'toast', value })
      },
      promote: promoteOnce,
    })

    const first = await Promise.race([sessionPromise ?? new Promise(() => {}), promotedResult, toastResult])
    const entry = pending.get(id)
    if (entry) {
      clearTimeout(entry.timer)
      pending.delete(id)
    }

    if (first.source === 'session') {
      // Answered in the in-app card: the toast for this request is obsolete,
      // and removing it clears the notification group.
      closeOnce()
      promoteAll()
      return first.value
    }
    if (first.value === OUTCOME_ALLOW || first.value === OUTCOME_REJECT) {
      // Answering from the toast must also clear it from the notification
      // center; leaving it there is what users experience as a zombie toast.
      closeOnce()
      // Closing one toast clears the app's notification group, so any other
      // queued approvals are promoted to their in-app cards right away.
      promoteAll()
      return first.value
    }
    // The toast was dismissed, its body was clicked, or it timed out: fall back
    // to the in-app card and wait for the user's decision there.
    const decision = await startSession()
    return decision.value
  }

  ctx.effect(() => {
    const dispose = ctx.on('approval/request', onApproval, { global: true, prepend: true })
    debug(`listener registered type=${typeof dispose}`)
    return () => {
      dispose?.()
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer)
        entry.settle(undefined)
        pending.delete(id)
      }
    }
  }, 'dsh-window-focus: approval listener')

  // Questions are also surfaced by the host: dsh-pet silently drops them while
  // the page is focused, which is exactly when the user asked to be reminded.
  // The client half suppresses dsh-pet's question toast, so there is exactly one
  // notification per question and it never contains the answer options.
  ctx.effect(() => {
    const dispose = ctx.on('user-questions/request', (request, next) => {
      const id = randomUUID()
      try {
        const origin = ctx.webServer.getOrigin()
        showQuestionToast(origin, {
          id,
          title: '❓ 需要你回答',
          body: '模型在等你回答一个问题，点击回到 DeepSeek Harness。',
        })
        debug(`question requested id=${id}`)
      } catch {
        // no toast: the in-app question UI is still there
      }
      const answered = Promise.resolve().then(() => next())
      answered.then(
        () => closeToast(id, { noClear: true }),
        () => closeToast(id, { noClear: true }),
      )
      return answered
    }, { global: true, prepend: true })
    debug(`question listener registered type=${typeof dispose}`)
    return () => dispose?.()
  }, 'dsh-window-focus: question notifications')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      if (!hasJsonContentType(req)) {
        sendJson(res, 415, { ok: false, error: 'unsupported-media-type' })
        return
      }
      const body = await readJsonBody(req)
      if (!body || typeof body.id !== 'string' || typeof body.token !== 'string') {
        sendJson(res, 400, { ok: false, error: 'bad-request' })
        return
      }
      const entry = pending.get(body.id)
      if (!entry || entry.token !== body.token) {
        sendJson(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      if (body.decision === 'allow') {
        finish(body.id, OUTCOME_ALLOW)
        sendJson(res, 200, { ok: true, decision: 'allow' })
        return
      }
      if (body.decision === 'reject') {
        finish(body.id, OUTCOME_REJECT)
        sendJson(res, 200, { ok: true, decision: 'reject' })
        return
      }
      if (body.decision === 'open') {
        // Body click only raises the window and promotes the request to the
        // in-app card; the user still decides there.
        entry.promote?.()
        promoteAll()
        focusDesktopWindow()
        sendJson(res, 200, { ok: true, decision: 'open' })
        return
      }
      sendJson(res, 400, { ok: false, error: 'bad-decision' })
    },
  }), 'dsh-window-focus: result route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: FOCUS_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      if (typeof req.resume === 'function') req.resume()
      focusDesktopWindow()
      sendJson(res, 200, { ok: true })
    },
  }), 'dsh-window-focus: focus route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DISMISS_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      if (!hasJsonContentType(req)) {
        sendJson(res, 415, { ok: false, error: 'unsupported-media-type' })
        return
      }
      if (typeof req.resume === 'function') req.resume()
      // The user came back to the app window: clear the toasts and promote the
      // pending requests to the normal in-app cards.
      debug(`dismiss requested pending=${pending.size}`)
      promoteAll()
      sendJson(res, 200, { ok: true })
    },
  }), 'dsh-window-focus: dismiss route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATE_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      if (!hasJsonContentType(req)) {
        sendJson(res, 415, { ok: false, error: 'unsupported-media-type' })
        return
      }
      const body = await readJsonBody(req)
      if (!body || typeof body.focused !== 'boolean') {
        sendJson(res, 400, { ok: false, error: 'bad-request' })
        return
      }
      windowFocused = body.focused
      debug(`window focused=${windowFocused}`)
      if (windowFocused) promoteAll()
      sendJson(res, 200, { ok: true })
    },
  }), 'dsh-window-focus: state route')
}
