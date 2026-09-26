/* ===== 短视频工厂工作台 · 纯前端零构建 ===== */
'use strict';

/* ---------- 全局状态 ---------- */
const state = {
  currentProjectId: localStorage.getItem('svf_current') || null,
  project: null,          // {project, scenes[], shots[], runs[]}
  assets: [],
  selectedRunId: null,
  // SSE
  es: null,
  lastSeq: 0,
  seenEventIds: new Set(),
  sseRetryDelay: 1000,
  sseRetryTimer: null,
  // run 客户端计时兜底 {run_id: {firstSeen, lastProgressAt, lastProgressLabel}}
  runClocks: {},
  events: [],
  // 一键成片
  quickMode: 'text',
  quickSelected: new Set(),
  // 素材库页签
  alAssets: [],
  alCategory: '__all',
  alRendered: false,
};

// mirrors domain/state_machine/machine.py
const RUN_STATES = ['PLANNED', 'ASSET_READY', 'PROMPT_READY', 'QUEUED', 'RENDERING', 'GENERATED', 'SCORING', 'ACCEPTED'];
const TERMINAL_STATES = ['ACCEPTED', 'FAILED', 'CANCELLED'];

/* ---------- 工具 ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg, kind) {
  const box = $('#toast-container');
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function fmtBytes(n) {
  if (n == null || isNaN(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function fmtElapsed(ms) {
  if (ms == null || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + (s % 60) + 's';
  const h = Math.floor(m / 60);
  return h + 'h' + (m % 60) + 'm';
}

function parseTime(t) {
  if (!t) return null;
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function newCommandId() {
  return crypto.randomUUID();
}

/* ---------- API ---------- */
async function api(path, opts) {
  opts = opts || {};
  const headers = opts.headers || {};
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.json);
  }
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body,
  });
  if (!res.ok) {
    let detail = res.status + ' ' + res.statusText;
    try {
      const text = await res.text();
      if (text) detail += ' — ' + text.slice(0, 300);
    } catch (e) { /* ignore */ }
    throw new Error(detail);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res;
}

/* ---------- 页签切换 ---------- */
$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === btn.dataset.tab));
    if (btn.dataset.tab === 'tab-monitor') renderMonitor();
    if (btn.dataset.tab === 'tab-generate') renderRuns();
    if (btn.dataset.tab === 'tab-review') renderReview();
    if (btn.dataset.tab === 'tab-director') renderDirector();
    if (btn.dataset.tab === 'tab-assets') renderAssetLibrary();
  });
});

/* ---------- 项目管理 ---------- */
function getRecentProjects() {
  try { return JSON.parse(localStorage.getItem('svf_projects') || '[]'); }
  catch (e) { return []; }
}

function rememberProject(id, title) {
  const list = getRecentProjects().filter((p) => p.id !== id);
  list.unshift({ id, title: title || id });
  localStorage.setItem('svf_projects', JSON.stringify(list.slice(0, 20)));
  renderRecentProjects();
}

function renderRecentProjects() {
  const ul = $('#recent-projects');
  const list = getRecentProjects();
  ul.innerHTML = list.map((p) =>
    '<li data-id="' + esc(p.id) + '"><span>' + esc(p.title) + '</span><span class="pid">' + esc(p.id) + '</span></li>'
  ).join('');
  ul.querySelectorAll('li').forEach((li) => {
    li.addEventListener('click', () => loadProject(li.dataset.id));
  });
}

$('#create-project-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {
    title: fd.get('title'),
    style: fd.get('style') || undefined,
    brief: fd.get('brief') || undefined,
    duration_target_s: Number(fd.get('duration_target_s')) || undefined,
  };
  try {
    const res = await api('/projects', { method: 'POST', json: body });
    const id = res.project_id || res.id || (res.project && (res.project.project_id || res.project.id));
    if (!id) throw new Error('响应中未找到项目 ID');
    toast('项目创建成功:' + id, 'ok');
    rememberProject(id, body.title);
    e.target.reset();
    await loadProject(id);
  } catch (err) {
    toast('创建项目失败:' + err.message, 'err');
  }
});

$('#open-project-btn').addEventListener('click', () => {
  const id = $('#open-project-id').value.trim();
  if (id) loadProject(id);
});

$('#plan-btn').addEventListener('click', async () => {
  if (!state.currentProjectId) return;
  try {
    await api('/projects/' + encodeURIComponent(state.currentProjectId) + '/plan', { method: 'POST', json: {} });
    toast('已触发剧本分镜生成,请稍候刷新', 'ok');
  } catch (err) {
    toast('触发分镜生成失败:' + err.message, 'err');
  }
});

async function loadProject(id) {
  try {
    const data = await api('/projects/' + encodeURIComponent(id));
    state.currentProjectId = id;
    state.project = data;
    state.selectedRunId = null;
    localStorage.setItem('svf_current', id);
    const proj = data.project || {};
    rememberProject(id, proj.title || id);
    $('#current-project-label').textContent = (proj.title || '项目') + ' · ' + id;
    renderProjectSummary();
    renderScenes();
    renderRuns();
    renderMonitor();
    await refreshAssets();
    if (state.alRendered) renderAssetLibrary(); // 素材库页签渲染过则同步刷新
    connectSSE();
  } catch (err) {
    toast('加载项目失败:' + err.message, 'err');
    // 本地记录的项目可能已被删除,清除后回退到列表中的第一个
    localStorage.removeItem('svf_current');
    state.currentProjectId = null;
    const fallback = getRecentProjects().find((p) => p.id !== id);
    if (fallback) loadProject(fallback.id);
  }
}

function renderProjectSummary() {
  const box = $('#project-summary');
  const proj = (state.project && state.project.project) || null;
  if (!proj) { box.classList.add('hidden'); $('#plan-btn').classList.add('hidden'); return; }
  box.classList.remove('hidden');
  $('#plan-btn').classList.remove('hidden');
  box.innerHTML =
    '<h3>' + esc(proj.title || '(无标题)') + '</h3>' +
    '<div class="meta">ID:' + esc(state.currentProjectId) + '</div>' +
    (proj.style ? '<div class="meta">风格:' + esc(proj.style) + '</div>' : '') +
    (proj.duration_target_s ? '<div class="meta">目标时长:' + esc(proj.duration_target_s) + 's</div>' : '') +
    (proj.brief ? '<div class="meta">简报:' + esc(proj.brief) + '</div>' : '') +
    '<div class="meta">场景 ' + ((state.project.scenes || []).length) + ' · 镜头 ' +
    ((state.project.shots || []).length) + ' · 任务 ' + ((state.project.runs || []).length) + '</div>';
}

/* ---------- 素材上传(分块) ---------- */
const dropzone = $('#dropzone');
const fileInput = $('#file-input');

dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) uploadFiles(fileInput.files);
  fileInput.value = '';
});

function addUploadItem(name) {
  const li = document.createElement('li');
  li.className = 'upload-item';
  li.innerHTML =
    '<div class="up-row"><span class="up-name">' + esc(name) + '</span>' +
    '<span class="up-status">等待</span></div>' +
    '<div class="progress-track"><div class="progress-fill"></div></div>';
  $('#upload-list').prepend(li);
  return {
    setProgress(pct, label) {
      li.querySelector('.progress-fill').style.width = Math.min(100, pct) + '%';
      if (label) li.querySelector('.up-status').textContent = label;
    },
    done(msg) {
      li.classList.add('done');
      const st = li.querySelector('.up-status');
      st.textContent = msg || '完成';
      st.classList.add('ok');
    },
    error(msg) {
      li.classList.add('error');
      const st = li.querySelector('.up-status');
      st.textContent = '失败:' + msg;
      st.classList.add('err');
    },
  };
}

async function uploadFiles(files) {
  if (!state.currentProjectId) {
    toast('请先创建或加载项目再上传素材', 'err');
    return;
  }
  for (const file of Array.from(files)) {
    uploadOneFile(file).catch(() => { /* 单个失败已在 uploadOneFile 内提示 */ });
  }
}

