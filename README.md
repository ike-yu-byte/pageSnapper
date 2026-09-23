# Page Snapper — 网页素材包提取器

把**你当前正在浏览的页面**提取成一个适合交给 AI 复刻的素材包：分区块 HTML/CSS、设计令牌、语义化命名的原始图片，最终打包成 ZIP 下载。

面向的场景：客户发来旧版网页链接要求重构，没有源码。SingleFile 这类工具会把整页内联成一个巨型 HTML（CSS/JS/图片全塞进去），AI 读到的是几 MB 噪声；Page Snapper 的做法是**把信息分层**，让 AI 先读几 KB 的摘要建立认知，需要细节时再按区块取。

---

## 一、安装

Chrome 116 及以上。

1. 打开 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**
4. 选择本目录：`d:\develop\official\page-snapper`
5. 装好后工具栏会出现 Page Snapper 图标（若被折叠，点拼图图标固定它）

> 修改代码后，回到 `chrome://extensions` 点该扩展卡片上的**刷新**按钮即可生效。

### 权限说明

安装时会提示以下权限，用途如下：

| 权限 | 用途 |
|---|---|
| `activeTab` | 点击图标时访问当前标签页 |
| `scripting` | 向当前页注入采集脚本 |
| `downloads` | 保存最终的 ZIP |
| `offscreen` | 创建打包用的隐藏页面（MV3 的 Service Worker 里没有 `URL.createObjectURL`，必须借助它） |
| `<all_urls>` | 抓取页面上的跨域图片与字体文件 |

---

## 二、使用

1. 在 Chrome 里打开要复刻的网页，**等页面正常显示完整**
2. 点击工具栏的 **Page Snapper** 图标
3. 按需调整两个选项（见下），点 **提取当前页素材包**
4. 等待进度条走完，素材包会自动下载到浏览器的默认下载目录

采集期间**不要关闭弹窗**，进度走的是弹窗与后台的长连接。页面较大时约需 10–30 秒。

### 选项

| 选项 | 默认 | 说明 |
|---|---|---|
| 先滚动全页触发懒加载 | 开 | 自动滚到底再滚回，让 `loading="lazy"`、`data-src` 的图片真正加载出来。**建议保持开启**，否则页面上未进入过视口的图片尺寸为 0，会被判为不可见而漏采 |
| 包含完整还原页 `full/` | 开 | 生成像素级还原的整页 HTML+CSS。关掉可显著减小包体积，但失去"先看见原样"的兜底 |

### 因为运行在你的当前标签页

这一点和"用无头浏览器重新打开一遍 URL"有本质区别——登录态、你手动展开的面板、localStorage 里的开关、表单里填过的内容，都处于真实状态。**需要登录才能看到的页面也能正常采集**。

---

## 三、产物结构

ZIP 解压后：

```
README.md            给 AI 的使用说明与阅读顺序（注意：这是包内的，不是本项目文档）
outline.md           区块大纲 —— AI 先读这个
tokens.json          设计令牌：颜色 / 字体 / 字号 / 字重 / 间距 / 圆角 / 阴影
page-meta.json       页面元信息（URL、标题、视口、尺寸、采集警告等）
images.json          图片清单：每张图的原文、位置、尺寸、用途
sections/
  ├── 01-header-navbar.html    分区块 HTML
  ├── 01-header-navbar.css     分区块样式
  └── ...
images/              原始图片，按用途语义化命名
fonts/               @font-face 字体文件
full/
  ├── index.html     完整还原页（兜底，体积大）
  └── style.css
```

### 怎么喂给 AI

按顺序，**不要一次性全读**：

| 顺序 | 文件 | 作用 |
|---|---|---|
| 1 | `outline.md` | 页面有哪几个区块、各自的位置尺寸角色、关键样式、用了哪些图 |
| 2 | `tokens.json` | 设计系统：用了哪些颜色、几档字号、几档间距 |
| 3 | `sections/NN-*.html` + `.css` | 需要某个区块的细节时再单独读 |
| 4 | `images.json` | 需要判断某张图用在哪时读 |
| 5 | `full/index.html` | 仅在需要像素级对照时打开 |

