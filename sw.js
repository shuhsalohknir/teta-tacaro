const CACHE_NAME = 'teta-tacaro-v3';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json'
];

// Instala e ativa imediatamente
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
});

// Limpa caches antigos e assume o controle
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Estratégia: Network First (tenta a internet primeiro, depois o cache)
// Assim as atualizações aparecem rápido no app instalado
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Se a resposta for boa, atualiza o cache
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Se estiver offline, usa o cache
        return caches.match(event.request).then(cached => cached || caches.match('/'));
      })
  );
});

// Escuta mensagens para forçar atualização
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
