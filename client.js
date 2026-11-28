/**
 * Browser half of dsh-window-focus.
 *
 * On the desktop page (`dsh-app://`) this module:
 *
 * 1. Raises the desktop window when a DeepSeek Harness notification is
 *    clicked, so the app comes back to the foreground.
 * 2. Rewrites approval and question notifications before they reach the OS:
 *    approval bodies keep the tool name plus a shortened reason with an
 *    ellipsis, question bodies carry no question text at all, and a severity
 *    marker is prefixed to the title. Windows toast borders cannot be colored
 *    from the renderer, so severity travels in the title prefix; the sender's
 *    own icon (the whale) is preserved.
 *
 * Every other notification is constructed with its original arguments and is
 * never touched: the module must not take over unrelated notifications.
 *
 * Plain browser sessions (`http:`) are left alone: there is no native window
 * to raise there, and other plugins keep their own click handlers.
 */

window.__ModuleLoader__.load({
  id: 'dsh-window-focus',
  factory() {
    const FOCUS_ENDPOINT = '/dsh-window-focus/focus'
    const APPROVAL_TITLE = '正在申请权限'
    const QUESTION_TITLE = '模型在等你回答'
    const DSH_TITLE = /(正在申请权限|模型在等你回答|对话完成|生成失败|输出被截断)/
    const MAX_REASON = 48
    const MAX_BODY_BYTES = 1800

    /**
     * Severity is not carried by the approval event itself, so it has to be
     * inferred from the two things the notification actually exposes: the tool
     * name and the human-readable reason. The tool name is the stronger signal
     * (a `Write` call is a local write even when the reason text is vague), so
     * both are scored and the higher level wins.
     * @type {Record<number, { level: number, prefix: string, color: string, glyph: string }>}
     */
    const LEVEL_STYLE = {
      5: { level: 5, prefix: '⛔ ', color: '#e5484d', glyph: '!' },
      4: { level: 4, prefix: '⚠️ ', color: '#f5a524', glyph: '!' },
      3: { level: 3, prefix: '✏️ ', color: '#2fb36b', glyph: '+' },
      2: { level: 2, prefix: '👁️ ', color: '#4c8dff', glyph: 'i' },
      1: { level: 1, prefix: '', color: '#4c8dff', glyph: '' },
    }

    const REASON_RULES = [
      { level: 5, test: /(ssh|私钥|凭证|凭据|密钥|token|password|安装插件|配置变更|profile|post\s|https?:\/\/|上传|外发|webhook)/i },
      { level: 4, test: /(删除|删掉|移除|delete|rm\s|工作区外|outside the workspace)/i },
      { level: 3, test: /(写入|创建|新建|修改|覆盖|write|create|mkdir|touch)/i },
      { level: 2, test: /(读取|只读|查看|read|hosts)/i },
    ]

    const TOOL_RULES = [
      { level: 5, test: /(web_?fetch|web_?search|browser|http|fetch|curl|download|upload|webhook|network|post)/i },
      { level: 5, test: /(secret|credential|keychain|ssh|password|token|env|vault)/i },
      { level: 5, test: /(plugin_?manager|install|profile|config|setting)/i },
      { level: 3, test: /(bash|shell|pwsh|powershell|cmd|terminal|exec|run_?command|process)/i },
      { level: 3, test: /(write|edit|multi_?edit|apply_?patch|create|mkdir|touch|notebook|delete|remove|move|copy|rename|patch)/i },
      { level: 2, test: /(read|glob|grep|ls|list|view|cat|stat|find|search|dir|head|tail|open)/i },
    ]

    /**
     * Notification body is a DOMString: a lone UTF-16 surrogate (which a naive
     * `slice` can create in the middle of an emoji) makes the constructor throw
     * `InvalidStateError`. Repair the string before it is handed to the API.
     */
    function wellFormed(value) {
      if (typeof value.toWellFormed === 'function') return value.toWellFormed()
      return value.replace(/[\uD800-\uDFFF]/g, '\uFFFD')
    }

    function textOf(value) {
      if (typeof value !== 'string') return ''
      return wellFormed(value)
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    }

    function shorten(text, max) {
      const chars = Array.from(text)
      return chars.length > max ? chars.slice(0, max).join('') + '…' : text
    }

    function clampBytes(text, maxBytes) {
      if (typeof TextEncoder !== 'function') return shorten(text, maxBytes)
      const encoder = new TextEncoder()
      if (encoder.encode(text).length <= maxBytes) return text
      let result = ''
      let used = 0
      for (const char of text) {
        const bytes = encoder.encode(char).length
        if (used + bytes > maxBytes) break
        result += char
        used += bytes
      }
      return result + '…'
    }

    function levelOf(rules, text) {
      const hit = rules.find((rule) => rule.test.test(text))
      return hit === undefined ? 1 : hit.level
    }

    function severityOf(toolName, reason) {
      const toolLevel = levelOf(TOOL_RULES, toolName.trim())
      const reasonLevel = levelOf(REASON_RULES, reason)
      return LEVEL_STYLE[Math.max(toolLevel, reasonLevel)]
    }

    function hashCode(text) {
      let hash = 5381
      for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
      }
      return (hash >>> 0).toString(36)
    }

    /**
     * Build the options object for a rewritten notification. Only a small,
     * well-known set of fields is copied over: unknown fields from the caller
     * must never make the constructor throw.
     */
    function safeOptions(options, body, tag) {
      const source = options !== null && typeof options === 'object' ? options : {}
      const next = {}
      if (body !== '') next.body = clampBytes(body, MAX_BODY_BYTES)
      if (typeof source.icon === 'string' && source.icon !== '') next.icon = source.icon
      if (typeof source.requireInteraction === 'boolean') {
        next.requireInteraction = source.requireInteraction
      }
      if (typeof source.silent === 'boolean') next.silent = source.silent
      if (typeof source.lang === 'string' && source.lang !== '') next.lang = source.lang
      if (typeof source.dir === 'string' && source.dir !== '') next.dir = source.dir
      if (typeof source.timestamp === 'number' && Number.isFinite(source.timestamp)) {
        next.timestamp = source.timestamp
      }
      next.tag = typeof source.tag === 'string' && source.tag !== ''
        ? 'dsh-window-focus:' + source.tag
        : tag
      // A replaced notification with the same tag should not alert again.
      next.renotify = false
      return next
    }

    /**
     * Rewrite the parts of a harness notification that should not reach the OS
     * verbatim. Returns null for anything that is not a harness notification,
     * so unrelated notifications pass through untouched.
     * @returns {{ title: string, options: NotificationOptions } | null}
     */
    function decorate(rawTitle, options) {
      const heading = textOf(rawTitle)
      if (!DSH_TITLE.test(heading)) return null

      if (heading.includes(QUESTION_TITLE)) {
        const body = '需要你回答一个问题，点击回到 DeepSeek Harness。'
        return {
          title: '❓ ' + heading,
          options: safeOptions(options, body, 'dsh-window-focus:question:' + hashCode(heading + body)),
        }
      }

      if (!heading.includes(APPROVAL_TITLE)) {
        // Turn-finished and error notifications keep their text; only the
        // click-to-focus behaviour applies to them.
        return { title: heading, options: safeOptions(options, textOf(options?.body), 'dsh-window-focus:' + hashCode(heading + textOf(options?.body))) }
      }

      const body = textOf(options?.body)
      const matched = /^工具「([\s\S]*?)」：([\s\S]*)$/.exec(body)
      const toolName = matched ? matched[1] : ''
      const reason = matched ? matched[2] : body
      const severity = severityOf(toolName, reason)
      const shortened = shorten(reason, MAX_REASON)
      const nextBody = toolName === ''
        ? shortened
        : '工具「' + toolName + '」：' + shortened
      const tag = 'dsh-window-focus:approval:' + hashCode(toolName + '\u0000' + reason)
      const nextOptions = safeOptions(options, nextBody, tag)

      // Keep the sender's own icon (dsh-pet's whale); severity lives in the title.
      return { title: severity.prefix + heading, options: nextOptions }
    }

    function requestFocus() {
      try {
        const pending = fetch(FOCUS_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        if (pending !== undefined && typeof pending.catch === 'function') pending.catch(() => {})
      } catch {
        // The window may be going away; there is nothing useful to report.
      }
    }

    /**
     * Once a notification has been clicked the user is looking at the app
     * already; further copies of the same request must not pop again.
     */
    const mutedUntil = new Map()
    const MUTE_MS = 90_000

    function mutedTag(tag) {
      const until = mutedUntil.get(tag)
      if (until === undefined) return false
      if (until > Date.now()) return true
      mutedUntil.delete(tag)
      return false
    }

    function silentStub() {
      return {
        close() {},
        addEventListener() {},
        removeEventListener() {},
        set onclick(_value) {},
        get onclick() {
          return null
        },
      }
    }

    return {
      apply(ctx) {
        if (location.protocol !== 'dsh-app:') return
        if (typeof window.Notification !== 'function') return
        if (window.__dshWindowFocusInstalled === true) return

        const NativeNotification = window.Notification
        const WrappedNotification = new Proxy(NativeNotification, {
          construct(target, args) {
            let decorated
            try {
              decorated = decorate(args[0], args[1])
            } catch {
              decorated = null
            }
            if (decorated === null) {
              // Unrelated notification: construct it exactly as the caller did.
              return Reflect.construct(target, args)
            }

            const tag = typeof decorated.options.tag === 'string' ? decorated.options.tag : undefined
            if (tag !== undefined && mutedTag(tag)) {
              // The user already clicked this request; do not pop it again.
              return silentStub()
            }

            let notification
            try {
              notification = Reflect.construct(target, [decorated.title, decorated.options])
            } catch {
              try {
                notification = Reflect.construct(target, [decorated.title, { body: decorated.options.body }])
              } catch {
                return Reflect.construct(target, args)
              }
            }
            const onClick = () => {
              if (tag !== undefined) mutedUntil.set(tag, Date.now() + MUTE_MS)
              try {
                notification.close()
              } catch {
                // Closing is best effort.
              }
              requestFocus()
            }
            try {
              notification.addEventListener('click', onClick, { once: true })
            } catch {
              // A notification that cannot take listeners still works normally.
            }
            return notification
          },
          get(target, property) {
            // WebIDL static members reject a foreign `this`; call them with the
            // native constructor so permission checks keep working.
            if (property === 'requestPermission') {
              return target.requestPermission.bind(target)
            }
            return Reflect.get(target, property, target)
          },
        })

        window.Notification = WrappedNotification
        window.__dshWindowFocusInstalled = true

        ctx.effect(() => () => {
          if (window.Notification === WrappedNotification) {
            window.Notification = NativeNotification
          }
          window.__dshWindowFocusInstalled = false
        })
      },
    }
  },
})