实测参考（uni-app 官网首页，511 个可见元素 / 54 张图）：整包约 3 MB，其中 `outline.md` + `tokens.json` 合计只有 17 KB。

可以直接这样对 AI 说：

> 这是我用 Page Snapper 提取的旧版网页素材包。请先读 `outline.md` 和 `tokens.json` 理解它的结构和设计系统，然后按区块读 `sections/` 下的 HTML 和 CSS，帮我还原成现代前端代码。

### 图片命名规则

`NN-语义.ext`：

- `NN` 是所属区块序号（`01` 起）；`00` 表示该图不属于任何区块（如整页背景图、隐藏元素上的图）
- `语义` 依次从 `alt` → 祖先元素的 `id`/`class` → 附近文本 → 原文件名的顺序推断，并自动去掉构建哈希（`logo.8a3f2c1b.png` → `logo`）
- 与角色同义的词优先，所以 `alt="ACME 公司 Logo"` 会得到 `01-logo.svg` 而不是 `01-acme.svg`

实际样例：

```
01-logo.svg
02-hero.svg
04-icon.svg          04-icon-2.svg          04-icon-3.svg
08-仓储管理界面截图.svg
```

### 关于样式

- 只收录**可见元素**（`display:none`、`visibility:hidden`、`opacity:0` 会被跳过）
- 只记录**偏离 CSS 初始值**的属性，没写的属性就是浏览器默认值
- 选择器是采集时元素在真实 DOM 中的路径，不是原站源码里的类名
- HTML 里的图片引用已改写为本地相对路径，和 `images/` 一一对应，包是自洽的
- 未出现的 `border-*-color`（因为边框宽度为 0）与无效声明（如 Vue 残留的 `display:;`）已被清理

---

## 四、测试

```bash
cd d:\develop\official\page-snapper
npm test
```

默认跑离线测试页 `test/fixture.html`（覆盖 logo、CSS 背景图、伪元素图片、懒加载图、1×1 追踪像素、隐藏元素）。也可以指定真实网址：

```bash
node test/e2e.mjs "https://example.com/"
```

测试会启动独立的 headless Chrome（不碰你正在用的浏览器），完整走一遍采集 → 抓资源 → 打包，输出 10 项断言结果，产物落在 `test/output/`。

另有一个真机测试，会把扩展真正装进浏览器验证运行时行为：

```bash
node test/extension-e2e.mjs
```

它会把扩展真正装进 headless Chrome，验证 11 项只有运行时才暴露的行为：offscreen document 里 `chrome.downloads` 不可用（这正是"下载必须回到 SW 执行"的原因）、offscreen 创建的 blob URL 能否跨上下文交给 `downloads` 完成下载、Service Worker 能否正常注册，以及完整的 `popup → SW → offscreen → SW 下载` 链路能否跑通并真正产出 ZIP 文件。

---

## 五、已知限制

- **交互态不含**：`:hover`、`:focus`、`:active` 以及媒体查询的其他断点无法从 computed style 获得。
- **尺寸是固定的**：采集基于当时的视口宽度，产物里的 `width` 是具体像素值，响应式需要重新设计。
- **不穿透 Shadow DOM**：使用 Web Components 的站点，组件内部节点采不到。旧版网页一般不受影响。
- **Canvas 内容无法提取**：用 canvas 绘制的图形拿不到原始图像。
- **跨域 iframe 内容不可达**：只在 `page-meta.json` 的 `frames` 字段里记录它的 `src` 和位置。
- **不还原交互逻辑**：产出的是静态快照，页面里的 `<script>` 已被移除。

## 六、常见问题

**Q：出错了，但不知道去哪看日志？**

扩展各部分的日志不在一起，需要分别打开：

