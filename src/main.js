'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');

const db          = require('./db');
const scanEngine  = require('./scan-engine');
const mediaServer = require('./media-server');

let mainWindow = null;
let scanCancelled = false;

// ── 앱 초기화 ──────────────────────────────────────────────
app.whenReady().then(async () => {
  const userDataPath = app.getPath('userData');
  await db.init(userDataPath);

  const port = mediaServer.start(db.db(), 17099);
  console.log(`[Main] Media server on port ${port}`);

  createWindow();
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
    const id = db.upsertWork({
      folder_path: workInfo.folder_path,
      title:       workInfo.title,
      root_id:     rootId,
      cover_path:  workInfo.cover_path,
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

// 윈도우 컨트롤
ipcMain.on('win:minimize', () => mainWindow?.minimize());
ipcMain.on('win:maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('win:close',    () => mainWindow?.close());
