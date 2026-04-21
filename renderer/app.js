'use strict';
/* ─────────────────────────────────────────────
   Manga Library — Renderer
   ───────────────────────────────────────────── */

// ── 상태 ──────────────────────────────────────
const S = {
  page:       0,
  pageSize:   50,
  total:      0,
  search:     '',
  sort:       'date_added',
  order:      'DESC',
  view:       'grid',
  cardSize:   3,
  activeTags: [],
  roots:      [],
  allTags:    [],
  tagFilter:  '',
  currentWork:  null,
  currentWorks: [],
  selectMode:   false,
  selectedIds:  new Set(),
  contextWorkId: null,
  viewer: {
    files:   [],
    index:   0,
    workId:  null,
    title:   '',
    mode:    'fit',
  },
};

const CARD_SIZES = [110, 140, 170, 210, 260];
const THUMB_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const RENDER_CHUNK_SIZE = 120;
let thumbObserver = null;

function lazyThumb(className, src, alt = '') {
  return `<img class="${className} lazy-thumb" src="${THUMB_PLACEHOLDER}" data-src="${src}" alt="${esc(alt)}">`;
}

function observeLazyThumbs(root = document) {
  const imgs = [...root.querySelectorAll('img.lazy-thumb[data-src]')];
  if (!imgs.length) return;

  if (!('IntersectionObserver' in window)) {
    imgs.forEach(loadLazyThumb);
    return;
  }

  if (!thumbObserver) {
    thumbObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        loadLazyThumb(entry.target);
        thumbObserver.unobserve(entry.target);
      });
    }, { rootMargin: '360px 0px', threshold: 0.01 });
  }

  imgs.forEach(img => thumbObserver.observe(img));
}

function loadLazyThumb(img) {
  const src = img.dataset.src;
  if (!src) return;
  img.src = src;
  img.removeAttribute('data-src');
}

function setChunkedHtml(el, htmlItems) {
  if (thumbObserver) {
    el.querySelectorAll('img.lazy-thumb[data-src]').forEach(img => thumbObserver.unobserve(img));
  }

  if (!Array.isArray(htmlItems)) {
    el.innerHTML = htmlItems || '';
    observeLazyThumbs(el);
    return;
  }

  el.innerHTML = '';
  let index = 0;
  const append = () => {
    const chunk = htmlItems.slice(index, index + RENDER_CHUNK_SIZE).join('');
    el.insertAdjacentHTML('beforeend', chunk);
    observeLazyThumbs(el);
    index += RENDER_CHUNK_SIZE;
    if (index < htmlItems.length) requestAnimationFrame(append);
  };
  append();
}

// ── 경로 → URL 인코딩 (한글/특수문자 완전 대응) ──
// renderer에는 Node Buffer가 없으므로 TextEncoder로 UTF-8 바이트 → base64
function pathToFileUrl(filePath) {
  if (typeof filePath === 'string' && filePath.startsWith('zip://')) {
    return `http://127.0.0.1:17099/zip/${encodeURIComponent(filePath.slice('zip://'.length))}`;
  }
  const bytes = new TextEncoder().encode(filePath);
  let binary  = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary);
  return `http://127.0.0.1:17099/file/${encodeURIComponent(b64)}`;
}

// ── 초기화 ─────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  document.addEventListener('keydown', onKey);
  document.addEventListener('click', closeWorkContextMenu);
  window.addEventListener('blur', closeWorkContextMenu);
  api.scan.onProgress(d => onScanProgress(d));
  api.updater.onStatus(d => renderUpdateStatus(d));
  await Promise.all([loadStats(), loadRoots(), loadTags()]);
  await loadGallery();
  loadServerInfo();
  loadUpdateStatus();
});

// ── 뷰 전환 ────────────────────────────────────
function showView(name, btn) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

// ── 통계 ───────────────────────────────────────
async function loadStats() {
  const s = await api.stats.get();
  document.getElementById('st-total').textContent = fmt(s.total);
  document.getElementById('st-read').textContent  = fmt(s.read_count);
  document.getElementById('st-avg').textContent   = s.avg_grade ? Number(s.avg_grade).toFixed(1) : '—';
}

// ── 루트 경로 ──────────────────────────────────
async function loadRoots() {
  S.roots = await api.roots.list();
  renderRootList();
  renderRootMini();
}

function renderRootList() {
  const el = document.getElementById('root-list');
  el.innerHTML = S.roots.map(r => `
    <div class="root-item">
      <div class="root-item-info">
        <div class="root-item-label">${esc(r.label || r.path)}</div>
        <div class="root-item-path">${esc(r.path)}</div>
      </div>
      <div class="root-item-acts">
        <button class="root-btn scan-btn" onclick="startScan(${r.id}, '${esc(r.label || r.path)}')">스캔</button>
        <button class="root-btn" onclick="openFolderById(${r.id}, 'root')">폴더열기</button>
        <button class="root-btn danger" onclick="removeRoot(${r.id})">삭제</button>
      </div>
    </div>
  `).join('');
}

