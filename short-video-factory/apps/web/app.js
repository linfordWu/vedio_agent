/* ===== 短剧工坊工作台 · 纯前端零构建 · 3 视图 hash 路由 ===== */
'use strict';

/* ---------- 全局状态 ---------- */
const state = {
  route: { view: 'dashboard' },
  // 片库
  projects: [],
  dbQuery: '',
  // 工作室
  currentProjectId: null,
  bundle: null,          // GET /projects/{id} → {project, scenes[], shots[], runs[]}
  characters: [],        // GET /projects/{id}/characters
  assets: [],            // GET /assets?project_id=
  step: 'script',
  stepTimer: null,       // 当前步的轮询定时器
  portraitWorking: new Set(),
  portraitTimers: new Set(),
  noCharPatch: false,    // 后端不支持 PATCH /characters 后置 true,描述转只读
  propFilter: '__all',   // 道具步素材库子筛选
  sbDrafts: {},          // 分镜编辑草稿 {shotId: {action, duration_s}}
  sbExpandRun: null,     // 分镜展开播放的 run_id
  editSelectedShotId: null,
  directorReport: null,
  reviewing: false,
  exporting: false,
  // 建立片场
  nf: { genre: '都市情感', style: '写实电影感', ratio: '9:16' },
  qkMode: 'text',
  qkSelected: new Set(),
  qkAssets: [],
  qkLoaded: false,
  // SSE
  es: null,
  lastSeq: 0,
  seenEventIds: new Set(),
  events: [],
  sseRetryDelay: 1000,
  sseRetryTimer: null,
  sseStatus: 'off',
};

const STEPS = [
  { key: 'script', label: '剧本', note: '故事与场景' },
  { key: 'character', label: '角色', note: '人物与定妆' },
  { key: 'scene', label: '场景', note: '空间与光线' },
  { key: 'prop', label: '道具', note: '素材与分类' },
  { key: 'storyboard', label: '分镜', note: '镜头与生成' },
  { key: 'edit', label: '剪辑', note: '审核与成片' },
];

const CATEGORY_MAP = {
  character: '角色参考', location: '场景参考', prop: '道具', style: '风格参考',
  footage: '视频素材', audio: '音频', export: '成片', other: '其他',
};
const CATEGORIES = ['character', 'location', 'prop', 'style', 'footage', 'audio', 'export', 'other'];

const ISSUE_TYPE_MAP = {
  story: '剧情连贯', character: '人物不一致', goof: '穿帮',
  unexpected: '非预期', text: '画面文字',
};

const RUN_STATES_BUSY = ['QUEUED', 'RENDERING', 'SCORING'];
const RUN_STATES_PRE = ['PLANNED', 'ASSET_READY', 'PROMPT_READY'];

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
  setTimeout(() => el.remove(), 4200);
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

function categoryLabel(cat) {
  if (!cat) return '未分类';
  return CATEGORY_MAP[cat] || cat;
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

function isVideoAsset(a) {
  const name = (a.filename || a.name || a.storage_key || '').toLowerCase();
  const mime = (a.mime || a.content_type || '').toLowerCase();
  return a.media_type === 'video' || mime.startsWith('video/') || /\.(mp4|webm|mov|mkv|avi)$/.test(name);
}

function isAudioAsset(a) {
  const name = (a.filename || a.name || a.storage_key || '').toLowerCase();
  const mime = (a.mime || a.content_type || '').toLowerCase();
  return a.media_type === 'audio' || mime.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac)$/.test(name);
}

function assetFileUrl(a) {
  return '/assets/' + encodeURIComponent(a.asset_id || a.id) + '/file';
}

function assetName(a) {
  const id = a.asset_id || a.id;
  return (a.storage_key || '').split('/').pop() || a.filename || a.name || id;
}

/* ---------- Hash 路由 ---------- */
function parseHash() {
  const h = location.hash.slice(1) || '/';
  const qIdx = h.indexOf('?');
  const path = qIdx >= 0 ? h.slice(0, qIdx) : h;
  const params = new URLSearchParams(qIdx >= 0 ? h.slice(qIdx + 1) : '');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'new') return { view: 'new' };
  if (parts[0] === 'studio' && parts[1]) {
    return { view: 'studio', projectId: decodeURIComponent(parts[1]), step: params.get('step') || 'script' };
  }
  return { view: 'dashboard' };
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

window.addEventListener('hashchange', render);

async function render() {
  clearStepTimer();
  const r = parseHash();
  state.route = r;
  ['view-dashboard', 'view-new', 'view-studio'].forEach((id) => $('#' + id).classList.add('hidden'));
  if (r.view === 'new') {
    closeSSE();
    $('#view-new').classList.remove('hidden');
  } else if (r.view === 'studio') {
    $('#view-studio').classList.remove('hidden');
    await enterStudio(r.projectId, r.step);
  } else {
    closeSSE();
    $('#view-dashboard').classList.remove('hidden');
    await renderDashboard();
  }
}

/* ---------- 视图一:片库 Dashboard ---------- */
$('#db-new-btn').addEventListener('click', () => go('#/new'));
$('#db-search').addEventListener('input', (e) => {
  state.dbQuery = e.target.value;
  renderProjectCards();
});

async function renderDashboard() {
  const grid = $('#db-grid');
  grid.innerHTML = '<div class="panel db-empty">正在读取本地片库…</div>';
  try {
    const res = await api('/projects');
    state.projects = res.projects || res || [];
  } catch (err) {
    grid.innerHTML = '<div class="panel db-empty">读取片库失败:' + esc(err.message) + '</div>';
    return;
  }
  renderProjectCards();
}

const SEG_DEFS = [
  { label: '剧本', lit: (pg) => num(pg.scenes) > 0 },
  { label: '角色', lit: (pg) => num(pg.characters) > 0 },
  { label: '场景', lit: (pg) => num(pg.locations != null ? pg.locations : pg.location) > 0 },
  { label: '道具', lit: (pg) => num(pg.props != null ? pg.props : pg.prop) > 0 },
  { label: '分镜', lit: (pg) => num(pg.shots) > 0 },
  { label: '剪辑', lit: (pg) => num(pg.shots) > 0 && num(pg.accepted) >= num(pg.shots) },
];

function num(v) { const n = Number(v); return isNaN(n) ? 0 : n; }

