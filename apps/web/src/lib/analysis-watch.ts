"use client"

/**
 * Shared plumbing between "somewhere started an analysis" and the app-wide watcher that reports
 * when it finishes. Kept out of the component so any surface can start a run without importing
 * the watcher, and so the watcher stays a single instance in the signed-in layout.
 */

type Listener = () => void

const listeners = new Set<Listener>()

/** Tell the watcher to look now rather than at its next idle poll. */
export function analysisStarted() {
  for (const listener of [...listeners]) listener()
}

export function onAnalysisStarted(listener: Listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notificationsSupported(): boolean {
  return typeof window !== "undefined" && typeof window.Notification !== "undefined"
}

/**
 * Ask for desktop notifications at the moment the reason is obvious and the click is still a user
 * gesture. Never called on page load: an unprompted permission dialog is the fastest way to get
 * permanently denied. Safe to call repeatedly; the browser only prompts once.
 */
export function requestAnalysisNotifications() {
  if (!notificationsSupported() || Notification.permission !== "default") return
  try {
    // Older Safari passes a callback instead of returning a promise; both are fine here.
    void Promise.resolve(Notification.requestPermission()).catch(() => {})
  } catch {
    // A browser that throws on the call simply does not get desktop notifications.
  }
}

/** Show a desktop notification, if the user allowed them. Returns whether one was shown. */
export function showAnalysisNotification(title: string, body: string, tag: string): boolean {
  if (!notificationsSupported() || Notification.permission !== "granted") return false
  try {
    new Notification(title, { body, tag })
    return true
  } catch {
    return false
  }
}
