import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROUTE = '/dsh-window-focus/result'
const FOCUS_ROUTE = '/dsh-window-focus/focus'
const DISMISS_ROUTE = '/dsh-window-focus/dismiss'
const STATE_ROUTE = '/dsh-window-focus/state'
const DECISIONS_ROUTE = '/dsh-window-focus/decisions'
const APP_ID = 'Fanrongbo.DSH.WindowFocus'
// Question notifications live under their own AUMID so clearing them when the
// user returns cannot wipe approval toasts, which are the ones with buttons.
const QUESTIONS_APP_ID = 'Fanrongbo.DSH.WindowFocus.Questions'
const PROTOCOL = 'dsh-window-focus'
// Unanswered approvals are re-notified a few times: once is easy to miss when
// the user has just stepped away, but a notification every minute forever is
// noise. After the limit the in-app card is the remaining reminder.
const REMINDER_DELAY_MS = Number(process.env.DSH_WINDOW_FOCUS_REMIND_MS) > 0
  ? Number(process.env.DSH_WINDOW_FOCUS_REMIND_MS)
  : 25000
const REMINDER_LIMIT = 3
// The toast must outlive every reminder, otherwise the card promotion would
// happen first and the user would never see a second notification. This is a
// backstop, not a reminder interval, so it stays independent of the env
// override that tests use to shorten reminders.
const TOAST_TIMEOUT_MS = 120000
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
  const appIds = [APP_ID, QUESTIONS_APP_ID]
  for (const appId of appIds) {
    runReg([
      'add',
      `HKCU\\Software\\Classes\\AppUserModelId\\${appId}`,
      '/v', 'DisplayName', '/d', 'DeepSeek Harness', '/f',
    ])
    runReg([
      'add',
      `HKCU\\Software\\Classes\\AppUserModelId\\${appId}`,
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
        `HKCU\\Software\\Classes\\AppUserModelId\\${appId}`,
        '/v', 'IconUri', '/d', iconUri, '/f',
      ])
    }
  }
}

