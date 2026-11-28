/**
 * Browser half of dsh-window-focus.
 *
 * On the desktop page (`dsh-app://`) this module:
 *
 * 1. Raises the desktop window when a DeepSeek Harness notification is
 *    clicked, so the app comes back to the foreground.
 * 2. Suppresses dsh-pet's approval and question copies on the desktop page: the
 *    host plugin already shows one native notification for each (approval with
 *    allow / reject buttons, question as a plain reminder without options), so
 *    letting the duplicate through would ask twice.
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
    const DISMISS_ENDPOINT = '/dsh-window-focus/dismiss'
    const STATE_ENDPOINT = '/dsh-window-focus/state'
    const DECISIONS_ENDPOINT = '/dsh-window-focus/decisions'
    const APPROVAL_TITLE = '正在申请权限'
    const QUESTION_TITLE = '模型在等你回答'
    const DSH_TITLE = /(正在申请权限|模型在等你回答|对话完成|生成失败|输出被截断)/
    const MAX_BODY_BYTES = 1800

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

      if (heading.includes(APPROVAL_TITLE)) {
        // The host already shows one actionable toast (allow / reject) for
        // approvals; letting dsh-pet's copy through would ask twice.
        return { suppress: true }
      }

      if (heading.includes(QUESTION_TITLE)) {
        // The host shows one plain "you have been asked a question" toast for
        // every question, even while the window is focused; dsh-pet's copy is
        // suppressed to avoid two notifications asking the same thing.
        return { suppress: true }
      }

      // Turn-finished and error notifications keep their text; only the
      // click-to-focus behaviour applies to them.
      return { title: heading, options: safeOptions(options, textOf(options?.body), 'dsh-window-focus:' + hashCode(heading + textOf(options?.body))) }
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
            if (decorated.suppress === true) {
              // Approval duplicates are owned by the host's actionable toast.
              return silentStub()
            }

            const tag = typeof decorated.options.tag === 'string' ? decorated.options.tag : undefined
            // Only questions participate in click muting: turn-finished
            // notifications legitimately repeat with identical text.
            const mutable = tag !== undefined && tag.startsWith('dsh-window-focus:question:')
            if (mutable && mutedTag(tag)) {
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

        // Coming back through the app window (or Alt-Tab) should clear the
        // toast: the pending approval is answered in the in-app card instead.
        let lastDismiss = 0
        const postState = (focused) => {
          fetch(STATE_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ focused }),
          }).catch(() => {})
        }
        const onWindowFocus = () => {
          postState(true)
          const now = Date.now()
          if (now - lastDismiss < 1500) return
          lastDismiss = now
          fetch(DISMISS_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          }).catch(() => {})
        }
        const onWindowBlur = () => postState(false)
        window.addEventListener('focus', onWindowFocus)
        window.addEventListener('blur', onWindowBlur)
        postState(typeof document !== 'undefined' && document.hasFocus())

        // A request can already be shown as an in-app card when the user steps
        // away and answers it from the toast. The host reports those toast
        // decisions here; pressing the matching card button lets the normal UI
        // close the card and finish the interaction instead of leaving a
        // zombie card behind.
        const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
        const handledDecisions = new Set()
        const findCard = (decision) => {
          if (typeof document === 'undefined') return undefined
          const cards = Array.from(document.querySelectorAll('[data-approval-key]'))
          if (cards.length === 0) return undefined
          const needle = normalize(decision.reason).slice(0, 40)
          if (needle !== '') {
            const matching = cards.find((card) => normalize(card.textContent).includes(needle))
            if (matching !== undefined) return matching
          }
          return cards.length === 1 ? cards[0] : undefined
        }
        const pressCard = (card, outcome) => {
          const buttons = Array.from(card.querySelectorAll('button'))
          const pattern = outcome === 'rejected' ? /拒绝|reject|deny/i : /允许|allow/i
          const button = buttons.find((candidate) => !candidate.disabled && pattern.test(normalize(candidate.textContent)))
          if (button !== undefined) button.click()
        }
        const pollDecisions = async () => {
          if (typeof document === 'undefined') return
          if (document.querySelector('[data-approval-key]') === null) return
          try {
            const response = await fetch(DECISIONS_ENDPOINT, { headers: { accept: 'application/json' } })
            if (!response.ok) return
            const data = await response.json()
            for (const decision of data.decisions ?? []) {
              if (typeof decision.id !== 'string' || handledDecisions.has(decision.id)) continue
              handledDecisions.add(decision.id)
              const card = findCard(decision)
              if (card !== undefined) pressCard(card, decision.outcome)
            }
          } catch {
            // The window may be closing; the next tick can retry.
          }
        }
        const pollTimer = setInterval(pollDecisions, 700)

        ctx.effect(() => () => {
          clearInterval(pollTimer)
          window.removeEventListener('focus', onWindowFocus)
          window.removeEventListener('blur', onWindowBlur)
          if (window.Notification === WrappedNotification) {
            window.Notification = NativeNotification
          }
          window.__dshWindowFocusInstalled = false
        })
      },
    }
  },
})
