/**
 * 缓存策略：
 *   - 导航请求（index.html）：网络优先 → 保证新发布立刻生效，断网时回退缓存；
 *   - /assets/*（文件名带内容哈希）：缓存优先，跨发布复用；
 *   - /draco/*、/pdfjs/*：缓存优先，首次访问时顺手存入（都是小文件）；
 *   - **/content/* 一律接都不接**：大二进制交给网络与浏览器 HTTP 缓存（原因见下）；
 *   - config/museum.json 等：网络优先 → 改配置不必重新发布；
 *   - 带 Range 的请求（视频/PDF 分段）：不拦截，交给网络，避免破坏拖动进度。
 *
 * ⚠️ 为什么 /content/* 必须放行（2026-09-24 修复线上 bug）：
 *   设备模型的"正在准备 x%"完全依赖 `ProgressEvent.loaded / total`（deviceModel.ts:107-108），
 *   而 WebKit 在 **Service Worker 应答的下载里会丢失进度事件**：
 *     - WebKit #256696 REGRESSION (iOS 16): Missing progress during ServiceWorker downloads
 *     - WebKit #258412 SW 流式响应在 iOS 上被上报成 0kb
 *     - WebKit #303097 / #286060 SW 下载被静默丢弃 / 提前中断
 *   结果：iPhone 上场地模型（39 MB）的进度永远到不了 100%，加载卡片一直停在"正在准备"。
 *   另外 `response.clone()` 会把 39 MB 响应在内存里再存一份，而此刻 WebGL 正在分配
 *   数百 MB 贴图（本馆场地模型解码后约 400 MB），在 iOS 的内存/显存上限下雪上加霜。
 *   这几张大文件交给浏览器 HTTP 缓存（max-age=600）即可，收益远小于风险。
 *
 * 版本与失效：
 *   `BUILD` 由发布脚本 publish-github-pages.ps1 在每次发布时替换成时间戳，
 *   内容是版本化文件名 + 每次发布换一次内容缓存名，因此不会长期吃旧素材；
 *   `assets` 缓存按内容哈希命名，跨发布保留，省掉重复下载的 4.5 MB 前端代码。
 *
 * 注意：Service Worker 只在安全上下文（https 或 http://localhost）注册。
 *   展厅内网用 http://192.168.x.x 打开时它不会生效（也不报错），内网本来就不缺带宽。
 */
const BUILD = '20261009090039'; // 发布脚本会替换为 yyyyMMddHHmmss；本地调试保持 dev
const CONTENT_CACHE = `museum-content-${BUILD}`;
const ASSET_CACHE = 'museum-assets-v1';
const CORE = ['./', './index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CONTENT_CACHE);
      await cache.addAll(CORE).catch(() => {});
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([CONTENT_CACHE, ASSET_CACHE]);
      for (const name of await caches.keys()) {
        if (!keep.has(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

/** 缓存优先：命中即返回；未命中则取网络并在成功后写入缓存。 */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response && response.ok && response.status === 200) {
    // 克隆后写缓存；写失败不影响本次响应。
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

/** 网络优先：保证配置与新发布及时生效，失败时回退缓存（离线可用）。 */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok && response.status === 200) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  // 跨域（天地图瓦片、720yun 嵌入、对象存储素材）不插手，避免改变第三方行为。
  if (url.origin !== self.location.origin) return;
  // 分段请求（视频拖动、大字库 PDF）交给网络：Cache Storage 不适合承载 206。
  if (request.headers.has('range')) return;

  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(networkFirst(request, CONTENT_CACHE));
    return;
  }
  if (url.pathname.includes('/assets/')) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }
  // /content/* 一律放行（不 respondWith）：大二进制交给网络 + 浏览器 HTTP 缓存。
  // 理由见文件头：WebKit 在 SW 应答的下载中会丢失 ProgressEvent（#256696），
  // 而设备页的"正在准备 x%"就靠它驱动 —— 被 SW 接管后 iPhone 上卡片永不消失。
  if (/\/content\//.test(url.pathname)) return;
  if (/\/draco\/|\/pdfjs\//.test(url.pathname)) {
    event.respondWith(cacheFirst(request, CONTENT_CACHE));
    return;
  }
  event.respondWith(networkFirst(request, CONTENT_CACHE));
});
