import { mount } from 'svelte'
import './app.css'
import { keepScreenAwake } from './lib/keepAwake'
import App from './App.svelte'

const app = mount(App, {
  target: document.getElementById('app')!,
})

// Service workers need a secure context. localhost qualifies, a plain-http LAN
// address does not, so registration is skipped rather than throwing there.
keepScreenAwake()

if ("serviceWorker" in navigator && window.isSecureContext) {
  // Registering immediately rather than on "load": module scripts can run after
  // that event has already fired, in which case the listener never runs.
  navigator.serviceWorker.register("/sw.js").catch((err) => {
    console.warn("Service worker registration failed", err)
  })
}

export default app
