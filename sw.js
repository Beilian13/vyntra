/* Vyntra Service Worker
 * - Keeps app alive during calls (cache + heartbeat)
 * - Handles Web Push notifications for messages + calls
 */

const CACHE = 'vyntra-v2';
const STATIC = ['/', 'index.html'];

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e){
  var url = new URL(e.request.url);
  if (url.pathname.startsWith('/auth') ||
      url.pathname.startsWith('/livekit') ||
      url.pathname.startsWith('/push') ||
      e.request.headers.get('upgrade') === 'websocket') return;
  e.respondWith(
    caches.match(e.request).then(function(cached){
      var network = fetch(e.request).then(function(res){
        if (res && res.status === 200 && res.type === 'basic'){
          var clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => {});
      return cached || network;
    })
  );
});

/* Push: show notification */
self.addEventListener('push', function(e){
  if (!e.data) return;
  var data = {};
  try { data = e.data.json(); } catch(err) { return; }
  var title = data.title || 'Vyntra';
  var options = {
    body:  data.body || '',
    icon:  '/icon-192.png',
    badge: '/icon-192.png',
    tag:   data.type === 'call' ? 'vyntra-call' : ('vyntra-msg-' + (data.channelId || 'dm')),
    renotify: true,
    data: { url: data.url || '/' },
    vibrate: data.type === 'call' ? [200,100,200,100,200] : [100],
    requireInteraction: data.type === 'call',
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

/* Notification click */
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  var targetUrl = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list){
      for (var i = 0; i < list.length; i++){
        if (list[i].url.startsWith(self.location.origin)){ list[i].focus(); return; }
      }
      return clients.openWindow(targetUrl);
    })
  );
});

/* Heartbeat from page during calls */
self.addEventListener('message', function(e){
  if (e.data && e.data.type === 'CALL_ACTIVE'){
    e.ports[0] && e.ports[0].postMessage({ type: 'SW_ALIVE' });
  }
});
