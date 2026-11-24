/**
 * Browser half of dsh-window-focus.
 *
 * Every system notification created by the page gets a click listener that
 * asks the host to raise the desktop window. Other plugins keep their own
 * click handlers untouched. Nothing happens in a plain browser session,
 * where there is no harness window to raise.
 */

window.__ModuleLoader__.load({
  id: 'dsh-window-focus',
  factory() {
    const FOCUS_ENDPOINT = '/dsh-window-focus/focus'

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

    return {
      apply(ctx) {
        if (location.protocol !== 'dsh-app:') return
        if (typeof window.Notification !== 'function') return
        if (window.__dshWindowFocusInstalled === true) return

        const NativeNotification = window.Notification
        const WrappedNotification = new Proxy(NativeNotification, {
          construct(target, args) {
            const notification = Reflect.construct(target, args)
            try {
              notification.addEventListener('click', requestFocus, { once: true })
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
