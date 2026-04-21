'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const { autoUpdater } = require('electron-updater');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');

const db          = require('./db');
const scanEngine  = require('./scan-engine');
const mediaServer = require('./media-server');
const thumbs      = require('./main/thumbs/thumb-service');

let mainWindow = null;
let scanCancelled = false;
let updateStatus = {
  state: 'idle',
  message: '업데이트 확인 대기 중',
  version: app.getVersion(),
  percent: 0,
};

// ── 앱 초기화 ──────────────────────────────────────────────
app.whenReady().then(async () => {
  const userDataPath = app.getPath('userData');
  thumbs.init(path.join(userDataPath, 'data', 'thumbs'));
  await db.init(userDataPath);

  const port = mediaServer.start(db.db(), 17099);
  console.log(`[Main] Media server on port ${port}`);

  createWindow();
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  mediaServer.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1280,
    height: 800,
    minWidth:  900,
    minHeight: 600,
    backgroundColor: '#0f0f0f',
    titleBarStyle:   'hidden',
    titleBarOverlay: {
      color:        '#141414',
      symbolColor:  '#888',
      height:       32,
    },
    webPreferences: {
      preload:           path.join(__dirname, 'preload.js'),
      contextIsolation:  true,
      nodeIntegration:   false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (process.env.DEV) mainWindow.webContents.openDevTools();
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => setUpdateStatus('checking', '업데이트 확인 중...'));
  autoUpdater.on('update-available', info => {
    setUpdateStatus('available', `새 버전 ${info.version} 다운로드 중...`, info);
  });
  autoUpdater.on('update-not-available', () => setUpdateStatus('not-available', '현재 최신 버전입니다'));
  autoUpdater.on('download-progress', progress => {
    const percent = Math.round(progress.percent || 0);
    setUpdateStatus('downloading', `업데이트 다운로드 중... ${percent}%`, { percent });
  });
  autoUpdater.on('error', err => setUpdateStatus('error', `업데이트 오류: ${err.message}`));
  autoUpdater.on('update-downloaded', info => {
    setUpdateStatus('downloaded', `새 버전 ${info.version} 다운로드 완료`, info);
    promptInstallUpdate(info);
  });

  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => checkForUpdates(false), 2500);
  });
}

function setUpdateStatus(state, message, extra = {}) {
  updateStatus = {
    ...updateStatus,
    ...extra,
    state,
    message,
    version: app.getVersion(),
  };
  mainWindow?.webContents.send('updater:status', updateStatus);
}

async function checkForUpdates(manual = false) {
  if (!app.isPackaged && !process.env.FORCE_AUTO_UPDATE) {
    setUpdateStatus('disabled', '설치된 앱에서만 업데이트 확인이 활성화됩니다');
    return updateStatus;
  }

  try {
    setUpdateStatus('checking', '업데이트 확인 중...');
    await autoUpdater.checkForUpdates();
  } catch (err) {
    setUpdateStatus('error', `업데이트 확인 실패: ${err.message}`);
    if (manual) throw err;
  }
  return updateStatus;
}

async function promptInstallUpdate(info) {
  if (!mainWindow) return;
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['지금 재시작', '나중에'],
    defaultId: 0,
    cancelId: 1,
    title: '업데이트 준비 완료',
    message: `Manga Library ${info.version} 업데이트가 준비되었습니다.`,
    detail: '지금 재시작하면 새 버전으로 설치됩니다.',
  });
  if (result.response === 0) autoUpdater.quitAndInstall(false, true);
}

// ── IPC 핸들러 ─────────────────────────────────────────────

// 루트 경로 관리
ipcMain.handle('roots:list',   () => db.getRoots());
ipcMain.handle('roots:add',    (_, folderPath, label) => {
  if (!fs.existsSync(folderPath)) throw new Error('경로가 존재하지 않습니다: ' + folderPath);
  const id = db.addRoot(folderPath, label);
  return { id, path: folderPath, label: label || path.basename(folderPath) };
});
ipcMain.handle('roots:remove', (_, id) => { db.removeRoot(id); return true; });
ipcMain.handle('roots:rename', (_, id, label) => { db.updateRootLabel(id, label); return true; });

// 폴더 선택 다이얼로그
ipcMain.handle('dialog:folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'multiSelections'],
  });
  return result.canceled ? [] : result.filePaths;
});