async function uploadOneFile(file) {
  const item = addUploadItem(file.name);
  try {
    item.setProgress(0, '创建上传会话…');
    const initRes = await api('/assets/uploads', {
      method: 'POST',
      json: { filename: file.name, total_size: file.size, project_id: state.currentProjectId },
    });
    const uploadId = initRes.upload_id;
    const chunkSize = initRes.chunk_size || (4 * 1024 * 1024);
    if (!uploadId) throw new Error('响应缺少 upload_id');
    const totalParts = Math.max(1, Math.ceil(file.size / chunkSize));

    for (let n = 1; n <= totalParts; n++) {
      const start = (n - 1) * chunkSize;
      const blob = file.slice(start, Math.min(start + chunkSize, file.size));
      const res = await fetch('/assets/uploads/' + encodeURIComponent(uploadId) + '/parts/' + n, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: blob,
      });
      if (!res.ok) throw new Error('分块 ' + n + ' 上传失败:' + res.status);
      item.setProgress((n / totalParts) * 95, '分块 ' + n + '/' + totalParts + ' · ' + fmtBytes(file.size));
    }

    item.setProgress(97, '合并中…');
    const doneRes = await api('/assets/uploads/' + encodeURIComponent(uploadId) + '/complete', {
      method: 'POST',
      json: { project_id: state.currentProjectId },
    });
    item.setProgress(100);
    item.done('完成 · asset ' + (doneRes.asset_id || '?'));
    await refreshAssets();
  } catch (err) {
    item.error(err.message);
    toast('上传失败(' + file.name + '):' + err.message, 'err');
  }
}

/* ---------- 素材库 ---------- */
$('#refresh-assets-btn').addEventListener('click', refreshAssets);

async function refreshAssets() {
  if (!state.currentProjectId) return;
  try {
    const res = await api('/assets?project_id=' + encodeURIComponent(state.currentProjectId));
    state.assets = res.assets || res || [];
    renderAssets();
    renderScenes(); // 素材下拉需要最新列表
    renderQuickAssetPicker(); // 「素材+文案」模式的多选区同步刷新
  } catch (err) {
    toast('获取素材列表失败:' + err.message, 'err');
  }
}

function isVideoAsset(a) {
  const name = (a.filename || a.name || '').toLowerCase();
  const mime = (a.mime || a.content_type || '').toLowerCase();
  return mime.startsWith('video/') || /\.(mp4|webm|mov|mkv|avi)$/.test(name);
}

function assetFileUrl(a) {
  return '/assets/' + encodeURIComponent(a.asset_id || a.id) + '/file';
}

function renderAssets() {
  const grid = $('#asset-grid');
  if (!state.assets.length) {
    grid.innerHTML = '<p class="empty-hint">暂无素材</p>';
    return;
  }
  grid.innerHTML = state.assets.map((a) => {
    const id = a.asset_id || a.id;
    const name = a.filename || a.name || id;
    const media = isVideoAsset(a)
      ? '<video src="' + esc(assetFileUrl(a)) + '" controls preload="metadata"></video>'
      : '<img src="' + esc(assetFileUrl(a)) + '" loading="lazy" alt="' + esc(name) + '">';
    return '<div class="asset-card">' + media +
      '<div class="asset-info"><div class="asset-name" title="' + esc(name) + '">' + esc(name) + '</div>' +
      '<div class="asset-id">' + esc(id) + (a.asset_version != null ? ' · v' + esc(a.asset_version) : '') + '</div></div></div>';
  }).join('');
}

/* ---------- 一键成片 ---------- */
$$('.quick-mode-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.quickMode = btn.dataset.mode;
    $$('.quick-mode-pill').forEach((b) => b.classList.toggle('active', b === btn));
    renderQuickAssetPicker();
  });
});

// 「素材+文案」模式下的素材多选区(图片/视频缩略卡片,点击切换选中)
function renderQuickAssetPicker() {
  const box = $('#quick-asset-picker');
  if (state.quickMode !== 'assets') { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  if (!state.assets.length) {
    box.innerHTML = '<p class="empty-hint">当前项目暂无素材,可先在下方上传,或切到「文生视频」模式</p>';
    return;
  }
  box.innerHTML = '<div class="quick-picker-hint">选择要加入的素材(可多选,已选 ' + state.quickSelected.size + ')</div>' +
    '<div class="quick-picker-grid">' + state.assets.map((a) => {
      const id = a.asset_id || a.id;
      const name = a.filename || a.name || id;
      const media = isVideoAsset(a)
        ? '<video src="' + esc(assetFileUrl(a)) + '" preload="metadata" muted></video>'
        : '<img src="' + esc(assetFileUrl(a)) + '" loading="lazy" alt="' + esc(name) + '">';
      return '<div class="quick-pick-card' + (state.quickSelected.has(id) ? ' selected' : '') + '" data-asset-id="' + esc(id) + '">' +
        media + '<div class="quick-pick-name">' + esc(name) + '</div></div>';
    }).join('') + '</div>';
  box.querySelectorAll('.quick-pick-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.dataset.assetId;
      if (state.quickSelected.has(id)) state.quickSelected.delete(id);
      else state.quickSelected.add(id);
      card.classList.toggle('selected');
      const hint = box.querySelector('.quick-picker-hint');
      if (hint) hint.textContent = '选择要加入的素材(可多选,已选 ' + state.quickSelected.size + ')';
    });
  });
}

$('#quick-create-btn').addEventListener('click', async () => {
  const brief = $('#quick-brief').value.trim();
  if (!brief) { toast('请先描述你想要的短剧', 'err'); return; }
  const body = {
    title: brief.slice(0, 15),
    brief,
    duration_target_s: Number($('#quick-duration').value) || 60,
    mode: state.quickMode,
  };
  const style = $('#quick-style').value.trim();
  if (style) body.style = style;
  if (state.quickMode === 'assets') body.asset_ids = Array.from(state.quickSelected);
  const btn = $('#quick-create-btn');
  btn.disabled = true;
  btn.textContent = '创建中…';
  try {
    const res = await api('/projects/quick', { method: 'POST', json: body });
    const pid = res.project_id || res.id;
    if (!pid) throw new Error('响应中未找到 project_id');
    toast('一键成片项目已创建:' + pid, 'ok');
    state.quickSelected.clear();
    $('#quick-brief').value = '';
    await loadProject(pid);
  } catch (err) {
    toast('一键成片失败:' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '一键成片';
  }
});

/* ---------- 素材库页签 ---------- */
const AL_CATEGORY_MAP = {
  character: '角色参考', location: '场景参考', prop: '道具', style: '风格参考',
  footage: '视频素材', audio: '音频', export: '成片', other: '其他',
};
const AL_CATEGORIES = ['character', 'location', 'prop', 'style', 'footage', 'audio', 'export', 'other'];

function alCategoryLabel(cat) {
  if (!cat) return '未分类';
  return AL_CATEGORY_MAP[cat] || cat;
}

function isAudioAsset(a) {
  const mime = (a.mime || a.content_type || '').toLowerCase();
  const name = (a.filename || a.name || a.storage_key || '').toLowerCase();
  return a.media_type === 'audio' || mime.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac)$/.test(name);
}

// 项目筛选下拉 → 实际 project_id('' 表示全部项目)
function alProjectParam() {
  const v = $('#al-project-filter').value;
  if (v === '__current') return state.currentProjectId || '';
  return v;
}

async function renderAssetLibrary() {
  state.alRendered = true;
  renderAlCatNav();
  const grid = $('#al-grid');
  grid.innerHTML = '<p class="empty-hint">加载中…</p>';
  const params = [];
  const pid = alProjectParam();
  if (pid) params.push('project_id=' + encodeURIComponent(pid));
  if (state.alCategory !== '__all') {
    // 未分类用空字符串 category 表示
    params.push('category=' + encodeURIComponent(state.alCategory === '__none' ? '' : state.alCategory));
  }
  const mt = $('#al-type-filter').value;
  if (mt) params.push('media_type=' + encodeURIComponent(mt));
  try {
    const res = await api('/assets' + (params.length ? '?' + params.join('&') : ''));
    state.alAssets = res.assets || res || [];
    renderAlGrid();
  } catch (err) {
    grid.innerHTML = '<p class="empty-hint">加载素材失败:' + esc(err.message) + '</p>';
  }
}

function renderAlCatNav() {
  const nav = $('#al-cat-nav');
  const items = [['__all', '全部'], ['__none', '未分类']]
    .concat(AL_CATEGORIES.map((c) => [c, AL_CATEGORY_MAP[c]]));
  nav.innerHTML = items.map(([v, label]) =>
    '<button class="al-cat-pill' + (state.alCategory === v ? ' active' : '') + '" data-cat="' + esc(v) + '">' + esc(label) + '</button>'
  ).join('');
  nav.querySelectorAll('.al-cat-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.alCategory = btn.dataset.cat;
      renderAssetLibrary();
    });
  });
}