function renderRootMini() {
  const el = document.getElementById('root-list-mini');
  el.innerHTML = S.roots.map(r => `
    <div class="root-mini-item">
      <div class="root-mini-dot"></div>
      <span title="${esc(r.path)}">${esc(r.label || r.path)}</span>
    </div>
  `).join('') || '<div style="font-size:11px;color:var(--tx3);padding:2px 0">루트 없음</div>';
}

async function pickFolder() {
  const paths = await api.dialog.folder();
  if (paths.length) document.getElementById('root-input').value = paths[0];
}

async function addRoot() {
  const folderPath = document.getElementById('root-input').value.trim();
  const label      = document.getElementById('root-label').value.trim();
  if (!folderPath) return alert('경로를 입력하세요');
  try {
    await api.roots.add(folderPath, label);
    document.getElementById('root-input').value = '';
    document.getElementById('root-label').value = '';
    await loadRoots();
    loadStats();
  } catch (e) { alert(e.message); }
}

async function removeRoot(id) {
  if (!confirm('이 루트 경로와 연관된 모든 작품 정보가 삭제됩니다. 계속할까요?')) return;
  await api.roots.remove(id);
  await loadRoots();
  await loadGallery();
  loadStats();
}

// 폴더 열기 — 경로 문자열 대신 ID로 전달해서 main에서 안전하게 처리
// type: 'work' | 'root'
function openFolderById(id, type) {
  api.shell.openFolder(id, type);
}

// ── 스캔 ───────────────────────────────────────
async function startScan(rootId, rootName) {
  const panel = document.getElementById('scan-panel');
  panel.style.display = 'block';
  document.getElementById('scan-root-name').textContent = rootName;
  document.getElementById('scan-status').textContent = '준비 중…';
  document.getElementById('scan-count').textContent = '';
  document.getElementById('scan-bar-fill').style.width = '5%';

  try {
    const result = await api.scan.start(rootId);
    document.getElementById('scan-bar-fill').style.width = '100%';
    document.getElementById('scan-status').textContent =
      result.cancelled ? '스캔이 중단됐습니다' : `완료! ${result.count}개 작품 발견`;
    await loadGallery();
    await loadStats();
    await loadTags();
  } catch (e) {
    document.getElementById('scan-status').textContent = '오류: ' + e.message;
  }
}

function onScanProgress(d) {
  document.getElementById('scan-status').textContent = d.message;
  document.getElementById('scan-count').textContent  = `${d.count}개 발견됨`;
}

function cancelScan() { api.scan.cancel(); }

// ── 태그 목록 ──────────────────────────────────
async function loadTags() {
  S.allTags = await api.tags.list();
  renderTagList();
}

function renderTagList() {
  const q  = S.tagFilter.toLowerCase();
  const el = document.getElementById('tag-list');
  const filtered = S.allTags.filter(t => !q || t.name.toLowerCase().includes(q));

  el.innerHTML = filtered.map(t => {
    const active = S.activeTags.includes(t.name);
    return `<div class="tag-item ${active ? 'active' : ''}" onclick="toggleTag('${esc(t.name)}')">
      <span class="tag-name">${esc(t.name)}</span>
      <span class="tag-count">${t.count}</span>
    </div>`;
  }).join('');

  document.getElementById('tag-clear-btn').style.display = S.activeTags.length ? '' : 'none';
}

function filterTagList(val) { S.tagFilter = val; renderTagList(); }

function toggleTag(name) {
  const i = S.activeTags.indexOf(name);
  if (i === -1) S.activeTags.push(name);
  else S.activeTags.splice(i, 1);
  S.page = 0;
  renderTagList();
  loadGallery();
}

function clearTagFilter() {
  S.activeTags = [];
  S.page = 0;
  renderTagList();
  loadGallery();
}

// ── 갤러리 ─────────────────────────────────────
async function loadGallery() {
  showLoading(true);

  const opts = {
    search:  S.search,
    tags:    S.activeTags,
    sort:    S.sort,
    order:   S.order,
    limit:   S.pageSize,
    offset:  S.page * S.pageSize,
  };

  const { works, total } = await api.works.list(opts);
  S.total = total;
  S.currentWorks = works;
  showLoading(false);

  if (!works.length && S.page === 0) {
    showEmpty(true);
    document.getElementById('info-text').textContent = '';
    document.getElementById('pager').innerHTML = '';
    return;
  }
  showEmpty(false);

  document.getElementById('info-text').textContent =
    `${fmt(total)}개 작품 / 페이지 ${S.page + 1} / ${Math.ceil(total / S.pageSize)}`;

  if (S.view === 'grid') renderGrid(works);
  else renderListView(works);
  renderPager();
}

