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
      try {
        port.postMessage({
          type: 'error',
          message: String((err && err.message) || err)
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

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error('未找到当前活动标签页');
  if (!/^https?:/i.test(tab.url || '')) {
    throw new Error('仅支持 http / https 页面，当前是：' + (tab.url || '(空)'));
  }

  progress('inject', '注入采集脚本…');
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['lib/collector.js']
  });

  progress('collect', '采集页面结构（滚动触发懒加载 + 读取 computed 样式）…');
  const startedAt = Date.now();
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (opts) => window.__PAGE_SNAPPER__.collect(opts),
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

  progress('done', '素材包已开始下载', { result: resp });
  return resp;
}
