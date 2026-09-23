/**
 * extension-e2e.mjs — 真实扩展环境验证
 *
 * 为什么需要它：test/e2e.mjs 只覆盖纯函数与产物流水线，而"offscreen document 里
 * chrome.downloads 是 undefined"这类问题只有把扩展真正装进浏览器、跑真实 API 才暴露。
 *
 * 本脚本验证两件事：
 *   A. API 可用性差异 —— offscreen 里 chrome.downloads 不可用，扩展页面/SW 里可用。
 *      这正是"下载必须放在 SW 执行"这一修复的依据。
 *   B. 跨上下文 blob URL —— offscreen 创建 blob URL，交给扩展页面/SW 调 downloads 下载。
 *      这是修复方案成立的关键前提（blob URL 是 origin 级的，同源可跨上下文使用）。
 *
 * 环境限制说明：MV3 的 Service Worker 在 headless 下不会启动（Target 列表与
 * runtime.getContexts 都看不到 SERVICE_WORKER），因此无法在此环境跑通 SW 调度全链路；
 * 该链路已在真实浏览器中验证（用户实际使用时进度能推进到打包阶段）。
 *
 * 用法：node test/extension-e2e.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'output');
const DOWNLOADS = path.join(OUT, 'downloads');
const FIXTURE = path.join(__dirname, 'fixture.html');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9444', 10);
const HTTP_PORT = 8787;

const EXPECTED_PERMISSIONS = ['activeTab', 'scripting', 'downloads', 'offscreen', 'storage'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.on('unhandledRejection', (reason) => {
  console.error('[ext-e2e] 未处理的拒绝: ' + (reason && reason.stack ? reason.stack : String(reason)));
  process.exitCode = 1;
});

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => {
        if (!this.closed) reject(new Error('CDP 连接失败'));
      });
      this.ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
      });
    });
  }
  send(method, params, sessionId, timeoutMs) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = { id, method, params: params || {} };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时: ' + method));
        }
      }, timeoutMs || 120000);
    });
  }
  async evaluate(sessionId, expression, timeoutMs) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, sessionId, timeoutMs || 60000);
    if (r.exceptionDetails) {
      throw new Error('页面内执行异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    }
    return r.result ? r.result.value : undefined;
  }
  close() {
    this.closed = true;
    try { this.ws.close(); } catch (e) { /* ignore */ }
  }
}

async function httpJson(pathname) {
  const res = await fetch('http://127.0.0.1:' + CDP_PORT + pathname);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function waitForCdp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await httpJson('/json/version'); } catch (e) { await sleep(300); }
  }
  throw new Error('等待 Chrome 调试端口超时');
}

function startFixtureServer() {
  const html = fs.readFileSync(FIXTURE);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(HTTP_PORT, '127.0.0.1', () => resolve(server)));
}

async function openPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const v = await cdp.evaluate(sessionId, 'document.readyState', 10000);
      if (v === 'complete') break;
    } catch (e) { /* retry */ }
    await sleep(250);
  }
  await sleep(500);
  return sessionId;
}

/** 找到 offscreen document 的 target（CDP 里表现为 background_page 类型） */
async function findOffscreenTarget(cdp, extId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const hit = targetInfos.find((t) => String(t.url).indexOf('/offscreen.html') !== -1);
    if (hit) return hit;
    await sleep(400);
  }
  return null;
}