function renderAlGrid() {
  const grid = $('#al-grid');
  const list = state.alAssets;
  if (!list.length) { grid.innerHTML = '<p class="empty-hint">没有符合条件的素材</p>'; return; }
  grid.innerHTML = list.map((a) => {
    const id = a.asset_id || a.id;
    const name = (a.storage_key || '').split('/').pop() || a.filename || a.name || id;
    const url = assetFileUrl(a);
    let media;
    if (isAudioAsset(a)) media = '<div class="al-audio-thumb">♪</div>';
    else if (a.media_type === 'video' || isVideoAsset(a)) media = '<video src="' + esc(url) + '" preload="metadata" muted></video>';
    else media = '<img src="' + esc(url) + '" loading="lazy" alt="' + esc(name) + '">';
    const mt = a.media_type || (isVideoAsset(a) ? 'video' : isAudioAsset(a) ? 'audio' : 'image');
    return '<div class="asset-card al-card" data-asset-id="' + esc(id) + '">' + media +
      '<div class="asset-info"><div class="asset-name" title="' + esc(name) + '">' + esc(name) + '</div>' +
      '<div class="asset-id">' + esc(a.project_id || '-') + ' · ' + esc(mt) + '</div>' +
      '<div class="al-cat-row"><span class="al-cat-pill-sm">' + esc(alCategoryLabel(a.category)) + '</span></div>' +
      '</div></div>';
  }).join('');
  grid.querySelectorAll('.al-card').forEach((card) => {
    card.addEventListener('click', () => showAlOverlay(card.dataset.assetId));
  });
}

$('#al-project-filter').addEventListener('change', renderAssetLibrary);
$('#al-type-filter').addEventListener('change', renderAssetLibrary);

$('#al-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'al-overlay') hideAlOverlay();
});

function hideAlOverlay() {
  const ov = $('#al-overlay');
  ov.classList.add('hidden');
  ov.innerHTML = '';
}

// 素材卡片操作层:预览 + 设置分类 + 查看大图/播放
function showAlOverlay(assetId) {
  const a = state.alAssets.find((x) => (x.asset_id || x.id) === assetId);
  if (!a) return;
  const id = a.asset_id || a.id;
  const name = (a.storage_key || '').split('/').pop() || a.filename || a.name || id;
  const url = assetFileUrl(a);
  let preview;
  if (isAudioAsset(a)) preview = '<audio src="' + esc(url) + '" controls class="al-audio-player"></audio>';
  else if (a.media_type === 'video' || isVideoAsset(a)) preview = '<video src="' + esc(url) + '" controls preload="metadata"></video>';
  else preview = '<img src="' + esc(url) + '" alt="' + esc(name) + '">';
  const ov = $('#al-overlay');
  ov.innerHTML = '<div class="al-overlay-inner">' +
    '<div class="al-overlay-head"><span class="al-overlay-name" title="' + esc(name) + '">' + esc(name) + '</span>' +
    '<button id="al-overlay-close" class="btn btn-small">关闭 ✕</button></div>' +
    '<div class="al-overlay-preview">' + preview + '</div>' +
    '<div class="al-overlay-meta">ID:' + esc(id) + (a.project_id ? ' · 项目:' + esc(a.project_id) : '') + '</div>' +
    '<div class="al-overlay-actions">' +
      '<select id="al-cat-select">' +
        '<option value="">未分类</option>' +
        AL_CATEGORIES.map((c) => '<option value="' + c + '"' + (a.category === c ? ' selected' : '') + '>' + esc(AL_CATEGORY_MAP[c]) + '</option>').join('') +
      '</select>' +
      '<button id="al-cat-save" class="btn btn-small btn-accent">设置分类</button>' +
      '<a class="btn btn-small" href="' + esc(url) + '" target="_blank" rel="noopener">查看大图/播放</a>' +
    '</div></div>';
  ov.classList.remove('hidden');
  $('#al-overlay-close').addEventListener('click', hideAlOverlay);
  $('#al-cat-save').addEventListener('click', async () => {
    const cat = $('#al-cat-select').value;
    try {
      await api('/assets/' + encodeURIComponent(id) + '/category', { method: 'POST', json: { category: cat } });
      toast('分类已更新:' + alCategoryLabel(cat), 'ok');
      hideAlOverlay();
      renderAssetLibrary();
    } catch (err) {
      toast('设置分类失败:' + err.message, 'err');
    }
  });
}

$('#al-classify-btn').addEventListener('click', async () => {
  const pid = alProjectParam();
  if (!pid) {
    toast('请先把项目筛选切到具体项目(或加载项目后选「当前项目」)', 'err');
    return;
  }
  const btn = $('#al-classify-btn');
  btn.disabled = true;
  btn.textContent = '分类中…';
  try {
    const res = await api('/projects/' + encodeURIComponent(pid) + '/assets/classify', { method: 'POST', json: {} });
    const n = res.classified ? Object.keys(res.classified).length : 0;
    toast('自动分类完成:' + n + ' 个素材', 'ok');
    renderAssetLibrary();
  } catch (err) {
    toast('自动分类失败:' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '自动分类';
  }
});

/* ---------- 分镜镜头 ---------- */
$('#refresh-shots-btn').addEventListener('click', () => {
  if (state.currentProjectId) loadProject(state.currentProjectId);
});

function shotSpec(shot) {
  return shot.spec || {};
}

// 验收要求渲染:对象 {required[], forbidden[]} 渲染成标签,字符串原样显示
function renderAcceptance(acc) {
  if (!acc) return '';
  if (typeof acc === 'string') return esc(acc);
  if (typeof acc !== 'object') return esc(String(acc));
  let html = '';
  const req = Array.isArray(acc.required) ? acc.required : [];
  const forb = Array.isArray(acc.forbidden) ? acc.forbidden : [];
  html += req.map((t) => '<span class="acc-tag acc-req">' + esc(typeof t === 'object' ? JSON.stringify(t) : t) + '</span>').join('');
  html += forb.map((t) => '<span class="acc-tag acc-forb">' + esc(typeof t === 'object' ? JSON.stringify(t) : t) + '</span>').join('');
  if (!html) html = esc(JSON.stringify(acc));
  return html;
}

// 镜头参数渲染:对象渲染成 key:value 标签,字符串原样显示
function renderCamera(cam) {
  if (!cam) return '';
  if (typeof cam === 'string') return esc(cam);
  if (typeof cam !== 'object') return esc(String(cam));
  return Object.entries(cam).map(([k, v]) =>
    '<span class="acc-tag acc-cam">' + esc(k) + ': ' + esc(typeof v === 'object' ? JSON.stringify(v) : v) + '</span>'
  ).join('');
}

// 字符串/对象列表渲染成标签(characters / reference_assets 等)
function renderTagList(items) {
  if (!items) return '';
  const arr = Array.isArray(items) ? items : [items];
  if (!arr.length) return '';
  return arr.map((t) => {
    const label = typeof t === 'object' ? (t.name || t.character_id || t.asset_id || JSON.stringify(t)) : t;
    return '<span class="acc-tag">' + esc(label) + '</span>';
  }).join('');
}

function shotSceneId(shot, scenes) {
  if (shot.scene_id) return shot.scene_id;
  const spec = shotSpec(shot);
  return spec.scene_id || null;
}

function renderScenes() {
  const container = $('#scenes-container');
  const data = state.project;
  if (!data) {
    container.innerHTML = '<p class="empty-hint">暂无分镜数据,请先加载项目</p>';
    return;
  }
  const scenes = data.scenes || [];
  const shots = data.shots || [];
  if (!shots.length && !scenes.length) {
    container.innerHTML = '<p class="empty-hint">该项目还没有分镜,请先在「项目与素材」页触发剧本分镜生成</p>';
    return;
  }

  // 按 scene 分组;没有 scene 信息的归入"未分组"
  const groups = [];
  const byId = {};
  scenes.forEach((sc) => {
    const id = sc.scene_id || sc.id;
    const g = { id, title: sc.title || sc.name || ('场景 ' + id), summary: sc.summary || sc.description || '', shots: [] };
    byId[id] = g;
    groups.push(g);
  });
  const ungrouped = { id: '__none__', title: '未分组镜头', summary: '', shots: [] };
  shots.forEach((shot) => {
    const sid = shotSceneId(shot, scenes);
    if (sid && byId[sid]) byId[sid].shots.push(shot);
    else ungrouped.shots.push(shot);
  });
  if (ungrouped.shots.length) groups.push(ungrouped);

  container.innerHTML = groups.map((g) =>
    '<div class="scene-block">' +
      '<div class="scene-header"><h3>' + esc(g.title) + '</h3>' +
      (g.summary ? '<span class="scene-summary">' + esc(g.summary) + '</span>' : '') +
      '<span class="scene-summary">' + g.shots.length + ' 个镜头</span></div>' +
      '<div class="shot-grid">' + g.shots.map(renderShotCard).join('') + '</div>' +
    '</div>'
  ).join('');

  // 绑定事件
  container.querySelectorAll('.shot-bind-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); bindShotAsset(btn); });
  });
  container.querySelectorAll('.shot-run-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); submitShotRun(btn.dataset.shotId, btn); });
  });
  container.querySelectorAll('.shot-bind-row select').forEach((sel) => {
    sel.addEventListener('click', (e) => e.stopPropagation());
  });
  container.querySelectorAll('.shot-card').forEach((card) => {
    card.addEventListener('click', () => showShotDetail(card.dataset.shotId));
  });
}

