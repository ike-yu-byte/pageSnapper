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
    'mix-blend-mode': 'normal', 'clip-path': 'none', 'writing-mode': 'horizontal-tb', 'user-select': 'auto',
    // 下面这些早先漏采，会导致按钮/输入框退回浏览器原生外观、滚动条样式丢失、grid 定位失效
    'scrollbar-width': 'auto', 'scrollbar-color': 'auto',
    'outline-width': '0px', 'outline-style': 'none', 'outline-offset': '0px',
    'accent-color': 'auto',
    'grid-column-start': 'auto', 'grid-column-end': 'auto',
    'grid-row-start': 'auto', 'grid-row-end': 'auto',
    'justify-self': 'auto',
    '-webkit-line-clamp': 'none',
    'color-scheme': 'normal',
    resize: 'none', isolation: 'auto',
    'touch-action': 'auto', 'overscroll-behavior': 'auto',
    perspective: 'none', 'backface-visibility': 'visible', 'transform-style': 'flat',
    'border-image-source': 'none',
    // CSS 多列 / grid 自动轨道 / 表格等同样决定布局，漏采会让多列退化成单列堆叠
    'column-count': 'auto', 'column-width': 'auto', 'column-span': 'none',
    'grid-auto-columns': 'auto', 'grid-auto-rows': 'auto', 'grid-auto-flow': 'row',
    'place-items': 'normal', 'place-content': 'normal', 'place-self': 'auto',
    'border-collapse': 'separate', 'table-layout': 'auto'
  };

  // UA 样式表会给 button / input / select 等设上 appearance: auto（原生外观），
  // 它会盖掉作者写的背景、边框等。原页通常显式重置成 none，但 none 正好等于
  // CSS 初始值，会被上面"与初始值相同就跳过"的规则丢掉 —— 还原页于是回到原生外观。
  // 因此对这类元素单独采集该属性。
  const NATIVE_APPEARANCE_TAGS = {
    BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, PROGRESS: 1, METER: 1, FIELDSET: 1, LEGEND: 1
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

  /**
   * @param {CSSStyleDeclaration} cs
   * @param {object|null} ua 该标签的浏览器默认（UA）样式（见 buildUaDefaults）
   */
  function styleOf(cs, ua) {
    const out = {};
    for (let i = 0; i < PROPS.length; i++) {
      const p = PROPS[i];
      const v = cs.getPropertyValue(p);
      if (!v) continue;
      if (v !== DEFAULTS[p]) { out[p] = v; continue; }

      // 到这里说明 computed 值恰好等于 CSS 初始值。只有当该标签的 UA 默认值
      // 也等于初始值时，「跳过」才是安全的；否则还原页会回退到浏览器默认样式。
      // 典型：原站用 reset 把 body 的 margin、ul 的 padding-left、a 的
      // text-decoration 压回初始值，这些声明会因等于初始值被丢弃，还原页于是
      // 拿回 UA 的 margin:8px / padding-left:40px / underline —— 整页错位。
      // 因此当 UA 值 ≠ 初始值时必须显式写出 computed 值（即初始值）来覆盖 UA。
      if (ua && ua[p] !== undefined && ua[p] !== DEFAULTS[p]) out[p] = v;
    }
    if (out.transform && out.transform !== 'none') out['transform-origin'] = cs.transformOrigin;
    if (out['font-family']) out['font-family'] = intern(out['font-family']);
    return out;
  }

  /**
   * 采集 CSS 自定义属性（--xxx）。
   *
   * 为什么必须单独采集：getComputedStyle 会把 var(--accent) 解析成具体值，
   * 但原页 DOM 里内联的 style="color: var(--accent)" 会被原样带进还原页，
   * 而还原页没有变量定义 —— 那些颜色就会解析失败而丢失。
   *
   * 为什么要和父级做差：自定义属性是可继承的，若逐个元素全量输出，
   * 每个元素的规则里都会重复同一批变量，产物体积会成倍膨胀。
   * 因此只在"值与父级不同"（即真正的定义点）时输出。
   *
   * @param {Map} varCache 元素 -> 该元素的变量集合
   * @returns {object|null} 需要输出的变量，无变化时返回 null
   */
  function diffCustomProps(varCache, node, cs) {
    const parent = node.parentElement;
    const parentVars = parent ? varCache.get(parent) : null;
    const own = {};
    let changed = false;
    let has = false;

    for (let i = 0; i < cs.length; i++) {
      const name = cs[i];
      if (name.length < 3) continue;
      if (name.charCodeAt(0) !== 45 || name.charCodeAt(1) !== 45) continue; // '--'
      const val = cs.getPropertyValue(name).trim();
      if (!val) continue;
      own[name] = val;
      has = true;
      if (!parentVars || parentVars[name] !== val) changed = true;
    }

    if (!has) return null;
    varCache.set(node, own);
    return changed ? own : null;
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
        const root = roots[i];
        const size = root.querySelectorAll('*').length;
        if (size < sizeThreshold) continue;

        let kk = [];
        for (let c = 0; c < root.children.length; c++) {
          if (isMeaningful(root.children[c])) kk.push(root.children[c]);
        }

        // 穿透"只有一个有意义子元素"的包装层（#app / .VPApp 这类）。
        // 少了这一步，这类大容器会因为没有 2 个直接子元素而永远不被展开，
        // 整页就挤成一个区块（vuejs.org 上表现为 blocks: 2）。
        let guard = 0;
        while (kk.length === 1 && guard++ < 8) {
          const deeper = [];
          for (let c = 0; c < kk[0].children.length; c++) {
            if (isMeaningful(kk[0].children[c])) deeper.push(kk[0].children[c]);
          }
          if (!deeper.length) break;
          kk = deeper;
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

  // ------------------------------------------------------------ 伪元素规则
  /**
   * 这些伪元素无法通过 getComputedStyle 取值（滚动条尤其如此），
   * 只能把原页 CSSOM 里对应的规则原文搬进产物。
   * 好在导出的 HTML 完整保留了原页的 class，这些选择器在还原页里依然能匹配。
   */
  const PSEUDO_MARKERS = [
    '::-webkit-scrollbar', '-webkit-scrollbar',
    '::placeholder', '::-webkit-input-placeholder', '::-moz-placeholder',
    '::selection', '::-moz-selection'
  ];

  function matchesPseudoMarker(selector) {
    for (let i = 0; i < PSEUDO_MARKERS.length; i++) {
      if (selector.indexOf(PSEUDO_MARKERS[i]) !== -1) return true;
    }
    return false;
  }

  function collectPseudoRules() {
    const out = [];
    const seen = new Set();
    const MAX = 200;

    function walk(rules) {
      if (!rules || out.length >= MAX) return;
      for (let i = 0; i < rules.length && out.length < MAX; i++) {
        const rule = rules[i];
        // @media / @supports 没有 selectorText，需要递归进去
        if (!rule.selectorText && rule.cssRules) {
          walk(rule.cssRules);
          continue;
        }
        const sel = rule.selectorText;
        if (!sel || !matchesPseudoMarker(sel)) continue;
        const text = rule.cssText;
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push(text.slice(0, 1500));
      }
    }

    for (let s = 0; s < document.styleSheets.length; s++) {
      let rules;
      // 跨域样式表不可读，read 会抛异常
      try { rules = document.styleSheets[s].cssRules; } catch (e) { continue; }
      walk(rules);
    }
    return out;
  }

  // ------------------------------------------------------------ UA 默认样式探测
  function snapshotProps(cs) {
    const o = {};
    for (let i = 0; i < PROPS.length; i++) {
      const p = PROPS[i];
      o[p] = cs.getPropertyValue(p);
    }
    return o;
  }

  /**
   * 在离屏 iframe（无任何作者样式）里探测各标签的浏览器默认（UA）样式。
   *
   * 采集采用「computed 值 === CSS 初始值 就跳过」的压缩策略，但 UA 样式表会让
   * 同一属性的默认值偏离 CSS 初始值：body 的 margin 是 8px、ul/ol 的 padding-left
   * 是 40px、a 的 text-decoration 是 underline、h1 的 font-size 是 2em 并带
   * margin-block……原站通常用 reset 把这些压回初始值，于是被跳过；还原页却回退成
   * UA 默认值，整页错位。有了这张基准表，styleOf 就能判断「跳过是否安全」。
   *
   * @returns {Promise<{probe: (tag: string) => object|null, destroy: () => void}>}
   */
  async function buildUaDefaults() {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;left:-99999px;top:0;width:320px;height:240px;border:0;';
    frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
    document.body.appendChild(frame);

    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      frame.addEventListener('load', fin);
      setTimeout(fin, 1500);
    });

    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    const cache = {};
    try { cache.html = snapshotProps(win.getComputedStyle(doc.documentElement)); } catch (e) { /* ignore */ }
    try { cache.body = snapshotProps(win.getComputedStyle(doc.body)); } catch (e) { /* ignore */ }

    function probe(tag) {
      if (Object.prototype.hasOwnProperty.call(cache, tag)) return cache[tag];
      let el = null;
      try { el = doc.createElement(tag); } catch (e) { el = null; }
      if (!el) { cache[tag] = null; return null; }
      doc.body.appendChild(el);
      let o = null;
      try { o = snapshotProps(win.getComputedStyle(el)); } catch (e) { o = null; }
      if (el.parentNode) el.remove();
      cache[tag] = o;
      return o;
    }

    return {
      probe,
      destroy() { if (frame.parentNode) frame.remove(); }
    };
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

    // UA 默认样式基准：判断「computed 等于 CSS 初始值」的属性能否安全跳过
    let uaDefaults = null;
    try {
      uaDefaults = await buildUaDefaults();
    } catch (e) {
      warnings.push('UA 默认样式探测失败: ' + e.message);
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
    const varCache = new Map(); // 元素 -> 自定义属性集合，供 diffCustomProps 与父级比对
    const hidden = [];          // 原页面中不可见、但会留在 HTML 里的元素
    let truncated = false;

    /**
     * 记录"原页面里不可见、但会留在 HTML 中"的元素。
     *
     * 为什么必须记录：这些元素被 isVisibleEl 过滤后不会生成任何 CSS 规则，
     * 而 HTML 是从 DOM 整体复制的、它们仍在里面 —— 没有约束就会以浏览器默认样式
     * 显示出来。典型表现：整屏散落的下拉菜单、被撑成巨大黑块的无尺寸 SVG 图标。
     *
     * 只记录"自身样式导致不可见"的元素：父级已隐藏的交给父级即可，
     * 配合 walkEl 对 display:none 子树不再下探，避免重复记录。
     */
    function recordHidden(node, cs) {
      const parent = node.parentElement;
      if (parent) {
        const pcs = getComputedStyle(parent);
        if (pcs.display === 'none') return;
        if (pcs.visibility === 'hidden' && cs.visibility === 'hidden') return;
      }
      const rec = { p: cssPath(node) };
      if (cs.display === 'none') rec.d = 'none';
      else if (cs.visibility === 'hidden') rec.v = 'hidden';
      else if (parseFloat(cs.opacity) === 0) rec.o = '0';
      else return;
      hidden.push(rec);
    }

    function collectEl(node) {
      if (elements.length >= opts.maxElements) { truncated = true; return; }
      const cs = getComputedStyle(node);
      if (!isVisibleEl(node, cs)) {
        recordHidden(node, cs);
        return;
      }
      const r = node.getBoundingClientRect();
      if (!(r.width > 0 || r.height > 0)) {
        // 0 尺寸的纯空 / 装饰节点（追踪像素、无内容的占位）无需采集。
        // 但「有子元素」的 0 尺寸节点往往是布局容器 —— 子元素靠绝对定位脱离文档流
        // 使其自身塌缩为 0 尺寸。它的 display:flex / grid-template-columns / position
        // 等布局属性直接决定整棵子树的排布，一旦被跳过，子树在还原页就会回退成块级
        // 堆叠、整屏错位。这是 Vue 这类 SPA 还原后「页面混乱」的主因，因此容器必须保留。
        if (!node.children.length && !node.shadowRoot) return;
      }

      const tag = node.tagName.toLowerCase();
      const rec = {
        p: cssPath(node),
        t: tag,
        r: rectOf(node),
        bk: blockIndexOf(node),
        s: styleOf(cs, uaDefaults ? uaDefaults.probe(tag) : null)
      };

      // CSS 自定义属性只在"定义点"输出，否则继承会让每个元素重复同一批变量
      const vars = diffCustomProps(varCache, node, cs);
      if (vars) Object.assign(rec.s, vars);

      // 表单控件必须显式关掉原生外观，否则还原页里会退回浏览器默认样式
      if (NATIVE_APPEARANCE_TAGS[node.tagName]) {
        const ap = cs.getPropertyValue('appearance') || cs.getPropertyValue('-webkit-appearance');
        if (ap) rec.s.appearance = ap;
      }
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

        // display:none 的子树根本不会渲染，无需继续下探：
        // 既省时间，也避免把整棵隐藏子树逐条记录成冗余的隐藏规则
        let childCs;
        try { childCs = getComputedStyle(child); } catch (e) { continue; }
        if (childCs.display === 'none') continue;

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

    // 滚动条、placeholder 这类伪元素的样式无法从 computed style 取得，单独搬运规则原文
    let pseudoRules = [];
    try {
      pseudoRules = collectPseudoRules();
    } catch (e) {
      warnings.push('伪元素规则采集失败: ' + e.message);
    }

    // 探测 iframe 必须在取 outerHTML 之前移除，否则会被写进 fullHtml 快照
    if (uaDefaults) { try { uaDefaults.destroy(); } catch (e) { /* ignore */ } }

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
      hidden,
      images,
      pseudoRules,
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

  window.__PAGE_SNAPPER__ = { version: VERSION, collect, cssPath };
})();
