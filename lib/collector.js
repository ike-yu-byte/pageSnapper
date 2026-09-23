/**
 * collector.js — 注入到目标页面的采集模块
 *
 * 与 SingleFile 的思路差异：只收"可见元素"、只记"偏离 CSS 初始值"的属性、
 * 按语义区块分组，从源头压掉噪声，让产物对 AI 友好。
 *
 * 本文件以普通脚本注入页面上下文，不使用 ESM，暴露 window.__PAGE_SNAPPER__
 */
(() => {
  'use strict';

  if (window.__PAGE_SNAPPER__ && window.__PAGE_SNAPPER__.version) return;

  const VERSION = '1.0.0';
  const MAX_ELEMENTS = 8000;
  const MIN_RESOURCE_SIDE = 3; // 小于此边长的图片视为追踪像素/纯装饰

  const SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, META: 1, LINK: 1, TITLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, BASE: 1
  };

  // CSS 初始值：computed 值与之相同则不记录
  const DEFAULTS = {
    display: 'inline', position: 'static', float: 'none', clear: 'none', 'z-index': 'auto',
    'box-sizing': 'content-box', overflow: 'visible', 'overflow-x': 'visible', 'overflow-y': 'visible',
    width: 'auto', height: 'auto', 'min-width': '0px', 'min-height': '0px',
    'max-width': 'none', 'max-height': 'none',
    top: 'auto', right: 'auto', bottom: 'auto', left: 'auto',
    'margin-top': '0px', 'margin-right': '0px', 'margin-bottom': '0px', 'margin-left': '0px',
    'padding-top': '0px', 'padding-right': '0px', 'padding-bottom': '0px', 'padding-left': '0px',
    'border-top-width': '0px', 'border-right-width': '0px', 'border-bottom-width': '0px', 'border-left-width': '0px',
    'border-top-style': 'none', 'border-right-style': 'none', 'border-bottom-style': 'none', 'border-left-style': 'none',
    'border-top-color': 'rgb(0, 0, 0)', 'border-right-color': 'rgb(0, 0, 0)',
    'border-bottom-color': 'rgb(0, 0, 0)', 'border-left-color': 'rgb(0, 0, 0)',
    'border-top-left-radius': '0px', 'border-top-right-radius': '0px',
    'border-bottom-right-radius': '0px', 'border-bottom-left-radius': '0px',
    'background-color': 'rgba(0, 0, 0, 0)', 'background-image': 'none',
    'background-size': 'auto', 'background-position': '0% 0%', 'background-repeat': 'repeat',
    'background-attachment': 'scroll', 'background-clip': 'border-box', 'background-origin': 'padding-box',
    color: 'rgb(0, 0, 0)', opacity: '1', visibility: 'visible',
    'font-family': '', 'font-size': '16px', 'font-weight': '400', 'font-style': 'normal',
    'font-variant': 'normal', 'line-height': 'normal', 'letter-spacing': 'normal', 'word-spacing': '0px',
    'text-align': 'start', 'text-decoration-line': 'none', 'text-transform': 'none',
    'text-indent': '0px', 'text-shadow': 'none', 'white-space': 'normal',
    'word-break': 'normal', 'overflow-wrap': 'normal', 'vertical-align': 'baseline',
    'box-shadow': 'none', transform: 'none',
    'flex-direction': 'row', 'flex-wrap': 'nowrap', 'justify-content': 'normal',
    'align-items': 'normal', 'align-content': 'normal', 'align-self': 'auto',
    'flex-grow': '0', 'flex-shrink': '1', 'flex-basis': 'auto', order: '0',
    'grid-template-columns': 'none', 'grid-template-rows': 'none',
    gap: 'normal', 'row-gap': 'normal', 'column-gap': 'normal',
    cursor: 'auto', 'pointer-events': 'auto', 'object-fit': 'fill', 'object-position': '50% 50%',
    'aspect-ratio': 'auto', 'list-style-type': 'disc', 'list-style-position': 'outside',
    'text-overflow': 'clip', filter: 'none', 'backdrop-filter': 'none',
    'mix-blend-mode': 'normal', 'clip-path': 'none', 'writing-mode': 'horizontal-tb', 'user-select': 'auto'
  };
  const PROPS = Object.keys(DEFAULTS);

  const PLACEHOLDER_IMG = /^data:image\/(gif|png);base64,(R0lGODlhAQAB|iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB)/i;

  // ------------------------------------------------------------ 工具函数
  const stringPool = [];
  const stringPoolMap = new Map();
  function intern(s) {
    if (stringPoolMap.has(s)) return stringPoolMap.get(s);
    const i = stringPool.length;
    stringPool.push(s);
    stringPoolMap.set(s, i);
    return i;
  }

  function absUrl(u, base) {
    if (!u) return '';
    const trimmed = String(u).trim();
    if (!trimmed) return '';
    if (/^(https?:|data:|blob:|file:)/i.test(trimmed)) return trimmed;
    if (trimmed.startsWith('//')) return location.protocol + trimmed;
    try {
      return new URL(trimmed, base || location.href).href;
    } catch (e) {
      return trimmed;
    }
  }

  // 解析 CSS 中的 url()。注意 data URL 内部可能含引号与括号
  // （例如内联 SVG 里的 fill='url(%23g)'），因此不能用 [^'")]+ 粗暴截断。
  function parseCssUrls(value) {
    const urls = [];
    if (!value || value === 'none') return urls;
    const re = /url\(\s*(?:'([^']*)'|"([^"]*)"|([^)'"]*))\s*\)/g;
    let m;
    while ((m = re.exec(value))) {
      const u = (m[1] || m[2] || m[3] || '').trim();
      if (u) urls.push(u);
    }
    return urls;
  }

  // 清理 SPA 常见 hash 后缀：logo.8a3f2c1b.png -> logo.png
  function stripHash(filename) {
    return filename.replace(/[._-][0-9a-f]{6,}(?=\.[a-z0-9]+$)/i, '');
  }

  // 注意：SVG 元素的 className 是 SVGAnimatedString 而非字符串，
  // 用 typeof 判断会静默丢失 class，因此统一走 getAttribute。
  function classOf(el) {
    return el.getAttribute('class') || '';
  }

  function cssPath(el) {
    const parts = [];
    let cur = el;
    let guard = 0;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && guard++ < 32) {
      let sel = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(sel + '#' + cur.id);
        break;
      }
      const cls = classOf(cur)
        .trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) sel += '.' + cls.join('.');
      const parent = cur.parentElement;
      if (parent) {
        const sibs = [];
        for (let i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === cur.tagName) sibs.push(parent.children[i]);
        }
        if (sibs.length > 1) sel += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(sel);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function ownText(el) {
    let s = '';
    for (let i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) s += el.childNodes[i].nodeValue;
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return [
      Math.round(r.left + window.scrollX),
      Math.round(r.top + window.scrollY),
      Math.round(r.width),
      Math.round(r.height)
    ];
  }

  function isPluginEl(el) {
    const tag = el.tagName.toLowerCase();
    if (tag.indexOf('-') === -1) return false;
    const id = (el.id || '').toLowerCase();
    const cn = classOf(el).toLowerCase();
    if (/doubao|flow-ai|ai-csui|ai-assistant|ai-translate|browser-ext|chrome-ext/.test(id + ' ' + cn + ' ' + tag)) {
      return true;
    }
    return el.parentElement === document.body;
  }

  function isMeaningful(el) {
    if (SKIP_TAGS[el.tagName]) return false;
    if (isPluginEl(el)) return false;
    const r = el.getBoundingClientRect();
    // 1x1 追踪像素之类的元素不应被当成一个区块
    if (r.width < 2 && r.height < 2 && el.children.length === 0) return false;
    return true;
  }

  function isVisibleEl(el, cs) {
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    return true;
  }

  function styleOf(cs) {
    const out = {};
    for (let i = 0; i < PROPS.length; i++) {
      const p = PROPS[i];
      const v = cs.getPropertyValue(p);
      if (!v || v === DEFAULTS[p]) continue;
      out[p] = v;
    }
    if (out.transform && out.transform !== 'none') out['transform-origin'] = cs.transformOrigin;
    if (out['font-family']) out['font-family'] = intern(out['font-family']);
    return out;
  }

  // ------------------------------------------------------------ 区块划分
  function pickBlocks() {
    let container = document.body;
    let roots = [];
    for (let down = 0; down < 10; down++) {
      const kids = [];
      for (let i = 0; i < container.children.length; i++) {
        if (isMeaningful(container.children[i])) kids.push(container.children[i]);
      }
      if (kids.length === 0) break;
      if (kids.length >= 2) { roots = kids; break; }
      roots = kids;
      container = kids[0];
    }
    if (!roots.length) {
      for (let i = 0; i < document.body.children.length; i++) {
        if (!SKIP_TAGS[document.body.children[i].tagName]) roots.push(document.body.children[i]);
      }
    }

    // 自适应展开：只拆"体量明显偏大"的容器，避免把语义完整的区块拆成
    // 孤立的 h1 / p / a（hero 这类小节被拆开反而更难用）。
    const totalEls = document.body.querySelectorAll('*').length;
    const sizeThreshold = Math.max(20, Math.round(totalEls * 0.15));
    const MAX_BLOCKS = 14;
    for (let pass = 0; pass < 12 && roots.length < MAX_BLOCKS; pass++) {
      let pickIdx = -1;
      let pickKids = null;
      let bestSize = 0;
      for (let i = 0; i < roots.length; i++) {
        const size = roots[i].querySelectorAll('*').length;
        if (size < sizeThreshold) continue;
        const kk = [];
        for (let c = 0; c < roots[i].children.length; c++) {
          if (isMeaningful(roots[i].children[c])) kk.push(roots[i].children[c]);
        }
        if (kk.length < 2 || kk.length > 10) continue;
        if (size > bestSize) {
          bestSize = size;
          pickIdx = i;
          pickKids = kk;
        }
      }
      if (pickIdx === -1) break;
      roots = roots.slice(0, pickIdx).concat(pickKids, roots.slice(pickIdx + 1));
    }
    return { roots, container };
  }

  function nameOf(el) {
    const cls = classOf(el)
      .trim().split(/\s+/).filter(Boolean).join('.');
    return (el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '')).slice(0, 140);
  }

  // ------------------------------------------------------------ 滚动
  async function scrollThrough() {
    const total = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    const startY = window.scrollY;
    for (let y = 0; y < total; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 90));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 300));
    window.scrollTo(0, startY);
    await new Promise((r) => setTimeout(r, 150));
  }

  async function waitImages(timeoutMs) {
    const list = Array.from(document.images);
    const pending = list.filter((i) => !i.complete);
    if (!pending.length) return { total: list.length, loaded: list.length };
    await Promise.race([
      Promise.all(pending.map((i) => new Promise((r) => {
        i.addEventListener('load', r, { once: true });
        i.addEventListener('error', r, { once: true });
      }))),
      new Promise((r) => setTimeout(r, timeoutMs))
    ]);
    return {
      total: list.length,
      loaded: list.filter((i) => i.complete && i.naturalWidth > 0).length
    };
  }

  // ------------------------------------------------------------ 图片采集
  function collectImages(blockIndexOf, elements) {
    const resources = [];
    const byUrl = new Map();

    function ensureResource(base) {
      const key = base.kind + '|' + (base.url || '') + '|' + (base.inlineKey || '');
      if (base.url && base.kind !== 'inline-svg' && byUrl.has(key)) {
        return byUrl.get(key);
      }
      const res = Object.assign({ id: resources.length, usages: [] }, base);
      delete res.inlineKey;
      resources.push(res);
      if (base.url && base.kind !== 'inline-svg') byUrl.set(key, res);
      return res;
    }

    function contextOf(el) {
      const textBits = [];
      const t = ownText(el).slice(0, 60);
      if (t) textBits.push(t);
      const parent = el.parentElement;
      if (parent) {
        const pt = ownText(parent).slice(0, 60);
        if (pt && pt !== t) textBits.push(pt);
      }

      // 内联 SVG / 图标自身常无 class，语义在祖先上（如 <span class="icon outbound"><svg/></span>）
      let id = el.id || '';
      let classes = classOf(el).trim();
      if (!classes && !id && parent) {
        classes = classOf(parent).trim();
        id = parent.id || '';
        const grand = parent.parentElement;
        if (!classes && !id && grand) {
          classes = classOf(grand).trim();
          id = grand.id || '';
          if (!textBits.length) {
            const gt = ownText(grand).slice(0, 60);
            if (gt) textBits.push(gt);
          }
        }
      }

      return {
        tag: el.tagName.toLowerCase(),
        id,
        classes: classes.slice(0, 120),
        text: textBits.join(' | '),
        selector: cssPath(el)
      };
    }

    function addUsage(res, el, kind) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const usage = {
        kind,
        selector: cssPath(el),
        rect: rectOf(el),
        visible: isVisibleEl(el, cs) && r.width > 0 && r.height > 0,
        blockIndex: blockIndexOf(el)
      };
      res.usages.push(usage);
      return usage;
    }

    // ---- <img>
    const imgs = document.querySelectorAll('img');
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      const attrs = ['currentSrc', 'src', 'data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-url'];
      let url = '';
      for (const a of attrs) {
        const raw = a === 'currentSrc' ? img.currentSrc : img.getAttribute(a);
        if (raw && !PLACEHOLDER_IMG.test(raw)) { url = absUrl(raw); break; }
      }
      if (!url) {
        const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
        if (srcset) {
          const first = srcset.split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean).pop();
          if (first) url = absUrl(first);
        }
      }
      if (!url) continue;

      const res = ensureResource({
        kind: 'img',
        url,
        alt: img.alt || '',
        title: img.title || '',
        natural: [img.naturalWidth || 0, img.naturalHeight || 0],
        context: contextOf(img)
      });
      addUsage(res, img, 'img');

      // 高清候选：srcset 中的最大宽度版本
      const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
      if (srcset) {
        res.srcset = srcset.split(',').map((s) => {
          const parts = s.trim().split(/\s+/);
          return { url: absUrl(parts[0]), descriptor: parts[1] || '' };
        }).filter((s) => s.url);
      }
    }

    // ---- picture > source
    document.querySelectorAll('picture source[srcset]').forEach((source) => {
      const srcset = source.getAttribute('srcset');
      srcset.split(',').forEach((s) => {
        const parts = s.trim().split(/\s+/);
        if (!parts[0]) return;
        const url = absUrl(parts[0]);
        if (!url) return;
        const res = ensureResource({
          kind: 'picture-source',
          url,
          media: source.getAttribute('media') || '',
          type: source.getAttribute('type') || '',
          natural: [0, 0],
          context: contextOf(source.parentElement || source)
        });
        addUsage(res, source.parentElement || source, 'picture-source');
      });
    });

    // ---- video / audio poster
    document.querySelectorAll('video[poster], video').forEach((v) => {
      const poster = v.getAttribute('poster');
      if (!poster) return;
      const res = ensureResource({
        kind: 'video-poster',
        url: absUrl(poster),
        natural: [0, 0],
        context: contextOf(v)
      });
      addUsage(res, v, 'video-poster');
    });

    // ---- 内联 <svg>
    const svgs = document.querySelectorAll('svg');
    for (let i = 0; i < svgs.length; i++) {
      const svg = svgs[i];
      const r = svg.getBoundingClientRect();
      if (r.width < MIN_RESOURCE_SIDE && r.height < MIN_RESOURCE_SIDE) continue;
      const res = ensureResource({
        kind: 'inline-svg',
        url: '',
        svgText: svg.outerHTML,
        natural: [Math.round(r.width), Math.round(r.height)],
        context: contextOf(svg)
      });
      addUsage(res, svg, 'inline-svg');
    }

    // ---- CSS 背景图（元素 + 伪元素）
    for (let i = 0; i < elements.length; i++) {
      const e = elements[i];
      const img = e.s['background-image'];
      if (img && img !== 'none') {
        const urls = parseCssUrls(img);
        for (const u of urls) {
          const res = ensureResource({
            kind: 'css-background',
            url: absUrl(u),
            natural: [0, 0],
            context: e.contextLink || { tag: e.t, id: e.i || '', classes: e.c || '', text: e.x || '', selector: e.p }
          });
          res.usages.push({
            kind: 'css-background',
            selector: e.p,
            rect: e.r,
            visible: true,
            blockIndex: e.bk
          });
        }
      }
      for (const pk of ['b', 'a']) {
        const pe = e[pk];
        if (!pe) continue;
        const c = pe.content;
        if (!c) continue;
        const urls = parseCssUrls(c);
        for (const u of urls) {
          const res = ensureResource({
            kind: 'pseudo-content',
            url: absUrl(u),
            pseudo: pk === 'b' ? '::before' : '::after',
            natural: [0, 0],
            context: e.contextLink || { tag: e.t, id: e.i || '', classes: e.c || '', text: '', selector: e.p }
          });
          res.usages.push({
            kind: 'pseudo-content',
            selector: e.p + (pk === 'b' ? '::before' : '::after'),
            rect: e.r,
            visible: true,
            blockIndex: e.bk
          });
        }
      }
    }

    // 兜底：直接扫一遍所有元素的 computed 背景，捕获未被采集的隐藏元素上的背景图
    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (SKIP_TAGS[el.tagName] || isPluginEl(el)) continue;
      let cs;
      try { cs = getComputedStyle(el); } catch (e) { continue; }
      const bg = cs.backgroundImage;
      if (!bg || bg === 'none' || bg.indexOf('url(') === -1) continue;
      const urls = parseCssUrls(bg);
      const r = el.getBoundingClientRect();
      for (const u of urls) {
        const res = ensureResource({
          kind: 'css-background',
          url: absUrl(u),
          natural: [0, 0],
          context: contextOf(el)
        });
        const selector = cssPath(el);
        if (!res.usages.some((x) => x.selector === selector)) {
          res.usages.push({
            kind: 'css-background',
            selector,
            rect: [Math.round(r.left + window.scrollX), Math.round(r.top + window.scrollY),
              Math.round(r.width), Math.round(r.height)],
            visible: isVisibleEl(el, cs) && r.width > 0 && r.height > 0,
            blockIndex: blockIndexOf(el)
          });
        }
      }
    }

    // 过滤：追踪像素 / 无效资源
    const filtered = resources.filter((res) => {
      const n = res.natural || [0, 0];
      if (res.kind !== 'inline-svg' && n[0] > 0 && n[1] > 0 && n[0] < MIN_RESOURCE_SIDE && n[1] < MIN_RESOURCE_SIDE) {
        return false;
      }
      const first = res.usages[0];
      if (first && first.rect[2] < MIN_RESOURCE_SIDE && first.rect[3] < MIN_RESOURCE_SIDE && res.kind === 'inline-svg') {
        return false;
      }
      return true;
    });
    filtered.forEach((res, idx) => { res.id = idx; });
    return filtered;
  }

  // ------------------------------------------------------------ blob 转 dataURL
  async function inlineBlobResources(resources) {
    const tasks = resources.filter((r) => r.url && r.url.startsWith('blob:'));
    await Promise.all(tasks.map(async (res) => {
      try {
        const resp = await fetch(res.url);
        const blob = await resp.blob();
        res.inlineData = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = () => reject(fr.error);
          fr.readAsDataURL(blob);
        });
        res.declaredType = blob.type || '';
        res.byteLength = blob.size;
      } catch (e) {
        res.fetchError = String(e && e.message ? e.message : e);
      }
    }));
  }

  // ------------------------------------------------------------ 主采集
  async function collect(options) {
    const opts = Object.assign({
      scrollFirst: true,
      waitImagesMs: 15000,
      includeFullHtml: true,
      maxElements: MAX_ELEMENTS
    }, options || {});

    const warnings = [];

    if (opts.scrollFirst) {
      try { await scrollThrough(); } catch (e) { warnings.push('滚动触发懒加载失败: ' + e.message); }
    }
    try {
      const imgStat = await waitImages(opts.waitImagesMs);
      if (imgStat.loaded < imgStat.total) {
        warnings.push('有 ' + (imgStat.total - imgStat.loaded) + '/' + imgStat.total + ' 张图片未能加载完成');
      }
    } catch (e) {
      warnings.push('等待图片加载失败: ' + e.message);
    }

    const { roots, container } = pickBlocks();
    const rootIndex = new Map();
    roots.forEach((el, i) => rootIndex.set(el, i));

    function blockIndexOf(el) {
      let cur = el;
      while (cur && cur !== document.body) {
        if (rootIndex.has(cur)) return rootIndex.get(cur);
        cur = cur.parentElement;
      }
      return -1;
    }

    // ---- 遍历可见元素
    const elements = [];
    let truncated = false;

    function collectEl(node) {
      if (elements.length >= opts.maxElements) { truncated = true; return; }
      const cs = getComputedStyle(node);
      if (!isVisibleEl(node, cs)) return;
      const r = node.getBoundingClientRect();
      if (!(r.width > 0 || r.height > 0)) return;

      const rec = {
        p: cssPath(node),
        t: node.tagName.toLowerCase(),
        r: rectOf(node),
        bk: blockIndexOf(node),
        s: styleOf(cs)
      };
      if (node.id) rec.i = node.id;
      const clsName = classOf(node).trim();
      if (clsName) rec.c = clsName;
      const txt = ownText(node);
      if (txt) rec.x = txt.slice(0, 200);

      for (let q = 0; q < 2; q++) {
        const pseudo = q === 0 ? '::before' : '::after';
        let pcs;
        try { pcs = getComputedStyle(node, pseudo); } catch (e) { continue; }
        if (!pcs) continue;
        const content = pcs.getPropertyValue('content');
        if (!content || content === 'none' || content === 'normal') continue;
        const ps = styleOf(pcs);
        ps.content = content;
        if (q === 0) rec.b = ps; else rec.a = ps;
      }
      elements.push(rec);
    }

    function walkEl(node, depth, visited) {
      if (depth > 64 || elements.length >= opts.maxElements) return;
      for (let k = 0; k < node.children.length; k++) {
        const child = node.children[k];
        if (SKIP_TAGS[child.tagName] || isPluginEl(child)) continue;
        const tag = child.tagName.toLowerCase();
        if (tag === 'iframe' || tag === 'object' || tag === 'embed') {
          // 跨域 iframe 内容不可达，仅记录引用
          visited.frames.push({
            tag,
            src: child.getAttribute('src') || '',
            rect: rectOf(child)
          });
          continue;
        }
        collectEl(child);
        walkEl(child, depth + 1, visited);
      }
    }

    const visited = { frames: [] };
    collectEl(document.body);
    walkEl(document.body, 0, visited);

    // ---- 区块
    const blocks = roots.map((el, idx) => {
      let html = el.outerHTML;
      let htmlTruncated = false;
      if (html.length > 500000) {
        html = html.slice(0, 500000);
        htmlTruncated = true;
      }
      return {
        index: idx,
        name: nameOf(el),
        tag: el.tagName.toLowerCase(),
        rect: rectOf(el),
        html,
        htmlTruncated,
        elementCount: elements.filter((e) => e.bk === idx).length
      };
    });

    // ---- 图片
    let images = [];
    try {
      images = collectImages(blockIndexOf, elements);
      await inlineBlobResources(images);
    } catch (e) {
      warnings.push('图片采集异常: ' + e.message);
    }

    // ---- 字体 / 颜色 / 间距统计
    function tally(field) {
      const map = {};
      for (const e of elements) {
        const v = e.s[field];
        if (v === undefined) continue;
        const key = field === 'font-family' ? stringPool[v] : v;
        if (!key || key === 'none' || key === 'normal') continue;
        map[key] = (map[key] || 0) + 1;
      }
      return map;
    }

    function tallySpacing(fields) {
      const map = {};
      for (const e of elements) {
        for (const f of fields) {
          const v = e.s[f];
          if (v && v !== '0px') map[v] = (map[v] || 0) + 1;
        }
      }
      return map;
    }

    const fontFaces = [];
    for (let s = 0; s < document.styleSheets.length; s++) {
      let rules;
      try { rules = document.styleSheets[s].cssRules; } catch (e) { continue; }
      if (!rules) continue;
      for (let t = 0; t < rules.length; t++) {
        const rule = rules[t];
        if (rule.constructor && rule.constructor.name === 'CSSFontFaceRule') {
          fontFaces.push({ cssText: rule.cssText.slice(0, 800), href: document.styleSheets[s].href || '' });
        }
      }
    }

    // ---- 完整 HTML
    let fullHtml = '';
    let fullHtmlTruncated = false;
    if (opts.includeFullHtml) {
      fullHtml = document.documentElement.outerHTML;
      if (fullHtml.length > 4000000) {
        fullHtml = fullHtml.slice(0, 4000000);
        fullHtmlTruncated = true;
      }
    }

    const docEl = document.documentElement;
    return {
      version: VERSION,
      meta: {
        url: location.href,
        origin: location.origin,
        title: document.title,
        capturedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
        lang: docEl.getAttribute('lang') || '',
        charset: document.characterSet,
        viewport: [window.innerWidth, window.innerHeight],
        devicePixelRatio: window.devicePixelRatio,
        documentSize: [
          docEl.scrollWidth, docEl.scrollHeight,
          document.body.scrollWidth, document.body.scrollHeight
        ],
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        htmlBackground: getComputedStyle(docEl).backgroundColor,
        elementCount: elements.length,
        blockCount: blocks.length,
        frames: visited.frames
      },
      blocks,
      elements,
      images,
      fonts: {
        faces: fontFaces,
        families: tally('font-family'),
        sizes: tally('font-size'),
        weights: tally('font-weight'),
        lineHeights: tally('line-height')
      },
      colors: {
        text: tally('color'),
        background: tally('background-color'),
        border: ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color']
          .reduce((acc, f) => {
            const m = tally(f);
            for (const k of Object.keys(m)) acc[k] = (acc[k] || 0) + m[k];
            return acc;
          }, {}),
        boxShadow: tally('box-shadow')
      },
      spacing: {
        paddings: tallySpacing(['padding-top', 'padding-right', 'padding-bottom', 'padding-left']),
        margins: tallySpacing(['margin-top', 'margin-right', 'margin-bottom', 'margin-left']),
        gaps: tallySpacing(['gap', 'row-gap', 'column-gap']),
        borderRadii: tallySpacing([
          'border-top-left-radius', 'border-top-right-radius',
          'border-bottom-right-radius', 'border-bottom-left-radius'
        ])
      },
      stringPool,
      fullHtml,
      fullHtmlTruncated,
      truncated,
      warnings
    };
  }

  window.__PAGE_SNAPPER__ = { version: VERSION, collect };
})();