function renderProjectCards() {
  const grid = $('#db-grid');
  const q = state.dbQuery.trim().toLowerCase();
  const list = state.projects.filter((p) =>
    !q || ((p.title || '') + ' ' + (p.genre || '')).toLowerCase().includes(q));
  if (!state.projects.length) {
    grid.innerHTML = '<div class="panel db-empty">片场还是空的 — 点右上角「建立新片场」开始第一部短剧。</div>';
    return;
  }
  if (!list.length) {
    grid.innerHTML = '<div class="panel db-empty">没有匹配「' + esc(state.dbQuery) + '」的项目。</div>';
    return;
  }
  grid.innerHTML = list.map((p) => {
    const id = p.project_id || p.id;
    const pg = p.progress || {};
    const updated = p.updated_at || p.created_at;
    const updatedDate = updated ? new Date(updated) : null;
    const updatedTxt = updatedDate && !isNaN(updatedDate.getTime()) && updatedDate.getFullYear() >= 2000
      ? updatedDate.toLocaleDateString('zh-CN') : '';
    const ratio = p.aspect_ratio || p.ratio || '';
    const segs = SEG_DEFS.map((s, i) =>
      '<div><div class="proj-seg-bar' + (s.lit(pg) ? ' lit-' + i : '') + '"></div>' +
      '<div class="proj-seg-label">' + s.label + '</div></div>').join('');
    const stats = '剧本 ' + num(pg.scenes) + ' · 镜头 ' + num(pg.accepted) + '/' + num(pg.shots) +
      ' · 角色 ' + num(pg.characters) + ' · 定妆 ' + num(pg.portraits) + ' · 成片 ' + num(pg.exports);
    return '<article class="panel proj-card" data-id="' + esc(id) + '">' +
      '<div class="proj-card-main">' +
        '<div class="proj-card-updated">' + (updatedTxt ? 'UPDATED ' + esc(updatedTxt) : '') + '</div>' +
        '<h3 class="proj-card-title">' + esc(p.title || '(无标题)') + '</h3>' +
        '<div class="proj-card-meta">' + esc([p.genre, p.style, ratio].filter(Boolean).join(' / ') || '未设置风格') + '</div>' +
        '<p class="proj-card-brief">' + esc(p.brief || '尚未生成剧本') + '</p>' +
        '<div class="proj-progress">' + segs + '</div>' +
      '</div>' +
      '<div class="proj-card-foot"><span>' + esc(stats) + '</span>' +
      '<button class="btn btn-ghost btn-small db-del-btn" data-id="' + esc(id) + '" data-title="' + esc(p.title || id) + '">删除</button></div>' +
    '</article>';
  }).join('');
  grid.querySelectorAll('.proj-card-main').forEach((el) => {
    el.addEventListener('click', () => go('#/studio/' + encodeURIComponent(el.closest('.proj-card').dataset.id)));
  });
  grid.querySelectorAll('.db-del-btn').forEach((btn) => {
    btn.addEventListener('click', () => deleteProject(btn.dataset.id, btn.dataset.title));
  });
}

async function deleteProject(id, title) {
  if (!confirm('删除「' + title + '」?\n项目记录(剧本/分镜/任务)将被删除;\n本地素材与成片文件仍保留。')) return;
  try {
    await api('/projects/' + encodeURIComponent(id), { method: 'DELETE' });
    toast('项目已删除', 'ok');
    renderDashboard();
  } catch (err) {
    toast('删除失败:' + err.message, 'err');
  }
}

/* ---------- 视图二:建立片场 ---------- */
function bindPresetPills(containerSel, onPick) {
  $$(containerSel + ' .preset-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$(containerSel + ' .preset-pill').forEach((b) => b.classList.toggle('active', b === btn));
      onPick(btn.dataset.value);
    });
  });
}

bindPresetPills('#nf-genres', (v) => { state.nf.genre = v; });
bindPresetPills('#nf-styles', (v) => { state.nf.style = v; });

$$('.ratio-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.ratio-btn').forEach((b) => b.classList.toggle('active', b === btn));
    state.nf.ratio = btn.dataset.value;
  });
});

$('#nf-create-btn').addEventListener('click', async () => {
  const title = $('#nf-title').value.trim();
  if (!title) { toast('先给项目起个名字', 'err'); return; }
  const genre = $('#nf-genre-custom').value.trim() || state.nf.genre;
  const body = {
    title,
    style: state.nf.style,
    brief: $('#nf-brief').value.trim() || undefined,
    duration_target_s: Number($('#nf-duration').value) || 60,
    genre,
    aspect_ratio: state.nf.ratio,
  };
  const btn = $('#nf-create-btn');
  btn.disabled = true;
  btn.textContent = '正在建立片场…';
  try {
    const res = await api('/projects', { method: 'POST', json: body });
    const id = res.project_id || res.id || (res.project && (res.project.project_id || res.project.id));
    if (!id) throw new Error('响应中未找到项目 ID');
    toast('片场已建立,正在触发 AI 规划…', 'ok');
    // 立即触发规划;失败不阻塞进入工作室
    api('/projects/' + encodeURIComponent(id) + '/plan', { method: 'POST', json: {} })
      .catch((err) => toast('触发规划失败(可在剧本步重试):' + err.message, 'err'));
    go('#/studio/' + encodeURIComponent(id) + '?step=script');
  } catch (err) {
    toast('建立失败:' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '建立并进入剧本';
  }
});

/* ---- 一键成片(建立片场页底部) ---- */
$$('.qk-mode-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.qkMode = btn.dataset.mode;
    $$('.qk-mode-pill').forEach((b) => b.classList.toggle('active', b === btn));
    renderQuickPicker();
  });
});

async function renderQuickPicker() {
  const box = $('#qk-picker');
  if (state.qkMode !== 'assets') { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  if (!state.qkLoaded) {
    box.innerHTML = '<p class="empty-hint">加载素材中…</p>';
    try {
      const res = await api('/assets');
      state.qkAssets = (res.assets || res || []).filter((a) => !isAudioAsset(a));
      state.qkLoaded = true;
    } catch (err) {
      box.innerHTML = '<p class="empty-hint">素材加载失败:' + esc(err.message) + '</p>';
      return;
    }
  }
  if (!state.qkAssets.length) {
    box.innerHTML = '<p class="empty-hint">还没有可用素材,可切到「文生视频」模式</p>';
    return;
  }
  box.innerHTML = '<div class="quick-picker-hint">选择参考素材(可多选,已选 ' + state.qkSelected.size + ')</div>' +
    '<div class="quick-picker-grid">' + state.qkAssets.map((a) => {
      const id = a.asset_id || a.id;
      const name = assetName(a);
      const media = isVideoAsset(a)
        ? '<video src="' + esc(assetFileUrl(a)) + '" preload="metadata" muted></video>'
        : '<img src="' + esc(assetFileUrl(a)) + '" loading="lazy" alt="' + esc(name) + '">';
      return '<div class="quick-pick-card' + (state.qkSelected.has(id) ? ' selected' : '') + '" data-asset-id="' + esc(id) + '">' +
        media + '<div class="quick-pick-name">' + esc(name) + '</div></div>';
    }).join('') + '</div>';
  box.querySelectorAll('.quick-pick-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.dataset.assetId;
      if (state.qkSelected.has(id)) state.qkSelected.delete(id);
      else state.qkSelected.add(id);
      card.classList.toggle('selected');
      const hint = box.querySelector('.quick-picker-hint');
      if (hint) hint.textContent = '选择参考素材(可多选,已选 ' + state.qkSelected.size + ')';
    });
  });
}

