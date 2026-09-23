/**
 * e2e.mjs — 端到端测试：真实浏览器采集 → 抓资源 → 打包 → 产出 ZIP
 *
 * 与扩展内运行唯一的差别是：资源抓取用 Node 的 fetch 代替扩展 host 权限。
 *
 * 用法：node test/e2e.mjs [url-or-file]
 *   默认使用 test/fixture.html
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildPackage, extractFontUrls, suggestPackageName, planImageNames } from '../lib/packager.js';
import { ZipWriter } from '../lib/zip.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(__dirname, 'output');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = parseInt(process.env.CDP_PORT || '9333', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 退出码必须可信，否则测试形同虚设 —— 把被吞掉的异常暴露出来
process.on('unhandledRejection', (reason) => {
  console.error('[e2e] 未处理的 Promise 拒绝: ' + (reason && reason.stack ? reason.stack : String(reason)));
  process.exitCode = 1;
});
process.on('uncaughtException', (err) => {
  console.error('[e2e] 未捕获异常: ' + (err && err.stack ? err.stack : String(err)));
  process.exitCode = 1;
});

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.seq = 0;
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error('CDP 连接失败')));
      this.ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
      });
    });
  }
  send(method, params, timeoutMs) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时: ' + method));
        }
      }, timeoutMs || 180000);
    });
  }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

async function httpJson(pathname) {
  const res = await fetch('http://127.0.0.1:' + PORT + pathname);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function waitForEndpoint(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await httpJson('/json/version'); } catch (e) { await sleep(250); }
  }
  throw new Error('等待 Chrome 调试端口超时');
}

async function pickPageTarget() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const list = await httpJson('/json/list');
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) return page;
    await sleep(200);
  }
  throw new Error('未找到 page target');
}

function decodeDataUrl(dataUrl) {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  if (m[2]) {
    const binary = atob(m[3]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, contentType: mime };
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(m[3])), contentType: mime };
}

function humanSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

async function main() {
  const target = process.argv[2] || pathToFileURL(path.join(__dirname, 'fixture.html')).href;
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const profile = path.join(os.tmpdir(), 'page-snapper-test-' + Date.now());
  console.log('[e2e] 采集目标: ' + target);
  console.log('[e2e] 启动 Chrome ...');

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--window-size=1440,900',
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--allow-file-access-from-files',
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  let cdp = null;
  try {
    await waitForEndpoint(25000);
    const targetInfo = await pickPageTarget();
    cdp = new CDP(targetInfo.webSocketDebuggerUrl);
    await cdp.connect();

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
    });
    await cdp.send('Page.navigate', { url: target });

    const readyDeadline = Date.now() + 30000;
    while (Date.now() < readyDeadline) {
      try {
        const r = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
        if (r.result && r.result.value === 'complete') break;
      } catch (e) { /* retry */ }
      await sleep(250);
    }
    await sleep(600);

    console.log('[e2e] 注入采集器 ...');
    const collectorSrc = fs.readFileSync(path.join(ROOT, 'lib', 'collector.js'), 'utf8');
    await cdp.send('Runtime.evaluate', { expression: collectorSrc, returnByValue: false });

    const collectOpts = { scrollFirst: true, waitImagesMs: 8000, includeFullHtml: true };
    const evalResult = await cdp.send('Runtime.evaluate', {
      expression: 'window.__PAGE_SNAPPER__.collect(' + JSON.stringify(collectOpts) + ')',
      awaitPromise: true,
      returnByValue: true
    }, 120000);

    if (evalResult.exceptionDetails) {
      throw new Error('collect 异常: ' + JSON.stringify(evalResult.exceptionDetails).slice(0, 800));
    }
    const data = evalResult.result.value;
    if (!data || !data.elements) throw new Error('collect 返回为空');

    console.log('[e2e] 采集完成: ' + data.meta.elementCount + ' 元素 / ' +
      data.meta.blockCount + ' 区块 / ' + data.images.length + ' 图片');

    fs.writeFileSync(path.join(OUT_DIR, 'collect-data.json'), JSON.stringify(data, null, 2));

    // ---- 抓资源
    const assetMap = new Map();
    const failures = [];
    for (const res of data.images) {
      try {
        if (res.inlineData) {
          const d = decodeDataUrl(res.inlineData);
          if (d) assetMap.set(res.id, d);
        } else if (res.svgText) {
          assetMap.set(res.id, { bytes: new TextEncoder().encode(res.svgText), contentType: 'image/svg+xml' });
        } else if (res.url && res.url.startsWith('data:')) {
          const d = decodeDataUrl(res.url);
          if (d) assetMap.set(res.id, d);
        } else if (res.url) {
          const resp = await fetch(res.url);
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          assetMap.set(res.id, {
            bytes: new Uint8Array(await resp.arrayBuffer()),
            contentType: resp.headers.get('content-type') || ''
          });
        }
      } catch (e) {
        failures.push({ url: res.url || '(inline)', error: String(e.message || e) });
      }
    }

    const fontMap = new Map();
    for (const url of extractFontUrls(data)) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        fontMap.set(url, {
          bytes: new Uint8Array(await resp.arrayBuffer()),
          contentType: resp.headers.get('content-type') || '',
          fileName: String(fontMap.size + 1).padStart(2, '0') + '-font.woff2'
        });
      } catch (e) {
        failures.push({ url, error: String(e.message || e) });
      }
    }

    // ---- 打包
    console.log('[e2e] 生成素材包 ...');
    const files = buildPackage(data, assetMap, fontMap);
    const zip = new ZipWriter();
    for (const f of files) zip.add(f.path, f.data);
    const bytes = zip.build();

    const zipName = suggestPackageName(data.meta) + '.zip';
    const zipPath = path.join(OUT_DIR, zipName);
    fs.writeFileSync(zipPath, bytes);

    // ---- 报告
    console.log('');
    console.log('[e2e] ZIP: ' + zipPath);
    console.log('[e2e] 体积: ' + humanSize(bytes.length) + '，包内 ' + files.length + ' 个条目');
    console.log('[e2e] 资源: 图片 ' + assetMap.size + '/' + data.images.length +
      '，字体 ' + fontMap.size + '，失败 ' + failures.length);
    console.log('');
    console.log('包内文件树:');
    const tree = files
      .map((f) => ({
        path: f.path,
        size: typeof f.data === 'string' ? Buffer.byteLength(f.data, 'utf8') : f.data.length
      }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    let imagesShown = 0;
    for (const f of tree) {
      if (f.path.startsWith('images/')) {
        imagesShown++;
        if (imagesShown > 12) {
          if (imagesShown === 13) console.log('  ... 其余图片省略');
          continue;
        }
      }
      console.log('  ' + f.path.padEnd(48) + humanSize(f.size));
    }

    // ---- 断言
    console.log('');
    console.log('断言:');
    const plan = planImageNames(data);
    const checks = [];

    const hiddenEl = data.elements.find((e) => (e.c || '').includes('hidden-block'));
    checks.push(['display:none 元素被过滤', !hiddenEl]);

    const names = plan.map((p) => p.fileName);
    checks.push(['图片全部命名为 NN-xxx.ext 形式',
      names.length > 0 && names.every((n) => /^\d{2}-[a-z0-9\u4e00-\u9fa5-]+\.(png|jpg|jpeg|gif|svg|webp|avif|ico)$/i.test(n))]);
    checks.push(['无重复文件名', new Set(names).size === names.length]);
    checks.push(['图片名不含构建哈希',
      !names.some((n) => /[0-9a-f]{8,}/i.test(n))]);

    const outline = files.find((f) => f.path === 'outline.md');
    checks.push(['outline.md 已生成且包含区块标题',
      !!outline && /## 区块 \d+/.test(outline.data)]);
    checks.push(['tokens.json 为合法 JSON', (() => {
      try {
        const t = JSON.parse(files.find((f) => f.path === 'tokens.json').data);
        return Array.isArray(t.colors.text) && Array.isArray(t.typography.sizes);
      } catch (e) { return false; }
    })()]);
    checks.push(['每个区块都有 html + css',
      data.blocks.every((b) => {
        const p = String(b.index + 1).padStart(2, '0');
        return files.some((f) => f.path.startsWith('sections/' + p + '-') && f.path.endsWith('.html')) &&
          files.some((f) => f.path.startsWith('sections/' + p + '-') && f.path.endsWith('.css'));
      })]);
    checks.push(['HTML 中图片引用已改写为本地路径', files
      .filter((f) => f.path.startsWith('sections/') && f.path.endsWith('.html'))
      .some((f) => f.data.includes('../images/'))]);
    checks.push(['根目录 index.html 已生成（解压即可预览）',
      files.some((f) => f.path === 'index.html')]);
    checks.push(['根目录 style.css 已生成',
      files.some((f) => f.path === 'style.css')]);
    checks.push(['index.html 图片引用指向同级 images/', (() => {
      const idx = files.find((f) => f.path === 'index.html');
      if (!idx) return false;
      return /src=["']images\//.test(idx.data) || /url\(["']?images\//.test(idx.data);
    })()]);
    // 早先的 bug：fileName 取错对象，引用被拼成 images/undefined。
    // 只判断"包含 images/" 抓不到它，必须显式排除。
    checks.push(['包内无 images/undefined 这类坏引用',
      !files.some((f) => typeof f.data === 'string' && /images\/undefined/.test(f.data))]);
    // 原页靠 JS 把 data-src 赋给 src；静态快照没有 JS，必须补 src 才能显示
    checks.push(['懒加载图片已补上 src（预览不缺图）', (() => {
      const idx = files.find((f) => f.path === 'index.html');
      return !!idx && !/<img\b(?![^>]*\ssrc\s*=)[^>]*\sdata-src\s*=/i.test(idx.data);
    })()]);
    // 伪元素样式：图标字体的 content、装饰元素都在 ::before / ::after 上，
    // 早先采集了却没输出，导致图标整片消失。
    const allCss = files.filter((f) => typeof f.data === 'string' && f.path.endsWith('.css'));
    const allText = files.filter((f) => typeof f.data === 'string').map((f) => f.data).join('\n');
    checks.push(['伪元素样式已输出（::before 规则存在）',
      allCss.some((f) => /::before\s*\{/.test(f.data))]);
    checks.push(['CSS 自定义属性（--accent）已输出',
      /--accent\s*:/.test(allText)]);
    checks.push(['图标字体 content 已转义为 \\XXXX 形式',
      /content:\s*"\\[0-9a-f]{2,6}/i.test(allText)]);
    checks.push(['CSS 中不含无效声明 "x:;"',
      !files.some((f) => typeof f.data === 'string' && /[a-z-]+:\s*;/.test(f.data))]);

    let pass = 0;
    for (const [label, ok] of checks) {
      console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label);
      if (ok) pass++;
    }
    console.log('  → ' + pass + '/' + checks.length + ' 通过');
    if (failures.length) {
      console.log('');
      console.log('资源抓取失败明细:');
      failures.slice(0, 10).forEach((f) => console.log('  - ' + f.url + ' — ' + f.error));
    }

    if (pass < checks.length) process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    try { chrome.kill(); } catch (e) { /* ignore */ }
    await sleep(600);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

main().catch((err) => {
  console.error('[e2e] 失败: ' + err.message);
  process.exit(1);
});