/* ---------- 镜头详情(分镜单独查看) ---------- */
$('#shot-detail').addEventListener('click', (e) => {
  // 点击面板外的空白背景收起
  if (e.target.id === 'shot-detail') hideShotDetail();
});

function hideShotDetail() {
  const panel = $('#shot-detail');
  panel.classList.add('hidden');
  panel.innerHTML = '';
  delete panel.dataset.shotId;
}

function showShotDetail(shotId) {
  const data = state.project || {};
  const shot = (data.shots || []).find((s) => (s.shot_id || s.id) === shotId);
  if (!shot) return;
  const spec = shotSpec(shot);
  const scenes = data.scenes || [];
  const sid = shotSceneId(shot, scenes);
  const scene = scenes.find((sc) => (sc.scene_id || sc.id) === sid);
  const sceneTitle = scene ? (scene.title || scene.name || sid) : (sid || '-');
  const runs = getRuns().filter((r) => r.shot_id === shotId);

  let html = '<div class="shot-detail-inner">' +
    '<div class="shot-detail-head"><h3>镜头 ' + esc(shotId) + '</h3>' +
    '<button id="shot-detail-close" class="btn btn-small">关闭 ✕</button></div>' +
    '<div class="shot-field"><span class="k">shot_id</span><span class="mono">' + esc(shotId) + '</span></div>' +
    '<div class="shot-field"><span class="k">所属场景</span>' + esc(sceneTitle) + '</div>' +
    (spec.duration_s ? '<div class="shot-field"><span class="k">时长</span>' + esc(spec.duration_s) + 's</div>' : '') +
    (spec.aspect_ratio ? '<div class="shot-field"><span class="k">宽高比</span>' + esc(spec.aspect_ratio) + '</div>' : '') +
    (spec.action ? '<div class="shot-field"><span class="k">动作</span>' + esc(spec.action) + '</div>' : '') +
    (spec.dialogue ? '<div class="shot-field"><span class="k">台词</span>' + esc(spec.dialogue) + '</div>' : '') +
    (spec.camera ? '<div class="shot-field"><span class="k">镜头参数</span>' + renderCamera(spec.camera) + '</div>' : '') +
    ((spec.acceptance || spec.acceptance_criteria)
      ? '<div class="shot-field"><span class="k">验收要求</span>' + renderAcceptance(spec.acceptance || spec.acceptance_criteria) + '</div>' : '') +
    (spec.characters ? '<div class="shot-field"><span class="k">出场角色</span>' + renderTagList(spec.characters) + '</div>' : '') +
    ((spec.reference_assets || shot.reference_assets)
      ? '<div class="shot-field"><span class="k">参考素材</span>' + renderTagList(spec.reference_assets || shot.reference_assets) + '</div>' : '');

  // 该镜头全部 runs
  html += '<h3 class="shot-detail-sub">生成任务(' + runs.length + ')</h3>';
  if (!runs.length) {
    html += '<p class="empty-hint">该镜头还没有生成任务</p>';
  } else {
    html += runs.map((run) => {
      const rid = run.run_id || run.id;
      const st = runState(run);
      let rh = '<div class="shot-run-entry">' +
        '<div class="shot-run-head"><span class="mono">' + esc(rid) + '</span>' +
        '<span class="run-state-pill ' + esc(st) + '">' + esc(st) + '</span></div>';
      const candidates = run.candidate_asset_ids || run.candidates || [];
      if (candidates.length) {
        rh += '<div class="candidate-videos">' + candidates.map((cid) => {
          const aid = typeof cid === 'object' ? (cid.asset_id || cid.id) : cid;
          const asset = state.assets.find((a) => (a.asset_id || a.id) === aid);
          const url = '/assets/' + encodeURIComponent(aid) + '/file';
          return (asset && !isVideoAsset(asset))
            ? '<img src="' + esc(url) + '" alt="candidate">'
            : '<video src="' + esc(url) + '" controls preload="metadata"></video>';
        }).join('') + '</div>';
      }
      rh += renderScore(run);
      rh += '<div class="review-row">' +
        '<button class="btn btn-accent btn-small review-btn" data-decision="accept" data-run-id="' + esc(rid) + '">接受</button>' +
        '<button class="btn btn-danger btn-small review-btn" data-decision="reject" data-run-id="' + esc(rid) + '">拒绝</button>' +
        '<input type="text" class="review-note" placeholder="备注(可选,随审核一并提交)">' +
        '</div></div>';
      return rh;
    }).join('');
  }
  html += '</div>';

  const panel = $('#shot-detail');
  panel.dataset.shotId = shotId;
  panel.innerHTML = html;
  panel.classList.remove('hidden');
  $('#shot-detail-close').addEventListener('click', hideShotDetail);
  panel.querySelectorAll('.review-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      submitReview(btn.dataset.runId, btn.dataset.decision, btn.closest('.shot-run-entry'));
    });
  });
}

function renderShotCard(shot) {
  const spec = shotSpec(shot);
  const shotId = shot.shot_id || shot.id;
  const accepted = !!shot.accepted_run_id;
  const assetOptions = ['<option value="">选择素材…</option>'].concat(
    state.assets.map((a) => {
      const id = a.asset_id || a.id;
      return '<option value="' + esc(id) + '" data-version="' + esc(a.asset_version != null ? a.asset_version : 1) + '">' +
        esc(a.filename || a.name || id) + '</option>';
    })
  ).join('');
  return '<div class="shot-card' + (accepted ? ' accepted' : '') + '" data-shot-id="' + esc(shotId) + '">' +
    '<div class="shot-head"><span class="shot-id">' + esc(shotId) + '</span>' +
    (accepted ? '<span class="accepted-tag">已验收</span>' : '') + '</div>' +
    (spec.action ? '<div class="shot-field"><span class="k">动作</span>' + esc(spec.action) + '</div>' : '') +
    (spec.dialogue ? '<div class="shot-field"><span class="k">台词</span>' + esc(spec.dialogue) + '</div>' : '') +
    (spec.acceptance || spec.acceptance_criteria
      ? '<div class="shot-field"><span class="k">验收要求</span>' + renderAcceptance(spec.acceptance || spec.acceptance_criteria) + '</div>' : '') +
    (spec.duration_s ? '<div class="shot-field"><span class="k">时长</span>' + esc(spec.duration_s) + 's</div>' : '') +
    '<div class="shot-bind-row">' +
      '<select class="shot-asset-select">' + assetOptions + '</select>' +
      '<select class="shot-role-select">' +
        '<option value="reference">参考</option><option value="anchor">锚定</option>' +
        '<option value="background">背景</option><option value="audio">音频</option>' +
      '</select>' +
      '<button class="btn btn-small shot-bind-btn" data-shot-id="' + esc(shotId) + '">绑定</button>' +
    '</div>' +
    '<div class="shot-actions">' +
      '<button class="btn btn-primary btn-small shot-run-btn" data-shot-id="' + esc(shotId) + '">提交生成</button>' +
    '</div>' +
  '</div>';
}

async function bindShotAsset(btn) {
  const card = btn.closest('.shot-card');
  const shotId = btn.dataset.shotId;
  const sel = card.querySelector('.shot-asset-select');
  const roleSel = card.querySelector('.shot-role-select');
  const assetId = sel.value;
  if (!assetId) { toast('请先选择素材', 'err'); return; }
  const opt = sel.options[sel.selectedIndex];
  const version = Number(opt.dataset.version) || 1;
  try {
    await api('/shots/' + encodeURIComponent(shotId) + '/asset-bindings', {
      method: 'POST',
      json: { asset_id: assetId, asset_version: version, role: roleSel.value },
    });
    toast('素材已绑定到镜头 ' + shotId, 'ok');
  } catch (err) {
    toast('绑定失败:' + err.message, 'err');
  }
}