$('#qk-btn').addEventListener('click', async () => {
  const brief = $('#qk-brief').value.trim();
  if (!brief) { toast('请先描述你想要的短剧', 'err'); return; }
  const body = {
    title: brief.slice(0, 15),
    brief,
    duration_target_s: Number($('#qk-duration').value) || 60,
    mode: state.qkMode,
  };
  const style = $('#qk-style').value.trim();
  if (style) body.style = style;
  if (state.qkMode === 'assets') body.asset_ids = Array.from(state.qkSelected);
  const btn = $('#qk-btn');
  btn.disabled = true;
  btn.textContent = '创建中…';
  try {
    const res = await api('/projects/quick', { method: 'POST', json: body });
    const pid = res.project_id || res.id;
    if (!pid) throw new Error('响应中未找到 project_id');
    toast('一键成片项目已创建:' + pid, 'ok');
    state.qkSelected.clear();
    $('#qk-brief').value = '';
    go('#/studio/' + encodeURIComponent(pid) + '?step=storyboard');
  } catch (err) {
    toast('一键成片失败:' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '一键成片';
  }
});

/* ---------- 视图三:工作室骨架 ---------- */
function getRuns() {
  return (state.bundle && state.bundle.runs) || [];
}

function getShots() {
  return (state.bundle && state.bundle.shots) || [];
}

function getScenes() {
  return (state.bundle && state.bundle.scenes) || [];
}

function shotSpec(shot) {
  return shot.spec || {};
}

function shotId(shot) {
  return shot.shot_id || shot.id;
}

function runId(run) {
  return run.run_id || run.id;
}

function runState(run) {
  return (run.state || run.status || 'PLANNED').toUpperCase();
}

// 镜头最新 run(按创建时间)
function latestRunForShot(sid) {
  const runs = getRuns().filter((r) => r.shot_id === sid);
  if (!runs.length) return null;
  return runs.slice().sort((a, b) => (parseTime(a.created_at) || 0) - (parseTime(b.created_at) || 0)).pop();
}

// 镜头状态徽章:无 run=待生成 / 生成中 / 待审核 / 已完成 / 失败
function shotStatusInfo(sid) {
  const run = latestRunForShot(sid);
  if (!run) return { cls: 'st-idle', label: '待生成' };
  const st = runState(run);
  if (st === 'ACCEPTED') return { cls: 'st-done', label: '已完成' };
  if (st === 'HUMAN_REVIEW') return { cls: 'st-review', label: '待审核' };
  if (st === 'FAILED' || st === 'CANCELLED') return { cls: 'st-fail', label: '失败' };
  if (RUN_STATES_BUSY.includes(st) || RUN_STATES_PRE.includes(st)) return { cls: 'st-busy', label: '生成中' };
  return { cls: 'st-idle', label: st };
}

function scoreAvg(run) {
  const s = run.score;
  if (!s) return '-';
  const sd = s.scores || (s.detail && s.detail.scores);
  if (sd && typeof sd === 'object') {
    const vals = Object.values(sd).map(Number).filter((n) => !isNaN(n));
    if (vals.length) return (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2);
  }
  if (typeof s.total === 'number') return s.total.toFixed(2);
  if (typeof s.overall === 'number') return s.overall.toFixed(2);
  return '-';
}

function clearStepTimer() {
  if (state.stepTimer) { clearInterval(state.stepTimer); state.stepTimer = null; }
}

async function enterStudio(pid, step) {
  state.currentProjectId = pid;
  state.step = STEPS.some((s) => s.key === step) ? step : 'script';
  state.directorReport = null;
  state.sbDrafts = {};
  state.sbExpandRun = null;
  state.editSelectedShotId = null;
  const root = $('#studio-root');
  root.innerHTML = '<div class="studio-loading"><span class="spinner"></span> 正在开机片场…</div>';
  try {
    await refreshBundle();
  } catch (err) {
    root.innerHTML = '<div class="studio-loading">片场开机失败:' + esc(err.message) +
      ' · <a href="#/" style="color:var(--projector)">返回片库</a></div>';
    return;
  }
  connectSSE();
  renderStudioShell();
}

// 全量重拉 bundle;写操作成功后一律走这个,不做客户端合并
async function refreshBundle() {
  const pid = state.currentProjectId;
  const [bundle, chars, assets] = await Promise.all([
    api('/projects/' + encodeURIComponent(pid)),
    api('/projects/' + encodeURIComponent(pid) + '/characters').catch(() => ({ characters: [] })),
    api('/assets?project_id=' + encodeURIComponent(pid)).catch(() => ({ assets: [] })),
  ]);
  state.bundle = bundle;
  state.characters = chars.characters || [];
  state.assets = assets.assets || assets || [];
}

// 静默刷新 + 重渲当前步
async function refreshQuiet() {
  try {
    await refreshBundle();
    renderStudioShell();
  } catch (err) {
    toast('刷新失败:' + err.message, 'err');
  }
}

function studioCounts() {
  const chars = state.characters;
  const shots = getShots();
  const accepted = shots.filter((s) => !!s.accepted_run_id).length;
  const exports = (state.assets || []).filter((a) => a.source === 'derived' && isVideoAsset(a)).length;
  return {
    script: getScenes().length + ' 场',
    character: String(chars.filter((c) => (c.kind || 'character') === 'character').length),
    scene: String(chars.filter((c) => c.kind === 'location').length),
    prop: String((state.assets || []).filter((a) => a.category === 'prop').length),
    storyboard: accepted + '/' + shots.length + ' 镜',
    edit: exports ? exports + ' 条成片' : '未成片',
  };
}

function renderStudioShell() {
  const root = $('#studio-root');
  const proj = (state.bundle && state.bundle.project) || {};
  const counts = studioCounts();
  const pid = state.currentProjectId;
  const ratio = proj.aspect_ratio || proj.ratio || '-';
  const stepIdx = STEPS.findIndex((s) => s.key === state.step);

  root.innerHTML =
    '<div class="studio-grid">' +
    '<aside class="sidebar">' +
      '<div class="sidebar-perforation"></div>' +
      '<div class="sidebar-inner">' +
        '<div class="sidebar-head">' +
          '<div class="sidebar-brand">镜界 · PRODUCTION STUDIO</div>' +
          '<a href="#/" class="sidebar-back">← 返回片库</a>' +
          '<h1 class="sidebar-title">' + esc(proj.title || '(无标题)') + '</h1>' +
          '<div class="sidebar-meta">LOCAL / ' + esc(ratio) + ' / ' + esc(proj.genre || proj.style || '-') + '</div>' +
        '</div>' +
        '<nav class="sidebar-nav">' +
          STEPS.map((s, i) =>
            '<button class="step-btn' + (s.key === state.step ? ' active' : '') + '" data-step="' + s.key + '">' +
              '<span class="step-num">' + String(i + 1).padStart(2, '0') + '</span>' +
              '<span class="step-text"><span class="step-label">' + s.label + '</span>' +
              '<span class="step-note">' + s.note + ' · ' + counts[s.key] + '</span></span>' +
            '</button>').join('') +
        '</nav>' +
        '<div class="sidebar-foot">' +
          '<button id="sse-chip" class="sse-chip"><span>事件流</span><span id="sse-dot" class="sse-dot"></span></button>' +
          '<div class="sidebar-slogan">本地运行 · 无登录 · 无积分</div>' +
        '</div>' +
      '</div>' +
    '</aside>' +
    '<div class="studio-main">' +
      '<header class="studio-topbar">' +
        '<div><div class="label studio-stage-label">STAGE ' + String(stepIdx + 1).padStart(2, '0') + '</div>' +
        '<div class="studio-stage-title">' + STEPS[stepIdx].label + '</div></div>' +
        '<button id="studio-refresh-btn" class="btn btn-small">↻ 刷新</button>' +
      '</header>' +
      '<div id="step-content" class="step-content"></div>' +
    '</div>' +
    '</div>';

  root.querySelectorAll('.step-btn').forEach((btn) => {
    btn.addEventListener('click', () =>
      go('#/studio/' + encodeURIComponent(pid) + '?step=' + btn.dataset.step));
  });
  $('#studio-refresh-btn').addEventListener('click', refreshQuiet);
  $('#sse-chip').addEventListener('click', () => $('#sse-drawer').classList.toggle('hidden'));
  updateSSEIndicator();
  renderStepContent();
}

function renderStepContent() {
  clearStepTimer();
  const el = $('#step-content');
  if (!el) return;
  if (state.step === 'script') renderScriptStep(el);
  else if (state.step === 'character') renderEntityStep(el, 'character');
  else if (state.step === 'scene') renderEntityStep(el, 'location');
  else if (state.step === 'prop') renderPropStep(el);
  else if (state.step === 'storyboard') renderStoryboardStep(el);
  else renderEditStep(el);
}

/* ---------- 第 1 步:剧本 ---------- */
function renderScriptStep(el) {
  const proj = (state.bundle && state.bundle.project) || {};
  const scenes = getScenes();
  const shots = getShots();
  const ratio = proj.aspect_ratio || proj.ratio || '-';

  let html = '<div class="panel brief-panel">' +
    '<div class="brief-head"><div>' +
      '<div class="brief-title">' + esc(proj.title || '(无标题)') + '</div>' +
      '<div class="brief-meta">' + esc([proj.genre, proj.style, ratio, (proj.duration_target_s ? proj.duration_target_s + 's' : '')].filter(Boolean).join(' / ')) + '</div>' +
    '</div>' +
    '<button id="replan-btn" class="btn btn-small">↻ 重新规划</button></div>' +
    (proj.brief ? '<div class="brief-text">' + esc(proj.brief) + '</div>' : '<div class="empty-hint">暂无创作底稿</div>') +
  '</div>';

  if (!scenes.length) {
    html += '<div class="panel waiting-panel"><span class="spinner"></span>' +
      '<div>规划进行中…AI 正在拆解剧本与场景</div>' +
      '<div class="empty-hint" style="padding:0">每 3 秒自动刷新;若长时间无结果,可点上方「重新规划」</div></div>';
  } else {
    html += '<div class="scene-list">' + scenes.map((sc, i) => {
      const sid = sc.scene_id || sc.id || ('scene_' + (i + 1));
      const count = shots.filter((sh) => {
        const ssid = sh.scene_id || shotSpec(sh).scene_id;
        return ssid === sid;
      }).length;
      return '<div class="scene-row">' +
        '<span class="scene-idx">' + String(i + 1).padStart(2, '0') + '</span>' +
        '<span class="scene-title">' + esc(sc.title || sc.name || ('场景 ' + String(i + 1).padStart(2, '0'))) + '</span>' +
        '<span class="scene-summary">' + esc(sc.summary || sc.description || '') + '</span>' +
        '<span class="scene-count">' + count + ' 镜</span>' +
      '</div>';
    }).join('') + '</div>';
  }
  el.innerHTML = html;

  $('#replan-btn').addEventListener('click', async () => {
    if (!confirm('重新规划?\n现有剧本场景、角色与分镜可能被替换;\n本地素材与成片文件仍保留。')) return;
    try {
      await api('/projects/' + encodeURIComponent(state.currentProjectId) + '/plan?force=true', { method: 'POST', json: {} });
      toast('已触发重新规划', 'ok');
      setTimeout(refreshQuiet, 800);
    } catch (err) {
      toast('重新规划失败:' + err.message, 'err');
    }
  });

  // 没有 scenes 时每 3 秒轮询
  if (!scenes.length) {
    state.stepTimer = setInterval(refreshQuiet, 3000);
  }
}

/* ---------- 第 2/3 步:角色 / 场景(实体卡片) ---------- */
function renderEntityStep(el, kind) {
  const isChar = kind === 'character';
  const title = isChar ? '角色造型' : '空镜场景';
  const emptyHint = isChar
    ? '剧本规划后会自动整理角色;若为空,请到「剧本」步触发(重新)规划。'
    : '剧本规划后会自动整理场景;若为空,请到「剧本」步触发(重新)规划。';
  const list = state.characters.filter((c) => (c.kind || 'character') === kind);
  const imageAssets = (state.assets || []).filter((a) => !isVideoAsset(a) && !isAudioAsset(a));

  let html = '<div class="prop-toolbar"><span class="empty-hint" style="padding:0">' +
    (isChar ? '角色定妆照与参考图会注入分镜提示词,保证形象一致。' : '场景参考图会注入分镜提示词,保证空间光线一致。') +
    (state.noCharPatch ? ' · 后端暂不支持在线修改(描述为只读)' : '') +
    '</span></div>';

  if (!list.length) {
    html += '<div class="panel db-empty">' + esc(emptyHint) + '</div>';
    el.innerHTML = html;
    return;
  }

  html += '<div class="entity-grid">' + list.map((c) => {
    const cid = c.character_id || c.id;
    const working = state.portraitWorking.has(cid);
    const img = c.asset_id
      ? '<img src="/assets/' + encodeURIComponent(c.asset_id) + '/file" loading="lazy" alt="' + esc(c.name) + '">'
      : '<div class="entity-img-placeholder"><span class="ph-icon">' + (isChar ? '🎭' : '🏞') + '</span><span>暂无' + (isChar ? '定妆照' : '场景图') + '</span></div>';
    const refOptions = ['<option value="">参考图:未关联</option>'].concat(
      imageAssets.map((a) => {
        const aid = a.asset_id || a.id;
        return '<option value="' + esc(aid) + '"' + (c.asset_id === aid ? ' selected' : '') + '>' + esc(assetName(a)) + '</option>';
      })).join('');
    return '<div class="panel entity-card" data-id="' + esc(cid) + '">' +
      '<div class="entity-img-wrap">' + img +
        (working ? '<div class="entity-working"><span class="spinner"></span>生成中…</div>' : '') +
      '</div>' +
      '<div class="entity-body">' +
        '<div class="entity-name">' + esc(c.name || cid) + '</div>' +
        '<textarea class="entity-desc" rows="3" data-id="' + esc(cid) + '"' + (state.noCharPatch ? ' readonly' : '') +
          ' placeholder="外观 / 氛围描述">' + esc(c.description || '') + '</textarea>' +
        '<div class="entity-ref-row"><select class="field entity-ref-select" data-id="' + esc(cid) + '">' + refOptions + '</select></div>' +
        '<div class="entity-actions">' +
          '<button class="btn btn-projector btn-small portrait-btn" data-id="' + esc(cid) + '"' + (working ? ' disabled' : '') + '>' +
            (working ? '生成中…' : (c.asset_id ? '重新生成' : '生成') + (isChar ? '定妆照' : '场景图')) + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('') + '</div>';
  el.innerHTML = html;

  el.querySelectorAll('.entity-desc').forEach((ta) => {
    ta.addEventListener('blur', () => saveCharDesc(ta.dataset.id, ta));
  });
  el.querySelectorAll('.entity-ref-select').forEach((sel) => {
    sel.addEventListener('change', () => setCharAsset(sel.dataset.id, sel.value, sel));
  });
  el.querySelectorAll('.portrait-btn').forEach((btn) => {
    btn.addEventListener('click', () => generatePortrait(btn.dataset.id));
  });
}

// 描述就地编辑:onBlur 保存;后端无 PATCH /characters 时转只读并提示
async function saveCharDesc(cid, ta) {
  const c = state.characters.find((x) => (x.character_id || x.id) === cid);
  const old = c ? (c.description || '') : '';
  if (ta.value === old) return;
  try {
    await api('/characters/' + encodeURIComponent(cid), { method: 'PATCH', json: { description: ta.value } });
    toast('描述已保存', 'ok');
    refreshQuiet();
  } catch (err) {
    state.noCharPatch = true;
    ta.value = old;
    toast('保存失败(后端可能未支持在线修改):' + err.message, 'err');
  }
}

// TODO: 后端暂无"单角色设置 asset_id"的专用接口,这里复用 PATCH /characters/{id};
// 若后端未实现该字段,仅提示失败,卡片上的下拉保持展示用途
async function setCharAsset(cid, assetId, sel) {
  if (!assetId) return;
  try {
    await api('/characters/' + encodeURIComponent(cid), { method: 'PATCH', json: { asset_id: assetId } });
    toast('参考图已关联', 'ok');
    refreshQuiet();
  } catch (err) {
    sel.value = '';
    toast('关联失败(后端可能未支持):' + err.message + ' — 可在「道具」步把素材分类为参考图', 'err');
  }
}

// 生成定妆照:单角色也走批量接口,轮询角色表直到 asset_id 出现
async function generatePortrait(cid) {
  const pid = state.currentProjectId;
  try {
    await api('/projects/' + encodeURIComponent(pid) + '/characters/portraits', {
      method: 'POST', json: { character_ids: [cid] },
    });
  } catch (err) {
    toast('生成请求失败:' + err.message, 'err');
    return;
  }
  state.portraitWorking.add(cid);
  renderStepContent();
  const started = Date.now();
  const timer = setInterval(async () => {
    if (state.currentProjectId !== pid || Date.now() - started > 120000) {
      clearInterval(timer);
      state.portraitTimers.delete(timer);
      state.portraitWorking.delete(cid);
      if (Date.now() - started > 120000) toast('生成超时,请稍后刷新查看', 'err');
      renderStepContent();
      return;
    }
    try {
      const res = await api('/projects/' + encodeURIComponent(pid) + '/characters');
      const fresh = (res.characters || []).find((x) => (x.character_id || x.id) === cid);
      if (fresh && fresh.asset_id) {
        clearInterval(timer);
        state.portraitTimers.delete(timer);
        state.portraitWorking.delete(cid);
        toast('图片已生成', 'ok');
        await refreshQuiet();
      }
    } catch (e) { /* 下次轮询再试 */ }
  }, 3000);
  state.portraitTimers.add(timer);
}

/* ---------- 第 4 步:道具(素材库 + 分类 + 上传) ---------- */
const PROP_PILLS = [
  { key: '__all', label: '全部', params: {} },
  { key: 'character', label: '角色参考', params: { category: 'character' } },
  { key: 'location', label: '场景参考', params: { category: 'location' } },
  { key: 'prop', label: '道具', params: { category: 'prop' } },
  { key: 'video', label: '视频', params: { media_type: 'video' } },
  { key: 'audio', label: '音频', params: { media_type: 'audio' } },
  { key: 'export', label: '成片', params: { category: 'export' } },
];

function renderPropStep(el) {
  el.innerHTML =
    '<div class="prop-toolbar">' +
      '<button id="prop-classify-btn" class="btn btn-projector btn-small">自动分类</button>' +
      '<button id="prop-upload-btn" class="btn btn-small">上传素材</button>' +
      '<input type="file" id="prop-file-input" multiple accept="image/*,video/*,audio/*" class="hidden">' +
      PROP_PILLS.map((p) =>
        '<button class="preset-pill prop-pill' + (state.propFilter === p.key ? ' active' : '') + '" data-key="' + p.key + '">' + p.label + '</button>'
      ).join('') +
    '</div>' +
    '<div id="prop-upload-status" class="empty-hint" style="padding:0 0 8px"></div>' +
    '<div id="prop-grid" class="asset-grid"><p class="empty-hint">加载中…</p></div>';

  el.querySelectorAll('.prop-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.propFilter = btn.dataset.key;
      el.querySelectorAll('.prop-pill').forEach((b) => b.classList.toggle('active', b === btn));
      loadPropAssets();
    });
  });
  $('#prop-classify-btn').addEventListener('click', classifyPropAssets);
  $('#prop-upload-btn').addEventListener('click', () => $('#prop-file-input').click());
  $('#prop-file-input').addEventListener('change', (e) => {
    if (e.target.files.length) uploadPropFiles(Array.from(e.target.files));
    e.target.value = '';
  });
  loadPropAssets();
}

