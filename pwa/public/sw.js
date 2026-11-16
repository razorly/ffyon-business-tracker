const cacheName = "ffyon-offline-v1";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.add(new Request("/offline.html", { cache: "reload" }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("ffyon-offline-") && name !== cacheName) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate" || event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname !== "/") return;
  // Only the public offline message is stored. API calls never enter Cache Storage.
  event.respondWith(fetch(event.request).catch(async () => (await caches.match("/offline.html")) || Response.error()));
});

function alertUrl(target) {
  try {
    const url = new URL(target, self.location.origin);
    if (url.origin === self.location.origin && url.pathname === "/" && !url.search &&
        ["#/todo", "#/mail"].includes(url.hash)) return url.href;
  } catch { /* Open the tracker for unrecognized destinations. */ }
  return new URL("/", self.location.origin).href;
}

self.addEventListener("push", (event) => {
  if (event.notification) return; // Newer WebKit displays the declarative notification.
  let message;
  try { message = event.data?.json()?.notification; } catch { /* Display the generic notification. */ }
  const url = alertUrl(message?.navigate);
  const tag = new URL(url).hash === "#/mail" ? "ffyon-mail" : "ffyon-todo";
  event.waitUntil(self.registration.showNotification("Tanned by Ffy", {
    body: typeof message?.body === "string" ? message.body : "Open the tracker to see what's new.",
    tag,
    data: { url },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = alertUrl(event.notification.data?.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) {
      const updated = await existing.navigate(url).catch(() => null);
      if (updated) { await updated.focus(); return; }
    }
    await self.clients.openWindow(url);
  })());
});