// 스캔
ipcMain.handle('scan:start', async (event, rootId) => {
  const root = db.getRoots().find(r => r.id === rootId);
  if (!root) throw new Error('루트 경로를 찾을 수 없습니다');
  if (!fs.existsSync(root.path)) throw new Error('경로가 존재하지 않습니다: ' + root.path);

  scanCancelled = false;
  const foundPaths = [];

  const onWork = async (workInfo) => {
    const thumbPath = await thumbs.ensureThumbnail({
      ...workInfo,
      root_path: root.path,
      leaf_path: path.relative(root.path, workInfo.folder_path),
    });
    const id = db.upsertWork({
      folder_path: workInfo.folder_path,
      title:       workInfo.title,
      root_id:     rootId,
      cover_path:  workInfo.cover_path,
      thumb_path:  thumbPath,
      page_count:  workInfo.page_count,
      has_video:   workInfo.has_video,
      artist:      workInfo.artist,
      series:      workInfo.series,
    });
    foundPaths.push(workInfo.folder_path);
    event.sender.send('scan:progress', { message: workInfo.title, count: foundPaths.length });
  };

  const onProgress = (msg) => {
    event.sender.send('scan:progress', { message: msg, count: foundPaths.length });
  };

  const count = await scanEngine.scanRoot(root.path, onWork, onProgress, () => scanCancelled);

  // DB에서 이번 스캔에 없는 작품 삭제 (파일 삭제된 경우)
  if (!scanCancelled) db.deleteWorksNotInPaths(rootId, foundPaths);

  event.sender.send('scan:done', { count, cancelled: scanCancelled });
  return { count, cancelled: scanCancelled };
});

ipcMain.handle('scan:cancel', () => { scanCancelled = true; return true; });

// 작품 목록
ipcMain.handle('works:list', (_, opts) => {
  const works = db.getWorks(opts);
  const total = db.countWorks(opts);
  return { works, total };
});

ipcMain.handle('works:get', (_, id) => {
  const work = db.getWorkById(id);
  if (!work) return null;
  const tags     = db.getTagsForWork(id);
  const progress = db.getProgress(id);
  const files    = scanEngine.getWorkFiles(work.folder_path);
  return { ...work, tags, progress, files };
});

ipcMain.handle('works:setGrade', (_, id, grade) => { db.updateWorkGrade(id, grade); return true; });
ipcMain.handle('works:markRead', (_, id, isRead) => { db.markRead(id, isRead); return true; });
ipcMain.handle('works:incrementView', (_, id) => { db.incrementViewCount(id); return true; });
ipcMain.handle('works:setProgress', (_, id, page) => { db.setProgress(id, page); return true; });
ipcMain.handle('works:deleteMany',  (_, ids) => {
  if (!Array.isArray(ids) || !ids.length) return true;
  db.deleteWorksByIds(ids);
  return true;
});

// 태그
ipcMain.handle('tags:list',          ()              => db.getAllTags());
ipcMain.handle('tags:forWork',       (_, id)         => db.getTagsForWork(id));
ipcMain.handle('tags:setForWork',    (_, id, names)  => { db.setTagsForWork(id, names); return true; });
ipcMain.handle('tags:rename',        (_, old, n)     => { db.renameTag(old, n); return true; });
ipcMain.handle('tags:delete',        (_, name)       => { db.deleteTag(name); return true; });

// 작가별 탐색
ipcMain.handle('works:listArtists', (_, rootIds) => db.getArtists(rootIds || []));
ipcMain.handle('works:listSeries',  (_, artist, rootIds) => db.getSeriesForArtist(artist, rootIds || []));

// 통계
ipcMain.handle('stats:get',          ()              => db.getStats());

// 파일 열기 — id+type으로 받아서 DB에서 경로 조회 (특수문자 경로 문제 방지)
ipcMain.handle('shell:openFolder', (_, id, type) => {
  let folderPath = null;
  if (type === 'work') {
    const work = db.getWorkById(id);
    if (work) folderPath = work.folder_path;
  } else if (type === 'root') {
    const root = db.getRoots().find(r => r.id === id);
    if (root) folderPath = root.path;
  }
  if (folderPath) shell.openPath(folderPath);
  return true;
});

// 서버 정보
ipcMain.handle('server:info', () => {
  const interfaces = os.networkInterfaces();
  const addresses  = [];
  for (const iface of Object.values(interfaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) addresses.push(addr.address);
    }
  }
  const port = mediaServer.getPort();
  const networkUrls = addresses.map(a => `http://${a}:${port}`);
  return {
    port,
    addresses,
    networkUrls,
    localUrl:  `http://127.0.0.1:${port}`,
    komgaUrl:  `http://127.0.0.1:${port}`,
    opdsUrl:   `http://127.0.0.1:${port}/opds`,
    mobileUrl: networkUrls[0] || '',
    mobileOpdsUrl: networkUrls[0] ? `${networkUrls[0]}/opds` : '',
  };
});

// 업데이트
ipcMain.handle('updater:check', () => checkForUpdates(true));
ipcMain.handle('updater:status', () => updateStatus);

// 윈도우 컨트롤
ipcMain.on('win:minimize', () => mainWindow?.minimize());
ipcMain.on('win:maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('win:close',    () => mainWindow?.close());
