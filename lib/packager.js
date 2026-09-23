/**
 * packager.js — 把采集数据 + 已抓取的二进制资源，转换成对 AI 友好的文件树
 *
 * 产物（双轨）：
 *   README.md            给 AI 的使用说明
 *   outline.md           区块大纲 —— AI 先读这个（几 KB ~ 几十 KB）
 *   tokens.json          设计令牌（颜色/字体/间距/圆角/阴影）
 *   page-meta.json       页面元信息
 *   images.json          图片清单（原文/位置/尺寸/用途）
 *   sections/NN-*.html   分区块语义化 HTML，图片引用已改写为本地路径
 *   sections/NN-*.css    分区块样式，只含偏离 CSS 初始值的声明
 *   images/*             原始图片，按语义命名
 *   fonts/*              原页面 @font-face 字体文件
 *   index.html           完整还原页，解压后双击即可在浏览器预览效果
 *   style.css
 */

const STOP_WORDS = new Set([
  'image', 'img', 'pic', 'picture', 'photo', 'banner', 'background', 'bg',
  'untitled', 'download', 'file', 'asset', 'sprite', 'unnamed', 'default',
  'placeholder', 'thumb', 'thumbnail', 'blank', 'empty', 'new', 'temp'
]);

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'application/font-woff': 'woff',
  'application/x-font-ttf': 'ttf',
  'application/vnd.ms-fontobject': 'eot',
  'video/mp4': 'mp4',
  'video/webm': 'webm'
};

const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', ico: 'image/x-icon',
  bmp: 'image/bmp', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  otf: 'font/otf', eot: 'application/vnd.ms-fontobject', mp4: 'video/mp4', webm: 'video/webm'
};

// ------------------------------------------------------------------ 工具
function pad2(n) {
  return String(n).padStart(2, '0');
}

function slug(input, maxLen) {
  return String(input || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen || 36);
}

function isHashLike(s) {
  const v = String(s || '');
  if (!v) return true;
  if (/^[0-9a-f]{6,}$/i.test(v)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(v)) return true;
  if (/^\d+$/.test(v)) return true;
  if (v.length <= 2) return true;
  return false;
}

function isMeaningfulWord(s) {
  const v = String(s || '').trim();
  if (!v) return false;
  if (isHashLike(v)) return false;
  if (STOP_WORDS.has(v.toLowerCase())) return false;
  return true;
}

function extFromMime(mime) {
  return MIME_EXT[String(mime || '').split(';')[0].trim().toLowerCase()] || '';
}

function extFromUrl(url) {
  const clean = String(url || '').split('?')[0].split('#')[0];
  const m = /\.([a-z0-9]{2,5})$/i.exec(clean);
  return m ? m[1].toLowerCase() : '';
}

function resolveExt(resource, asset) {
  if (resource.kind === 'inline-svg') return 'svg';
  const fromMime = asset && asset.contentType ? extFromMime(asset.contentType) : '';
  if (fromMime) return fromMime;
  const fromUrl = extFromUrl(resource.url);
  if (fromUrl) return fromUrl;
  if (resource.inlineData) {
    const m = /^data:([^;,]+)/.exec(resource.inlineData);
    if (m) return extFromMime(m[1]) || 'bin';
  }
  return 'bin';
}