async function loadPropAssets() {
  const grid = $('#prop-grid');
  if (!grid) return;
  const pill = PROP_PILLS.find((p) => p.key === state.propFilter) || PROP_PILLS[0];
  const params = ['project_id=' + encodeURIComponent(state.currentProjectId)];
  Object.entries(pill.params).forEach(([k, v]) => params.push(k + '=' + encodeURIComponent(v)));
  try {
    const res = await api('/assets?' + params.join('&'));
    renderPropGrid(res.assets || res || []);
  } catch (err) {
    grid.innerHTML = '<p class="empty-hint">加载素材失败:' + esc(err.message) + '</p>';
  }
}

function renderPropGrid(list) {
  const grid = $('#prop-grid');
  if (!grid) return;
  if (!list.length) {
    grid.innerHTML = '<p class="empty-hint">暂无素材 — 上传道具/参考素材,或点「自动分类」让 AI 整理现有素材。</p>';
    return;
  }
  grid.innerHTML = list.map((a) => {
    const id = a.asset_id || a.id;
    const name = assetName(a);
    const url = assetFileUrl(a);
    let media;
    if (isAudioAsset(a)) media = '<div class="asset-audio-thumb">♪</div>';
    else if (isVideoAsset(a)) media = '<video src="' + esc(url) + '" preload="metadata" muted></video>';
    else media = '<img src="' + esc(url) + '" loading="lazy" alt="' + esc(name) + '">';
    const catOptions = ['<option value="">未分类</option>'].concat(
      CATEGORIES.map((c) => '<option value="' + c + '"' + (a.category === c ? ' selected' : '') + '>' + CATEGORY_MAP[c] + '</option>')
    ).join('');
    const mt = a.media_type || (isVideoAsset(a) ? 'video' : isAudioAsset(a) ? 'audio' : 'image');
    return '<div class="asset-card">' + media +
      '<div class="asset-info"><div class="asset-name" title="' + esc(name) + '">' + esc(name) + '</div>' +
      '<div class="asset-sub">' + esc(mt) + ' · ' + esc(id) + '</div>' +
      '<div class="asset-cat-row"><select class="field prop-cat-select" data-id="' + esc(id) + '">' + catOptions + '</select></div>' +
      '</div></div>';
  }).join('');
  grid.querySelectorAll('.prop-cat-select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      try {
        await api('/assets/' + encodeURIComponent(sel.dataset.id) + '/category', {
          method: 'POST', json: { category: sel.value },
        });
        toast('分类已更新:' + categoryLabel(sel.value), 'ok');
        refreshQuiet();
      } catch (err) {
        toast('设置分类失败:' + err.message, 'err');
      }
    });
  });
}

