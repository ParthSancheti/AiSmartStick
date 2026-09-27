/* Guardian PWA background push (FCM). Config is passed in the registration URL (?config=...)
   by src/core/native/notifications.ts, so no project values are hardcoded here. */
importScripts('https://www.gstatic.com/firebasejs/12.4.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.4.0/firebase-messaging-compat.js');

const config = JSON.parse(new URL(self.location.href).searchParams.get('config') || '{}');
if (config.apiKey) {
  firebase.initializeApp(config);
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage((payload) => {
    const n = payload.notification || {};
    self.registration.showNotification(n.title || 'AI Smart Stick', {
      body: n.body || '',
      tag: (payload.data && payload.data.kind) || 'aiss',
      requireInteraction: payload.data && payload.data.kind === 'sos',
      data: payload.data || {},
    });
  });
}
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then((w) => (w[0] ? w[0].focus() : clients.openWindow('/'))));
});
