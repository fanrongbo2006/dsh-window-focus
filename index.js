/**
 * Host half of dsh-window-focus.
 *
 * The desktop app keeps running with a single instance: launching
 * `DeepSeek Harness.exe` a second time makes the primary instance restore,
 * show and focus its main window. The browser half calls this route when the
 * user clicks a system notification, which is exactly when the user wants the
 * harness back in front.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Route the browser half POSTs to when a notification is clicked. */
const FOCUS_ROUTE = '/dsh-window-focus/focus'

/** The application executable lives in one of these, in order of preference. */
function resolveAppExecutable() {
  const candidates = [
    process.env.DSH_DESKTOP_NODE_EXECUTABLE,
    process.env.DSH_NODE_EXECUTABLE,
    process.execPath,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate)) {
      return candidate
    }
  }
  return undefined
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Relaunch the desktop shell. It exits immediately after the primary instance
 * receives its `second-instance` event, so no extra window stays open.
 */
function focusDesktopWindow() {
  // Only a packaged desktop host can be raised this way; a plain `dsh` host
  // (or a browser session) has no window to focus.
  if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE !== '1') {
    return { ok: false, reason: 'not-desktop' }
  }
  const executable = resolveAppExecutable()
  if (executable === undefined) {
    return { ok: false, reason: 'executable-not-found' }
  }
  const env = { ...process.env }
  // The host runs as Node inside Electron; the GUI must not inherit that flag.
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(executable, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env,
    })
    child.on('error', () => {
      // A failed relaunch must not take the host down; the next click retries.
    })
    child.unref()
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true }
}

export const inject = ['webServer']

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: FOCUS_ROUTE,
        handler: (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST' })
            res.end()
            return
          }
          // The body carries no data; drain it so the socket can close cleanly.
          if (typeof req.resume === 'function') req.resume()
          let result
          try {
            result = focusDesktopWindow()
          } catch (error) {
            result = { ok: false, reason: error instanceof Error ? error.message : String(error) }
          }
          sendJson(res, result.ok ? 200 : 409, result)
        },
      }),
    'dsh-window-focus: focus route',
  )
}