async function classifyPropAssets() {
  const btn = $('#prop-classify-btn');
  btn.disabled = true;
  btn.textContent = '分类中…';
  try {
    const res = await api('/projects/' + encodeURIComponent(state.currentProjectId) + '/assets/classify', {
      method: 'POST', json: {},
    });
    const n = res.classified ? Object.keys(res.classified).length : 0;
    toast('自动分类完成:' + n + ' 个素材', 'ok');
    await refreshQuiet();
  } catch (err) {
    toast('自动分类失败:' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '自动分类';
  }
}

/* ---- 分块上传(沿用既有流程) ---- */
async function uploadPropFiles(files) {
  const status = $('#prop-upload-status');
  for (const file of files) {
    try {
      if (status) status.textContent = '上传中:' + file.name + ' (' + fmtBytes(file.size) + ')…';
      await uploadOneFile(file);
      toast('上传完成:' + file.name, 'ok');
    } catch (err) {
      toast('上传失败(' + file.name + '):' + err.message, 'err');
    }
  }
  if (status) status.textContent = '';
  refreshQuiet();
}

async function uploadOneFile(file) {
  const initRes = await api('/assets/uploads', {
    method: 'POST',
    json: { filename: file.name, total_size: file.size, project_id: state.currentProjectId },
  });
  const uploadId = initRes.upload_id;
  const chunkSize = initRes.chunk_size || (4 * 1024 * 1024);
  if (!uploadId) throw new Error('响应缺少 upload_id');
  const totalParts = Math.max(1, Math.ceil(file.size / chunkSize));
  const status = $('#prop-upload-status');
  for (let n = 1; n <= totalParts; n++) {
    const start = (n - 1) * chunkSize;
    const blob = file.slice(start, Math.min(start + chunkSize, file.size));
    const res = await fetch('/assets/uploads/' + encodeURIComponent(uploadId) + '/parts/' + n, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    });
    if (!res.ok) throw new Error('分块 ' + n + ' 上传失败:' + res.status);
    if (status) status.textContent = '上传中:' + file.name + ' · 分块 ' + n + '/' + totalParts;
  }
  await api('/assets/uploads/' + encodeURIComponent(uploadId) + '/complete', {
    method: 'POST',
    json: { project_id: state.currentProjectId },
  });
}