async function submitShotRun(shotId, btn) {
  btn.disabled = true;
  try {
    const res = await api('/shots/' + encodeURIComponent(shotId) + '/runs', {
      method: 'POST',
      json: { command_id: newCommandId() },
    });
    toast('已提交生成,run_id: ' + (res.run_id || '?'), 'ok');
    if (state.currentProjectId) {
      const data = await api('/projects/' + encodeURIComponent(state.currentProjectId));
      state.project = data;
      renderRuns();
      renderMonitor();
      renderProjectSummary();
    }
  } catch (err) {
    toast('提交生成失败:' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

/* ---------- 视频生成(Runs) ---------- */
$('#refresh-runs-btn').addEventListener('click', async () => {
  if (!state.currentProjectId) return;
  try {
    const data = await api('/projects/' + encodeURIComponent(state.currentProjectId));
    state.project = data;
    renderRuns();
    renderProjectSummary();
  } catch (err) {
    toast('刷新失败:' + err.message, 'err');
  }
});

function getRuns() {
  return (state.project && state.project.runs) || [];
}

function runState(run) {
  return (run.state || run.status || 'PLANNED').toUpperCase();
}

function getRunClock(run) {
  const id = run.run_id || run.id;
  if (!state.runClocks[id]) {
    state.runClocks[id] = { firstSeen: Date.now(), lastProgressAt: null, lastProgressLabel: '' };
  }
  return state.runClocks[id];
}

function runElapsedMs(run) {
  const started = parseTime(run.started_at) || parseTime(run.created_at) || getRunClock(run).firstSeen;
  const ended = parseTime(run.finished_at) || parseTime(run.completed_at);
  const st = runState(run);
  if (ended || TERMINAL_STATES.includes(st)) {
    return (ended || Date.now()) - started;
  }
  return Date.now() - started;
}

function renderStateMachine(current) {
  const cur = current.toUpperCase();
  const isTerminalFail = TERMINAL_STATES.includes(cur) && cur !== 'ACCEPTED';
  const curIdx = RUN_STATES.indexOf(cur);
  let html = '<div class="state-machine">';
  RUN_STATES.forEach((s, i) => {
    let cls = 'state-badge';
    if (s === cur) cls += ' current';
    else if (curIdx > i) cls += ' passed';
    html += '<span class="' + cls + '">' + s + '</span>';
    if (i < RUN_STATES.length - 1 || isTerminalFail) html += '<span class="state-arrow">→</span>';
  });
  if (isTerminalFail) html += '<span class="state-badge current terminal-fail">' + esc(cur) + '</span>';
  html += '</div>';
  return html;
}

function renderRuns() {
  const list = $('#run-list');
  const runs = getRuns();
  if (!runs.length) {
    list.innerHTML = '<p class="empty-hint">暂无生成任务</p>';
    $('#run-detail').classList.add('hidden');
    return;
  }
  list.innerHTML = runs.map((run) => {
    const id = run.run_id || run.id;
    const st = runState(run);
    return '<div class="run-item' + (state.selectedRunId === id ? ' selected' : '') + '" data-run-id="' + esc(id) + '">' +
      '<span class="rid">' + esc(id) + '</span>' +
      '<span>镜头 ' + esc(run.shot_id || '-') + '</span>' +
      '<span class="run-state-pill ' + esc(st) + '">' + esc(st) + '</span>' +
    '</div>';
  }).join('');
  list.querySelectorAll('.run-item').forEach((el) => {
    el.addEventListener('click', () => selectRun(el.dataset.runId));
  });
  if (state.selectedRunId) renderRunDetail();
}

async function selectRun(runId) {
  state.selectedRunId = runId;
  renderRuns();
  // 拉取单个 run 的最新详情(接口返回 {run, score_report},需解包)
  try {
    const resp = await api('/runs/' + encodeURIComponent(runId));
    const detail = (resp && resp.run) ? resp.run : resp;
    const runs = getRuns();
    const idx = runs.findIndex((r) => (r.run_id || r.id) === runId);
    if (idx >= 0 && state.project) state.project.runs[idx] = Object.assign({}, runs[idx], detail);
    renderRunDetail();
    renderRuns();
  } catch (err) {
    toast('获取任务详情失败:' + err.message, 'err');
  }
}

// 从任务监控页打开某条任务的详情/审核面板(详情面板在「生成」页签内)
function openRunDetail(runId) {
  $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'tab-generate'));
  $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === 'tab-generate'));
  selectRun(runId);
}

function renderRunDetail() {
  const box = $('#run-detail');
  const runs = getRuns();
  const run = runs.find((r) => (r.run_id || r.id) === state.selectedRunId);
  if (!run) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const id = run.run_id || run.id;
  const st = runState(run);

  let html = '<h3>任务 ' + esc(id) + '</h3>' + renderStateMachine(st);
  html += '<div class="shot-field"><span class="k">状态</span>' + esc(st) +
    ' · <span class="k">耗时</span><span class="run-elapsed" data-run-id="' + esc(id) + '">' +
    fmtElapsed(runElapsedMs(run)) + '</span></div>';

  // 候选视频
  const candidates = run.candidate_asset_ids || run.candidates || [];
  if (candidates.length) {
    html += '<div><h3>候选结果</h3><div class="candidate-videos">' +
      candidates.map((cid) => {
        const aid = typeof cid === 'object' ? (cid.asset_id || cid.id) : cid;
        const asset = state.assets.find((a) => (a.asset_id || a.id) === aid);
        const url = '/assets/' + encodeURIComponent(aid) + '/file';
        const video = asset ? isVideoAsset(asset) : true;
        return video
          ? '<video src="' + esc(url) + '" controls preload="metadata"></video>'
          : '<img src="' + esc(url) + '" alt="candidate">';
      }).join('') + '</div></div>';
  }

  // 评分
  html += renderScore(run);

  // 失败原因
  if (run.failure) {
    const f = typeof run.failure === 'object' ? (run.failure.message || JSON.stringify(run.failure, null, 2)) : run.failure;
    html += '<div><h3>失败原因</h3><div class="failure-box">' + esc(f) + '</div></div>';
  }

  // 审核操作
  html += '<div><h3>人工审核</h3><div class="review-row">' +
    '<button class="btn btn-accent review-btn" data-decision="accept" data-run-id="' + esc(id) + '">接受</button>' +
    '<button class="btn btn-danger review-btn" data-decision="reject" data-run-id="' + esc(id) + '">拒绝</button>' +
    '<input type="text" class="review-note" placeholder="备注(可选,随审核一并提交)">' +
    '<button class="btn review-btn" data-decision="note" data-run-id="' + esc(id) + '">仅提交备注</button>' +
  '</div></div>';

  box.innerHTML = html;
  box.querySelectorAll('.review-btn').forEach((btn) => {
    btn.addEventListener('click', () => submitReview(btn.dataset.runId, btn.dataset.decision, box));
  });
}

function renderScore(run) {
  const score = run.score;
  if (!score) return '';
  let html = '<div><h3>质量评分</h3>';
  const hard = score.hard_checks || (score.detail && score.detail.hard_checks);
  if (hard && typeof hard === 'object') {
    html += '<div class="hard-checks">' +
      Object.entries(hard).map(([k, v]) => {
        const pass = v === true || v === 'pass' || v === 'PASS' || (v && v.pass === true);
        return '<span class="hard-check ' + (pass ? 'pass' : 'fail') + '">' + esc(k) + ':' + (pass ? '通过' : '未过') + '</span>';
      }).join('') + '</div>';
  }
  const scores = score.scores || (score.detail && score.detail.scores);
  if (scores && typeof scores === 'object') {
    html += '<div class="score-bars" style="margin-top:8px">' +
      Object.entries(scores).map(([k, v]) => {
        const num = Number(v);
        const pct = isNaN(num) ? 0 : Math.max(0, Math.min(1, num)) * 100;
        return '<div class="score-row"><span class="score-name">' + esc(k) + '</span>' +
          '<div class="progress-track"><div class="progress-fill" style="width:' + pct.toFixed(0) + '%"></div></div>' +
          '<span class="score-val">' + (isNaN(num) ? esc(v) : num.toFixed(2)) + '</span></div>';
      }).join('') + '</div>';
  }
  if (!hard && !scores) {
    html += '<pre>' + esc(JSON.stringify(score, null, 2)) + '</pre>';
  }
  html += '</div>';
  return html;
}

async function submitReview(runId, decision, box) {
  const noteEl = box ? box.querySelector('.review-note') : null;
  const note = noteEl ? noteEl.value.trim() : '';
  const body = { decision };
  if (note) body.note = note;
  try {
    await api('/runs/' + encodeURIComponent(runId) + '/review', { method: 'POST', json: body });
    toast('审核已提交:' + decision, 'ok');
    if (state.currentProjectId) {
      const data = await api('/projects/' + encodeURIComponent(state.currentProjectId));
      state.project = data;
      renderRuns();
      renderScenes();
      renderMonitor();
      renderReview();
      renderProjectSummary();
      // 镜头详情面板打开时同步刷新内容
      const sd = $('#shot-detail');
      if (sd && !sd.classList.contains('hidden') && sd.dataset.shotId) showShotDetail(sd.dataset.shotId);
    }
  } catch (err) {
    toast('审核提交失败:' + err.message, 'err');
  }
}