| 组件 | 打开方式 |
|---|---|
| Service Worker（`background.js`） | `chrome://extensions` → 本扩展卡片 → 点 **Service Worker** 打开检查视图 |
| offscreen document | 同一区域会列出 `offscreen.html` 的检查入口 |
| popup 界面 | 在工具栏扩展图标上**右键 → 检查弹出内容** |

弹窗里显示的失败信息同时会把完整堆栈打印到 popup 与 Service Worker 的控制台，便于定位。

**Q：进度条走到"下载图片与字体"卡住或失败项很多？**
看 ZIP 里 `images.json` 的 `error` 字段和 `page-meta.json` 的 `warnings`。常见原因是图片服务器有防盗链（校验 `Referer`）或需要鉴权 Cookie，这类资源扩展抓不到。数量很少时通常不影响复刻。

**Q：采到的元素数为 0 或异常少？**
页面主体可能整体在跨域 iframe 或 Shadow DOM 内。看弹窗上"识别到 N 个可见元素"的数字确认。

**Q：点击没反应 / 提示"仅支持 http / https 页面"？**
`chrome://`、`edge://`、扩展页面、Chrome 应用商店等受保护页面不允许注入脚本。

**Q：采集完发现页面被我滚到底了？**
采集结束后会滚回原来的位置；如果偏差明显，可关掉"先滚动全页触发懒加载"改用页面自带的方式。

---

## 七、可调参数

想改行为时改这些常量（改完记得在 `chrome://extensions` 刷新扩展）：

| 文件 | 常量 | 默认 | 作用 |
|---|---|---|---|
| `lib/collector.js` | `MAX_ELEMENTS` | 8000 | 单页最多采集的元素数，超出即截断 |
| | `MIN_RESOURCE_SIDE` | 3 | 边长小于此值的图片视为追踪像素/装饰并丢弃 |
| | `sizeThreshold` 比例 | 0.15 | 区块展开阈值：体量超过页面元素总数 15% 的容器才会被拆开 |
| | `MAX_BLOCKS` | 14 | 区块数上限 |
| `lib/packager.js` | `STOP_WORDS` | — | 图片命名时视为无意义而跳过的词（`image`/`img`/`banner` 等） |
| `offscreen.js` | `FETCH_CONCURRENCY` | 6 | 资源并发抓取数 |
| | `FETCH_TIMEOUT_MS` | 25000 | 单个资源的抓取超时 |

## 八、代码结构

```
manifest.json       MV3 清单
package.json        仅用于让 Node 测试以 ESM 加载 lib/ 下的模块，Chrome 会忽略它
background.js       Service Worker：注入采集脚本 → 把结果转交 offscreen
offscreen.html/js   打包器：抓图片/字体 → 生成文件树 → 打 ZIP → 触发下载
popup.html/css/js   弹窗界面与进度展示
lib/collector.js    注入页面的采集核心（DOM + computed 样式 + 图片清单）
lib/packager.js     产物生成：语义化命名、引用改写、outline/tokens 生成
lib/zip.js          手写 ZIP 打包器（store 模式，UTF-8 文件名）
test/
  ├── fixture.html  离线测试页
  └── e2e.mjs       端到端测试
```

三处值得留意的实现决策（都是被平台限制逼出来的）：

- **ZIP 打包器是手写的**：MV3 禁止加载远程代码，用不了 CDN 上的 JSZip；而图片本身已是压缩格式，store 模式（不再 deflate）足够，还能避免引入依赖。
- **打包放在 offscreen 而非 Service Worker**：MV3 的 SW 里 `URL.createObjectURL` 已被移除，无法把内存中的 ZIP 字节变成可交给 `downloads` API 的 blob URL。
- **下载动作必须回到 Service Worker**：offscreen document 虽然继承了扩展权限，但**扩展 API 访问被大幅裁剪**——`chrome.downloads` 在它里面是 `undefined`（`chrome.runtime`、`URL.createObjectURL` 可用）。因此分工是：offscreen 生成 blob URL，SW 拿它调 `chrome.downloads.download`。blob URL 是 origin 级的，扩展各上下文同源，可以跨上下文使用。
