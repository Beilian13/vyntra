/* Vyntra Service Worker
 * Keeps the app alive in background during calls so audio doesn't drop.
 * Strategy: cache-first for static assets, network-first for API calls.
 */

const CACHE = 'vyntra-v1';
const STATIC = ['/','index.html'];

/* ── Install: pre-cache shell ── */
self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(c){ return c.addAll(STATIC); })
  );
  self.skipWaiting();
});

/* ── Activate: claim all clients immediately ── */
self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)));
    })
  );
  self.clients.claim();
});

/* ── Fetch: network-first for API/WS, cache-first for assets ── */
self.addEventListener('fetch', function(e){
  var url = new URL(e.request.url);

  // Never intercept WebSocket upgrades or API calls
  if(url.pathname.startsWith('/auth') ||
     url.pathname.startsWith('/livekit') ||
     e.request.headers.get('upgrade') === 'websocket'){
    return;
  }

  // Cache-first for the app shell
  e.respondWith(
    caches.match(e.request).then(function(cached){
      var network = fetch(e.request).then(function(res){
        if(res && res.status === 200 && res.type === 'basic'){
          var clone = res.clone();
          caches.open(CACHE).then(function(c){ c.put(e.request, clone); });
        }
        return res;
      }).catch(function(){});
      return cached || network;
    })
  );
});

/* ── Message: ping from page keeps SW alive during calls ── */
self.addEventListener('message', function(e){
  if(e.data && e.data.type === 'CALL_ACTIVE'){
    // Respond to confirm we're alive — page uses this as a heartbeat
    e.ports[0] && e.ports[0].postMessage({type:'SW_ALIVE'});
  }
});