/* ---------- 审核页 ---------- */
function pendingReviewRuns() {
  return getRuns().filter((r) => runState(r) === 'HUMAN_REVIEW');
}

function renderReview() {
  const list = $('#review-list');
  if (!list) return;
  const runs = pendingReviewRuns();
  $('#review-hint').textContent = runs.length ? ('待审核 ' + runs.length + ' 条') : '没有待审核的任务';
  $('#accept-all-btn').disabled = !runs.length;
  if (!state.currentProjectId) {
    list.innerHTML = '<div class="empty-hint">请先选择项目</div>';
    return;
  }
  if (!runs.length) {
    list.innerHTML = '<div class="empty-hint">暂无待审核任务</div>';
    return;
  }
  list.innerHTML = runs.map((run) => {
    const id = run.run_id || run.id;
    const candidates = run.candidate_asset_ids || run.candidates || [];
    const media = candidates.map((cid) => {
      const aid = typeof cid === 'object' ? (cid.asset_id || cid.id) : cid;
      const asset = state.assets.find((a) => (a.asset_id || a.id) === aid);
      const url = '/assets/' + encodeURIComponent(aid) + '/file';
      return (asset && !isVideoAsset(asset))
        ? '<img src="' + esc(url) + '" alt="candidate">'
        : '<video src="' + esc(url) + '" controls preload="metadata"></video>';
    }).join('');
    return '<div class="review-card" data-run-id="' + esc(id) + '">' +
      '<div class="review-card-head"><span class="run-state-pill HUMAN_REVIEW">HUMAN_REVIEW</span>' +
      '<span class="rid">' + esc(id) + '</span><span>镜头 ' + esc(run.shot_id || '-') + '</span></div>' +
      (media ? '<div class="candidate-videos">' + media + '</div>' : '<div class="empty-hint">无候选素材</div>') +
      renderScore(run) +
      '<div class="review-row">' +
        '<button class="btn btn-accent review-btn" data-decision="accept" data-run-id="' + esc(id) + '">接受</button>' +
        '<button class="btn btn-danger review-btn" data-decision="reject" data-run-id="' + esc(id) + '">拒绝</button>' +
        '<input type="text" class="review-note" placeholder="备注(可选,随审核一并提交)">' +
      '</div>' +
    '</div>';
  }).join('');
  list.querySelectorAll('.review-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.review-card');
      submitReview(btn.dataset.runId, btn.dataset.decision, card);
    });
  });
}

$('#refresh-review-btn').addEventListener('click', async () => {
  if (!state.currentProjectId) return;
  const data = await api('/projects/' + encodeURIComponent(state.currentProjectId));
  state.project = data;
  renderReview();
  toast('已刷新', 'ok');
});

$('#accept-all-btn').addEventListener('click', async () => {
  const runs = pendingReviewRuns();
  if (!runs.length) return;
  if (!confirm('一键接受全部 ' + runs.length + ' 条待审核任务?')) return;
  const btn = $('#accept-all-btn');
  btn.disabled = true;
  let okCount = 0, failCount = 0;
  for (const run of runs) {
    const id = run.run_id || run.id;
    try {
      await api('/runs/' + encodeURIComponent(id) + '/review', { method: 'POST', json: { decision: 'accept' } });
      okCount++;
    } catch (err) {
      failCount++;
    }
    btn.textContent = '接受中… ' + okCount + '/' + runs.length;
  }
  btn.textContent = '一键接受全部待审';
  btn.disabled = false;
  toast('一键接受完成:成功 ' + okCount + (failCount ? ',失败 ' + failCount : ''), failCount ? 'err' : 'ok');
  if (state.currentProjectId) {
    const data = await api('/projects/' + encodeURIComponent(state.currentProjectId));
    state.project = data;
    renderRuns();
    renderScenes();
    renderMonitor();
    renderReview();
    renderProjectSummary();
  }
});

/* ---------- 导演台:角色/地点登记 + 连贯性审核 ---------- */
const ISSUE_TYPE_MAP = {
  story: '剧情连贯', character: '人物不一致', goof: '穿帮',
  unexpected: '非预期', text: '画面文字',
};
let directorReviewPoll = null;

function renderDirector() {
  renderCharacterAssetOptions();
  loadCharacters();
  loadDirectorReviewReport();
}

// 参考图下拉:只列图片素材
function renderCharacterAssetOptions() {
  const sel = $('#character-asset-select');
  if (!sel) return;
  const cur = sel.value;
  const imgs = (state.assets || []).filter((a) => !isVideoAsset(a));
  sel.innerHTML = '<option value="">不使用参考图</option>' + imgs.map((a) => {
    const id = a.asset_id || a.id;
    return '<option value="' + esc(id) + '">' + esc(a.filename || a.name || id) + '</option>';
  }).join('');
  sel.value = cur;
}

async function loadCharacters() {
  const wrap = $('#character-table-wrap');
  if (!state.currentProjectId) {
    wrap.innerHTML = '<p class="empty-hint">请先加载项目</p>';
    return;
  }
  try {
    const res = await api('/projects/' + encodeURIComponent(state.currentProjectId) + '/characters');
    renderCharacterTable(res.characters || []);
  } catch (err) {
    wrap.innerHTML = '<p class="empty-hint">获取角色列表失败:' + esc(err.message) + '</p>';
  }
}

function renderCharacterTable(chars) {
  const wrap = $('#character-table-wrap');
  if (!chars.length) {
    wrap.innerHTML = '<p class="empty-hint">尚未登记角色或地点</p>';
    return;
  }
  wrap.innerHTML = '<table class="run-table character-table"><thead><tr>' +
    '<th>参考图</th><th>名称</th><th>类型</th><th>描述</th><th>ID</th><th>操作</th>' +
    '</tr></thead><tbody>' +
    chars.map((c) => {
      const cid = c.character_id || c.id;
      const thumb = c.asset_id
        ? '<img class="char-thumb" src="/assets/' + encodeURIComponent(c.asset_id) + '/file" alt="参考图">'
        : '<span class="char-no-thumb">-</span>';
      const kind = c.kind === 'location' ? '地点' : '角色';
      return '<tr>' +
        '<td>' + thumb + '</td>' +
        '<td>' + esc(c.name || '-') + '</td>' +
        '<td><span class="kind-pill kind-' + esc(c.kind === 'location' ? 'location' : 'character') + '">' + kind + '</span></td>' +
        '<td class="char-desc" title="' + esc(c.description || '') + '">' + esc(c.description || '-') + '</td>' +
        '<td>' + esc(cid) + '</td>' +
        '<td><button class="btn btn-small btn-danger char-del-btn" data-char-id="' + esc(cid) + '">删除</button></td>' +
      '</tr>';
    }).join('') + '</tbody></table>';
  wrap.querySelectorAll('.char-del-btn').forEach((btn) => {
    btn.addEventListener('click', () => deleteCharacter(btn.dataset.charId, btn));
  });
}

$('#character-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.currentProjectId) { toast('请先创建或加载项目', 'err'); return; }
  const fd = new FormData(e.target);
  const body = {
    name: fd.get('name'),
    kind: fd.get('kind'),
    description: fd.get('description') || '',
  };
  const aid = fd.get('asset_id');
  if (aid) body.asset_id = aid;
  try {
    await api('/projects/' + encodeURIComponent(state.currentProjectId) + '/characters', {
      method: 'POST', json: body,
    });
    toast('已登记:' + body.name, 'ok');
    e.target.reset();
    loadCharacters();
  } catch (err) {
    toast('登记失败:' + err.message, 'err');
  }
});

$('#refresh-characters-btn').addEventListener('click', () => {
  renderCharacterAssetOptions();
  loadCharacters();
});

