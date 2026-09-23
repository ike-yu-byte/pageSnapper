/**
 * offscreen.js — 素材包打包器
 *
 * 为什么必须放在 offscreen：MV3 的 Service Worker 里 URL.createObjectURL 已被移除，
 * 无法把内存中的 ZIP 字节变成可交给 downloads API 的 blob URL。
 *
 * 这里承担重量级工作：抓取图片/字体（利用扩展的 host 权限绕过 CORS）→ 生成文件树 → 打 ZIP → 下载。
 */

import { buildPackage, extractFontUrls, suggestPackageName } from './lib/packager.js';
import { ZipWriter } from './lib/zip.js';

const FETCH_CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 25000;

// 最近一次生成的 blob URL。下次打包前释放，避免内存泄漏；
// 下载期间必须保持有效，所以不做即时 revoke。
let lastBlobUrl = '';

function report(stage, detail, extra) {
  try {
    chrome.runtime.sendMessage(Object.assign({ type: 'progress', stage, detail }, extra || {})).catch(() => {});
  } catch (e) { /* 没有接收者时忽略 */ }
}

function chunkArray(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function decodeDataUrl(dataUrl) {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  const isBase64 = !!m[2];
  const payload = m[3];
  if (isBase64) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, contentType: mime };
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), contentType: mime };
}