/* ---------- 第 5 步:分镜 ---------- */
function shotOrder(shot, idx) {
  const spec = shotSpec(shot);
  const o = shot.shot_order != null ? shot.shot_order : (shot.order != null ? shot.order : spec.order);
  return o != null ? Number(o) : idx + 1;
}

function renderStoryboardStep(el) {
  const scenes = getScenes();
  const shots = getShots();
  if (!shots.length) {
    el.innerHTML = '<div class="panel db-empty">还没有分镜 — 请先在「剧本」步完成规划。</div>';
    return;
  }

  // 按场景分组
  const groups = [];
  const byId = {};
  scenes.forEach((sc) => {
    const id = sc.scene_id || sc.id;
    const g = { id, title: sc.title || sc.name || ('场景 ' + id), shots: [] };
    byId[id] = g;
    groups.push(g);
  });
  const ungrouped = { id: '__none__', title: '未分组镜头', shots: [] };
  shots.forEach((shot) => {
    const sid = shot.scene_id || shotSpec(shot).scene_id;
    if (sid && byId[sid]) byId[sid].shots.push(shot);
    else ungrouped.shots.push(shot);
  });
  if (ungrouped.shots.length) groups.push(ungrouped);

  el.innerHTML = groups.map((g) => {
    const sorted = g.shots.slice().sort(shotOrder);
    return '<div class="sb-scene-block">' +
      '<div class="sb-scene-head"><h3>' + esc(g.title) + '</h3><span>' + sorted.length + ' 个镜头</span></div>' +
      sorted.map((shot, i) => renderShotCard(shot, i)).join('') +
    '</div>';
  }).join('');

  bindShotCardEvents(el);

  // 有 run 处于生成中时每 5 秒轮询
  const busy = getRuns().some((r) => RUN_STATES_BUSY.includes(runState(r)));
  if (busy) state.stepTimer = setInterval(refreshQuiet, 5000);
}

function renderShotCard(shot, idx) {
  const spec = shotSpec(shot);
  const sid = shotId(shot);
  const info = shotStatusInfo(sid);
  const draft = state.sbDrafts[sid] || {};
  const runs = getRuns().filter((r) => r.shot_id === sid)
    .sort((a, b) => (parseTime(a.created_at) || 0) - (parseTime(b.created_at) || 0));
  const needsReview = runs.some((r) => runState(r) === 'HUMAN_REVIEW');

  const refAssets = spec.reference_assets || shot.reference_assets || [];
  const characters = spec.characters || [];

  let html = '<div class="shot-card' + (needsReview ? ' needs-review' : '') + '" data-shot-id="' + esc(sid) + '">';
  if (needsReview) html += '<div class="review-banner">⚠ 有待审核的生成结果,请在下方 TAKE 中接受或拒绝</div>';
  html += '<div class="shot-head">' +
    '<span class="shot-badge">SHOT ' + String(shotOrder(shot, idx)).padStart(2, '0') + '</span>' +
    '<span class="status-badge ' + info.cls + '">' + info.label + '</span>' +
    '<span class="shot-dur-wrap">时长 <input type="number" class="shot-dur-input" data-shot-id="' + esc(sid) + '" min="1" value="' +
      esc(draft.duration_s != null ? draft.duration_s : (spec.duration_s || '')) + '"> s</span>' +
  '</div>';
  html += '<textarea class="shot-action" data-shot-id="' + esc(sid) + '" rows="3" placeholder="镜头动作 / 画面描述">' +
    esc(draft.action != null ? draft.action : (spec.action || '')) + '</textarea>';

  if (refAssets.length || characters.length) {
    html += '<div class="chip-row">';
    characters.forEach((c) => {
      const label = typeof c === 'object' ? (c.name || c.character_id || JSON.stringify(c)) : c;
      html += '<span class="chip char">' + esc(label) + '</span>';
    });
    refAssets.forEach((aid0) => {
      const aid = typeof aid0 === 'object' ? (aid0.asset_id || aid0.id) : aid0;
      html += '<span class="ref-chip"><img src="/assets/' + encodeURIComponent(aid) + '/file" loading="lazy" alt="ref">' +
        '<button class="ref-x" data-shot-id="' + esc(sid) + '" data-asset-id="' + esc(aid) + '" title="移除参考图">×</button></span>';
    });
    html += '</div>';
  }

  html += '<div class="shot-actions-row">' +
    '<button class="btn btn-projector btn-small sb-gen-btn" data-shot-id="' + esc(sid) + '">生成</button>' +
    '<button class="btn btn-small sb-save-btn hidden" data-shot-id="' + esc(sid) + '">保存</button>' +
    '<span class="shot-dirty-hint sb-dirty-hint hidden" data-shot-id="' + esc(sid) + '">● 未保存</span>' +
  '</div>';

  // TAKE 版本条
  if (runs.length) {
    html += '<div class="take-strip"><div class="take-strip-label">TAKES · ' + runs.length + '</div>';
    runs.forEach((run, i) => {
      const rid = runId(run);
      const st = runState(run);
      const stInfo = (() => {
        if (st === 'ACCEPTED') return { cls: 'st-done', label: 'ACCEPTED' };
        if (st === 'HUMAN_REVIEW') return { cls: 'st-review', label: 'HUMAN_REVIEW' };
        if (st === 'FAILED' || st === 'CANCELLED') return { cls: 'st-fail', label: st };
        if (RUN_STATES_BUSY.includes(st)) return { cls: 'st-busy', label: st };
        return { cls: 'st-idle', label: st };
      })();
      const expanded = state.sbExpandRun === rid;
      const candidates = run.candidate_asset_ids || run.candidates || [];
      const firstCid = candidates.length ? (typeof candidates[0] === 'object' ? (candidates[0].asset_id || candidates[0].id) : candidates[0]) : null;
      html += '<div class="take-row' + (firstCid ? ' expandable' : '') + (expanded ? ' expanded' : '') + '" data-run-id="' + esc(rid) + '">' +
        '<span class="take-num">TAKE ' + String(i + 1).padStart(2, '0') + '</span>' +
        '<span class="status-badge ' + stInfo.cls + '">' + stInfo.label + '</span>' +
        '<span class="take-score">评分 ' + scoreAvg(run) + '</span>' +
        (RUN_STATES_BUSY.includes(st) ? '<span class="take-elapsed" data-elapsed-run="' + esc(rid) + '">计时…</span>' : '') +
        (firstCid ? '<span class="chip">' + (expanded ? '收起' : '播放') + '</span>' : '') +
        '<span style="flex:1"></span>' +
        '<button class="btn btn-small take-review-btn" data-decision="accept" data-run-id="' + esc(rid) + '">接受</button>' +
        '<button class="btn btn-small btn-danger take-review-btn" data-decision="reject" data-run-id="' + esc(rid) + '">拒绝</button>' +
      '</div>';
      if (expanded && firstCid) {
        html += '<div class="take-video"><video src="/assets/' + encodeURIComponent(firstCid) + '/file" controls autoplay preload="metadata"></video></div>';
      }
    });
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function bindShotCardEvents(el) {
  // 编辑草稿
  el.querySelectorAll('.shot-action').forEach((ta) => {
    ta.addEventListener('input', () => markShotDirty(ta.dataset.shotId, el));
  });
  el.querySelectorAll('.shot-dur-input').forEach((inp) => {
    inp.addEventListener('input', () => markShotDirty(inp.dataset.shotId, el));
  });
  // 保存
  el.querySelectorAll('.sb-save-btn').forEach((btn) => {
    btn.addEventListener('click', () => saveShot(btn.dataset.shotId, btn));
  });
  // 生成
  el.querySelectorAll('.sb-gen-btn').forEach((btn) => {
    btn.addEventListener('click', () => submitShotRun(btn.dataset.shotId, btn));
  });
  // 参考图移除
  el.querySelectorAll('.ref-x').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeShotReference(btn.dataset.shotId, btn.dataset.assetId);
    });
  });
  // TAKE 展开播放
  el.querySelectorAll('.take-row.expandable').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.take-review-btn')) return;
      const rid = row.dataset.runId;
      state.sbExpandRun = state.sbExpandRun === rid ? null : rid;
      renderStepContent();
    });
  });
  // TAKE 审核
  el.querySelectorAll('.take-review-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      submitRunReview(btn.dataset.runId, btn.dataset.decision);
    });
  });
}