function ensureShortcut() {
  if (process.platform !== 'win32') return
  if (!existsSync(INSTALL_SHORTCUT_SCRIPT)) return
  const programs = join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  // Two AUMIDs: approvals (with buttons) and questions (cleared as a group when
  // the user returns). Each unpackaged AUMID only gets a toast header icon when
  // a Start Menu shortcut carries that AUMID and icon.
  const shortcuts = [
    { lnk: join(programs, 'DSH Window Focus.lnk'), appId: APP_ID },
    { lnk: join(programs, 'DSH Window Focus Questions.lnk'), appId: QUESTIONS_APP_ID },
  ]
  for (const { lnk, appId } of shortcuts) {
    try {
      const child = spawn(powershellPath(), [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', INSTALL_SHORTCUT_SCRIPT,
        '-LnkPath', lnk,
        '-AppId', appId,
        // Clicking the Start Menu entry should open the app; the shortcut exists
        // mainly to give our unpackaged AUMID an icon, but a dead entry would be
        // confusing.
        '-Target', resolveAppExecutable() || wscriptPath(),
        '-IconPath', existsSync(APP_ICO) ? APP_ICO : APP_ICON,
      ], { stdio: 'ignore', windowsHide: true })
      child.on('error', () => {})
      child.on('exit', (code) => debug(`shortcut exit ${code} app=${appId}`))
      child.unref()
    } catch {
      // the toast still works without the header icon
    }
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
// Windows tags are limited to 16 characters; reminders need their own tag so
// the replaced toast alerts again instead of silently updating in the center.
const reminderTag = (id, attempt) => `${String(id).replaceAll('-', '').slice(0, 14)}${String(attempt).padStart(2, '0')}`

function showToast({ id, title, body, endpoint, token, tag }) {
  if (!existsSync(TOAST_SCRIPT)) return false
  // Tests run without a desktop session; they assert the decision flow only.
  if (process.env.DSH_WINDOW_FOCUS_TEST === '1') return true
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
    '-Tag', tag ?? toastTag(id),
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

function closeToast(id, { noClear = false, tag, appId = APP_ID } = {}) {
  if (!existsSync(CLOSE_SCRIPT)) return
  if (process.env.DSH_WINDOW_FOCUS_TEST === '1') return
  try {
    const args = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', CLOSE_SCRIPT,
      '-AppId', appId,
      '-Tag', tag ?? toastTag(id),
    ]
    if (noClear) args.push('-NoClear')
    const child = spawn(powershellPath(), args, { stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.on('exit', (code) => debug(`close exit ${String(code)} tag=${tag ?? toastTag(id)}`))
    child.unref()
  } catch {
    // ignore
  }
}

function showQuestionToast(origin, { id, title, body, tag }) {
  if (!existsSync(TOAST_SCRIPT) || !origin) return false
  if (process.env.DSH_WINDOW_FOCUS_TEST === '1') return true
  const params = new URLSearchParams({ endpoint: `${origin}${FOCUS_ROUTE}` })
  const openUri = `${PROTOCOL}:focus?${params.toString()}`
  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', TOAST_SCRIPT,
    '-AppId', QUESTIONS_APP_ID,
    '-Title', title,
    '-Body', body,
    '-OpenUri', openUri,
    '-Tag', tag ?? toastTag(id),
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
  // Decisions answered from a toast are also reported to the browser half: an
  // approval request is presented as an in-app card when the user is looking at
  // the app, and answering that same request from the toast has to dismiss the
  // card as well. The browser polls this short-lived list and presses the
  // matching card button, which lets the normal UI own the dismissal.
  const decisions = []
  const DECISION_TTL_MS = 120_000
  const recordDecision = (entry, outcome) => {
    decisions.push({
      id: entry.id,
      outcome,
      toolName: entry.toolName,
      reason: entry.reason,
      at: Date.now(),
    })
    const cutoff = Date.now() - DECISION_TTL_MS
    while (decisions.length > 0 && decisions[0].at < cutoff) decisions.shift()
    if (decisions.length > 50) decisions.splice(0, decisions.length - 50)
  }
  // Unanswered questions are surfaced the same way as approvals: while the user
  // is away a toast is shown and re-shown a few times. A question that arrives
  // while the app has focus stays card-only until the window loses focus.
  const questions = new Map()

  const showQuestion = (entry) => {
    if (entry.done || entry.shown || !entry.origin) return false
    if (!showQuestionToast(entry.origin, {
      id: entry.id,
      title: entry.title,
      body: entry.body,
      tag: entry.tag,
    })) return false
    entry.shown = true
    debug(`question toast shown id=${entry.id}`)
    return true
  }
  const closeQuestionToast = (entry) => {
    if (!entry.shown) return
    entry.shown = false
    // Question toasts live under their own AUMID, so clearing that group when
    // the window returns cannot touch approval toasts that still have buttons.
    closeToast(entry.id, { tag: entry.tag, appId: QUESTIONS_APP_ID })
  }
  const finishQuestion = (id) => {
    const entry = questions.get(id)
    if (!entry) return
    questions.delete(id)
    entry.done = true
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    closeQuestionToast(entry)
  }
  const scheduleQuestionReminder = (entry) => {
    if (entry.done || entry.timer !== null || entry.reminders >= REMINDER_LIMIT) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      if (entry.done) return
      if (windowFocused) {
        scheduleQuestionReminder(entry)
        return
      }
      entry.reminders += 1
      closeQuestionToast(entry)
      entry.tag = reminderTag(entry.id, entry.reminders)
      if (!showQuestion(entry)) return
      debug(`question reminder ${entry.reminders} id=${entry.id}`)
      scheduleQuestionReminder(entry)
    }, REMINDER_DELAY_MS)
  }
  // Called when the window loses focus: a question that arrived while the user
  // was looking at the app had no toast yet, so surface it now and start
  // counting reminders from here.
  const notifyQuestions = () => {
    for (const entry of questions.values()) {
      if (entry.done || windowFocused) continue
      showQuestion(entry)
      scheduleQuestionReminder(entry)
    }
  }
  // Called when the window regains focus: drop the question toasts, keep the
  // question itself in memory so a later blur can surface it again.
  const closeQuestionToasts = () => {
    for (const entry of questions.values()) {
      if (entry.done) continue
      if (entry.timer !== null) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      closeQuestionToast(entry)
    }
  }

  // The browser half reports whether the app window is in the foreground; when
  // the user is already looking at the in-app card a toast would be noise.
  let windowFocused = false

  const finish = (id, outcome) => {
    const entry = pending.get(id)
    if (!entry) return false
    debug(`finish id=${id} outcome=${String(outcome)}`)
    pending.delete(id)
    clearTimeout(entry.timer)
    if (outcome === OUTCOME_ALLOW || outcome === OUTCOME_REJECT) {
      recordDecision(entry, outcome)
    }
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

    let resolveToast
    const toastResult = new Promise((resolve) => {
      resolveToast = resolve
    })
    let promoted
    const promotedResult = new Promise((resolve) => {
      promoted = () => resolve(startSession())
    })
    let promotedOnce = false
    let toastShown = false
    let toastClosed = false
    let currentTag = toastTag(id)
    let reminders = 0
    let reminderTimer = null
    let timer = null
    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
    const clearReminder = () => {
      if (reminderTimer !== null) {
        clearTimeout(reminderTimer)
        reminderTimer = null
      }
    }
    // Windows clears the app's whole notification group on Remove, so closing
    // the same toast twice would wipe unrelated notifications. Close once.
    const closeOnce = () => {
      if (toastClosed) return
      toastClosed = true
      clearReminder()
      if (toastShown) closeToast(id, { tag: currentTag })
    }
    const promoteOnce = () => {
      if (promotedOnce) return
      promotedOnce = true
      clearTimer()
      closeOnce()
      promoted()
    }
    // Unanswered approvals are re-notified a few times instead of exactly once:
    // a single toast is easy to miss, but endless reminders are noise. Every
    // reminder uses a fresh tag so Windows alerts again rather than silently
    // updating the existing entry, and the previous one is removed first so the
    // center does not fill with copies.
    const scheduleReminder = () => {
      if (reminders >= REMINDER_LIMIT || toastClosed) return
      reminderTimer = setTimeout(() => {
        reminderTimer = null
        if (toastClosed) return
        if (windowFocused) {
          // Back at the keyboard: the card is enough, but keep the option open
          // for a later blur.
          scheduleReminder()
          return
        }
        reminders += 1
        closeToast(id, { noClear: true, tag: currentTag })
        currentTag = reminderTag(id, reminders)
        if (!showToast({ id, title, body, endpoint, token, tag: currentTag })) return
        debug(`toast reminder ${reminders} id=${id}`)
        scheduleReminder()
      }, REMINDER_DELAY_MS)
    }
    // The toast is shown when the request arrives while the app is in the
    // background. A request that arrives while the user is looking at the
    // in-app card stays registered here without a toast, so it can still be
    // surfaced when the window later loses focus.
    const notify = () => {
      if (promotedOnce) {
        if (!toastClosed) return
        // The user came back once, which closed the toast and stopped the
        // reminders. If they leave again while the request is still unanswered,
        // surface it again and restart the reminder cycle.
        toastClosed = false
        toastShown = false
        reminders = 0
        currentTag = toastTag(id)
      }
      if (toastShown) return
      toastShown = true
      if (!showToast({ id, title, body, endpoint, token, tag: currentTag })) {
        // No toast script (or not Windows): the in-app card is the only path.
        toastShown = false
        promoteOnce()
        return
      }
      debug(`toast shown title=${title}`)
      timer = setTimeout(() => {
        debug(`timeout id=${id}`)
        promoteOnce()
        promoteAll()
      }, TOAST_TIMEOUT_MS)
      scheduleReminder()
    }
    pending.set(id, {
      id,
      token,
      toolName: request.toolName,
      reason: request.reason,
      get timer() {
        return timer
      },
      notify,
      settle: (value) => {
        clearTimer()
        clearReminder()
        resolveToast({ source: 'toast', value })
      },
      promote: promoteOnce,
    })

    if (windowFocused) {
      // The user is already looking at the app: show the in-app card right away
      // and keep the request in `pending` so the next blur can notify.
      startSession()
      debug(`card only id=${id}`)
    } else {
      notify()
    }

    const first = await Promise.race([sessionPromise ?? new Promise(() => {}), promotedResult, toastResult])

    const leave = () => {
      const entry = pending.get(id)
      if (entry) {
        clearTimeout(entry.timer)
        pending.delete(id)
      }
    }

    if (first.source === 'session') {
      // Answered in the in-app card: the toast for this request is obsolete,
      // and removing it clears the notification group.
      leave()
      closeOnce()
      promoteAll()
      return first.value
    }
    if (first.value === OUTCOME_ALLOW || first.value === OUTCOME_REJECT) {
      // Answering from the toast must also clear it from the notification
      // center; leaving it there is what users experience as a zombie toast.
      leave()
      closeOnce()
      // Closing one toast clears the app's notification group, so any other
      // queued approvals are promoted to their in-app cards right away.
      promoteAll()
      return first.value
    }
    // Dismissed, body clicked, or timed out: the in-app card is the primary
    // path, but `notify()` re-arms when the window loses focus again, so the
    // request can still be answered from a later toast. Keep the entry alive
    // until one of the two paths decides.
    const second = await Promise.race([sessionPromise ?? new Promise(() => {}), toastResult])
    leave()
    if (second.source === 'session') return second.value
    if (second.value === OUTCOME_ALLOW || second.value === OUTCOME_REJECT) {
      closeOnce()
      promoteAll()
      return second.value
    }
    const third = await startSession()
    return third.value
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
      const entry = {
        id,
        origin: '',
        title: '❓ 需要你回答',
        body: '模型在等你回答一个问题，点击回到 DeepSeek Harness。',
        tag: toastTag(id),
        shown: false,
        reminders: 0,
        timer: null,
        done: false,
      }
      questions.set(id, entry)
      try {
        entry.origin = ctx.webServer.getOrigin()
        debug(`question requested id=${id}`)
        if (windowFocused) {
          // The in-app question is already on screen; no toast while focused.
          debug(`question card only id=${id}`)
        } else {
          showQuestion(entry)
        }
        scheduleQuestionReminder(entry)
      } catch {
        // no toast: the in-app question UI is still there
      }
      const answered = Promise.resolve().then(() => next())
      answered.then(
        () => finishQuestion(id),
        () => finishQuestion(id),
      )
      return answered
    }, { global: true, prepend: true })
    debug(`question listener registered type=${typeof dispose}`)
    return () => {
      dispose?.()
      for (const entry of questions.values()) {
        entry.done = true
        if (entry.timer !== null) clearTimeout(entry.timer)
      }
      questions.clear()
    }
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
      debug(`window focused=${windowFocused} pending=${pending.size}`)
      if (windowFocused) {
        // Back in the app: drop the toasts, keep the requests as cards.
        promoteAll()
        closeQuestionToasts()
      } else {
        // The user left while the app still has unanswered requests: make sure
        // each one now has a notification, including requests that arrived
        // while the window was focused and therefore had no toast yet.
        for (const entry of pending.values()) entry.notify?.()
        notifyQuestions()
      }
      sendJson(res, 200, { ok: true })
    },
  }), 'dsh-window-focus: state route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DECISIONS_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET')
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      const cutoff = Date.now() - DECISION_TTL_MS
      while (decisions.length > 0 && decisions[0].at < cutoff) decisions.shift()
      sendJson(res, 200, { ok: true, decisions })
    },
  }), 'dsh-window-focus: decisions route')
}
