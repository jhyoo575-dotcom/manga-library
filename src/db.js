'use strict';
const path = require('path');
const fs   = require('fs');

let db        = null;
let _dbPath   = null;
let _saveTimer = null;

function init(userDataPath) {
  const initSqlJs = require('sql.js');
  _dbPath = path.join(userDataPath, 'library.db');

  const wasmPath = path.join(
    path.dirname(require.resolve('sql.js')),
    'sql-wasm.wasm'
  );

  return initSqlJs({ locateFile: () => wasmPath }).then(SQL => {
    if (fs.existsSync(_dbPath)) {
      const fileBuffer = fs.readFileSync(_dbPath);
      db = new SQL.Database(fileBuffer);
    } else {
      db = new SQL.Database();
    }
    _createSchema();
    scheduleSave();
    return db;
  });
}

function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      if (!db || !_dbPath) return;
      const data = db.export();
      fs.writeFileSync(_dbPath, Buffer.from(data));
    } catch (e) { console.error('[DB] save error:', e); }
  }, 200);
}

function _createSchema() {
  db.run('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS root_paths (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      path       TEXT    NOT NULL UNIQUE,
      label      TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS works (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_path  TEXT    NOT NULL UNIQUE,
      title        TEXT    NOT NULL,
      root_id      INTEGER REFERENCES root_paths(id) ON DELETE CASCADE,
      cover_path   TEXT,
      thumb_path   TEXT,
      page_count   INTEGER DEFAULT 0,
      has_video    INTEGER DEFAULT 0,
      date_added   INTEGER DEFAULT (strftime('%s','now')),
      date_scanned INTEGER DEFAULT (strftime('%s','now')),
      grade        REAL    DEFAULT 0,
      view_count   INTEGER DEFAULT 0,
      is_read      INTEGER DEFAULT 0,
      extra_json   TEXT    DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS tags (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS work_tags (
      work_id INTEGER REFERENCES works(id) ON DELETE CASCADE,
      tag_id  INTEGER REFERENCES tags(id)  ON DELETE CASCADE,
      PRIMARY KEY (work_id, tag_id)
    );
    CREATE TABLE IF NOT EXISTS read_progress (
      work_id    INTEGER PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
      last_page  INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_works_root    ON works(root_id);
    CREATE INDEX IF NOT EXISTS idx_works_title   ON works(title);
    CREATE INDEX IF NOT EXISTS idx_works_grade   ON works(grade);
    CREATE INDEX IF NOT EXISTS idx_works_added   ON works(date_added);
    CREATE INDEX IF NOT EXISTS idx_work_tags_wid ON work_tags(work_id);
    CREATE INDEX IF NOT EXISTS idx_work_tags_tid ON work_tags(tag_id);
  `);
  // 기존 DB 마이그레이션 — 컬럼이 이미 있으면 무시
  try { db.run('ALTER TABLE works ADD COLUMN artist TEXT'); } catch {}
  try { db.run('ALTER TABLE works ADD COLUMN series TEXT'); } catch {}
  try { db.run('ALTER TABLE works ADD COLUMN thumb_path TEXT'); } catch {}
}

function queryAll(sql, params) {
  const stmt = db.prepare(sql);
  if (params && params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(sql, params) {
  return queryAll(sql, params)[0] || null;
}

function run(sql, params) {
  db.run(sql, params || []);
  scheduleSave();
}

function lastId() {
  return queryOne('SELECT last_insert_rowid() as id').id;
}

// ── Root paths ─────────────────────────────────────────────
function getRoots() {
  return queryAll('SELECT * FROM root_paths ORDER BY label, path');
}
function addRoot(folderPath, label) {
  run('INSERT OR IGNORE INTO root_paths (path, label) VALUES (?, ?)',
    [folderPath, label || path.basename(folderPath)]);
  return queryOne('SELECT id FROM root_paths WHERE path = ?', [folderPath]).id;
}
function removeRoot(id) { run('DELETE FROM root_paths WHERE id = ?', [id]); }
function updateRootLabel(id, label) { run('UPDATE root_paths SET label = ? WHERE id = ?', [label, id]); }

// ── Works ──────────────────────────────────────────────────
function upsertWork(data) {
  const ex = queryOne('SELECT id FROM works WHERE folder_path = ?', [data.folder_path]);
  if (ex) {
    run(`UPDATE works SET title=?,cover_path=?,thumb_path=?,page_count=?,has_video=?,artist=?,series=?,date_scanned=strftime('%s','now') WHERE id=?`,
      [data.title, data.cover_path, data.thumb_path || null, data.page_count, data.has_video, data.artist||null, data.series||null, ex.id]);
    return ex.id;
  }
  run('INSERT INTO works (folder_path,title,root_id,cover_path,thumb_path,page_count,has_video,artist,series) VALUES (?,?,?,?,?,?,?,?,?)',
    [data.folder_path, data.title, data.root_id, data.cover_path, data.thumb_path || null, data.page_count, data.has_video, data.artist||null, data.series||null]);
  return lastId();
}

function deleteWorksNotInPaths(rootId, validPaths) {
  const validSet = new Set(validPaths);
  const rows = queryAll('SELECT id,folder_path FROM works WHERE root_id=?', [rootId]);
  for (const r of rows) {
    if (!validSet.has(r.folder_path)) run('DELETE FROM works WHERE id=?', [r.id]);
  }
}

function getWorks({ search='', tags=[], rootIds=[], sort='date_added', order='DESC',
                    limit=50, offset=0, minGrade=0, onlyUnread=false,
                    artist=null, series=null, noSeries=false } = {}) {
  const w=[]; const p=[];
  if (search)       { w.push('w.title LIKE ?'); p.push(`%${search}%`); }
  if (rootIds.length){ w.push(`w.root_id IN (${rootIds.map(()=>'?').join(',')})`); p.push(...rootIds); }
  if (minGrade>0)   { w.push('w.grade >= ?'); p.push(minGrade); }
  if (onlyUnread)   { w.push('w.is_read = 0'); }
  if (artist !== null)   { w.push('w.artist = ?'); p.push(artist); }
  if (noSeries)          { w.push('w.series IS NULL'); }
  else if (series !== null) { w.push('w.series = ?'); p.push(series); }

  let tj='';
  if (tags.length) {
    tj=`JOIN work_tags wt ON wt.work_id=w.id JOIN tags t ON t.id=wt.tag_id AND t.name IN (${tags.map(()=>'?').join(',')})`;
    p.push(...tags);
  }
  const sc = {title:'w.title',date_added:'w.date_added',grade:'w.grade',view_count:'w.view_count',page_count:'w.page_count'}[sort]||'w.date_added';
  const od = order==='ASC'?'ASC':'DESC';
  return queryAll(
    `SELECT w.*,rp.label as root_label,rp.path as root_path FROM works w LEFT JOIN root_paths rp ON rp.id=w.root_id ${tj} WHERE ${w.join(' AND ')||'1=1'} ${tags.length?`GROUP BY w.id HAVING COUNT(DISTINCT t.id)=${tags.length}`:''} ORDER BY ${sc} ${od} LIMIT ? OFFSET ?`,
    [...p, limit, offset]
  );
}

function countWorks({ search='', tags=[], rootIds=[], minGrade=0, onlyUnread=false,
                      artist=null, series=null, noSeries=false } = {}) {
  const w=[]; const p=[];
  if (search)       { w.push('w.title LIKE ?'); p.push(`%${search}%`); }
  if (rootIds.length){ w.push(`w.root_id IN (${rootIds.map(()=>'?').join(',')})`); p.push(...rootIds); }
  if (minGrade>0)   { w.push('w.grade >= ?'); p.push(minGrade); }
  if (onlyUnread)   { w.push('w.is_read = 0'); }
  if (artist !== null)   { w.push('w.artist = ?'); p.push(artist); }
  if (noSeries)          { w.push('w.series IS NULL'); }
  else if (series !== null) { w.push('w.series = ?'); p.push(series); }
  let tj='';
  if (tags.length) { tj=`JOIN work_tags wt ON wt.work_id=w.id JOIN tags t ON t.id=wt.tag_id AND t.name IN (${tags.map(()=>'?').join(',')})`; p.push(...tags); }
  const row = queryOne(`SELECT COUNT(${tags.length?'DISTINCT w.id':'*'}) as cnt FROM works w ${tj} WHERE ${w.join(' AND ')||'1=1'}`, p);
  return row ? Number(row.cnt) : 0;
}

function getArtists(rootIds = []) {
  const w = [`artist IS NOT NULL AND artist != ''`];
  const p = [];
  if (rootIds.length) {
    w.push(`root_id IN (${rootIds.map(() => '?').join(',')})`);
    p.push(...rootIds);
  }
  return queryAll(
    `SELECT artist, COUNT(*) as work_count, MIN(cover_path) as cover_path, MIN(id) as sample_id, MAX(date_added) as last_added
     FROM works WHERE ${w.join(' AND ')} GROUP BY artist ORDER BY artist`, p
  );
}

function getSeriesForArtist(artist, rootIds = []) {
  const w = [`artist = ?`, `series IS NOT NULL AND series != ''`];
  const p = [artist];
  if (rootIds.length) {
    w.push(`root_id IN (${rootIds.map(() => '?').join(',')})`);
    p.push(...rootIds);
  }
  return queryAll(
    `SELECT series, COUNT(*) as work_count, MIN(cover_path) as cover_path, MIN(id) as sample_id, MAX(date_added) as last_added
     FROM works WHERE ${w.join(' AND ')} GROUP BY series ORDER BY series`, p
  );
}

function getWorkById(id) {
  return queryOne('SELECT w.*,rp.label as root_label,rp.path as root_path FROM works w LEFT JOIN root_paths rp ON rp.id=w.root_id WHERE w.id=?', [id]);
}
function getWorkByPath(fp) { return queryOne('SELECT * FROM works WHERE folder_path=?',[fp]); }
function updateWorkGrade(id,g) { run('UPDATE works SET grade=? WHERE id=?',[g,id]); }
function markRead(id,v) { run('UPDATE works SET is_read=? WHERE id=?',[v?1:0,id]); }
function incrementViewCount(id) { run('UPDATE works SET view_count=view_count+1 WHERE id=?',[id]); }
function deleteWorksByIds(ids) {
  if (!ids || !ids.length) return;
  const ph = ids.map(() => '?').join(',');
  run(`DELETE FROM works WHERE id IN (${ph})`, ids);
}

// ── Tags ───────────────────────────────────────────────────
function getAllTags() {
  return queryAll('SELECT t.id,t.name,COUNT(wt.work_id) as count FROM tags t LEFT JOIN work_tags wt ON wt.tag_id=t.id GROUP BY t.id ORDER BY count DESC,t.name');
}
function getTagsForWork(wid) {
  return queryAll('SELECT t.id,t.name FROM tags t JOIN work_tags wt ON wt.tag_id=t.id WHERE wt.work_id=? ORDER BY t.name',[wid]);
}
function setTagsForWork(workId, tagNames) {
  run('DELETE FROM work_tags WHERE work_id=?',[workId]);
  for (const name of tagNames) {
    const n=name.trim(); if(!n) continue;
    run('INSERT OR IGNORE INTO tags (name) VALUES (?)',[n]);
    const t=queryOne('SELECT id FROM tags WHERE name=?',[n]);
    if(t) run('INSERT OR IGNORE INTO work_tags (work_id,tag_id) VALUES (?,?)',[workId,t.id]);
  }
}
function renameTag(oldN, newN) {
  const ex=queryOne('SELECT id FROM tags WHERE name=?',[newN]);
  const old=queryOne('SELECT id FROM tags WHERE name=?',[oldN]);
  if(!old) return;
  if(ex) {
    const wts=queryAll('SELECT work_id FROM work_tags WHERE tag_id=?',[old.id]);
    for(const r of wts) run('INSERT OR IGNORE INTO work_tags(work_id,tag_id) VALUES(?,?)',[r.work_id,ex.id]);
    run('DELETE FROM tags WHERE id=?',[old.id]);
  } else { run('UPDATE tags SET name=? WHERE id=?',[newN,old.id]); }
}
function deleteTag(n) { run('DELETE FROM tags WHERE name=?',[n]); }

// ── Progress ───────────────────────────────────────────────
function getProgress(wid) { return queryOne('SELECT * FROM read_progress WHERE work_id=?',[wid]); }
function setProgress(wid, page) {
  if(queryOne('SELECT work_id FROM read_progress WHERE work_id=?',[wid]))
    run(`UPDATE read_progress SET last_page=?,updated_at=strftime('%s','now') WHERE work_id=?`,[page,wid]);
  else run('INSERT INTO read_progress(work_id,last_page) VALUES(?,?)',[wid,page]);
}

// ── Stats ──────────────────────────────────────────────────
function getStats() {
  return queryOne(`SELECT
    (SELECT COUNT(*) FROM works) as total,
    (SELECT COUNT(*) FROM works WHERE grade>0) as rated,
    (SELECT AVG(grade) FROM works WHERE grade>0) as avg_grade,
    (SELECT COUNT(*) FROM works WHERE is_read=1) as read_count,
    (SELECT COUNT(*) FROM tags) as tag_count,
    (SELECT COUNT(*) FROM root_paths) as root_count`);
}

// media-server용 db() 래퍼
function db_compat() {
  return {
    prepare: (sql) => ({
      get:  (...args) => queryOne(sql, args.flat()),
      all:  (...args) => queryAll(sql, args.flat()),
    }),
    run: (sql, params) => run(sql, params),
  };
}

module.exports = {
  init, db: db_compat, queryOne, queryAll,
  getRoots, addRoot, removeRoot, updateRootLabel,
  upsertWork, deleteWorksNotInPaths, getWorks, countWorks,
  getArtists, getSeriesForArtist,
  getWorkById, getWorkByPath, updateWorkGrade, markRead, incrementViewCount, deleteWorksByIds,
  getAllTags, getTagsForWork, setTagsForWork, renameTag, deleteTag,
  getProgress, setProgress, getStats,
};