function renderGrid(works) {
  const grid = document.getElementById('grid');
  const lv   = document.getElementById('list-view');
  grid.style.display = '';
  lv.style.display   = 'none';
  const w = CARD_SIZES[S.cardSize - 1];
  document.getElementById('grid').style.setProperty('--card-w', w + 'px');

  setChunkedHtml(grid, works.map(work => {
    const thumbUrl = work.cover_path ? `http://127.0.0.1:17099/thumb/${work.id}` : null;
    const sel      = S.selectedIds.has(work.id);
    const cls      = `card${S.selectMode ? ' selectable' : ''}${sel ? ' selected' : ''}`;
    const click    = S.selectMode ? `toggleSelectCard(${work.id})` : `openDetail(${work.id})`;
    return `<div class="${cls}" onclick="${click}" oncontextmenu="openWorkContextMenu(event, ${work.id})">
      ${S.selectMode ? `<div class="card-check">${sel ? '✓' : ''}</div>` : ''}
      ${work.is_read ? '<div class="card-read-badge">✓</div>' : ''}
      ${thumbUrl
        ? lazyThumb('card-thumb', thumbUrl, work.title)
        : `<div class="card-thumb-placeholder">📖</div>`}
      <div class="card-body">
        <div class="card-title">${esc(work.title)}</div>
        <div class="card-meta">
          <span class="card-pages">${work.page_count}p</span>
          ${work.grade > 0 ? `<span class="card-grade">★ ${Number(work.grade).toFixed(1)}</span>` : ''}
        </div>
      </div>
    </div>`;
  }));
}

function renderListView(works) {
  const grid = document.getElementById('grid');
  const lv   = document.getElementById('list-view');
  grid.style.display = 'none';
  lv.style.display   = '';

  setChunkedHtml(lv, works.map(work => {
    const thumbUrl = work.cover_path ? `http://127.0.0.1:17099/thumb/${work.id}` : null;
    const sel      = S.selectedIds.has(work.id);
    const cls      = `list-item${S.selectMode ? ' selectable' : ''}${sel ? ' selected' : ''}`;
    const click    = S.selectMode ? `toggleSelectCard(${work.id})` : `openDetail(${work.id})`;
    return `<div class="${cls}" onclick="${click}" oncontextmenu="openWorkContextMenu(event, ${work.id})">
      ${S.selectMode ? `<div class="list-check">${sel ? '✓' : ''}</div>` : ''}
      ${thumbUrl
        ? lazyThumb('list-thumb', thumbUrl)
        : `<div class="list-thumb" style="display:flex;align-items:center;justify-content:center;font-size:20px">📖</div>`}
      <div class="list-title">${esc(work.title)}</div>
      <div class="list-meta">${work.page_count}p${work.grade > 0 ? ` · ★${Number(work.grade).toFixed(1)}` : ''}</div>
    </div>`;
  }));
}

function renderPager() {
  const totalPages = Math.ceil(S.total / S.pageSize);
  if (totalPages <= 1) { document.getElementById('pager').innerHTML = ''; return; }

  const pages = [];
  const p     = S.page;
  pages.push(0);
  if (p > 2) pages.push('…');
  for (let i = Math.max(1, p - 1); i <= Math.min(totalPages - 2, p + 1); i++) pages.push(i);
  if (p < totalPages - 3) pages.push('…');
  if (totalPages > 1) pages.push(totalPages - 1);

  document.getElementById('pager').innerHTML = `
    <button class="page-btn" onclick="goPage(${p-1})" ${p===0?'disabled':''}>‹</button>
    ${pages.map(pg => pg==='…'
      ? `<span style="color:var(--tx3);padding:0 4px">…</span>`
      : `<button class="page-btn ${pg===p?'active':''}" onclick="goPage(${pg})">${pg+1}</button>`
    ).join('')}
    <button class="page-btn" onclick="goPage(${p+1})" ${p>=totalPages-1?'disabled':''}>›</button>
  `;
}

function goPage(p) {
  const total = Math.ceil(S.total / S.pageSize);
  if (p < 0 || p >= total) return;
  S.page = p;
  loadGallery();
  document.getElementById('grid-container').scrollTop = 0;
}

function showLoading(v) { document.getElementById('loading-state').style.display = v ? '' : 'none'; }
function showEmpty(v)   { document.getElementById('empty-state').style.display   = v ? '' : 'none'; }