function mimeForExt(ext) {
  return EXT_MIME[String(ext).toLowerCase()] || 'application/octet-stream';
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ------------------------------------------------------------------ 形象命名
function inferRole(resource, blockName, desc) {
  const usage = resource.usages && resource.usages[0];
  let w = 0;
  let h = 0;
  if (resource.natural && resource.natural[0] > 0) {
    w = resource.natural[0];
    h = resource.natural[1];
  } else if (usage && usage.rect) {
    w = usage.rect[2];
    h = usage.rect[3];
  }
  const ratio = h > 0 ? w / h : 1;
  const inHeader = /header|nav|top|title|logo/i.test(blockName || '');
  const inFooter = /footer|bottom/i.test(blockName || '');
  const text = (desc || '').toLowerCase();

  if (resource.kind === 'inline-svg') {
    return w <= 48 ? 'icon' : 'svg';
  }
  if (w > 0 && h > 0 && w <= 64 && h <= 64) return 'icon';
  if (/avatar|profile|user|portrait|head/i.test(text) && Math.abs(ratio - 1) < 0.25) return 'avatar';
  if (inHeader && w >= 40 && ratio > 1.3) return 'logo';
  if (ratio > 3) return 'banner';
  if (inFooter && w <= 200) return 'logo';
  if (resource.kind === 'css-background') return 'bg';
  if (resource.kind === 'video-poster') return 'poster';
  return 'image';
}

function deriveBase(resource, role) {
  const candidates = [];

  if (resource.alt) candidates.push(resource.alt);
  const ctx = resource.context || {};
  if (ctx.id) candidates.push(ctx.id);
  if (ctx.classes) {
    ctx.classes.split(/\s+/).forEach((c) => candidates.push(c));
  }
  if (ctx.text) candidates.push(ctx.text);
  if (ctx.tag) candidates.push(ctx.tag);

  if (resource.url) {
    const file = decodeURIComponent(String(resource.url).split('?')[0].split('#')[0].split('/').pop() || '');
    const noExt = file.replace(/\.[a-z0-9]{2,5}$/i, '');
    // 去掉形如 logo.8a3f2c1b 的构建哈希
    candidates.push(noExt.replace(/[._-][0-9a-f]{6,}$/i, ''));
  }

  const words = [];
  for (const c of candidates) {
    const parts = String(c || '').split(/[\s\-_/|·、，,。.]+/).filter(Boolean);
    for (const p of parts) {
      if (!isMeaningfulWord(p)) continue;
      const s = slug(p);
      if (s && s.length >= 2 && words.indexOf(s) === -1) words.push(s);
    }
  }
  if (!words.length) return role;

  // 与角色同义的词优先，例如 'ACME 公司 Logo' 应得到 logo 而不是 acme
  const exact = words.find((w) => w === role);
  if (exact) return exact;
  const contains = words.find((w) => w.includes(role));
  if (contains) return contains;
  return words[0];
}

/**
 * 为每张图片分配包内文件名
 * @returns {Array<{resource, fileName, ext, role, base}>}
 */
export function planImageNames(data) {
  const blocks = data.blocks || [];
  const taken = new Set();
  const plan = [];

  for (const res of data.images || []) {
    const usage = (res.usages && res.usages[0]) || null;
    const blockIdx = usage ? usage.blockIndex : -1;
    const blockName = blockIdx >= 0 && blocks[blockIdx] ? blocks[blockIdx].name : '';
    const desc = [res.alt, res.context && res.context.classes, res.context && res.context.text]
      .filter(Boolean).join(' ');
    const role = inferRole(res, blockName, desc);
    const base = deriveBase(res, role);
    const ext = resolveExt(res, res.asset);
    const prefix = blockIdx >= 0 ? pad2(blockIdx + 1) + '-' : '00-';

    let candidate = pad2(blockIdx + 1) + '-' + base + '.' + ext;
    if (blockIdx < 0) candidate = '00-' + base + '.' + ext;

    let n = 2;
    while (taken.has(candidate)) {
      candidate = pad2(blockIdx + 1) + '-' + base + '-' + n + '.' + ext;
      n++;
    }
    taken.add(candidate);
    plan.push({ resource: res, fileName: candidate, ext, role, base, prefix });
  }
  return plan;
}

// ------------------------------------------------------------------ URL 改写
function makeUrlRewriter(urlMap, base) {
  const baseUrl = base || '';
  const lookup = (raw) => {
    if (!raw) return null;
    let abs = String(raw).trim();
    if (!/^(https?:|data:|blob:)/i.test(abs)) {
      try { abs = new URL(abs, baseUrl).href; } catch (e) { return null; }
    }
    return urlMap.get(abs) || null;
  };
  return { lookup };
}

function rewriteText(text, rewriter, prefix) {
  if (!text) return text;
  let out = text;

  // HTML 属性：src / href / poster / data-src
  // 属性值内部可能含另一种引号（内联 SVG 的 data URL 很常见），
  // 所以用非贪婪匹配到与外层相同的引号，而不是排除所有引号字符。
  out = out.replace(/(\s(?:src|href|poster|data-src|data-original)=)(["'])([\s\S]*?)\2/gi, (m, p1, q, v) => {
    const hit = rewriter.lookup(v);
    return hit ? p1 + q + prefix + hit + q : m;
  });

  // srcset
  out = out.replace(/(\ssrcset=)(["'])([\s\S]*?)\2/gi, (m, p1, q, v) => {
    const next = v.split(',').map((part) => {
      const segs = part.trim().split(/\s+/);
      if (!segs[0]) return part;
      const hit = rewriter.lookup(segs[0]);
      if (hit) segs[0] = prefix + hit;
      return segs.join(' ');
    }).join(', ');
    return p1 + q + next + q;
  });

  // CSS url()：优先匹配引号包裹的形式，允许内部含括号与另一种引号
  out = out.replace(/url\(\s*(?:'([^']*)'|"([^"]*)"|([^)'"]*))\s*\)/g, (m, s, d, bare) => {
    const raw = (s !== undefined ? s : (d !== undefined ? d : bare)) || '';
    const hit = rewriter.lookup(raw.trim());
    if (!hit) return m;
    const quote = s !== undefined ? "'" : (d !== undefined ? '"' : '');
    return 'url(' + quote + prefix + hit + quote + ')';
  });

  return out;
}

function cleanHtml(html, rewriter, imagePrefix) {
  if (!html) return '';
  let out = html;
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<script\b[^>]*\/>/gi, '');
  out = out.replace(/\sloading=["']lazy["']/gi, '');
  out = out.replace(/([a-zA-Z-]+)\s*:\s*;/g, '');
  out = out.replace(/\sstyle=(["'])\s*;?\s*\1/gi, '');

  out = rewriteText(out, rewriter, imagePrefix);

  // 懒加载图片：原页靠 JS 把 data-src 赋给 src 才显示。
  // 静态快照没有 JS，这里直接补一个 src，保证预览时看得见。
  // 此时 data-src 的值已被改写成包内相对路径，可以直接复用。
  out = out.replace(/<img\b([^>]*)>/gi, (m, attrs) => {
    if (/\ssrc\s*=/i.test(attrs)) return m;
    const lazy = /\sdata-(?:src|original|lazy-src|url)\s*=\s*(["'])([^"']*)\1/i.exec(attrs);
    if (lazy && lazy[2]) {
      return '<img' + attrs + ' src=' + lazy[1] + lazy[2] + lazy[1] + '>';
    }
    return m;
  });

  return out;
}

// ------------------------------------------------------------------ 样式生成
const PROP_ORDER = [
  'content', 'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'float', 'clear',
  'box-sizing', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'aspect-ratio',
  'overflow', 'overflow-x', 'overflow-y',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'background-color', 'background-image', 'background-size', 'background-position', 'background-repeat',
  'background-attachment', 'background-clip', 'background-origin',
  'box-shadow', 'filter', 'backdrop-filter', 'mix-blend-mode', 'clip-path', 'opacity',
  'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'line-height', 'letter-spacing', 'word-spacing',
  'text-align', 'text-decoration-line', 'text-transform', 'text-indent', 'text-shadow',
  'white-space', 'word-break', 'overflow-wrap', 'text-overflow', 'vertical-align',
  'writing-mode', 'user-select',
  'transform', 'transform-origin', 'cursor', 'pointer-events',
  'list-style-type', 'list-style-position', 'object-fit', 'object-position'
];

const BORDER_COLOR_KEYS = ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'];
const BORDER_WIDTH_KEYS = ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'];

function orderKeys(obj) {
  return Object.keys(obj).sort((a, b) => {
    const ia = PROP_ORDER.indexOf(a);
    const ib = PROP_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a < b ? -1 : 1;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

function resolveValue(key, value, pool) {
  if (key === 'font-family' && typeof value === 'number') return pool[value];
  return value;
}

function hasVisibleBorder(style) {
  return BORDER_WIDTH_KEYS.some((k) => style[k] && parseFloat(style[k]) > 0);
}

function declText(style, pool, indent) {
  const lines = [];
  const visibleBorder = hasVisibleBorder(style);
  for (const k of orderKeys(style)) {
    if (BORDER_COLOR_KEYS.indexOf(k) >= 0 && !visibleBorder) continue;
    const v = resolveValue(k, style[k], pool);
    if (v === undefined || v === null || v === '') continue;
    lines.push(indent + k + ': ' + v + ';');
  }
  return lines.join('\n');
}

function buildRulesForElements(elements, pool) {
  const groups = new Map();
  for (const e of elements) {
    const sig = orderKeys(e.s).map((k) => k + '\u0000' + e.s[k]).join('\u0001');
    if (!groups.has(sig)) groups.set(sig, { style: e.s, selectors: [] });
    groups.get(sig).selectors.push(e.p);
  }
  const rules = [];
  for (const g of groups.values()) {
    rules.push({
      selectors: g.selectors,
      body: declText(g.style, pool, '  ')
    });
  }
  return rules;
}

// ------------------------------------------------------------------ 角色推断
function inferBlockRole(block) {
  const n = (block.name || '').toLowerCase();
  if (/navbar|nav\b|header|topbar|masthead/.test(n)) return '顶部导航栏';
  if (/sidebar|aside|drawer/.test(n)) return '侧边栏';
  if (/footer|page-edit|bottom|footnav/.test(n)) return '页脚';
  if (/hero|banner|jumbotron|masthead/.test(n)) return '首屏横幅';
  if (/toc|table-of-contents|catalog/.test(n)) return '目录导航';
  if (/content|article|main|post|doc\b/.test(n)) return '主内容区';
  if (/card|list|grid|gallery/.test(n)) return '卡片列表';
  if (/form|search|login|signup/.test(n)) return '表单区';
  if (/modal|dialog|popup|overlay/.test(n)) return '弹层';
  if (/global-ui|toast|notification/.test(n)) return '全局 UI';
  return '内容区块';
}

function blockKeyStyles(block, elements, pool) {
  const rootEl = elements.find((e) => e.bk === block.index && e.p === block.name) ||
    elements.find((e) => e.bk === block.index);
  if (!rootEl) return {};
  const wanted = ['display', 'position', 'background-color', 'color', 'font-size', 'font-family',
    'padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'box-shadow', 'border-radius',
    'border-top-left-radius', 'width', 'max-width'];
  const out = {};
  for (const k of wanted) {
    const v = resolveValue(k, rootEl.s[k], pool);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ------------------------------------------------------------------ Markdown
function humanSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function buildReadme(data, plan, stats) {
  const m = data.meta;
  return `# 网页素材包 — ${m.title || m.url}

由 **Page Snapper** 提取，用于让 AI 复刻页面。请按下面的顺序阅读，避免一次性加载全部文件。

## 阅读顺序（重要）

| 顺序 | 文件 | 作用 | 体量 |
|---|---|---|---|
| 1 | \`outline.md\` | 区块大纲：每块的位置、尺寸、角色、关键样式、图片 | ${stats.outlineSize} |
| 2 | \`tokens.json\` | 设计令牌：颜色 / 字体 / 间距 / 圆角 / 阴影 | ${stats.tokensSize} |
| 3 | \`sections/NN-*.html\` + \`.css\` | 需要细节时按区块读 | 按需 |
| 4 | \`images.json\` | 每张图的位置、尺寸、用途 | ${stats.imagesJsonSize} |
| 5 | \`index.html\` | 完整还原页，**仅在需要像素级对照时打开** | ${stats.fullHtmlSize} |

> 前三步通常足以理解整个页面的设计系统。\`index.html\` / \`style.css\` 体积大，不要让 AI 默认读取。

## 想看还原效果？

**先解压整个 ZIP，然后双击根目录的 \`index.html\`**，即可在浏览器中看到采集下来的页面。

必须解压后再打开 —— 直接双击 ZIP 里的文件，浏览器无法解析其中的相对路径，会看到没有样式和图片的空白页。

## 页面信息

- 来源：${m.url}
- 标题：${m.title || '(无)'}
- 采集时间：${m.capturedAt}
- 视口：${m.viewport.join(' x ')}（DPR ${m.devicePixelRatio}）
- 文档尺寸：${m.documentSize[0]} x ${m.documentSize[1]}
- 可见元素：${m.elementCount}　区块：${m.blockCount}　图片：${(data.images || []).length}
- 页面背景：${m.bodyBackground}

## 目录结构

\`\`\`
.
├── index.html          ← 解压后双击，在浏览器预览还原效果
├── style.css           ← 预览页样式
├── outline.md          ← AI 先读
├── tokens.json         ← AI 再读
├── page-meta.json
├── images.json
├── sections/           ← 分区块 HTML + CSS
├── images/             ← 原始图片（语义化命名）
└── fonts/              ← 原页面字体文件
\`\`\`

## 注意事项

- 样式只包含**偏离 CSS 初始值**的声明，未出现的属性即为浏览器默认值。
- 选择器是采集时元素在真实 DOM 中的路径，不是原站源码里的类名。
- 交互态（\`:hover\`、\`:focus\`、媒体查询分支）无法从 computed style 获得，**未包含**。
- HTML 中的图片引用已改写为本地相对路径，与 \`images/\` 目录一一对应。
- 采集基于 ${m.viewport[0]}px 视口，尺寸为固定值；响应式表现需自行重设计。
${data.warnings && data.warnings.length ? '\n## 采集警告\n\n' + data.warnings.map((w) => '- ' + w).join('\n') + '\n' : ''}`;
}

function buildOutline(data, plan) {
  const m = data.meta;
  const pool = data.stringPool || [];
  const lines = [];

  lines.push('# 页面大纲 — ' + (m.title || m.url));
  lines.push('');
  lines.push('- 来源：' + m.url);
  lines.push('- 视口：' + m.viewport.join(' x ') + '　文档尺寸：' + m.documentSize[0] + ' x ' + m.documentSize[1]);
  lines.push('- 可见元素 ' + m.elementCount + ' 个，划分为 ' + m.blockCount + ' 个区块，图片 ' + (data.images || []).length + ' 张');
  lines.push('- 页面背景：' + m.bodyBackground + '　根元素背景：' + m.htmlBackground);
  lines.push('');

  const byBlock = new Map();
  for (const p of plan) {
    const usage = (p.resource.usages && p.resource.usages[0]) || null;
    const idx = usage ? usage.blockIndex : -1;
    if (!byBlock.has(idx)) byBlock.set(idx, []);
    byBlock.get(idx).push(p);
  }

  const blocks = (data.blocks || []).slice().sort((a, b) => a.index - b.index);
  for (const b of blocks) {
    const count = (data.elements || []).filter((e) => e.bk === b.index).length;
    const role = inferBlockRole(b);
    lines.push('## 区块 ' + pad2(b.index + 1) + ' — ' + b.name);
    lines.push('');
    lines.push('- 角色：' + role);
    lines.push('- 位置：x=' + b.rect[0] + ' y=' + b.rect[1] + '　尺寸：' + b.rect[2] + ' x ' + b.rect[3]);
    lines.push('- 可见元素：' + count + ' 个');
    const keyStyles = blockKeyStyles(b, data.elements || [], pool);
    const keys = Object.keys(keyStyles);
    if (keys.length) {
      lines.push('- 关键样式：');
      for (const k of keys) lines.push('  - `' + k + '`: ' + keyStyles[k]);
    }
    const imgs = byBlock.get(b.index) || [];
    if (imgs.length) {
      lines.push('- 图片（' + imgs.length + ' 张）：');
      for (const p of imgs.slice(0, 20)) {
        const alt = p.resource.alt ? ' alt="' + p.resource.alt + '"' : '';
        lines.push('  - `images/' + p.fileName + '`（' + p.role + '，' +
          (p.resource.natural && p.resource.natural[0]
            ? p.resource.natural[0] + 'x' + p.resource.natural[1]
            : p.resource.usages[0].rect[2] + 'x' + p.resource.usages[0].rect[3]) + alt + '）');
      }
      if (imgs.length > 20) lines.push('  - … 其余 ' + (imgs.length - 20) + ' 张见 images.json');
    }
    lines.push('- 文件：`sections/' + pad2(b.index + 1) + '-' + slugFile(b.name) + '.html`');
    lines.push('');
  }

  const orphan = byBlock.get(-1);
  if (orphan && orphan.length) {
    lines.push('## 未归属区块的图片（' + orphan.length + ' 张）');
    lines.push('');
    for (const p of orphan.slice(0, 30)) {
      lines.push('- `images/' + p.fileName + '`（' + p.role + '）');
    }
    lines.push('');
  }

  return lines.join('\n');
}

function slugFile(name) {
  return slug(name.replace(/[.#]/g, '-').replace(/:nth-of-type\(\d+\)/g, ''), 40) || 'block';
}

function tallyToArray(map, limit) {
  return Object.keys(map || {})
    .map((k) => ({ value: k, count: map[k] }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1))
    .slice(0, limit || 60);
}

function buildTokens(data) {
  const f = data.fonts || {};
  const c = data.colors || {};
  const s = data.spacing || {};
  return {
    generatedFrom: data.meta.url,
    generatedAt: data.meta.capturedAt,
    colors: {
      text: tallyToArray(c.text, 40),
      background: tallyToArray(c.background, 30),
      border: tallyToArray(c.border, 20),
      shadow: tallyToArray(c.boxShadow, 15)
    },
    typography: {
      families: tallyToArray(f.families, 20),
      sizes: tallyToArray(f.sizes, 30),
      weights: tallyToArray(f.weights, 12),
      lineHeights: tallyToArray(f.lineHeights, 20),
      fontFaces: (f.faces || []).map((x) => x.cssText)
    },
    spacing: {
      padding: tallyToArray(s.paddings, 40),
      margin: tallyToArray(s.margins, 40),
      gap: tallyToArray(s.gaps, 20),
      borderRadius: tallyToArray(s.borderRadii, 20)
    }
  };
}

function buildImagesJson(data, plan) {
  const m = data.meta;
  return {
    page: m.url,
    viewport: m.viewport,
    total: plan.length,
    items: plan.map((p) => {
      const res = p.resource;
      return {
        file: 'images/' + p.fileName,
        role: p.role,
        kind: res.kind,
        originalUrl: res.url || '(inline)',
        alt: res.alt || '',
        naturalSize: res.natural && res.natural[0] ? { width: res.natural[0], height: res.natural[1] } : null,
        byteLength: res.asset ? res.asset.byteLength : (res.byteLength || null),
        context: res.context || null,
        usages: (res.usages || []).map((u) => ({
          selector: u.selector,
          rect: u.rect,
          visible: u.visible,
          blockIndex: u.blockIndex
        })),
        srcset: res.srcset || undefined,
        error: res.fetchError || undefined
      };
    })
  };
}

// ------------------------------------------------------------------ 主入口
/**
 * @param {object} data    collector 的返回
 * @param {Map<number, {bytes: Uint8Array, contentType: string, fileName?: string}>} assetMap
 * @param {Map<number, {bytes: Uint8Array, contentType: string, fileName: string}>} fontMap
 * @returns {Array<{path: string, data: any}>}
 */
export function buildPackage(data, assetMap, fontMap) {
  const files = [];
  const pool = data.stringPool || [];
  const meta = data.meta || {};

  // 1) 给资源挂上已抓取的二进制，规划文件名
  (data.images || []).forEach((res) => {
    if (assetMap && assetMap.has(res.id)) res.asset = assetMap.get(res.id);
  });

  const plan = planImageNames(data);

  // 注意：fileName 在 plan 项上，不在 resource 上。
  // 早先误写成 res.fileName，导致 HTML 里的引用被拼成 images/undefined。
  const urlMap = new Map();
  for (const p of plan) {
    const res = p.resource;
    if (!res.url) continue;
    // data: / blob: 同样已被提取成本地文件，因此引用也要改写
    if (!urlMap.has(res.url)) urlMap.set(res.url, 'images/' + p.fileName);
  }
  const fontMapByUrl = new Map();
  if (fontMap) {
    for (const [url, info] of fontMap.entries()) {
      fontMapByUrl.set(url, info.fileName);
    }
  }

  const rewriter = makeUrlRewriter(urlMap, meta.url || '');
  // sections/ 位于子目录，引用资源要回上一级；根目录的 index.html 与 images/ 同级
  const imagePrefix = '../';
  const rootPrefix = '';

  // 2) 图片文件
  for (const p of plan) {
    const asset = p.resource.asset;
    if (asset && asset.bytes && asset.bytes.length) {
      files.push({ path: 'images/' + p.fileName, data: asset.bytes });
    } else if (p.resource.kind === 'inline-svg' && p.resource.svgText) {
      files.push({ path: 'images/' + p.fileName, data: p.resource.svgText });
      p.resource.asset = { bytes: new TextEncoder().encode(p.resource.svgText), contentType: 'image/svg+xml' };
    } else if (p.resource.inlineData) {
      const m = /^data:[^;,]*;base64,(.*)$/s.exec(p.resource.inlineData);
      if (m) {
        try {
          const bin = atob(m[1]);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          files.push({ path: 'images/' + p.fileName, data: bytes });
          p.resource.asset = { bytes, contentType: 'image/*' };
        } catch (e) { /* 忽略损坏的内联数据 */ }
      }
    }
  }

  // 3) 字体文件
  if (fontMap) {
    for (const [, info] of fontMap.entries()) {
      if (info.bytes && info.bytes.length) {
        files.push({ path: 'fonts/' + info.fileName, data: info.bytes });
      }
    }
  }

  // 4) 分区块文件
  const elements = data.elements || [];
  const blocks = (data.blocks || []).slice().sort((a, b) => a.index - b.index);
  for (const b of blocks) {
    const fileBase = pad2(b.index + 1) + '-' + slugFile(b.name);
    const blockEls = elements.filter((e) => e.bk === b.index);
    const html = cleanHtml(b.html, rewriter, imagePrefix);
    files.push({ path: 'sections/' + fileBase + '.html', data: html });

    const rules = buildRulesForElements(blockEls, pool);
    const css = [];
    css.push('/* 区块 ' + pad2(b.index + 1) + ': ' + b.name + ' */');
    css.push('/* 角色: ' + inferBlockRole(b) + ' | 位置: x=' + b.rect[0] + ' y=' + b.rect[1] +
      ' 尺寸: ' + b.rect[2] + 'x' + b.rect[3] + ' | 可见元素: ' + blockEls.length + ' */');
    css.push('');
    for (const r of rules) {
      css.push(rewriteText(r.selectors.join(',\n'), rewriter, imagePrefix) + ' {');
      css.push(rewriteText(r.body, rewriter, imagePrefix));
      css.push('}');
      css.push('');
    }
    files.push({ path: 'sections/' + fileBase + '.css', data: css.join('\n') });
  }

  // 5) 根目录预览页 —— 解压后双击 index.html 即可在浏览器查看还原效果。
  //    它位于包根目录，与 images/ 同级，因此资源前缀是空的。
  let shellHtml = data.fullHtml || '';
  if (shellHtml) {
    const inner = cleanHtml(shellHtml, rewriter, rootPrefix);
    const withCss = inner.replace(/<\/head>/i, '  <link rel="stylesheet" href="style.css">\n</head>');
    files.push({
      path: 'index.html',
      data: /<\/head>/i.test(inner)
        ? withCss
        : '<!DOCTYPE html>\n<html><head><link rel="stylesheet" href="style.css"></head><body>\n' +
          blocks.map((b) => cleanHtml(b.html, rewriter, rootPrefix)).join('\n') + '\n</body></html>'
    });
  } else {
    files.push({
      path: 'index.html',
      data: '<!DOCTYPE html>\n<html lang="' + (meta.lang || 'zh-CN') + '">\n<head>\n' +
        '<meta charset="utf-8">\n<title>' + escapeHtml(meta.title || '') + '</title>\n' +
        '<link rel="stylesheet" href="style.css">\n</head>\n<body>\n' +
        blocks.map((b) => cleanHtml(b.html, rewriter, rootPrefix)).join('\n') +
        '\n</body>\n</html>'
    });
  }

  const fullCss = [];
  fullCss.push('/* 完整还原样式 — ' + meta.url + ' */');
  fullCss.push('/* 选择器为采集时元素的真实 DOM 路径；声明仅含偏离 CSS 初始值的属性 */');
  fullCss.push('');

  const faceList = (data.fonts && data.fonts.faces) || [];
  if (faceList.length) {
    fullCss.push('/* 原页面 @font-face，src 已指向本地 fonts/ */');
    for (const face of faceList) {
      const css = typeof face === 'string' ? face : face.cssText;
      fullCss.push(rewriteFontFaces(css, fontMapByUrl, meta.url || '', 'fonts/'));
    }
    fullCss.push('');
  }

  if (meta.htmlBackground && meta.htmlBackground !== 'rgba(0, 0, 0, 0)') {
    fullCss.push('html {');
    fullCss.push('  background-color: ' + meta.htmlBackground + ';');
    fullCss.push('}');
    fullCss.push('');
  }
  for (const b of blocks) {
    fullCss.push('/* ===== 区块 ' + pad2(b.index + 1) + ': ' + b.name + ' ===== */');
    fullCss.push('');
    const blockEls = elements.filter((e) => e.bk === b.index);
    for (const r of buildRulesForElements(blockEls, pool)) {
      fullCss.push(rewriteText(r.selectors.join(',\n'), rewriter, rootPrefix) + ' {');
      fullCss.push(rewriteText(r.body, rewriter, rootPrefix));
      fullCss.push('}');
      fullCss.push('');
    }
  }
  const orphanEls = elements.filter((e) => e.bk === -1);
  if (orphanEls.length) {
    fullCss.push('/* ===== 未归属区块的元素 ===== */');
    fullCss.push('');
    for (const r of buildRulesForElements(orphanEls, pool)) {
      fullCss.push(rewriteText(r.selectors.join(',\n'), rewriter, rootPrefix) + ' {');
      fullCss.push(rewriteText(r.body, rewriter, rootPrefix));
      fullCss.push('}');
      fullCss.push('');
    }
  }
  files.push({ path: 'style.css', data: fullCss.join('\n') });

  // 6) 清单与元信息
  files.push({ path: 'page-meta.json', data: JSON.stringify({
    url: meta.url,
    origin: meta.origin,
    title: meta.title,
    lang: meta.lang,
    charset: meta.charset,
    capturedAt: meta.capturedAt,
    userAgent: meta.userAgent,
    viewport: meta.viewport,
    devicePixelRatio: meta.devicePixelRatio,
    documentSize: meta.documentSize,
    bodyBackground: meta.bodyBackground,
    htmlBackground: meta.htmlBackground,
    elementCount: meta.elementCount,
    blockCount: meta.blockCount,
    imageCount: plan.length,
    frames: meta.frames || [],
    warnings: data.warnings || [],
    truncated: !!data.truncated,
    fullHtmlTruncated: !!data.fullHtmlTruncated,
    tool: { name: 'Page Snapper', version: data.version }
  }, null, 2) });

  files.push({ path: 'images.json', data: JSON.stringify(buildImagesJson(data, plan), null, 2) });
  files.push({ path: 'tokens.json', data: JSON.stringify(buildTokens(data), null, 2) });
  files.push({ path: 'outline.md', data: buildOutline(data, plan) });

  const sizeOf = (p) => {
    const f = files.find((x) => x.path === p);
    if (!f) return '—';
    const len = typeof f.data === 'string' ? new TextEncoder().encode(f.data).length : f.data.length;
    return humanSize(len);
  };
  files.push({
    path: 'README.md',
    data: buildReadme(data, plan, {
      outlineSize: sizeOf('outline.md'),
      tokensSize: sizeOf('tokens.json'),
      imagesJsonSize: sizeOf('images.json'),
      fullHtmlSize: sizeOf('full/index.html')
    })
  });

  return files;
}

/** 从 @font-face 中提取需要下载的字体 URL */
export function extractFontUrls(data) {
  const urls = new Set();
  const faces = (data.fonts && data.fonts.faces) || [];
  for (const f of faces) {
    const css = typeof f === 'string' ? f : f.cssText;
    const re = /url\((['"]?)([^'")]+)\1\)/g;
    let m;
    while ((m = re.exec(css))) {
      let u = m[2].trim();
      if (!u || u.startsWith('data:')) continue;
      try { u = new URL(u, data.meta.url).href; } catch (e) { continue; }
      urls.add(u);
    }
  }
  return Array.from(urls);
}

/**
 * 把 @font-face 的 src 改写为本地 fonts/ 相对路径
 * @param {string} cssText
 * @param {Map<string,string>} fontUrlMap 绝对 URL -> 文件名
 * @param {string} base 用于把相对 URL 绝对化，以便命中映射
 * @param {string} fontPrefix 路径前缀：根目录用 'fonts/'，子目录用 '../fonts/'
 */
export function rewriteFontFaces(cssText, fontUrlMap, base, fontPrefix) {
  const prefix = fontPrefix === undefined ? '../fonts/' : fontPrefix;
  if (!fontUrlMap || !fontUrlMap.size) return String(cssText);
  // 引号包裹的形式优先，允许 URL 内部含另一种引号与括号
  return String(cssText).replace(/url\(\s*(?:'([^']*)'|"([^"]*)"|([^)'"]*))\s*\)/g, (m, s, d, bare) => {
    const raw = ((s !== undefined ? s : (d !== undefined ? d : bare)) || '').trim();
    if (!raw || raw.startsWith('data:')) return m;
    let abs = raw;
    if (base) {
      try { abs = new URL(raw, base).href; } catch (e) { /* 保持原样 */ }
    }
    const fileName = fontUrlMap.get(abs) || fontUrlMap.get(raw);
    if (!fileName) return m;
    const quote = s !== undefined ? "'" : (d !== undefined ? '"' : '');
    return 'url(' + quote + prefix + fileName + quote + ')';
  });
}

export function suggestPackageName(meta) {
  let host = 'page';
  try { host = new URL(meta.url).hostname.replace(/^www\./, ''); } catch (e) { /* ignore */ }
  const d = new Date(meta.capturedAt || Date.now());
  const stamp = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
    pad2(d.getHours()) + pad2(d.getMinutes());
  const titleSlug = slug(meta.title || '', 24);
  return [host, titleSlug, stamp].filter(Boolean).join('-');
}
