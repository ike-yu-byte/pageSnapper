/**
 * dump.mjs — 对比关键区块容器「采集时的样式」与「生成页实际渲染样式」
 * 用法：node test/dump.mjs
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
const SRC = path.join(OUT, 'collect-data.json');
const COLLECTOR = fs.readFileSync(path.join(ROOT, 'lib', 'collector.js'), 'utf8');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9477', 10);
const VIEWPORT_W = 1440, VIEWPORT_H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.seq = 0; this.pending = new Map(); this.closed = false; }
  connect() { return new Promise((resolve, reject) => { this.ws = new WebSocket(this.wsUrl); this.ws.addEventListener('open', () => resolve()); this.ws.addEventListener('error', () => { if (!this.closed) reject(new Error('CDP 连接失败')); }); this.ws.addEventListener('message', (ev) => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); } }); }); }
  send(method, params, sessionId, timeoutMs) { const id = ++this.seq; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); const payload = { id, method, params: params || {} }; if (sessionId) payload.sessionId = sessionId; this.ws.send(JSON.stringify(payload)); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); } }, timeoutMs || 120000); }); }
  async evaluate(sessionId, expression, timeoutMs) { const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId, timeoutMs || 60000); if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 600)); return r.result ? r.result.value : undefined; }
  close() { this.closed = true; try { this.ws.close(); } catch (e) {} }
}
async function httpJson(p) { const res = await fetch('http://127.0.0.1:' + CDP_PORT + p); if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); }
async function waitForCdp(ms) { const d = Date.now() + ms; while (Date.now() < d) { try { return await httpJson('/json/version'); } catch (e) { await sleep(300); } } throw new Error('等待 CDP 超时'); }

const SELS = [
  'section#hero > h1.tagline',
  'section#hero > h1.tagline > br',
  'section#hero > p.description:nth-of-type(1)',
  'section#sitemap > div.container',
  'section#sitemap > div.container > div.sitemap-col:nth-of-type(2)',
  'section#sitemap > div.container > div.sitemap-col:nth-of-type(3)',
  'section#sitemap > div.container > div.sitemap-col:nth-of-type(3) > ul',
  'section#sitemap > div.container > div.sitemap-col:nth-of-type(3) > ul > li:nth-of-type(1)'
];

async function main() {
  const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const files = buildPackage(data, new Map(), new Map());
  fs.rmSync(RENDER, { recursive: true, force: true });
  fs.mkdirSync(RENDER, { recursive: true });
  for (const f of files) { const fp = path.join(RENDER, f.path); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, typeof f.data === 'string' ? f.data : Buffer.from(f.data)); }

  const profile = path.join(os.tmpdir(), 'page-snapper-dump-' + Date.now());
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + profile, '--window-size=' + VIEWPORT_W + ',' + VIEWPORT_H, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--mute-audio', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let cdp = null;
  try {
    await waitForCdp(25000);
    const version = await httpJson('/json/version');
    cdp = new CDP(version.webSocketDebuggerUrl); await cdp.connect();
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId); await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1, mobile: false }, sessionId);
    const fileUrl = 'file://' + path.join(RENDER, 'index.html').replace(/\\/g, '/');
    await cdp.send('Page.navigate', { url: fileUrl }, sessionId);
    const d = Date.now() + 20000; while (Date.now() < d) { try { if (await cdp.evaluate(sessionId, 'document.readyState', 10000) === 'complete') break; } catch (e) {} await sleep(300); }
    await sleep(2500);
    await cdp.evaluate(sessionId, COLLECTOR, 30000);

    const els = data.elements;
    const byP = {}; els.forEach((e) => { byP[e.p] = e; });

    for (const sel of SELS) {
      const rec = byP[sel];
      const info = await cdp.evaluate(sessionId, `(function(){
        var node = document.querySelector(${JSON.stringify(sel)});
        if (!node) return JSON.stringify({ found: false });
        var cs = getComputedStyle(node);
        var r = node.getBoundingClientRect();
        return JSON.stringify({ found: true,
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          display: cs.display, position: cs.position,
          maxWidth: cs.maxWidth, width: cs.width, height: cs.height,
          marginLeft: cs.marginLeft, marginRight: cs.marginRight, marginTop: cs.marginTop, marginBottom: cs.marginBottom,
          paddingLeft: cs.paddingLeft, paddingRight: cs.paddingRight,
          fontSize: cs.fontSize, fontFamily: cs.fontFamily, lineHeight: cs.lineHeight,
          flexDirection: cs.flexDirection, gap: cs.gap,
          justifyContent: cs.justifyContent, alignItems: cs.alignItems
        });
      })()`, 20000);
      const o = JSON.parse(info);
      const origRect = rec ? rec.r : '(未采集)';
      const origS = rec ? rec.s : {};
      console.log('');
      console.log('选择器: ' + sel);
      console.log('  采集到: ' + (rec ? '是' : '否') + (rec ? '  blockIndex=' + rec.bk : ''));
      console.log('  原 rect: ' + JSON.stringify(origRect));
      console.log('  现 rect: ' + (o.found ? JSON.stringify(o.rect) : '未找到'));
      if (rec) {
        console.log('  采集样式(布局相关): ' + JSON.stringify(pick(origS)));
      }
      if (o.found) {
        console.log('  渲染样式: display=' + o.display + ' pos=' + o.position + ' W=' + o.width + ' H=' + o.height +
          ' mT=' + o.marginTop + ' mB=' + o.marginBottom + ' pL=' + o.paddingLeft +
          ' font=' + o.fontSize + '/' + o.lineHeight + ' flex=' + o.flexDirection + ' gap=' + o.gap);
      }
    }
  } finally {
    if (cdp) cdp.close(); try { chrome.kill(); } catch (e) {} await sleep(700); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} }
}
function pick(s) {
  const o = {}; const keys = ['display', 'position', 'left', 'top', 'width', 'height', 'max-width',
    'margin-top', 'margin-left', 'margin-bottom', 'padding-left', 'padding-right',
    'font-size', 'font-family', 'font-weight', 'line-height', 'letter-spacing',
    'flex-direction', 'gap', 'justify-content', 'align-items', 'grid-template-columns'];
  for (const k of keys) if (s[k] !== undefined) o[k] = s[k]; return o;
}
main().catch((e) => { console.error('[dump] 失败: ' + (e.stack || e)); process.exit(1); });
