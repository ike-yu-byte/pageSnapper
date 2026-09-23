/**
 * diagnose.mjs — 用已有的 collect-data.json 分析打包产物的问题
 *
 * 用法：node test/diagnose.mjs [collect-data.json 路径]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackage } from '../lib/packager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] || path.join(__dirname, 'output', 'collect-data.json');

const data = JSON.parse(fs.readFileSync(src, 'utf8'));
const files = buildPackage(data, new Map(), new Map());

const css = files.find((f) => f.path === 'style.css').data;
const html = files.find((f) => f.path === 'index.html').data;
const elements = data.elements || [];

console.log('=== 输入 ===');
console.log('URL:', data.meta.url);
console.log('采集元素:', elements.length, '| 区块:', data.blocks.length);
console.log('HTML 中的标签数（近似）:', (html.match(/<[a-zA-Z]/g) || []).length);

console.log('');
console.log('=== CSS 输出 ===');
console.log('style.css:', (css.length / 1024).toFixed(1), 'KB');
console.log('规则数（含 { 计）:', (css.match(/\{/g) || []).length);
console.log('含 svg 的行数:', (css.match(/svg/g) || []).length);

console.log('');
console.log('=== SVG 元素 ===');
const svgs = elements.filter((e) => e.t === 'svg');
console.log('采集到的 svg:', svgs.length);
console.log('样式里含 width 的:', svgs.filter((s) => s.s && s.s.width).length);
let missing = 0;
for (const s of svgs) {
  if (!css.includes(s.p)) {
    missing++;
    if (missing <= 3) console.log('  [选择器未出现在 CSS 中]', s.p.slice(0, 110));
  }
}
console.log('选择器缺失的 svg:', missing, '/', svgs.length);

console.log('');
console.log('=== HTML 中的 svg ===');
console.log('<svg 出现次数:', (html.match(/<svg/g) || []).length);
console.log('带 width 属性的 <svg:', (html.match(/<svg[^>]*\swidth=/gi) || []).length);

console.log('');
console.log('=== 隐藏元素（在 HTML 中但未采集 / 无 CSS 规则）===');
// 用 cssPath 重建：采集到的元素路径集合
const known = new Set(elements.map((e) => e.p));
console.log('已采集元素路径数:', known.size);
const hiddenCount = (html.match(/<[a-zA-Z]/g) || []).length - known.size;
console.log('HTML 标签数 - 已采集元素数 ≈', hiddenCount, '（这些元素没有 CSS 约束）');

console.log('');
console.log('=== 文件清单 ===');
files
  .map((f) => ({ p: f.path, size: typeof f.data === 'string' ? Buffer.byteLength(f.data, 'utf8') : f.data.length }))
  .sort((a, b) => b.size - a.size)
  .slice(0, 12)
  .forEach((f) => console.log('  ' + f.p.padEnd(42) + (f.size / 1024).toFixed(1) + ' KB'));
