/**
 * overflow-probe.mjs — 在还原页里定位水平溢出源
 * 用法：node test/overflow-probe.mjs [render/index.html 路径]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDER = path.join(__dirname, 'output', 'render');
const TARGET = process.argv[2] || path.join(RENDER, 'index.html');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9477', 10);
const VIEWPORT_W = parseInt(process.env.VIEWPORT_W || '390', 10);
const VIEWPORT_H = parseInt(process.env.VIEWPORT_H || '844', 10);
const MOBILE = process.env.MOBILE === '1';
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

const probe = `(function(){
  var iw = window.innerWidth;
  var out = [];
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    // 自身内容宽度远超自身可视宽度、且自己没裁剪 → 它就是溢出源
    var sw = el.scrollWidth, cw = el.clientWidth;
    if (sw <= cw + 8) continue;
    var selfClips = cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.overflow === 'hidden' || cs.overflow === 'clip' || cs.overflowX === 'auto' || cs.overflowX === 'scroll' || cs.overflow === 'auto' || cs.overflow === 'scroll';
    var path = [];
    var cur = el;
    while (cur && cur.nodeType === 1 && path.length < 6) {
      path.unshift(cur.tagName.toLowerCase() + (cur.id ? '#'+cur.id : '') + (cur.getAttribute('class') ? '.'+cur.getAttribute('class').trim().split(/\\s+/).slice(0,2).join('.') : ''));
      cur = cur.parentElement;
    }
    out.push({ p: path.join(' > '), sw: sw, cw: cw, clip: selfClips ? 'self-clips' : 'LEAK', vis: cs.visibility, op: cs.opacity, disp: cs.display, pos: cs.position, ws: cs.whiteSpace });
  }
  out.sort(function(a,b){ return (b.sw-b.cw) - (a.sw-a.cw); });
  // 额外：找 getBoundingClientRect().right 最大的可见叶子
  var wide = [];
  for (var j = 0; j < all.length; j++) {
    var e2 = all[j]; var c2 = getComputedStyle(e2);
    if (c2.display === 'none' || c2.visibility === 'hidden') continue;
    var rr = e2.getBoundingClientRect();
    if (rr.right > iw + 8) {
      var pp = [], cu = e2;
      while (cu && cu.nodeType === 1 && pp.length < 6) { pp.unshift(cu.tagName.toLowerCase() + (cu.id?'#'+cu.id:'') + (cu.getAttribute('class')?'.'+cu.getAttribute('class').trim().split(/\\s+/).slice(0,2).join('.'):'')); cu = cu.parentElement; }
      wide.push({ p: pp.join(' > '), right: Math.round(rr.right), w: Math.round(rr.width), x: Math.round(rr.left), pos: c2.position, disp: c2.display, ws: c2.whiteSpace });
    }
  }
  wide.sort(function(a,b){ return b.right - a.right; });
  // 包括隐藏元素，找 rect.width 或 right 真正超大的源
  var huge = [];
  for (var k = 0; k < all.length; k++) {
    var e3 = all[k]; var c3 = getComputedStyle(e3);
    if (c3.display === 'none') continue;
    var r3 = e3.getBoundingClientRect();
    if (r3.width > 400 || r3.right > 400) {
      var p3 = [], c4 = e3;
      while (c4 && c4.nodeType === 1 && p3.length < 7) { p3.unshift(c4.tagName.toLowerCase() + (c4.id?'#'+c4.id:'') + (c4.getAttribute('class')?'.'+c4.getAttribute('class').trim().split(/\\s+/).slice(0,2).join('.'):'')); c4 = c4.parentElement; }
      huge.push({ p: p3.join(' > '), right: Math.round(r3.right), w: Math.round(r3.width), x: Math.round(r3.left), pos: c3.position, vis: c3.visibility, ov: c3.overflow, disp: c3.display });
    }
  }
  huge.sort(function(a,b){ return b.w - a.w; });
  return JSON.stringify({ iw: iw, scrollWidth: document.documentElement.scrollWidth, bodySW: document.body.scrollWidth, bodyCW: document.body.clientWidth, count: out.length, leaks: out.filter(function(x){return x.clip==='LEAK';}).length, top: out.slice(0, 12), wide: wide.slice(0, 15), huge: huge.slice(0, 20) });
})()`;

async function main() {
  const profile = path.join(os.tmpdir(), 'page-snapper-ovf-' + Date.now());
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1, mobile: MOBILE }, sessionId);
    await cdp.send('Page.navigate', { url: 'file://' + TARGET.replace(/\\/g, '/') }, sessionId);
    const d = Date.now() + 20000;
    while (Date.now() < d) { try { if (await cdp.evaluate(sessionId, 'document.readyState', 10000) === 'complete') break; } catch (e) {} await sleep(300); }
    await sleep(2000);
    const rep = JSON.parse(await cdp.evaluate(sessionId, probe, 60000));
    console.log('innerWidth:', rep.iw, '| html.scrollWidth:', rep.scrollWidth, '| body sw/cw:', rep.bodySW + '/' + rep.bodyCW, '| 溢出容器:', rep.count, '| 未裁剪泄漏:', rep.leaks);
    for (const x of rep.top) console.log('  [' + x.clip + '] sw=' + x.sw + ' cw=' + x.cw + ' disp=' + x.disp + ' vis=' + x.vis + ' op=' + x.op + ' pos=' + x.pos + ' ws=' + x.ws + '\n      ' + x.p.slice(0, 200));
    console.log('--- right 最大的可见元素 ---');
    for (const x of rep.wide) console.log('  right=' + x.right + ' w=' + x.w + ' x=' + x.x + ' disp=' + x.disp + ' pos=' + x.pos + ' ws=' + x.ws + '\n      ' + x.p.slice(0, 200));
    console.log('--- 宽度/右边界真正超大的元素(含隐藏) ---');
    for (const x of rep.huge) console.log('  w=' + x.w + ' right=' + x.right + ' x=' + x.x + ' pos=' + x.pos + ' vis=' + x.vis + ' ov=' + x.ov + ' disp=' + x.disp + '\n      ' + x.p.slice(0, 220));
  } finally {
    if (cdp) cdp.close();
    try { chrome.kill(); } catch (e) {}
    await sleep(700);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }
}
main().catch((e) => { console.error('[ovf] 失败: ' + (e.stack || e)); process.exit(1); });
