/**
 * render-verify.mjs — 在真实浏览器里渲染生成的 index.html，量化布局还原质量
 *
 * 指标：
 *   - missing：采集元素的选择器在还原页里 querySelector 不到（规则失效）
 *   - largeOffset：位置/尺寸偏差 > 阈值（布局错乱候选）
 *   - horizontalOverflow：documentElement.scrollWidth 超过视口宽度（绝对定位飞出等）
 *
 * 用法：node test/render-verify.mjs [collect-data.json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPackage } from '../lib/packager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'output');
const RENDER = path.join(OUT, 'render');
const SRC = process.argv[2] || path.join(OUT, 'collect-data.json');
const COLLECTOR = fs.readFileSync(path.join(ROOT, 'lib', 'collector.js'), 'utf8');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9466', 10);
const VIEWPORT_W = 1440, VIEWPORT_H = 900;
const OFFSET_THRESHOLD = 40;

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
          const p = this.pending.get(msg.id); this.pending.delete(msg.id);
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); } }, timeoutMs || 120000);
    });
  }
  async evaluate(sessionId, expression, timeoutMs) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId, timeoutMs || 60000);
    if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
    return r.result ? r.result.value : undefined;
  }
  close() { this.closed = true; try { this.ws.close(); } catch (e) {} }
}
async function httpJson(p) { const res = await fetch('http://127.0.0.1:' + CDP_PORT + p); if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); }
async function waitForCdp(ms) { const d = Date.now() + ms; while (Date.now() < d) { try { return await httpJson('/json/version'); } catch (e) { await sleep(300); } } throw new Error('等待 CDP 超时'); }

async function main() {
  const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const files = buildPackage(data, new Map(), new Map());
  fs.rmSync(RENDER, { recursive: true, force: true });
  fs.mkdirSync(RENDER, { recursive: true });
  for (const f of files) {
    const fp = path.join(RENDER, f.path);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, typeof f.data === 'string' ? f.data : Buffer.from(f.data));
  }
  console.log('[verify] 已写出渲染目录: ' + RENDER + ' (' + files.length + ' 个文件)');

  const profile = path.join(os.tmpdir(), 'page-snapper-verify-' + Date.now());
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + profile, '--window-size=' + VIEWPORT_W + ',' + VIEWPORT_H,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--mute-audio',
    'about:blank'
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1, mobile: false }, sessionId);

    const fileUrl = 'file://' + path.join(RENDER, 'index.html').replace(/\\/g, '/');
    console.log('[verify] 打开 ' + fileUrl);
    await cdp.send('Page.navigate', { url: fileUrl }, sessionId);
    const d = Date.now() + 20000;
    while (Date.now() < d) { try { if (await cdp.evaluate(sessionId, 'document.readyState', 10000) === 'complete') break; } catch (e) {} await sleep(300); }
    await sleep(2500);

    const elementsJson = JSON.stringify(data.elements);
    await cdp.evaluate(sessionId, COLLECTOR, 30000);
    await cdp.evaluate(sessionId, 'window.__ELEMENTS__ = ' + elementsJson, 30000);

    const report = await cdp.evaluate(sessionId, `(function(){
      var els = window.__ELEMENTS__ || [];
      var PS = window.__PAGE_SNAPPER__;
      var pSet = {};
      els.forEach(function(e){ pSet[e.p] = true; });
      var compared = 0, missing = 0, largeOffset = 0, detail = [];
      var parentMiss = 0, parentMissSample = [];
      for (var i = 0; i < els.length; i++) {
        var e = els[i];
        var node = null;
        try { node = document.querySelector(e.p); } catch (err) { node = null; }
        if (!node) { missing++; continue; }
        compared++;
        var r = node.getBoundingClientRect();
        var dx = Math.abs(r.left - e.r[0]);
        var dy = Math.abs(r.top - e.r[1]);
        var dw = Math.abs(r.width - e.r[2]);
        var dh = Math.abs(r.height - e.r[3]);
        if (dx > ${OFFSET_THRESHOLD} || dy > ${OFFSET_THRESHOLD} || dw > ${OFFSET_THRESHOLD} || dh > ${OFFSET_THRESHOLD}) {
          largeOffset++;
          // 向上找第一个「未被采集」的祖先：它的 display/flex/gap 等布局属性缺失，
          // 导致整棵子树在还原页回退成块级堆叠 —— 这就是位置偏移的根因。
          var anc = node.parentElement, depth = 0, found = null;
          while (anc && anc.nodeType === 1 && depth < 14) {
            var ap = PS.cssPath(anc);
            if (ap && !pSet[ap]) {
              found = { tag: anc.tagName, cls: (anc.getAttribute && anc.getAttribute('class')) || '',
                display: getComputedStyle(anc).display, pos: getComputedStyle(anc).position, depth: depth };
              break;
            }
            anc = anc.parentElement; depth++;
          }
          if (found) {
            parentMiss++;
            if (parentMissSample.length < 18) {
              var cls = String(found.cls).trim().split(/\\s+/).slice(0, 2).join('.');
              parentMissSample.push({ p: e.p.slice(0, 64), dx: Math.round(dx), dy: Math.round(dy),
                anc: found.tag + (cls ? '.' + cls : ''), disp: found.display, pos: found.pos, d: found.depth });
            }
          }
          if (detail.length < 25) detail.push({ p: e.p.slice(0, 80), dx: Math.round(dx), dy: Math.round(dy), dw: Math.round(dw), dh: Math.round(dh) });
        }
      }
      var sw = document.documentElement.scrollWidth;
      var iw = window.innerWidth;
      return JSON.stringify({
        total: els.length, compared: compared, missing: missing, largeOffset: largeOffset,
        parentMiss: parentMiss,
        horizontalOverflow: sw > iw + 5 ? (sw - iw) : 0,
        scrollWidth: sw, innerWidth: iw,
        parentMissSample: parentMissSample,
        detail: detail
      });
    })()`, 60000);

    const rep = JSON.parse(report);
    console.log('');
    console.log('=== 渲染还原质量 ===');
    console.log('  采集元素: ' + rep.total);
    console.log('  选择器可匹配: ' + rep.compared);
    console.log('  选择器失效(missing): ' + rep.missing);
    console.log('  位置/尺寸偏差>=' + OFFSET_THRESHOLD + 'px: ' + rep.largeOffset);
    console.log('  其中存在漏采祖先容器: ' + rep.parentMiss + ' / ' + rep.largeOffset);
    console.log('  水平溢出: ' + (rep.horizontalOverflow ? ('+' + rep.horizontalOverflow + 'px (scrollWidth ' + rep.scrollWidth + ' > innerWidth ' + rep.innerWidth + ')') : '无'));
    console.log('  漏采祖先样例 (anc=容器, disp=其 display, d=层级距离):');
    for (const x of rep.parentMissSample) console.log('    子 ' + x.p + ' Δ=(' + x.dx + ',' + x.dy + ')  → 未采集容器 ' + x.anc + ' [display:' + x.disp + ' pos:' + x.pos + ' 距祖先 ' + x.d + ' 层]');
    console.log('  偏差样例:');
    for (const x of rep.detail) console.log('    ' + x.p + '  Δpos=(' + x.dx + ',' + x.dy + ') Δsize=(' + x.dw + ',' + x.dh + ')');
    return rep;
  } finally {
    if (cdp) cdp.close();
    try { chrome.kill(); } catch (e) {}
    await sleep(700);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
}

main().catch((e) => { console.error('[verify] 失败: ' + (e.stack || e)); process.exit(1); });
