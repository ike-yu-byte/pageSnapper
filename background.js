/**
 * background.js — MV3 Service Worker
 *
 * 职责边界刻意收窄：只负责注入采集脚本、把结果转交 offscreen。
 * 打包与下载必须放在 offscreen —— Service Worker 里没有 URL.createObjectURL。
 */

const OFFSCREEN_URL = 'offscreen.html';

const PORT_NAME = 'page-snapper';

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'start') return;
    run(port, msg.options).catch((err) => {
      // 同时打到 Service Worker 的 console，便于在 chrome://extensions 的
      // "检查视图 → Service Worker" 中查看完整堆栈
      console.error('[Page Snapper] 流程失败:', err);
      try {
        port.postMessage({
          type: 'error',
          message: String((err && err.message) || err),
          stack: err && err.stack ? String(err.stack) : ''
        });
      } catch (e) { /* popup 可能已关闭 */ }
    });
  });
});

async function ensureOffscreen() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts && contexts.length) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: '打包素材为 ZIP 并使用 Blob URL 触发下载'
    });
  } catch (e) {
    if (!/already exists|single offscreen/i.test(String((e && e.message) || e))) throw e;
  }
}

async function run(port, options) {
  const progress = (stage, detail, extra) => {
    try {
      port.postMessage(Object.assign({ type: 'progress', stage, detail }, extra || {}));
    } catch (e) { /* popup 已关闭，忽略 */ }
  };

  // 优先使用 popup 在点击瞬间确定的目标标签页；取不到时再回退到当前活动标签页
  const opts = options || {};
  let tab = null;
  if (opts.tabId) {
    try { tab = await chrome.tabs.get(opts.tabId); } catch (e) { tab = null; }
  }
  if (!tab) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = activeTab;
  }
  if (!tab || !tab.id) throw new Error('未找到要采集的标签页');
  if (!/^https?:/i.test(tab.url || '')) {
    throw new Error('仅支持 http / https 页面，当前是：' + (tab.url || '(空)'));
  }

  progress('inject', '注入采集脚本…');
  await chrome.scripting.executeScript({ // 1. 注入采集脚本
    target: { tabId: tab.id },
    files: ['lib/collector.js']
  });

  progress('collect', '采集页面结构（滚动触发懒加载 + 读取 computed 样式）…');
  const startedAt = Date.now();
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (opts) => window.__PAGE_SNAPPER__.collect(opts), // 2. 调用注入脚本里面的window.__PAGE_SNAPPER__的collect方法
    args: [options || {}]
  });

  if (!result) throw new Error('采集未返回数据，该页面可能禁止脚本注入');

  progress('collected', '页面采集完成', {
    summary: {
      title: result.meta.title,
      url: result.meta.url,
      elements: result.meta.elementCount,
      blocks: result.meta.blockCount,
      images: (result.images || []).length,
      ms: Date.now() - startedAt
    }
  });

  await ensureOffscreen();

  progress('assets', '下载图片与字体资源…');
  const resp = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'build-package',
    data: result
  });

  if (!resp || !resp.ok) {
    throw new Error((resp && resp.error) || '打包失败（offscreen 无响应）');
  }
  if (!resp.blobUrl) {
    throw new Error('offscreen 未返回 blob URL，无法保存文件');
  }

  progress('save', '保存 ZIP 到下载目录…');
  let downloadId;
  try {
    // chrome.downloads 只在 Service Worker / 扩展页面可用，offscreen 里是 undefined
    downloadId = await chrome.downloads.download({
      url: resp.blobUrl,
      filename: resp.fileName,
      saveAs: false
    });
  } catch (e) {
    throw new Error('调用下载接口失败: ' + ((e && e.message) || e));
  }

  // blobUrl 只是下载用的中转，不必回传给界面。
  // 注意不要命名为 result —— 上面 executeScript 的解构已经占用了这个名字。
  const summary = Object.assign({}, resp, { downloadId });
  delete summary.blobUrl;

  progress('done', '素材包已开始下载', { result: summary });
  return summary;
}