async function fetchAsset(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // force-cache：图片通常刚被页面加载过，直接命中浏览器缓存，又快又不重复消耗流量
    const res = await fetch(url, {
      signal: controller.signal,
      credentials: 'omit',
      cache: 'force-cache'
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buffer = await res.arrayBuffer();
    return {
      bytes: new Uint8Array(buffer),
      contentType: res.headers.get('content-type') || ''
    };
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('请求超时（' + FETCH_TIMEOUT_MS + 'ms）');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const FONT_EXT_BY_MIME = {
  'font/woff2': 'woff2',
  'font/woff': 'woff',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'application/font-woff': 'woff',
  'application/x-font-ttf': 'ttf',
  'application/vnd.ms-fontobject': 'eot'
};

function guessFontFileName(url, index, contentType) {
  let file = '';
  try {
    file = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  } catch (e) {
    file = String(url).split('?')[0].split('/').pop() || '';
  }
  file = file.split('?')[0].replace(/[._-][0-9a-f]{6,}(?=\.[a-z0-9]+$)/i, '');
  const m = /^(.+?)(?:\.([a-z0-9]{2,5}))?$/i.exec(file);
  let base = (m && m[1]) || 'font';
  let ext = (m && m[2] ? m[2] : '').toLowerCase();
  if (!ext) ext = FONT_EXT_BY_MIME[String(contentType || '').split(';')[0].trim().toLowerCase()] || 'bin';
  base = base.replace(/[^a-zA-Z0-9\u4e00-\u9fa5-]/g, '-').slice(0, 40) || 'font';
  return String(index + 1).padStart(2, '0') + '-' + base + '.' + ext;
}

async function collectImageAssets(data, assetMap, failures) {
  const targets = (data.images || []).filter((r) => r.url || r.inlineData || r.svgText);
  const total = targets.length;
  let processed = 0;
  const queue = targets.slice();

  async function worker() {
    while (queue.length) {
      const res = queue.shift();
      try {
        if (res.svgText) {
          assetMap.set(res.id, {
            bytes: new TextEncoder().encode(res.svgText),
            contentType: 'image/svg+xml'
          });
        } else if (res.inlineData) {
          const decoded = decodeDataUrl(res.inlineData);
          if (decoded) assetMap.set(res.id, decoded);
          else throw new Error('内联数据无法解码');
        } else if (res.url && res.url.startsWith('data:')) {
          const decoded = decodeDataUrl(res.url);
          if (decoded) assetMap.set(res.id, decoded);
          else throw new Error('内联数据无法解码');
        } else if (res.url) {
          assetMap.set(res.id, await fetchAsset(res.url));
        }
      } catch (e) {
        const message = String((e && e.message) || e);
        res.fetchError = message;
        failures.push({ kind: res.kind, url: res.url || '(inline)', error: message });
      } finally {
        processed++;
        if (processed % 4 === 0 || processed === total) {
          report('assets-progress', '资源 ' + processed + ' / ' + total, {
            pct: total ? Math.round((processed / total) * 100) : 100
          });
        }
      }
    }
  }

  const pool = Math.max(1, Math.min(FETCH_CONCURRENCY, total));
  await Promise.all(Array.from({ length: pool }, worker));
  return { total, ok: assetMap.size, failed: failures.length };
}

async function collectFontAssets(data, fontMap, failures) {
  const urls = extractFontUrls(data);
  if (!urls.length) return { total: 0, ok: 0 };

  let done = 0;
  for (const chunk of chunkArray(urls, FETCH_CONCURRENCY)) {
    await Promise.all(chunk.map(async (url) => {
      const index = urls.indexOf(url);
      try {
        const asset = await fetchAsset(url);
        fontMap.set(url, {
          bytes: asset.bytes,
          contentType: asset.contentType,
          fileName: guessFontFileName(url, index, asset.contentType)
        });
      } catch (e) {
        failures.push({ kind: 'font', url, error: String((e && e.message) || e) });
      } finally {
        done++;
        report('fonts-progress', '字体 ' + done + ' / ' + urls.length, {
          pct: Math.round((done / urls.length) * 100)
        });
      }
    }));
  }
  return { total: urls.length, ok: fontMap.size };
}

async function buildAndDownload(data) {
  const assetMap = new Map();
  const fontMap = new Map();
  const failures = [];

  const imgStat = await collectImageAssets(data, assetMap, failures);
  const fontStat = await collectFontAssets(data, fontMap, failures);

  report('pack', '生成包内文件…');
  const files = buildPackage(data, assetMap, fontMap);

  report('zip', '打包 ZIP（' + files.length + ' 个文件）…');
  const zip = new ZipWriter();
  for (const f of files) zip.add(f.path, f.data);
  const bytes = zip.build();

  // offscreen document 的扩展 API 被大幅裁剪，chrome.downloads 在这里是 undefined，
  // 因此本页只负责把字节转成 blob URL，真正的下载由 Service Worker 执行。
  // blob URL 是 origin 级的，offscreen 与 SW 同源，可以跨上下文使用。
  if (lastBlobUrl) {
    try { URL.revokeObjectURL(lastBlobUrl); } catch (e) { /* ignore */ }
    lastBlobUrl = '';
  }
  const blob = new Blob([bytes], { type: 'application/zip' });
  lastBlobUrl = URL.createObjectURL(blob);
  const fileName = suggestPackageName(data.meta) + '.zip';

  return {
    ok: true,
    fileName,
    blobUrl: lastBlobUrl,
    fileCount: files.length,
    bytes: bytes.length,
    images: imgStat,
    fonts: fontStat,
    failures: failures.length,
    failedItems: failures.slice(0, 15)
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 便于排查"消息是否送达 / 处理卡在哪一步"（可在扩展详情页的检查视图里查看）
  self.__OFFSCREEN_MSG_COUNT__ = (self.__OFFSCREEN_MSG_COUNT__ || 0) + 1;
  self.__OFFSCREEN_LAST_MSG__ = msg && msg.type ? msg.type : '(unknown)';
  self.__OFFSCREEN_STAGE__ = 'received:' + self.__OFFSCREEN_LAST_MSG__;

  if (!msg || msg.target !== 'offscreen') return false;

  if (msg.type === 'build-package') {
    buildAndDownload(msg.data)
      .then((result) => {
        self.__OFFSCREEN_STAGE__ = 'responded:ok';
        sendResponse(result);
      })
      .catch((e) => {
        self.__OFFSCREEN_ERR__ = String((e && e.stack) || e);
        self.__OFFSCREEN_STAGE__ = 'responded:error';
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    return true; // 异步响应
  }

  return false;
});