function markShotDirty(sid, el) {
  const card = el.querySelector('.shot-card[data-shot-id="' + CSS.escape(sid) + '"]');
  if (!card) return;
  const draft = state.sbDrafts[sid] || {};
  draft.action = card.querySelector('.shot-action').value;
  const dur = card.querySelector('.shot-dur-input').value;
  draft.duration_s = dur === '' ? undefined : Number(dur);
  state.sbDrafts[sid] = draft;
  card.querySelector('.sb-save-btn').classList.remove('hidden');
  card.querySelector('.sb-dirty-hint').classList.remove('hidden');
}

async function saveShot(sid, btn) {
  const draft = state.sbDrafts[sid];
  if (!draft) return;
  btn.disabled = true;
  try {
    const body = {};
    if (draft.action !== undefined) body.action = draft.action;
    if (draft.duration_s !== undefined && !isNaN(draft.duration_s)) body.duration_s = draft.duration_s;
    await api('/shots/' + encodeURIComponent(sid), { method: 'PATCH', json: body });
    delete state.sbDrafts[sid];
    toast('镜头已保存', 'ok');
    refreshQuiet();
  } catch (err) {
    toast('保存失败:' + err.message, 'err');
    btn.disabled = false;
  }
}

async function submitShotRun(sid, btn) {
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    const res = await api('/shots/' + encodeURIComponent(sid) + '/runs', {
      method: 'POST', json: { command_id: newCommandId() },
    });
    toast('已提交生成,run_id: ' + (res.run_id || '?'), 'ok');
    refreshQuiet();
  } catch (err) {
    toast('提交生成失败:' + err.message, 'err');
    btn.disabled = false;
    btn.textContent = '生成';
  }
}

async function removeShotReference(sid, aid) {
  try {
    await api('/shots/' + encodeURIComponent(sid) + '/references/' + encodeURIComponent(aid), { method: 'DELETE' });
    toast('参考图已移除', 'ok');
    refreshQuiet();
  } catch (err) {
    toast('移除失败:' + err.message, 'err');
  }
}

async function submitRunReview(rid, decision) {
  try {
    await api('/runs/' + encodeURIComponent(rid) + '/review', { method: 'POST', json: { decision } });
    toast('审核已提交:' + decision, 'ok');
    refreshQuiet();
  } catch (err) {
    toast('审核提交失败:' + err.message, 'err');
  }
}

/* ---------- 第 6 步:剪辑 ---------- */
function acceptedShotsSorted() {
  const scenes = getScenes();
  const sceneOrder = {};
  scenes.forEach((sc, i) => { sceneOrder[sc.scene_id || sc.id] = i; });
  return getShots().filter((s) => !!s.accepted_run_id).sort((a, b) => {
    const sa = a.scene_id || shotSpec(a).scene_id || '';
    const sb = b.scene_id || shotSpec(b).scene_id || '';
    const oa = sceneOrder[sa] != null ? sceneOrder[sa] : 999;
    const ob = sceneOrder[sb] != null ? sceneOrder[sb] : 999;
    if (oa !== ob) return oa - ob;
    return shotOrder(a, 0) - shotOrder(b, 0);
  });
}

function acceptedVideoUrl(shot) {
  const run = getRuns().find((r) => runId(r) === shot.accepted_run_id);
  if (!run) return null;
  const candidates = run.candidate_asset_ids || run.candidates || [];
  if (!candidates.length) return null;
  const aid = typeof candidates[0] === 'object' ? (candidates[0].asset_id || candidates[0].id) : candidates[0];
  return '/assets/' + encodeURIComponent(aid) + '/file';
}

function renderEditStep(el) {
  const accepted = acceptedShotsSorted();
  const total = getShots().length;
  const missing = total - accepted.length;
  const exports = (state.assets || []).filter((a) => a.source === 'derived' && isVideoAsset(a));
  if (!accepted.some((s) => shotId(s) === state.editSelectedShotId)) {
    state.editSelectedShotId = accepted.length ? shotId(accepted[0]) : null;
  }
  const selected = accepted.find((s) => shotId(s) === state.editSelectedShotId);

  let html = '<div class="edit-layout"><div>' +
    '<div class="label" style="margin-bottom:8px">TIMELINE · 已验收 ' + accepted.length + '/' + total + '</div>' +
    '<div class="timeline">';
  if (!accepted.length) {
    html += '<div class="panel db-empty">还没有已验收的镜头 — 到「分镜」步生成并接受 TAKE。</div>';
  } else {
    html += accepted.map((shot) => {
      const sid = shotId(shot);
      const url = acceptedVideoUrl(shot);
      const dur = shotSpec(shot).duration_s;
      return '<div class="timeline-row' + (sid === state.editSelectedShotId ? ' selected' : '') + '" data-shot-id="' + esc(sid) + '">' +
        (url ? '<video src="' + esc(url) + '" preload="metadata" muted></video>' : '<div class="asset-audio-thumb" style="width:96px;height:60px;font-size:20px">🎬</div>') +
        '<div class="timeline-info"><div class="timeline-shot">' + esc(sid) + '</div>' +
        '<div class="timeline-meta">' + (dur ? esc(dur) + 's · ' : '') + '<span style="color:var(--ok)">已验收 ✓</span></div></div>' +
      '</div>';
    }).join('');
  }
  html += '</div></div>';

  // 右侧:PROGRAM MONITOR + 操作
  html += '<div class="panel monitor-panel">' +
    '<div class="monitor-head"><span>PROGRAM MONITOR</span><span>' + (selected ? esc(shotId(selected)) : 'NO SIGNAL') + '</span></div>' +
    '<div class="monitor-screen">' +
      (selected && acceptedVideoUrl(selected)
        ? '<video src="' + esc(acceptedVideoUrl(selected)) + '" controls preload="metadata"></video>'
        : '<div class="monitor-empty">' + (accepted.length ? '该镜头缺少已验收视频' : '时间线为空') + '</div>') +
    '</div>' +
    '<div class="edit-actions">' +
      '<button id="dr-review-btn" class="btn btn-small"' + (state.reviewing ? ' disabled' : '') + '>' +
        (state.reviewing ? '审核中…' : '导演审核') + '</button>' +
      '<button id="edit-export-btn" class="btn btn-projector"' + (missing > 0 || state.exporting ? ' disabled' : '') + '>' +
        (state.exporting ? '导出中…' : '导出成片(带字幕)') + '</button>' +
      (missing > 0 ? '<span class="edit-hint">还差 ' + missing + ' 镜未验收,全部验收后可导出</span>' : '') +
    '</div>' +
    '<div id="dr-report" class="dr-report"></div>' +
    '<div class="export-list"><div class="label" style="margin-top:14px">已导出成片(' + exports.length + ')</div>';
  if (exports.length) {
    html += exports.map((a) => {
      const id = a.asset_id || a.id;
      const name = assetName(a);
      const url = assetFileUrl(a);
      return '<div class="export-item"><video src="' + esc(url) + '" controls preload="metadata"></video>' +
        '<div class="export-meta"><span>' + esc(name) + '</span>' +
        '<a class="btn btn-small" href="' + esc(url) + '" download="' + esc(name) + '">下载</a></div></div>';
    }).join('');
  } else {
    html += '<p class="empty-hint">暂无成片</p>';
  }
  html += '</div></div></div>';
  el.innerHTML = html;

  el.querySelectorAll('.timeline-row').forEach((row) => {
    row.addEventListener('click', () => {
      state.editSelectedShotId = row.dataset.shotId;
      renderStepContent();
    });
  });
  $('#dr-review-btn').addEventListener('click', startDirectorReview);
  $('#edit-export-btn').addEventListener('click', exportFilm);
  if (state.directorReport) renderDirectorReport($('#dr-report'), state.directorReport);
}

