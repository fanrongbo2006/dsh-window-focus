import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROUTE = '/dsh-window-focus/result'
const FOCUS_ROUTE = '/dsh-window-focus/focus'
const DISMISS_ROUTE = '/dsh-window-focus/dismiss'
const APP_ID = 'Fanrongbo.DSH.WindowFocus'
const PROTOCOL = 'dsh-window-focus'
const APPROVAL_TIMEOUT_MS = 30000
const ACTIVE_KEY = Symbol.for('dsh-window-focus.active-instance')

const OUTCOME_ALLOW = 'allowed-once'
const OUTCOME_REJECT = 'rejected'

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = join(PACKAGE_DIR, 'scripts')
const APP_ICON = join(PACKAGE_DIR, 'assets', 'dsh.png')
const AVATAR_ICON = join(PACKAGE_DIR, 'assets', 'whale.png')
const TOAST_SCRIPT = join(SCRIPTS_DIR, 'toast.ps1')
const ACTION_LAUNCHER = join(SCRIPTS_DIR, 'toast-action.vbs')
const CLOSE_SCRIPT = join(SCRIPTS_DIR, 'close-toast.ps1')

export const name = 'dsh-window-focus'
export const inject = ['webServer']

function debug(line) {
  try {
    const file = join(process.env.TEMP || 'C:\\Windows\\Temp', 'dsh-window-focus-debug.log')
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
  if (existsSync(APP_ICON)) {
    runReg([
      'add',
      `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`,
      '/v', 'IconUri', '/d', pathToFileURL(APP_ICON).href, '/f',
    ])
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
  for (const [level, pattern] of rules) {
    if (pattern.test(text)) return level
  }
  return 1
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

function showToast({ id, title, body, endpoint, token }) {
  if (!existsSync(TOAST_SCRIPT)) return
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
    '-Tag', id,
  ]
  if (existsSync(AVATAR_ICON)) {
    args.push('-IconPath', AVATAR_ICON)
  }
  if (process.platform !== 'win32') return
  try {
    const child = spawn(powershellPath(), args, {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', (error) => debug(`toast error ${String(error)}`))
    child.on('exit', (code) => debug(`toast exit ${code}`))
    child.unref()
  } catch {
    // ignore
  }
}

function closeToast(id) {
  if (!existsSync(CLOSE_SCRIPT)) return
  try {
    const child = spawn(powershellPath(), [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', CLOSE_SCRIPT,
      '-AppId', APP_ID,
      '-Tag', id,
    ], { stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // ignore
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

  const pending = new Map()

  const finish = (id, outcome) => {
    const entry = pending.get(id)
    if (!entry) return false
    debug(`finish id=${id} outcome=${String(outcome)}`)
    pending.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(outcome)
    return true
  }

  const onApproval = async (request, next) => {
    debug(`approval tool=${request.toolName} pending=${pending.size}`)
    // The in-app approval card must always appear: forward first, then offer a
    // toast as a second way to answer the same request.
    const sessionResult = Promise.resolve()
      .then(() => next())
      .then((value) => ({ source: 'session', value }))
      .catch(() => ({ source: 'session', value: undefined }))

    // One actionable toast at a time; further requests only get the in-app card.
    if (pending.size > 0) {
      const early = await sessionResult
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
      const early = await sessionResult
      return early.value
    }

    const level = severityOf(request.toolName, request.reason)
    const title = `${severityPrefix(level)}DeepSeek Harness · 权限请求`
    const body = shorten(request.reason) || `工具「${request.toolName}」请求权限`

    let resolveToast
    const toastResult = new Promise((resolve) => {
      resolveToast = resolve
    })
    const timer = setTimeout(() => {
      debug(`timeout id=${id}`)
      closeToast(id)
      resolveToast({ source: 'toast', value: undefined })
    }, APPROVAL_TIMEOUT_MS)
    pending.set(id, {
      token,
      timer,
      resolve: (value) => {
        clearTimeout(timer)
        resolveToast({ source: 'toast', value })
      },
    })
    showToast({ id, title, body, endpoint, token })

    const first = await Promise.race([sessionResult, toastResult])
    const entry = pending.get(id)
    if (entry) {
      clearTimeout(entry.timer)
      pending.delete(id)
    }

    if (first.source === 'session') {
      closeToast(id)
      return first.value
    }
    if (first.value === OUTCOME_ALLOW || first.value === OUTCOME_REJECT) {
      return first.value
    }
    // The toast was dismissed or its body was clicked: keep the in-app card open
    // and let the user decide there.
    const decision = await sessionResult
    return decision.value
  }

  ctx.effect(() => {
    const dispose = ctx.on('approval/request', onApproval, { global: true, prepend: true })
    debug(`listener registered type=${typeof dispose}`)
    return () => {
      dispose?.()
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer)
        entry.resolve(undefined)
        pending.delete(id)
      }
    }
  }, 'dsh-window-focus: approval listener')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
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
        // Body click only raises the window: the in-app card must stay open so
        // the user can decide there.
        closeToast(body.id)
        entry.resolve('open')
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
      if (typeof req.resume === 'function') req.resume()
      // The user came back to the app window: clear the toasts but keep the
      // approvals pending so they can be answered in the in-app card.
      for (const [id, entry] of pending) {
        closeToast(id)
        entry.resolve('dismiss')
      }
      sendJson(res, 200, { ok: true })
    },
  }), 'dsh-window-focus: dismiss route')
}
