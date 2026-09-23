/**
 * capture-vue.mjs — 真实采集 cn.vuejs.org，保存 collect-data.json 供 diagnose.mjs 分析
 *
 * 复用 extension-e2e 的 CDP 方式，但不加载扩展，而是把 collector.js 直接注入页面执行。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'output');
const COLLECTOR = fs.readFileSync(path.join(ROOT, 'lib', 'collector.js'), 'utf8');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9455', 10);
const TARGET_URL = process.env.TARGET_URL || 'https://cn.vuejs.org/';
const VIEWPORT_W = 1440, VIEWPORT_H = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.seq = 0; this.pending = new Map(); this.closed = false; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => { if (!this.closed) reject(new Error('CDP 连接失败')); });
      this.ws.addEventListener('message', (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
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
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
      }, timeoutMs || 120000);
    });
  }
  async evaluate(sessionId, expression, timeoutMs) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId, timeoutMs || 60000);
    if (r.exceptionDetails) throw new Error('页面内执行异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
    return r.result ? r.result.value : undefined;
  }
  close() { this.closed = true; try { this.ws.close(); } catch (e) {} }
}

async function httpJson(p) {
  const res = await fetch('http://127.0.0.1:' + CDP_PORT + p);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
async function waitForCdp(ms) {
  const d = Date.now() + ms;
  while (Date.now() < d) { try { return await httpJson('/json/version'); } catch (e) { await sleep(300); } }
  throw new Error('等待 Chrome 调试端口超时');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = path.join(os.tmpdir(), 'page-snapper-cap-' + Date.now());
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile, '--window-size=' + VIEWPORT_W + ',' + VIEWPORT_H,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--mute-audio', '--enable-unsafe-extension-debugging', 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  let cdp = null;
  try {
    await waitForCdp(25000);
    const version = await httpJson('/json/version');
    cdp = new CDP(version.webSocketDebuggerUrl);
    await cdp.connect();

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1, mobile: false }, sessionId);

    console.log('[capture] 打开 ' + TARGET_URL);
    await cdp.send('Page.navigate', { url: TARGET_URL }, sessionId);

    const d = Date.now() + 30000;
    while (Date.now() < d) {
      try { if (await cdp.evaluate(sessionId, 'document.readyState', 10000) === 'complete') break; } catch (e) {}
      await sleep(300);
    }
    // SPA 渲染 + 字体/图片加载
    await sleep(8000);

    console.log('[capture] 注入 collector.js …');
    await cdp.evaluate(sessionId, COLLECTOR, 30000);

    console.log('[capture] 采集中（含滚动触发懒加载）…');
    const json = await cdp.evaluate(sessionId, `(async () => {
      var data = await window.__PAGE_SNAPPER__.collect({ scrollFirst: true, includeFullHtml: true, waitImagesMs: 8000 });
      // 去掉图片二进制，缩小体积；保留分析所需字段
      return JSON.stringify({
        meta: data.meta,
        elements: data.elements,
        blocks: data.blocks,
        hidden: data.hidden,
        fonts: data.fonts,
        fullHtml: data.fullHtml,
        fullHtmlTruncated: data.fullHtmlTruncated,
        warnings: data.warnings,
        version: data.version
      });
    })()`, 180000);

    const data = JSON.parse(json);
    const outPath = path.join(OUT, 'collect-data.json');
    fs.writeFileSync(outPath, JSON.stringify(data));
    console.log('[capture] 已保存 -> ' + outPath);
    console.log('  元素:', data.elements.length, '| 区块:', data.blocks.length, '| 隐藏:', (data.hidden || []).length);
    console.log('  URL:', data.meta.url);
  } finally {
    if (cdp) cdp.close();
    try { chrome.kill(); } catch (e) {}
    await sleep(700);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
}

main().catch((e) => { console.error('[capture] 失败: ' + (e.stack || e)); process.exit(1); });
