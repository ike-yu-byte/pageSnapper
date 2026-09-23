const runBtn = document.getElementById('run');
const statusBox = document.getElementById('status');
const statusText = document.getElementById('status-text');
const statusDetail = document.getElementById('status-detail');
const barFill = document.getElementById('bar-fill');
const summaryBox = document.getElementById('summary');
const hint = document.getElementById('hint');

const STAGE_LABEL = {
  inject: '注入采集脚本',
  collect: '采集页面结构',
  collected: '页面采集完成',
  assets: '下载图片与字体',
  'assets-progress': '下载资源',
  'fonts-progress': '下载字体',
  pack: '生成包内文件',
  zip: '打包 ZIP',
  done: '完成'
};

let port = null;

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function humanSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function setStatus(text, detail, pct) {
  statusBox.hidden = false;
  statusText.textContent = text;
  statusDetail.textContent = detail || '';
  if (typeof pct === 'number') {
    barFill.style.width = Math.max(4, Math.min(100, pct)) + '%';
  }
}

function setBusy(busy) {
  runBtn.disabled = busy;
  runBtn.textContent = busy ? '处理中…' : '提取当前页素材包';
}

function showSummary(result) {
  const img = result.images || {};
  const font = result.fonts || {};
  const failed = result.failedItems || [];

  const rows = [
    ['文件', escapeHtml(result.fileName)],
    ['包内条目', result.fileCount + ' 个'],
    ['体积', humanSize(result.bytes)],
    ['图片', (img.ok || 0) + ' / ' + (img.total || 0) + ' 成功'],
    ['字体', (font.ok || 0) + ' / ' + (font.total || 0) + ' 成功']
  ];
  if (result.failures) {
    rows.push(['失败资源', '<span class="warn">' + result.failures + ' 个</span>']);
  }

  summaryBox.hidden = false;
  summaryBox.innerHTML =
    '<h2>素材包已生成</h2>' +
    '<dl>' +
    rows.map((r) => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('') +
    '</dl>' +
    (failed.length
      ? '<details><summary>查看失败明细</summary><ul>' +
        failed.map((f) => '<li>' + escapeHtml(f.kind + ' · ' + f.url + ' — ' + f.error) + '</li>').join('') +
        '</ul></details>'
      : '');
}

function handleProgress(msg) {
  const label = STAGE_LABEL[msg.stage] || msg.stage || '处理中';
  setStatus(label, msg.detail || '', typeof msg.pct === 'number' ? msg.pct : undefined);

  if (msg.stage === 'collected' && msg.summary) {
    const s = msg.summary;
    statusDetail.textContent =
      '识别到 ' + s.elements + ' 个可见元素、' + s.blocks + ' 个区块、' + s.images + ' 张图片';
  }

  if (msg.stage === 'done') {
    barFill.style.width = '100%';
    setStatus('完成', '素材包已开始下载，请查看浏览器下载目录');
    if (msg.result) showSummary(msg.result);
    setBusy(false);
  }
}

runBtn.addEventListener('click', () => {
  setBusy(true);
  summaryBox.hidden = true;
  barFill.classList.remove('error');
  setStatus('准备中…', '正在连接页面…', 4);

  port = chrome.runtime.connect({ name: 'page-snapper' });

  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'progress') {
      handleProgress(msg);
      return;
    }
    if (msg.type === 'error') {
      barFill.classList.add('error');
      setStatus('失败', msg.message);
      setBusy(false);
    }
  });

  port.onDisconnect.addListener(() => {
    port = null;
  });

  port.postMessage({
    type: 'start',
    options: {
      scrollFirst: document.getElementById('opt-scroll').checked,
      includeFullHtml: document.getElementById('opt-full').checked
    }
  });
});

// offscreen 打包阶段的进度广播
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'progress' || msg.target === 'offscreen') return;
  if (msg.stage === 'assets-progress' || msg.stage === 'fonts-progress' ||
      msg.stage === 'pack' || msg.stage === 'zip') {
    handleProgress(msg);
  }
});