async function main() {
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  for (const f of fs.readdirSync(DOWNLOADS)) {
    fs.rmSync(path.join(DOWNLOADS, f), { force: true, recursive: true });
  }

  const server = await startFixtureServer();
  const profile = path.join(os.tmpdir(), 'page-snapper-ext-' + Date.now());
  const pageUrl = 'http://127.0.0.1:' + HTTP_PORT + '/';

  console.log('[ext-e2e] 测试页: ' + pageUrl);
  console.log('[ext-e2e] 待加载扩展: ' + ROOT);

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile,
    '--enable-unsafe-extension-debugging',
    '--window-size=1440,900',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--mute-audio',
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  let cdp = null;
  const results = {};

  try {
    await waitForCdp(25000);
    const version = await httpJson('/json/version');
    cdp = new CDP(version.webSocketDebuggerUrl);
    await cdp.connect();

    const loaded = await cdp.send('Extensions.loadUnpacked', { path: ROOT }, null, 30000);
    const extId = loaded.id;
    console.log('[ext-e2e] 扩展已加载，ID = ' + extId);

    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });

    // ---- 测试页与驱动端（扩展页面）
    await openPage(cdp, pageUrl);
    const driverSession = await openPage(cdp, 'chrome-extension://' + extId + '/popup.html');
    console.log('[ext-e2e] 测试页与扩展页面已就绪');

    // ---- 步骤 1：在扩展页面里注入采集器并采集
    const collectInfo = JSON.parse(await cdp.evaluate(driverSession, `(async () => {
      const out = { permissions: chrome.runtime.getManifest().permissions };
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url && t.url.indexOf('127.0.0.1:${HTTP_PORT}') !== -1);
      if (!tab) { out.error = '未找到测试页标签'; return JSON.stringify(out); }
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['lib/collector.js'] });
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (o) => window.__PAGE_SNAPPER__.collect(o),
        args: [{ scrollFirst: true, includeFullHtml: true, waitImagesMs: 4000 }]
      });
      out.elements = result.meta.elementCount;
      out.blocks = result.meta.blockCount;
      out.images = result.images.length;
      return JSON.stringify(out);
    })()`, 120000));
    results.permissions = collectInfo.permissions;
    results.elements = collectInfo.elements || 0;
    results.blocks = collectInfo.blocks || 0;
    results.images = collectInfo.images || 0;

    // ---- 步骤 2：创建 offscreen 并读取其内部 API 可用性
    await cdp.evaluate(driverSession, `(async () => {
      const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (!existing.length) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html', reasons: ['BLOBS'], justification: '扩展端到端验证'
        });
      }
      return 'ok';
    })()`, 30000);
    await sleep(1200);

    const offTarget = await findOffscreenTarget(cdp, extId, 15000);
    if (!offTarget) throw new Error('未找到 offscreen document target');
    const { sessionId: offSession } = await cdp.send('Target.attachToTarget', {
      targetId: offTarget.targetId, flatten: true
    });
    await cdp.send('Runtime.enable', {}, offSession);

    results.offscreenApis = JSON.parse(await cdp.evaluate(offSession,
      `JSON.stringify({
        runtime: typeof chrome.runtime,
        onMessage: typeof (chrome.runtime && chrome.runtime.onMessage),
        onMessageHasListeners: (chrome.runtime && chrome.runtime.onMessage && chrome.runtime.onMessage.hasListeners)
          ? chrome.runtime.onMessage.hasListeners() : 'n/a',
        downloads: typeof chrome.downloads,
        createObjectURL: typeof URL.createObjectURL
      })`, 20000));

    // ---- background.js 若有语法错误，Service Worker 会注册失败，这里显式检查
    const { targetInfos: allTargets } = await cdp.send('Target.getTargets');
    const ourSw = allTargets.find((t) =>
      t.type === 'service_worker' && String(t.url).indexOf(extId) !== -1);
    results.serviceWorker = ourSw ? ourSw.url : null;

    // ---- 步骤 3：offscreen 创建 blob URL
    results.offscreenBlobUrl = await cdp.evaluate(offSession, `(async () => {
      const payload = 'Page Snapper cross-context blob test\\n' + new Date().toISOString();
      const blob = new Blob([payload], { type: 'text/plain' });
      self.__TEST_BLOB_URL__ = URL.createObjectURL(blob);
      return self.__TEST_BLOB_URL__;
    })()`, 20000);

    // ---- 步骤 4：扩展页面用这个 blob URL 调 downloads 下载
    results.download = await cdp.evaluate(driverSession, `(async () => {
      try {
        if (typeof chrome.downloads !== 'object') return JSON.stringify({ err: 'chrome.downloads 不可用' });
        const id = await chrome.downloads.download({
          url: self_blobUrl_placeholder,
          filename: 'page-snapper-blob-test.txt',
          saveAs: false
        });
        return JSON.stringify({ ok: true, id });
      } catch (e) {
        return JSON.stringify({ err: (e && e.message) || String(e) });
      }
    })()`.replace('self_blobUrl_placeholder', JSON.stringify(results.offscreenBlobUrl)), 30000);

    // ---- 步骤 5：驱动真实流程 popup → SW(background.js) → offscreen → SW 下载
    // 模拟真实 popup 的行为：在"点击瞬间"确定目标标签页并传给 background
    const targetTabId = JSON.parse(await cdp.evaluate(driverSession, `(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url && t.url.indexOf('127.0.0.1:${HTTP_PORT}') !== -1);
      return JSON.stringify(tab ? tab.id : null);
    })()`, 15000));
    console.log('[ext-e2e] 目标标签页 id = ' + targetTabId);

    await cdp.evaluate(driverSession, `(() => {
      const S = window.__FLOW__ = { msgs: [], done: false, error: null };
      try {
        const port = chrome.runtime.connect({ name: 'page-snapper' });
        port.onMessage.addListener((m) => {
          S.msgs.push({ type: m.type, stage: m.stage, detail: m.detail });
          if (m.type === 'error') { S.error = m.message; S.done = true; }
          if (m.type === 'done') { S.result = m.result; S.done = true; }
        });
        port.onDisconnect.addListener(() => {
          S.disconnected = true;
          try { S.lastError = chrome.runtime.lastError && chrome.runtime.lastError.message; } catch (e) {}
          S.done = true;
        });
        port.postMessage({ type: 'start', options: { scrollFirst: true, includeFullHtml: true, tabId: ${targetTabId} } });
      } catch (e) {
        S.error = 'connect 失败: ' + ((e && e.message) || String(e));
        S.done = true;
      }
      return 'started';
    })()`, 15000);

    let flow = null;
    const flowDeadline = Date.now() + 120000;
    while (Date.now() < flowDeadline) {
      await sleep(1500);
      flow = JSON.parse(await cdp.evaluate(driverSession, 'JSON.stringify(window.__FLOW__ || null)', 15000));
      if (flow && flow.done) break;
    }
    results.flow = flow;

    await sleep(3000);
    const downloaded = fs.existsSync(DOWNLOADS) ? fs.readdirSync(DOWNLOADS) : [];

    // ---- 输出
    console.log('');
    console.log('采集: ' + results.elements + ' 元素 / ' + results.blocks + ' 区块 / ' +
      results.images + ' 图片');
    console.log('Service Worker: ' + (results.serviceWorker || '(未启动)'));
    console.log('offscreen 内 API: ' + JSON.stringify(results.offscreenApis));
    console.log('offscreen 创建的 blob URL: ' + String(results.offscreenBlobUrl).slice(0, 56));
    console.log('扩展页面下载结果: ' + results.download);
    console.log('');
    console.log('真实流程（popup → SW → offscreen → SW 下载）:');
    if (flow) {
      console.log('  完成: ' + flow.done + '，收到消息 ' + flow.msgs.length + ' 条');
      for (const m of flow.msgs) {
        console.log('    ' + (m.type === 'error' ? 'ERROR ' : '') + (m.stage || m.type) +
          (m.detail ? ' — ' + m.detail : ''));
      }
      if (flow.error) console.log('  错误: ' + flow.error);
      if (flow.disconnected) console.log('  port 断开: ' + (flow.lastError || '(无 lastError)'));
    } else {
      console.log('  (未取得流程状态)');
    }
    console.log('下载目录: ' + (downloaded.length ? downloaded.join(', ') : '(空)'));

    const off = results.offscreenApis || {};
    const dl = (() => { try { return JSON.parse(results.download); } catch (e) { return {}; } })();

    console.log('');
    console.log('断言:');
    const checks = [
      ['manifest 权限与预期一致',
        JSON.stringify(results.permissions) === JSON.stringify(EXPECTED_PERMISSIONS)],
      ['注入脚本并采集到可见元素', results.elements > 0],
      ['Service Worker 已启动（background.js 无语法错误）', !!results.serviceWorker],
      ['offscreen document 创建成功', off.runtime === 'object'],
      ['offscreen 内 URL.createObjectURL 可用', off.createObjectURL === 'function'],
      ['[本次 bug 根因] offscreen 内 chrome.downloads 不可用', off.downloads === 'undefined'],
      ['offscreen 成功创建 blob URL',
        typeof results.offscreenBlobUrl === 'string' && results.offscreenBlobUrl.startsWith('blob:')],
      ['[修复验证] 跨上下文 blob URL 交给 downloads 下载成功', dl.ok === true],
      ['测试文件已落到磁盘', downloaded.some((f) => f.endsWith('.txt'))],
      ['真实流程完整走通且无错误', !!(results.flow && results.flow.done && !results.flow.error)],
      ['流程产出的 ZIP 已下载', downloaded.some((f) => f.endsWith('.zip'))]
    ];

    let pass = 0;
    for (const [label, ok] of checks) {
      console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label);
      if (ok) pass++;
    }
    console.log('  → ' + pass + '/' + checks.length + ' 通过');
    if (pass < checks.length) process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    try { server.close(); } catch (e) { /* ignore */ }
    try { chrome.kill(); } catch (e) { /* ignore */ }
    await sleep(700);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

main().catch((err) => {
  console.error('[ext-e2e] 失败: ' + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
});