// ── 검색 / 정렬 / 크기 ─────────────────────────
let _searchTimer = null;
function onSearch(val) {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => { S.search = val; S.page = 0; loadGallery(); }, 280);
}
function onSort(val) {
  const [sort, order] = val.split('|');
  S.sort = sort; S.order = order; S.page = 0; loadGallery();
}
function setGridView(v, btn) {
  S.view = v;
  document.querySelectorAll('.vt-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  loadGallery();
}
function onSizeChange(val) {
  S.cardSize = parseInt(val);
  if (S.view === 'grid') loadGallery();
}

// ── 작품 상세 모달 ─────────────────────────────
async function openDetail(id) {
  const work = await api.works.get(id);
  if (!work) return;
  S.currentWork = work;
  await api.works.incrementView(id);

  const overlay = document.getElementById('detail-overlay');
  const content = document.getElementById('detail-content');

  const thumbUrl = work.cover_path
    ? `http://127.0.0.1:17099/thumb/${id}`
    : null;

  const grade = work.grade || 0;
  const stars = [1,2,3,4,5].map(n =>
    `<button class="star-btn ${n <= grade ? 'lit' : ''}" onclick="setGrade(${id},${n})" data-n="${n}"
      onmouseover="hoverStars(${n})" onmouseout="resetStars(${grade})">★</button>`
  ).join('');

  const tagBadges = (work.tags || []).map(t =>
    `<span class="tag-badge">${esc(t.name)}<button onclick="removeTagFromWork(${id},'${esc(t.name)}')">×</button></span>`
  ).join('');

  // 이미지 스트립 — pathToFileUrl로 안전하게 인코딩
  const strip = (work.files.images || []).slice(0, 12).map((imgPath, i) =>
    `<img class="lazy-thumb" src="${THUMB_PLACEHOLDER}" data-src="${pathToFileUrl(imgPath)}"
      onclick="openViewer(${id}, ${i})" alt="p${i+1}">`
  ).join('');

  content.innerHTML = `
    <div class="d-cover-row">
      ${thumbUrl ? lazyThumb('d-cover', thumbUrl) : '<div class="d-cover"></div>'}
      <div class="d-info">
        <div class="d-title">${esc(work.title)}</div>
        <div class="d-meta-row">
          <span>📄 ${work.page_count}페이지${work.has_video ? ' + 영상' : ''}</span>
          <span>📁 <span class="d-path">${esc(work.folder_path)}</span></span>
          ${work.root_label ? `<span>🗂 ${esc(work.root_label)}</span>` : ''}
          <span>👁 ${work.view_count}회 조회</span>
        </div>
      </div>
    </div>
    <div class="d-section">
      <div class="d-section-title">평점</div>
      <div class="star-row" id="star-row">${stars}</div>
    </div>
    <div class="d-section">
      <div class="d-section-title">태그</div>
      <div class="tag-edit-row" id="tag-edit-row">
        ${tagBadges}
        <input type="text" class="tag-add-input" placeholder="태그 추가 후 Enter…"
          onkeydown="addTagToWork(event, ${id})">
      </div>
    </div>
    ${strip ? `<div class="d-section">
      <div class="d-section-title">미리보기 (${work.files.images.length}장)</div>
      <div class="d-strip">${strip}</div>
    </div>` : ''}
    <div class="d-actions">
      <button class="d-act-btn primary" onclick="openViewer(${id}, 0)">📖 읽기</button>
      <button class="d-act-btn" onclick="toggleRead(${id})">
        ${work.is_read ? '✓ 읽음 해제' : '읽음 표시'}
      </button>
      <button class="d-act-btn" onclick="openFolderById(${id}, 'work')">폴더 열기</button>
    </div>
  `;

  overlay.style.display = 'flex';
  observeLazyThumbs(content);
}

function closeDetail(e) {
  if (e.target === document.getElementById('detail-overlay')) closeDetailBtn();
}
function closeDetailBtn() {
  document.getElementById('detail-overlay').style.display = 'none';
  S.currentWork = null;
  loadStats();
  renderTagList();
}

async function setGrade(workId, grade) {
  await api.works.setGrade(workId, grade);
  document.querySelectorAll('#star-row .star-btn').forEach(b => {
    b.classList.toggle('lit', parseInt(b.dataset.n) <= grade);
  });
  loadGallery();
}
function hoverStars(n) {
  document.querySelectorAll('#star-row .star-btn').forEach(b => {
    b.classList.toggle('lit', parseInt(b.dataset.n) <= n);
  });
}
function resetStars(grade) {
  document.querySelectorAll('#star-row .star-btn').forEach(b => {
    b.classList.toggle('lit', parseInt(b.dataset.n) <= grade);
  });
}

async function toggleRead(workId) {
  const work = await api.works.get(workId);
  await api.works.markRead(workId, !work.is_read);
  openDetail(workId);
}

async function addTagToWork(event, workId) {
  if (event.key !== 'Enter') return;
  const input = event.target;
  const name  = input.value.trim();
  if (!name) return;
  const work  = await api.works.get(workId);
  const names = [...(work.tags || []).map(t => t.name), name];
  await api.tags.setForWork(workId, names);
  input.value = '';
  openDetail(workId);
  loadTags();
}

async function removeTagFromWork(workId, tagName) {
  const work  = await api.works.get(workId);
  const names = (work.tags || []).map(t => t.name).filter(n => n !== tagName);
  await api.tags.setForWork(workId, names);
  openDetail(workId);
  loadTags();
}

// ── 선택 모드 ──────────────────────────────────
function toggleSelectMode() {
  S.selectMode = !S.selectMode;
  if (!S.selectMode) S.selectedIds.clear();

  document.getElementById('select-bar').style.display = S.selectMode ? 'flex' : 'none';
  document.getElementById('sel-mode-btn').classList.toggle('active', S.selectMode);

  updateSelectBar();
  if (S.view === 'grid') renderGrid(S.currentWorks);
  else renderListView(S.currentWorks);
}

function exitSelectMode() {
  S.selectMode = false;
  S.selectedIds.clear();
  document.getElementById('select-bar').style.display = 'none';
  document.getElementById('sel-mode-btn').classList.remove('active');
  updateSelectBar();
  if (S.view === 'grid') renderGrid(S.currentWorks);
  else renderListView(S.currentWorks);
}

function toggleSelectCard(id) {
  if (S.selectedIds.has(id)) S.selectedIds.delete(id);
  else S.selectedIds.add(id);
  updateSelectBar();
  if (S.view === 'grid') renderGrid(S.currentWorks);
  else renderListView(S.currentWorks);
}

function selectAll() {
  S.currentWorks.forEach(w => S.selectedIds.add(w.id));
  updateSelectBar();
  if (S.view === 'grid') renderGrid(S.currentWorks);
  else renderListView(S.currentWorks);
}

function clearSelection() {
  S.selectedIds.clear();
  updateSelectBar();
  if (S.view === 'grid') renderGrid(S.currentWorks);
  else renderListView(S.currentWorks);
}

function updateSelectBar() {
  const count = S.selectedIds.size;
  document.getElementById('sel-count').textContent = `${count}개 선택됨`;
  const btn = document.getElementById('sel-del-btn');
  btn.disabled = count === 0;
  btn.textContent = count > 0 ? `삭제 (${count})` : '삭제';
}

async function deleteSelected() {
  await deleteWorks([...S.selectedIds]);
}

function openWorkContextMenu(event, workId) {
  event.preventDefault();
  event.stopPropagation();

  S.contextWorkId = workId;
  const menu = document.getElementById('context-menu');
  const btn = menu.querySelector('button');
  const selectedCount = S.selectedIds.has(workId) ? S.selectedIds.size : 0;
  btn.textContent = selectedCount > 1 ? `삭제 (${selectedCount})` : '삭제';

  menu.style.display = 'block';
  const rect = menu.getBoundingClientRect();
  const x = Math.min(event.clientX, window.innerWidth - rect.width - 8);
  const y = Math.min(event.clientY, window.innerHeight - rect.height - 8);
  menu.style.left = Math.max(8, x) + 'px';
  menu.style.top = Math.max(8, y) + 'px';
}

function closeWorkContextMenu() {
  const menu = document.getElementById('context-menu');
  if (menu) menu.style.display = 'none';
}

async function deleteContextWork() {
  const workId = S.contextWorkId;
  if (!workId) return;
  closeWorkContextMenu();
  const ids = S.selectedIds.has(workId) && S.selectedIds.size > 1
    ? [...S.selectedIds]
    : [workId];
  await deleteWorks(ids);
}

async function deleteWorks(ids) {
  ids = [...new Set((ids || []).filter(Boolean))];
  if (!ids.length) return;
  const label = ids.length === 1 ? '이 작품' : `선택한 ${ids.length}개 작품`;
  if (!confirm(`${label}을 라이브러리에서 삭제할까요?\n실제 파일은 삭제되지 않습니다.`)) return;

  await api.works.deleteMany(ids);
  ids.forEach(id => S.selectedIds.delete(id));
  S.selectMode = false;
  document.getElementById('select-bar').style.display = 'none';
  document.getElementById('sel-mode-btn').classList.remove('active');
  updateSelectBar();

  if (document.getElementById('view-artist').classList.contains('active')) await loadArtistView();
  else await loadGallery();
  await loadStats();
  await loadTags();
}

// ── 이미지 뷰어 ────────────────────────────────
function openViewer(workId, startIndex) {
  const work = S.currentWork;
  if (!work) return;

  const files = (work.files.images || []).map(p => ({
    url:  pathToFileUrl(p),
    path: p,
    type: 'image',
  }));
  for (const p of (work.files.videos || [])) {
    files.push({ url: pathToFileUrl(p), path: p, type: 'video' });
  }

  S.viewer.files  = files;
  S.viewer.index  = startIndex;
  S.viewer.workId = workId;
  S.viewer.title  = work.title;

  document.getElementById('viewer-overlay').style.display = 'flex';
  document.getElementById('viewer-title').textContent     = work.title;

  renderViewerStrip();
  showViewerPage(startIndex);
}

function closeViewer() {
  document.getElementById('viewer-overlay').style.display = 'none';
  const vid = document.getElementById('viewer-video');
  vid.pause(); vid.src = '';
  if (S.viewer.workId) api.works.setProgress(S.viewer.workId, S.viewer.index);
}

function showViewerPage(index) {
  const files = S.viewer.files;
  if (!files.length) return;
  index = Math.max(0, Math.min(index, files.length - 1));
  S.viewer.index = index;

  const file = files[index];
  const img  = document.getElementById('viewer-img');
  const vid  = document.getElementById('viewer-video');

  if (file.type === 'video') {
    img.style.display = 'none';
    vid.style.display = '';
    vid.src = file.url; vid.load();
  } else {
    vid.pause(); vid.src = ''; vid.style.display = 'none';
    img.style.display = '';
    img.classList.remove('zoomed');
    img.src = file.url;
  }

  document.getElementById('viewer-page-info').textContent = `${index + 1} / ${files.length}`;

  const pct = files.length > 1 ? (index / (files.length - 1)) * 100 : 0;
  document.getElementById('viewer-prog-fill').style.width = pct + '%';
  document.getElementById('viewer-prog-thumb').style.left  = pct + '%';

  document.querySelectorAll('#viewer-strip img').forEach((el, i) => {
    el.classList.toggle('active', i === index);
    if (i === index) el.scrollIntoView({ inline: 'center', behavior: 'smooth' });
  });
}

function viewerGo(delta) { showViewerPage(S.viewer.index + delta); }

function viewerJump(e) {
  const bar  = document.getElementById('viewer-prog-bar');
  const rect = bar.getBoundingClientRect();
  const idx  = Math.round((e.clientX - rect.left) / rect.width * (S.viewer.files.length - 1));
  showViewerPage(idx);
}

function toggleZoom() {
  document.getElementById('viewer-img').classList.toggle('zoomed');
}

function toggleViewerMode() {
  S.viewer.mode = S.viewer.mode === 'fit' ? 'width' : 'fit';
  const img = document.getElementById('viewer-img');
  img.style.maxWidth  = S.viewer.mode === 'width' ? '100%'  : '';
  img.style.maxHeight = S.viewer.mode === 'width' ? 'none'  : '';
}

function renderViewerStrip() {
  const strip = document.getElementById('viewer-strip');
  strip.innerHTML = S.viewer.files.map((f, i) =>
    `<img class="lazy-thumb" src="${THUMB_PLACEHOLDER}" data-src="${f.url}" onclick="showViewerPage(${i})" alt="p${i+1}">`
  ).join('');
  observeLazyThumbs(strip);
}

// ── 작가별 뷰 ──────────────────────────────────
// 드릴다운 상태: artist=null → 작가 목록, artist+series=null → 작가 상세, artist+series → 시리즈 상세
const A = {
  artist: null,
  series: null,
  search: '',
  sort: 'artist',
  order: 'ASC',
  cardSize: 3,
};
let _artistData = [];   // renderArtistCards에서 채워짐 (onclick 인덱스 참조용)
let _seriesData  = [];  // renderArtistDetail에서 채워짐

function openArtistView(btn) {
  showView('artist', btn);
  A.artist = null;
  A.series = null;
  loadArtistView();
}

async function loadArtistView() {
  const grid    = document.getElementById('artist-grid');
  const empty   = document.getElementById('artist-empty');
  const loading = document.getElementById('artist-loading');

  grid.innerHTML = '';
  empty.style.display   = 'none';
  loading.style.display = '';
  updateArtistBreadcrumb();

  try {
    if (!A.artist) {
      // ── 레벨 0: 전체 작가 목록 ──
      const artists = sortArtistRows(filterArtistRows(await api.works.listArtists(), 'artist'), 'artist');
      loading.style.display = 'none';
      if (!artists.length) { empty.style.display = ''; return; }
      renderArtistCards(artists);

    } else if (!A.series) {
      // ── 레벨 1: 작가의 시리즈 + 직접 작품 ──
      const [seriesList, directRes] = await Promise.all([
        api.works.listSeries(A.artist),
        api.works.list({ artist: A.artist, noSeries: true, search: A.search, limit: 500, sort: artistWorkSort(), order: A.order }),
      ]);
      loading.style.display = 'none';
      const filteredSeries = sortArtistRows(filterArtistRows(seriesList, 'series'), 'series');
      if (!filteredSeries.length && !directRes.works.length) { empty.style.display = ''; return; }
      renderArtistDetail(filteredSeries, directRes.works);

    } else {
      // ── 레벨 2: 시리즈 안의 작품들 ──
      const res = await api.works.list({ artist: A.artist, series: A.series, search: A.search, limit: 500, sort: artistWorkSort(), order: A.order });
      loading.style.display = 'none';
      if (!res.works.length) { empty.style.display = ''; return; }
      renderArtistWorks(res.works);
    }
  } catch (e) {
    loading.style.display = 'none';
    empty.style.display = '';
    document.getElementById('artist-empty-sub').textContent = '오류: ' + e.message;
    console.error('[ArtistView]', e);
  }
}

function artistNavTo(level) {
  if (level === 'root')   { A.artist = null; A.series = null; }
  else if (level === 'artist') { A.series = null; }
  loadArtistView();
}

let _artistSearchTimer = null;
function onArtistSearch(val) {
  clearTimeout(_artistSearchTimer);
  _artistSearchTimer = setTimeout(() => {
    A.search = val.trim();
    loadArtistView();
  }, 220);
}

function onArtistSort(val) {
  const [sort, order] = val.split('|');
  A.sort = sort;
  A.order = order;
  loadArtistView();
}

function onArtistSizeChange(val) {
  A.cardSize = Number(val) || 3;
  document.getElementById('artist-grid').style.setProperty('--card-w', CARD_SIZES[A.cardSize - 1] + 'px');
}

function artistWorkSort() {
  return ['title', 'date_added', 'grade', 'view_count', 'page_count'].includes(A.sort) ? A.sort : 'title';
}

function filterArtistRows(rows, key) {
  const q = A.search.toLowerCase();
  if (!q) return rows;
  return rows.filter(r => String(r[key] || '').toLowerCase().includes(q));
}

function sortArtistRows(rows, nameKey = 'artist') {
  const dir = A.order === 'DESC' ? -1 : 1;
  let key = A.sort === 'date_added' ? 'last_added' : A.sort;
  if (key === 'title' || key === 'artist' || key === 'series') key = nameKey;
  const textKey = key === 'artist' || key === 'series' || key === 'title';
  return [...rows].sort((a, b) => {
    const av = textKey ? String(a[key] || '').toLowerCase() : Number(a[key] || 0);
    const bv = textKey ? String(b[key] || '').toLowerCase() : Number(b[key] || 0);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return String(a.artist || a.series || a.title || '').localeCompare(String(b.artist || b.series || b.title || ''));
  });
}

// 인덱스 기반 클릭 핸들러 (onclick 속성에서 특수문자 탈출 불필요)
function _artistClick(idx) {
  A.artist = _artistData[idx].artist;
  A.series = null;
  loadArtistView();
}
function _seriesClick(idx) {
  A.series = _seriesData[idx].series;
  loadArtistView();
}

function renderArtistCards(artists) {
  _artistData = artists;
  const grid = document.getElementById('artist-grid');
  grid.style.setProperty('--card-w', CARD_SIZES[A.cardSize - 1] + 'px');
  setChunkedHtml(grid, artists.map((a, i) => {
    const thumb = a.sample_id ? `http://127.0.0.1:17099/thumb/${a.sample_id}` : null;
    return `<div class="card artist-card" onclick="_artistClick(${i})">
      ${thumb
        ? lazyThumb('card-thumb', thumb, a.artist)
        : `<div class="card-thumb-placeholder">🎨</div>`}
      <div class="card-body">
        <div class="card-title">${esc(a.artist)}</div>
        <div class="card-meta"><span class="card-pages">${a.work_count}작품</span></div>
      </div>
    </div>`;
  }));
}

function renderArtistDetail(seriesList, directWorks) {
  _seriesData = seriesList;
  const grid = document.getElementById('artist-grid');
  grid.style.setProperty('--card-w', CARD_SIZES[A.cardSize - 1] + 'px');

  const seriesHtml = seriesList.map((s, i) => {
    const thumb = s.sample_id ? `http://127.0.0.1:17099/thumb/${s.sample_id}` : null;
    return `<div class="card series-card" onclick="_seriesClick(${i})">
      <div class="series-badge">시리즈 ${s.work_count}</div>
      ${thumb
        ? lazyThumb('card-thumb', thumb, s.series)
        : `<div class="card-thumb-placeholder">📚</div>`}
      <div class="card-body">
        <div class="card-title">${esc(s.series)}</div>
        <div class="card-meta"><span class="card-pages">${s.work_count}편</span></div>
      </div>
    </div>`;
  });

  setChunkedHtml(grid, [...seriesHtml, ...directWorks.map(w => _workCard(w))]);
}

function renderArtistWorks(works) {
  const grid = document.getElementById('artist-grid');
  grid.style.setProperty('--card-w', CARD_SIZES[A.cardSize - 1] + 'px');
  setChunkedHtml(grid, works.map(w => _workCard(w)));
}

function _workCard(work) {
  const thumb = work.cover_path ? `http://127.0.0.1:17099/thumb/${work.id}` : null;
  return `<div class="card" onclick="openDetail(${work.id})" oncontextmenu="openWorkContextMenu(event, ${work.id})">
    ${work.is_read ? '<div class="card-read-badge">✓</div>' : ''}
    ${thumb
      ? lazyThumb('card-thumb', thumb, work.title)
      : `<div class="card-thumb-placeholder">📖</div>`}
    <div class="card-body">
      <div class="card-title">${esc(work.title)}</div>
      <div class="card-meta">
        <span class="card-pages">${work.page_count}p</span>
        ${work.grade > 0 ? `<span class="card-grade">★ ${Number(work.grade).toFixed(1)}</span>` : ''}
      </div>
    </div>
  </div>`;
}

function updateArtistBreadcrumb() {
  const bcRoot      = document.getElementById('bc-root');
  const bcSep1      = document.getElementById('bc-sep1');
  const bcArtistBtn = document.getElementById('bc-artist-btn');
  const bcSep2      = document.getElementById('bc-sep2');
  const bcSeriesLbl = document.getElementById('bc-series-lbl');

  if (!A.artist) {
    bcRoot.classList.add('bc-current');
    bcSep1.style.display = bcArtistBtn.style.display = bcSep2.style.display = bcSeriesLbl.style.display = 'none';
  } else if (!A.series) {
    bcRoot.classList.remove('bc-current');
    bcSep1.style.display = '';
    bcArtistBtn.style.display = '';
    bcArtistBtn.textContent = A.artist;
    bcArtistBtn.classList.add('bc-current');
    bcSep2.style.display = bcSeriesLbl.style.display = 'none';
  } else {
    bcRoot.classList.remove('bc-current');
    bcSep1.style.display = '';
    bcArtistBtn.style.display = '';
    bcArtistBtn.textContent = A.artist;
    bcArtistBtn.classList.remove('bc-current');
    bcSep2.style.display = '';
    bcSeriesLbl.style.display = '';
    bcSeriesLbl.textContent = A.series;
  }
}

// ── 서버 정보 ──────────────────────────────────
async function loadServerInfo() {
  const info = await api.server.info();
  const el   = document.getElementById('server-info');
  const mobileUrls = info.networkUrls || [];
  const primaryMobileUrl = info.mobileUrl || mobileUrls[0] || '';
  const extensionApiUrl = primaryMobileUrl ? `${primaryMobileUrl}/mihon` : '';

  el.innerHTML = `<div class="si-row">
    <div class="si-item si-mobile">
      <div class="si-label">Manga Library 전용 Mihon 확장 서버 주소</div>
      ${extensionApiUrl ? `
      <div class="si-url-row">
        <div class="si-url si-url-main" id="si-mobile">${extensionApiUrl}</div>
        <button class="si-copy primary" onclick="copyText('${extensionApiUrl}')">복사</button>
      </div>
      <div class="si-help">전용 확장에서 이 주소를 기본 서버로 사용합니다. PC와 휴대폰은 같은 Wi-Fi에 있어야 합니다.</div>
      ` : `
      <div class="si-warning">사용 가능한 네트워크 IP를 찾지 못했습니다. Wi-Fi 또는 방화벽 설정을 확인하세요.</div>
      `}
    </div>
    <div class="si-item">
      <div class="si-label">이 PC에서 접속하는 주소</div>
      <div class="si-url-row">
        <div class="si-url" id="si-local">${info.localUrl}</div>
        <button class="si-copy" onclick="copyText('${info.localUrl}')">복사</button>
      </div>
    </div>
    <div class="si-item">
      <div class="si-label">다른 네트워크 주소 후보</div>
      ${mobileUrls.map(a => `
      <div class="si-url-row" style="margin-top:6px">
        <div class="si-url">${a}/mihon</div>
        <button class="si-copy" onclick="copyText('${a}/mihon')">복사</button>
      </div>`).join('')}
      ${mobileUrls.length ? '' : '<div class="si-help">네트워크 주소가 없습니다.</div>'}
    </div>
    <details class="legacy-api">
      <summary>레거시 API 주소 보기</summary>
      <div class="si-item">
        <div class="si-label">Komga 호환 API (비권장)</div>
        <div class="si-url-row">
          <div class="si-url">${primaryMobileUrl || info.localUrl}</div>
          <button class="si-copy" onclick="copyText('${primaryMobileUrl || info.localUrl}')">복사</button>
        </div>
      </div>
      <div class="si-item">
        <div class="si-label">OPDS URL</div>
        <div class="si-url-row">
          <div class="si-url" id="si-opds">${info.mobileOpdsUrl || info.opdsUrl}</div>
          <button class="si-copy" onclick="copyText('${info.mobileOpdsUrl || info.opdsUrl}')">복사</button>
        </div>
      </div>
    </details>
    <div class="si-item">
      <div class="si-label">이 PC의 IP 주소</div>
      <div class="si-addrs">
        ${info.addresses.map(a => `<span class="si-addr-chip">${a}</span>`).join('') 
          || '<span style="font-size:12px;color:var(--tx3)">IP 없음</span>'}
      </div>
    </div>
  </div>`;
}

function copyText(text) {
  navigator.clipboard.writeText(text).catch(() => {});
}

async function loadUpdateStatus() {
  try {
    renderUpdateStatus(await api.updater.status());
  } catch {}
}

async function checkUpdateNow() {
  renderUpdateStatus({ message: '업데이트 확인 중...' });
  try {
    renderUpdateStatus(await api.updater.check());
  } catch (e) {
    renderUpdateStatus({ state: 'error', message: '업데이트 확인 실패: ' + e.message });
  }
}

function renderUpdateStatus(status) {
  const el = document.getElementById('update-status');
  if (!el || !status) return;
  el.textContent = status.message || '업데이트 확인 대기 중';
  el.dataset.state = status.state || 'idle';
}

// ── 키보드 단축키 ──────────────────────────────
function onKey(e) {
  if (document.getElementById('viewer-overlay').style.display !== 'none') {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); viewerGo(1); }
    if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   { e.preventDefault(); viewerGo(-1); }
    if (e.key === 'Escape') closeViewer();
    if (e.key === 'Home')   showViewerPage(0);
    if (e.key === 'End')    showViewerPage(S.viewer.files.length - 1);
    return;
  }
  if (document.getElementById('detail-overlay').style.display !== 'none') {
    if (e.key === 'Escape') closeDetailBtn();
    return;
  }
  if (S.selectMode) {
    if (e.key === 'Escape') exitSelectMode();
    return;
  }
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
    e.preventDefault();
    const target = document.getElementById('view-artist').classList.contains('active')
      ? document.getElementById('artist-search')
      : document.getElementById('search');
    target.focus();
  }
}

// ── 유틸 ───────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmt(n) { return Number(n).toLocaleString('ko-KR'); }