async function startDirectorReview() {
  const pid = state.currentProjectId;
  state.reviewing = true;
  renderStepContent();
  try {
    await api('/projects/' + encodeURIComponent(pid) + '/director-review', { method: 'POST', json: {} });
  } catch (err) {
    state.reviewing = false;
    toast('发起审核失败:' + err.message, 'err');
    renderStepContent();
    return;
  }
  const started = Date.now();
  const timer = setInterval(async () => {
    if (state.currentProjectId !== pid || Date.now() - started > 120000) {
      clearInterval(timer);
      state.reviewing = false;
      if (Date.now() - started > 120000) toast('审核超时,请稍后手动刷新查看', 'err');
      renderStepContent();
      return;
    }
    try {
      const res = await fetch('/projects/' + encodeURIComponent(pid) + '/director-review');
      if (res.status === 404) return;
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      const report = await res.json();
      clearInterval(timer);
      state.reviewing = false;
      state.directorReport = report;
      toast('导演审核完成', 'ok');
      renderStepContent();
    } catch (e) { /* 下次轮询再试 */ }
  }, 3000);
}

function renderDirectorReport(box, report) {
  if (!box) return;
  const issues = report.issues || [];
  let html = '<div class="dr-report-head">';
  if (report.story_coherence != null && !isNaN(Number(report.story_coherence))) {
    html += '<span class="coherence-score">剧情连贯性 ' + Number(report.story_coherence).toFixed(2) + '</span>';
  }
  if (report.created_at) html += '<span class="empty-hint" style="padding:0">' + esc(report.created_at) + '</span>';
  html += '</div>';
  if (report.summary) html += '<p class="dr-summary">' + esc(report.summary) + '</p>';
  if (issues.length) {
    html += '<table class="issues-table"><thead><tr><th>镜头</th><th>类型</th><th>严重度</th><th>详情</th></tr></thead><tbody>' +
      issues.map((it) => {
        const sev = String(it.severity || 'info').toLowerCase();
        return '<tr><td>' + esc(it.shot_id || '-') + '</td>' +
          '<td>' + esc(ISSUE_TYPE_MAP[it.type] || it.type || '-') + '</td>' +
          '<td><span class="severity-pill sev-' + esc(sev) + '">' + esc(it.severity || '-') + '</span></td>' +
          '<td>' + esc(it.detail || '') + '</td></tr>';
      }).join('') + '</tbody></table>';
  } else {
    html += '<p class="empty-hint">未发现问题 ✓</p>';
  }
  box.innerHTML = html;
}

async function exportFilm() {
  state.exporting = true;
  renderStepContent();
  try {
    const res = await api('/projects/' + encodeURIComponent(state.currentProjectId) + '/export', {
      method: 'POST', json: { subtitles: true },
    });
    const asset = res.asset || {};
    const aid = asset.asset_id || res.export_id || '';
    toast('导出成功' + (aid ? ': ' + aid : ''), 'ok');
  } catch (err) {
    toast('导出失败:' + err.message, 'err');
  } finally {
    state.exporting = false;
    refreshQuiet();
  }
}

/* ---------- SSE 事件流(侧栏指示器 + 抽屉) ---------- */
function updateSSEIndicator() {
  const dot = $('#sse-dot');
  if (!dot) return;
  dot.className = 'sse-dot' + (state.sseStatus === 'on' ? ' on' : state.sseStatus === 'err' ? ' err' : '');
}

function connectSSE() {
  closeSSE();
  if (!state.currentProjectId) return;
  const url = '/projects/' + encodeURIComponent(state.currentProjectId) + '/events?seq=' + state.lastSeq;
  const es = new EventSource(url);
  state.es = es;

  es.onopen = () => {
    state.sseRetryDelay = 1000;
    state.sseStatus = 'on';
    updateSSEIndicator();
  };
  es.onmessage = (e) => {
    let evt;
    try { evt = JSON.parse(e.data); } catch (err) { return; }
    handleSSEEvent(evt);
  };
  es.onerror = () => {
    state.sseStatus = 'err';
    updateSSEIndicator();
    es.close();
    if (state.es === es) state.es = null;
    const delay = state.sseRetryDelay;
    state.sseRetryDelay = Math.min(state.sseRetryDelay * 2, 30000);
    state.sseRetryTimer = setTimeout(() => {
      if (state.currentProjectId && state.route.view === 'studio') connectSSE();
    }, delay);
  };
}

function closeSSE() {
  if (state.es) { state.es.close(); state.es = null; }
  if (state.sseRetryTimer) { clearTimeout(state.sseRetryTimer); state.sseRetryTimer = null; }
  state.sseStatus = 'off';
  $('#sse-drawer').classList.add('hidden');
}

function handleSSEEvent(evt) {
  if (evt.event_id) {
    if (state.seenEventIds.has(evt.event_id)) return;
    state.seenEventIds.add(evt.event_id);
    if (state.seenEventIds.size > 3000) {
      state.seenEventIds = new Set(Array.from(state.seenEventIds).slice(-1500));
    }
  }
  if (typeof evt.seq === 'number' && evt.seq > state.lastSeq) state.lastSeq = evt.seq;
  state.events.push(evt);
  if (state.events.length > 300) state.events = state.events.slice(-200);
  appendSSECard(evt);

  // 生成相关事件 → 静默刷新当前步
  const t = evt.type || evt.event_type || '';
  if (['step.completed', 'run.failed', 'quality.evaluated', 'artifact.created'].includes(t)) {
    refreshQuiet();
  }
}

function appendSSECard(evt) {
  const list = $('#sse-drawer-list');
  if (!list) return;
  const hint = list.querySelector('.empty-hint');
  if (hint) hint.remove();
  const t = evt.type || evt.event_type || 'unknown';
  const ts = evt.ts || evt.timestamp || '';
  const time = ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
    : new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const summary = evt.summary || evt.message || evt.action_summary || '';
  const card = document.createElement('div');
  card.className = 'sse-event';
  card.innerHTML = '<div class="sse-event-head"><span>' + esc(t) + '</span><span>' +
    (evt.seq != null ? '#' + esc(evt.seq) + ' · ' : '') + esc(time) + '</span></div>' +
    (summary ? '<div>' + esc(summary) + '</div>' : '');
  list.prepend(card);
}

$('#sse-drawer-close').addEventListener('click', () => $('#sse-drawer').classList.add('hidden'));

/* ---------- 生成中计时(每秒) ---------- */
setInterval(() => {
  $$('[data-elapsed-run]').forEach((el) => {
    const run = getRuns().find((r) => runId(r) === el.dataset.elapsedRun);
    if (!run) return;
    const started = parseTime(run.started_at) || parseTime(run.created_at);
    if (!started) { el.textContent = '执行中'; return; }
    el.textContent = '已耗时 ' + fmtElapsed(Date.now() - started);
  });
}, 1000);

/* ---------- 启动 ---------- */
if (!location.hash) location.hash = '#/';
render();
