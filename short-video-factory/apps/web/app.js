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
    connectSSE();
  } catch (err) {
    toast('加载项目失败:' + err.message, 'err');
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

/* ---------- 分镜镜头 ---------- */
$('#refresh-shots-btn').addEventListener('click', () => {
  if (state.currentProjectId) loadProject(state.currentProjectId);
});

function shotSpec(shot) {
  return shot.spec || {};
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
    btn.addEventListener('click', () => bindShotAsset(btn));
  });
  container.querySelectorAll('.shot-run-btn').forEach((btn) => {
    btn.addEventListener('click', () => submitShotRun(btn.dataset.shotId, btn));
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
      ? '<div class="shot-field"><span class="k">验收要求</span>' + esc(spec.acceptance || spec.acceptance_criteria) + '</div>' : '') +
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
  // 拉取单个 run 的最新详情
  try {
    const detail = await api('/runs/' + encodeURIComponent(runId));
    const runs = getRuns();
    const idx = runs.findIndex((r) => (r.run_id || r.id) === runId);
    if (idx >= 0 && state.project) state.project.runs[idx] = Object.assign({}, runs[idx], detail);
    renderRunDetail();
    renderRuns();
  } catch (err) {
    toast('获取任务详情失败:' + err.message, 'err');
  }
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
  const note = box.querySelector('.review-note').value.trim();
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
      renderProjectSummary();
    }
  } catch (err) {
    toast('审核提交失败:' + err.message, 'err');
  }
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
      const scoreObj = run.score;
      const total = scoreObj && typeof scoreObj.total === 'number' ? scoreObj.total.toFixed(2)
        : scoreObj && typeof scoreObj.overall === 'number' ? scoreObj.overall.toFixed(2) : '-';
      const failure = run.failure
        ? (typeof run.failure === 'object' ? (run.failure.message || JSON.stringify(run.failure)) : run.failure)
        : '';
      return '<tr>' +
        '<td>' + esc(id) + '</td>' +
        '<td>' + esc(run.shot_id || '-') + '</td>' +
        '<td><span class="run-state-pill ' + esc(st) + '">' + esc(st) + '</span></td>' +
        '<td>' + esc(total) + '</td>' +
        '<td class="run-elapsed" data-run-id="' + esc(id) + '">' + fmtElapsed(runElapsedMs(run)) + '</td>' +
        '<td>' + esc(run.retry_count != null ? run.retry_count : (run.retries != null ? run.retries : 0)) + '</td>' +
        '<td title="' + esc(failure) + '">' + esc(failure ? String(failure).slice(0, 40) : '-') + '</td>' +
        '<td><div class="ops">' +
          '<button class="btn btn-small cmd-btn" data-action="pause" data-run-id="' + esc(id) + '"' + (terminal ? ' disabled' : '') + '>暂停调度</button>' +
          '<button class="btn btn-small cmd-btn" data-action="resume" data-run-id="' + esc(id) + '"' + (terminal ? ' disabled' : '') + '>恢复</button>' +
          '<button class="btn btn-small btn-danger cmd-btn" data-action="cancel" data-run-id="' + esc(id) + '"' + (terminal ? ' disabled' : '') + '>取消</button>' +
        '</div></td>' +
      '</tr>';
    }).join('');
    tbody.querySelectorAll('.cmd-btn').forEach((btn) => {
      btn.addEventListener('click', () => sendRunCommand(btn.dataset.runId, btn.dataset.action, btn));
    });
  }
  const exportBtn = $('#export-btn');
  const ok = allShotsAccepted();
  exportBtn.disabled = !ok;
  $('#export-hint').textContent = ok ? '全部镜头已验收,可以导出' : '全部镜头验收通过后可用';
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
  try {
    const res = await api('/projects/' + encodeURIComponent(state.currentProjectId) + '/export', {
      method: 'POST', json: {},
    });
    toast('导出任务已触发' + (res.export_id ? ': ' + res.export_id : ''), 'ok');
  } catch (err) {
    toast('导出失败:' + err.message, 'err');
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
renderRecentProjects();
if (state.currentProjectId) {
  loadProject(state.currentProjectId);
} else {
  setSSEStatus('off', '未连接');
}