$('#portraits-btn').addEventListener('click', async () => {
  if (!state.currentProjectId) { toast('请先选择项目', 'err'); return; }
  const btn = $('#portraits-btn');
  btn.disabled = true;
  try {
    await api('/projects/' + encodeURIComponent(state.currentProjectId) + '/characters/portraits', { method: 'POST' });
    toast('定妆照生成已启动(约需几分钟),稍后点刷新查看', 'ok');
    // 定妆照每张约 1-2 分钟,轮询刷新角色表
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      await loadCharacters();
      if (tries >= 20) clearInterval(timer);
    }, 15000);
  } catch (err) {
    toast('启动失败:' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

async function deleteCharacter(charId, btn) {
  if (!confirm('删除该角色/地点 ' + charId + '?')) return;
  btn.disabled = true;
  try {
    await api('/characters/' + encodeURIComponent(charId), { method: 'DELETE' });
    toast('已删除:' + charId, 'ok');
    loadCharacters();
  } catch (err) {
    toast('删除失败:' + err.message, 'err');
    btn.disabled = false;
  }
}

/* ---- 连贯性审核 ---- */
$('#director-review-btn').addEventListener('click', async () => {
  if (!state.currentProjectId) { toast('请先创建或加载项目', 'err'); return; }
  const btn = $('#director-review-btn');
  btn.disabled = true;
  $('#director-review-status').textContent = '审核中…(通常需要几十秒,请稍候)';
  try {
    await api('/projects/' + encodeURIComponent(state.currentProjectId) + '/director-review', {
      method: 'POST', json: {},
    });
    pollDirectorReview();
  } catch (err) {
    toast('发起审核失败:' + err.message, 'err');
    $('#director-review-status').textContent = '';
    btn.disabled = false;
  }
});

function pollDirectorReview() {
  const started = Date.now();
  if (directorReviewPoll) clearInterval(directorReviewPoll);
  directorReviewPoll = setInterval(async () => {
    // 最多轮询 2 分钟
    if (Date.now() - started > 120000) {
      clearInterval(directorReviewPoll);
      directorReviewPoll = null;
      $('#director-review-status').textContent = '审核超时,请稍后重新进入本页查看报告';
      $('#director-review-btn').disabled = false;
      return;
    }
    const report = await fetchDirectorReview();
    if (report) {
      clearInterval(directorReviewPoll);
      directorReviewPoll = null;
      renderDirectorReviewReport(report);
      $('#director-review-status').textContent = '';
      $('#director-review-btn').disabled = false;
      toast('连贯性审核完成', 'ok');
    }
  }, 3000);
}

async function fetchDirectorReview() {
  if (!state.currentProjectId) return null;
  try {
    const res = await fetch('/projects/' + encodeURIComponent(state.currentProjectId) + '/director-review');
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function loadDirectorReviewReport() {
  const box = $('#director-review-report');
  if (!state.currentProjectId) {
    box.innerHTML = '<p class="empty-hint">请先加载项目</p>';
    return;
  }
  const report = await fetchDirectorReview();
  if (report) renderDirectorReviewReport(report);
  else box.innerHTML = '<p class="empty-hint">暂无审核报告</p>';
}

function renderDirectorReviewReport(report) {
  const box = $('#director-review-report');
  const issues = report.issues || [];
  let html = '<div class="director-report-head">';
  if (report.story_coherence != null && !isNaN(Number(report.story_coherence))) {
    html += '<span class="coherence-score">剧情连贯性 ' + Number(report.story_coherence).toFixed(2) + '</span>';
  }
  if (report.created_at) html += '<span class="toolbar-hint">' + esc(report.created_at) + '</span>';
  html += '</div>';
  if (report.summary) html += '<p class="director-summary">' + esc(report.summary) + '</p>';
  if (issues.length) {
    html += '<table class="run-table issues-table"><thead><tr>' +
      '<th>镜头</th><th>类型</th><th>严重度</th><th>详情</th></tr></thead><tbody>' +
      issues.map((it) => {
        const sev = String(it.severity || 'info').toLowerCase();
        return '<tr>' +
          '<td>' + esc(it.shot_id || '-') + '</td>' +
          '<td>' + esc(ISSUE_TYPE_MAP[it.type] || it.type || '-') + '</td>' +
          '<td><span class="severity-pill sev-' + esc(sev) + '">' + esc(it.severity || '-') + '</span></td>' +
          '<td class="issue-detail">' + esc(it.detail || '') + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table>';
  } else {
    html += '<p class="empty-hint">未发现问题 ✓</p>';
  }
  box.innerHTML = html;
}

/* ---------- SSE 事件流 ---------- */
function setSSEStatus(mode, text) {
  const el = $('#sse-indicator');
  el.className = 'sse-indicator ' + (mode === 'on' ? 'sse-on' : mode === 'err' ? 'sse-err' : 'sse-off');
  el.textContent = '● 事件流:' + text;
}

function connectSSE() {
  if (state.es) { state.es.close(); state.es = null; }
  if (state.sseRetryTimer) { clearTimeout(state.sseRetryTimer); state.sseRetryTimer = null; }
  if (!state.currentProjectId) { setSSEStatus('off', '未连接'); return; }

  const url = '/projects/' + encodeURIComponent(state.currentProjectId) + '/events?seq=' + state.lastSeq;
  const es = new EventSource(url);
  state.es = es;

  es.onopen = () => {
    state.sseRetryDelay = 1000;
    setSSEStatus('on', '已连接');
  };

  es.onmessage = (e) => {
    let evt;
    try { evt = JSON.parse(e.data); } catch (err) { return; }
    handleEvent(evt);
  };

  es.onerror = () => {
    setSSEStatus('err', '断开,重连中…');
    es.close();
    if (state.es === es) state.es = null;
    // 指数退避重连,用最后收到的 seq 补齐
    const delay = state.sseRetryDelay;
    state.sseRetryDelay = Math.min(state.sseRetryDelay * 2, 30000);
    state.sseRetryTimer = setTimeout(() => {
      if (state.currentProjectId) connectSSE();
    }, delay);
  };
}

function handleEvent(evt) {
  // 去重
  if (evt.event_id) {
    if (state.seenEventIds.has(evt.event_id)) return;
    state.seenEventIds.add(evt.event_id);
    if (state.seenEventIds.size > 5000) {
      state.seenEventIds = new Set(Array.from(state.seenEventIds).slice(-2500));
    }
  }
  if (typeof evt.seq === 'number' && evt.seq > state.lastSeq) state.lastSeq = evt.seq;

  state.events.push(evt);
  if (state.events.length > 500) state.events = state.events.slice(-300);
  appendEventCard(evt);

  // 事件驱动刷新 run 状态
  const t = evt.type || evt.event_type || '';
  if (['step.completed', 'run.failed', 'quality.evaluated', 'artifact.created'].includes(t)) {
    softRefreshRuns();
  }
  if (t === 'tool.progress') {
    const rid = evt.run_id;
    if (rid) {
      const clock = getRunClock({ run_id: rid });
      clock.lastProgressAt = Date.now();
      clock.lastProgressLabel = evt.summary || evt.message || evt.tool || '';
    }
  }
}

let softRefreshTimer = null;
function softRefreshRuns() {
  if (softRefreshTimer) clearTimeout(softRefreshTimer);
  softRefreshTimer = setTimeout(async () => {
    if (!state.currentProjectId) return;
    try {
      const data = await api('/projects/' + encodeURIComponent(state.currentProjectId));
      state.project = data;
      renderRuns();
      renderMonitor();
      renderProjectSummary();
    } catch (e) { /* 静默,下次事件再试 */ }
  }, 800);
}

function eventTypeClass(t) {
  return 'ev-' + String(t || '').replace(/\./g, '-');
}

function appendEventCard(evt) {
  const stream = $('#event-stream');
  const hint = stream.querySelector('.empty-hint');
  if (hint) hint.remove();

  const t = evt.type || evt.event_type || 'unknown';
  const ts = evt.ts || evt.timestamp || '';
  const time = ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) : new Date().toLocaleTimeString('zh-CN', { hour12: false });

  let body = '';
  // 行动摘要
  const summary = evt.summary || evt.message || evt.action_summary;
  if (summary) body += '<div class="ev-summary">' + esc(summary) + '</div>';

  // 结构化决策
  const decision = evt.decision || (t === 'decision.proposed' ? evt.payload : null);
  if (decision && typeof decision === 'object') {
    body += '<div class="ev-decision"><span class="k">结构化决策</span><pre>' +
      esc(JSON.stringify(decision, null, 2)) + '</pre></div>';
  }

  // 工具结果 / 进度
  if (t === 'tool.progress') {
    const p = evt.progress;
    if (p != null && typeof p === 'object' && typeof p.done === 'number' && typeof p.total === 'number' && p.total > 0) {
      // 有可测进度才显示真实百分比
      const pct = Math.min(100, (p.done / p.total) * 100);
      body += '<div class="progress-track"><div class="progress-fill" style="width:' + pct.toFixed(0) + '%"></div></div>' +
        '<div class="ev-summary">' + esc(p.done + '/' + p.total) + ' (' + pct.toFixed(0) + '%)</div>';
    } else {
      // 不伪造百分比:执行中 + 已耗时
      const rid = evt.run_id;
      let elapsedTxt = '';
      if (rid) {
        const run = getRuns().find((r) => (r.run_id || r.id) === rid);
        if (run) elapsedTxt = fmtElapsed(runElapsedMs(run));
      }
      body += '<div class="ev-summary"><span class="ev-elapsed">执行中' +
        (elapsedTxt ? ' · 已耗时 ' + esc(elapsedTxt) : '') + '</span></div>';
    }
    if (evt.result !== undefined) {
      body += '<pre>' + esc(typeof evt.result === 'string' ? evt.result : JSON.stringify(evt.result, null, 2)) + '</pre>';
    }
  } else if (evt.result !== undefined || evt.artifact !== undefined) {
    const payload = evt.result !== undefined ? evt.result : evt.artifact;
    body += '<pre>' + esc(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)) + '</pre>';
  } else if (!summary && !decision) {
    body += '<pre>' + esc(JSON.stringify(evt, null, 2)) + '</pre>';
  }

  const card = document.createElement('div');
  card.className = 'event-card ' + eventTypeClass(t);
  card.innerHTML =
    '<div class="ev-head"><span class="ev-type">' + esc(t) + '</span>' +
    '<span>' + (evt.seq != null ? '#' + esc(evt.seq) + ' · ' : '') + esc(time) + '</span></div>' + body;
  stream.appendChild(card);
  stream.scrollTop = stream.scrollHeight;
}

$('#clear-events-btn').addEventListener('click', () => {
  state.events = [];
  $('#event-stream').innerHTML = '<p class="empty-hint">等待事件…</p>';
});

/* ---------- 任务监控 ---------- */
$('#refresh-monitor-btn').addEventListener('click', () => {
  if (state.currentProjectId) loadProject(state.currentProjectId);
});

function allShotsAccepted() {
  const shots = (state.project && state.project.shots) || [];
  return shots.length > 0 && shots.every((s) => !!s.accepted_run_id);
}

function renderMonitor() {
  const tbody = $('#monitor-tbody');
  const runs = getRuns();
  if (!runs.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-hint">暂无任务</td></tr>';
  } else {
    tbody.innerHTML = runs.map((run) => {
      const id = run.run_id || run.id;
      const st = runState(run);
      const terminal = TERMINAL_STATES.includes(st);
      // 评分:score.scores 是 {identity,action,scene,text_ok} 字典,取数值平均(保留2位)
      const scoreObj = run.score;
      let total = '-';
      if (scoreObj) {
        const sd = scoreObj.scores || (scoreObj.detail && scoreObj.detail.scores);
        if (sd && typeof sd === 'object') {
          const vals = Object.values(sd).map(Number).filter((n) => !isNaN(n));
          if (vals.length) total = (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
        }
        if (total === '-') {
          if (typeof scoreObj.total === 'number') total = scoreObj.total.toFixed(2);
          else if (typeof scoreObj.overall === 'number') total = scoreObj.overall.toFixed(2);
        }
      }
      const failure = run.failure
        ? (typeof run.failure === 'object' ? (run.failure.message || JSON.stringify(run.failure)) : run.failure)
        : '';
      return '<tr class="monitor-row" data-run-id="' + esc(id) + '" title="点击查看详情与审核">' +
        '<td>' + esc(id) + '</td>' +
        '<td>' + esc(run.shot_id || '-') + '</td>' +
        '<td><span class="run-state-pill ' + esc(st) + '">' + esc(st) + '</span></td>' +
        '<td>' + esc(total) + '</td>' +
        '<td class="run-elapsed" data-run-id="' + esc(id) + '">' + fmtElapsed(runElapsedMs(run)) + '</td>' +
        '<td>' + esc(run.retry_count != null ? run.retry_count : (run.retries != null ? run.retries : 0)) + '</td>' +
        '<td title="' + esc(failure) + '">' + esc(failure ? String(failure).slice(0, 40) : '-') + '</td>' +
        '<td><div class="ops">' +
          '<button class="btn btn-small btn-accent open-detail-btn" data-run-id="' + esc(id) + '">详情/审核</button>' +
          '<button class="btn btn-small cmd-btn" data-action="pause" data-run-id="' + esc(id) + '"' + (terminal ? ' disabled' : '') + '>暂停调度</button>' +
          '<button class="btn btn-small cmd-btn" data-action="resume" data-run-id="' + esc(id) + '"' + (terminal ? ' disabled' : '') + '>恢复</button>' +
          '<button class="btn btn-small btn-danger cmd-btn" data-action="cancel" data-run-id="' + esc(id) + '"' + (terminal ? ' disabled' : '') + '>取消</button>' +
        '</div></td>' +
      '</tr>';
    }).join('');
    tbody.querySelectorAll('.cmd-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        sendRunCommand(btn.dataset.runId, btn.dataset.action, btn);
      });
    });
    tbody.querySelectorAll('.monitor-row').forEach((row) => {
      row.addEventListener('click', () => openRunDetail(row.dataset.runId));
    });
  }
  const exportBtn = $('#export-btn');
  const ok = allShotsAccepted();
  exportBtn.disabled = !ok;
  $('#export-hint').textContent = ok ? '全部镜头已验收,可以导出' : '全部镜头验收通过后可用';
  renderExportResult();
}

// 成片展示区:列出本项目已导出的成片(derived 视频素材)
function renderExportResult() {
  const box = $('#export-result');
  if (!box) return;
  const exports = (state.assets || [])
    .filter((a) => a.source === 'derived' && (a.media_type === 'video' || isVideoAsset(a)));
  if (!exports.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<h3>已导出成片(' + exports.length + ')</h3>' + exports.map((a) => {
    const id = a.asset_id || a.id;
    const m = a.metadata || {};
    const name = (a.storage_key || '').split('/').pop() || id;
    const size = m.size_bytes ? (m.size_bytes / 1048576).toFixed(1) + ' MB' : '';
    const dur = m.duration ? Math.round(m.duration) + 's' : '';
    const url = '/assets/' + encodeURIComponent(id) + '/file';
    return '<div class="export-item">' +
      '<video src="' + esc(url) + '" controls preload="metadata"></video>' +
      '<div class="export-meta"><span>' + esc(name) + '</span><span>' + esc(dur) + ' ' + esc(size) + '</span>' +
      '<a class="btn btn-small" href="' + esc(url) + '" download="' + esc(name) + '">下载</a></div>' +
    '</div>';
  }).join('');
}

async function sendRunCommand(runId, action, btn) {
  let body = { action, command_id: newCommandId() };
  if (action === 'resume') {
    const note = prompt('恢复调度:可填写修改意见(留空则原样恢复)', '');
    if (note === null) return; // 用户取消
    if (note.trim()) body.note = note.trim();
  }
  btn.disabled = true;
  try {
    await api('/runs/' + encodeURIComponent(runId) + '/commands', { method: 'POST', json: body });
    toast('指令已发送:' + action + ' → ' + runId, 'ok');
    setTimeout(() => { if (state.currentProjectId) loadProject(state.currentProjectId); }, 600);
  } catch (err) {
    toast('指令失败:' + err.message, 'err');
    btn.disabled = false;
  }
}

$('#export-btn').addEventListener('click', async () => {
  if (!state.currentProjectId) return;
  const btn = $('#export-btn');
  btn.disabled = true;
  btn.textContent = '导出中…';
  try {
    const res = await api('/projects/' + encodeURIComponent(state.currentProjectId) + '/export', {
      method: 'POST', json: {},
    });
    const asset = res.asset || {};
    const aid = asset.asset_id || res.export_id || '';
    toast('导出成功' + (aid ? ': ' + aid : ''), 'ok');
    await refreshAssets();
    renderMonitor();
  } catch (err) {
    toast('导出失败:' + err.message, 'err');
  } finally {
    btn.textContent = '导出成片';
    btn.disabled = !allShotsAccepted();
  }
});

/* ---------- 耗时实时刷新(每秒) ---------- */
setInterval(() => {
  $$('.run-elapsed').forEach((el) => {
    const run = getRuns().find((r) => (r.run_id || r.id) === el.dataset.runId);
    if (!run) return;
    const st = runState(run);
    if (TERMINAL_STATES.includes(st) && (parseTime(run.finished_at) || parseTime(run.completed_at))) return;
    el.textContent = fmtElapsed(runElapsedMs(run));
  });
}, 1000);

/* ---------- 启动 ---------- */
async function init() {
  // 先从后端拉项目列表合并进本地记录,避免换浏览器/清缓存后看不到项目
  try {
    const res = await api('/projects');
    const serverProjects = res.projects || [];
    const merged = getRecentProjects();
    serverProjects.forEach((p) => {
      const id = p.project_id || p.id;
      if (id && !merged.some((x) => x.id === id)) merged.push({ id, title: p.title || id });
    });
    localStorage.setItem('svf_projects', JSON.stringify(merged.slice(0, 50)));
  } catch (err) {
    // 后端不可达时退回本地缓存
  }
  renderRecentProjects();
  const list = getRecentProjects();
  if (state.currentProjectId) {
    loadProject(state.currentProjectId);
  } else if (list.length) {
    loadProject(list[0].id);
  } else {
    setSSEStatus('off', '未连接');
  }
}
init();
