'use strict';
const http   = require('http');
const path   = require('path');
const fs     = require('fs');
const url    = require('url');
const crypto = require('crypto');

let _db         = null;
let _server     = null;
let _port       = 17099;
let _serverHost = '0.0.0.0'; // 로컬 네트워크에서 접근 가능하도록

// ── 서버 시작 ──────────────────────────────────────────────
function start(db, port = 17099) {
  _db   = db;
  _port = port;

  _server = http.createServer(handleRequest);
  _server.listen(_port, _serverHost, () => {
    console.log(`[MediaServer] Listening on http://0.0.0.0:${_port}`);
  });
  return _port;
}

function stop() {
  if (_server) { _server.close(); _server = null; }
}

// ── 라우터 ─────────────────────────────────────────────────
function handleRequest(req, res) {
  const parsed  = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS (Mihon이 다른 포트에서 요청 가능)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // ── 이미지 파일 직접 서빙 ──
    if (pathname.startsWith('/file/')) {
      return serveFile(req, res, pathname);
    }
    // ── 썸네일 ──
    if (pathname.startsWith('/thumb/')) {
      return serveThumbnail(req, res, parsed);
    }

    // ── Manga Library 전용 Mihon 확장 API ──
    if (pathname === '/mihon/health') return mihonHealth(req, res);
    if (pathname === '/mihon/artists') return mihonArtists(req, res, parsed.query);
    if (pathname === '/mihon/catalog') return mihonCatalog(req, res, parsed.query);
    if (pathname === '/mihon/latest') return mihonLatest(req, res, parsed.query);
    if (pathname.startsWith('/mihon/search')) return mihonSearch(req, res, parsed.query);
    if (pathname.match(/^\/mihon\/artist\/.+\/works$/)) return mihonArtistWorks(req, res, pathname);
    if (pathname.match(/^\/mihon\/artist\/.+$/)) return mihonArtist(req, res, pathname);
    if (pathname.match(/^\/mihon\/work\/\d+$/)) return mihonWork(req, res, pathname);
    if (pathname.match(/^\/mihon\/work\/\d+\/pages$/)) return mihonPages(req, res, pathname);
    if (pathname.match(/^\/mihon\/work\/\d+\/pages\/\d+\/raw$/)) return mihonPageRaw(req, res, pathname);

    // ── Mihon / Tachiyomi 호환 API (komga-like) ──────────────────
    // GET /api/v1/series            — 시리즈 목록
    if (pathname === '/api/v1/series') return apiSeries(req, res, parsed.query);
    // GET /api/v1/series/:id        — 시리즈 상세
    if (pathname.match(/^\/api\/v1\/series\/\d+$/)) return apiSeriesById(req, res, pathname);
    // GET /api/v1/series/:id/books  — 책(페이지) 목록
    if (pathname.match(/^\/api\/v1\/series\/\d+\/books$/)) return apiSeriesBooks(req, res, pathname);
    // GET /api/v1/books/:id/pages   — 페이지 목록
    if (pathname.match(/^\/api\/v1\/books\/\d+\/pages$/)) return apiBookPages(req, res, pathname);
    // GET /api/v1/books/:id/pages/:n/raw — 페이지 이미지
    if (pathname.match(/^\/api\/v1\/books\/\d+\/pages\/\d+\/raw$/)) return apiPageRaw(req, res, pathname);
    // GET /api/v1/series/:id/thumbnail
    if (pathname.match(/^\/api\/v1\/series\/\d+\/thumbnail$/)) return apiSeriesThumb(req, res, pathname);
    // GET /api/v1/libraries         — 라이브러리 목록 (루트 경로들)
    if (pathname === '/api/v1/libraries') return apiLibraries(req, res);

    // ── OPDS 피드 ────────────────────────────────────────────────
    if (pathname === '/opds' || pathname === '/opds/') return opdsRoot(req, res);
    if (pathname.startsWith('/opds/series/')) return opdsSeries(req, res, pathname);
    if (pathname.startsWith('/opds/book/'))   return opdsBook(req, res, pathname);
    if (pathname.startsWith('/opds/search'))  return opdsSearch(req, res, parsed.query);

    // ── 헬스 체크 ──
    if (pathname === '/health') {
      return jsonRes(res, { status: 'ok', port: _port });
    }

    res.writeHead(404); res.end('Not Found');
  } catch (err) {
    console.error('[MediaServer]', err);
    res.writeHead(500); res.end('Internal Server Error');
  }
}

// ── 파일 직접 서빙 ─────────────────────────────────────────
function serveFile(req, res, pathname) {
  // /file/<base64-encoded-path>
  const encoded = pathname.slice('/file/'.length);
  let filePath;
  try { filePath = Buffer.from(decodeURIComponent(encoded), 'base64').toString('utf8'); }
  catch { res.writeHead(400); res.end('Bad path'); return; }

  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }

  const ext  = path.extname(filePath).toLowerCase();
  const mime = getMime(ext);
  const stat = fs.statSync(filePath);

  // Range request 지원 (영상 스트리밍)
  const range = req.headers.range;
  if (range && isVideo(ext)) {
    const parts  = range.replace(/bytes=/, '').split('-');
    const start  = parseInt(parts[0], 10);
    const end    = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunk  = end - start + 1;
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': chunk,
      'Content-Type':   mime,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Cache-Control': 'max-age=86400' });
    fs.createReadStream(filePath).pipe(res);
  }
}

// ── 썸네일 서빙 ────────────────────────────────────────────
function serveThumbnail(req, res, parsed) {
  const workId = parseInt(
    typeof parsed === 'object' && parsed.pathname
      ? parsed.pathname.slice('/thumb/'.length)
      : String(parsed)
  );
  const work = _db.prepare('SELECT cover_path FROM works WHERE id = ?').get(workId);
  if (!work || !work.cover_path || !fs.existsSync(work.cover_path)) {
    res.writeHead(404); res.end(); return;
  }
  // sharp 없이 원본 이미지 그대로 서빙 (CSS object-fit으로 클라이언트에서 크롭)
  fallbackServe(res, work.cover_path);
}

function fallbackServe(res, filePath) {
  const mime = getMime(path.extname(filePath).toLowerCase());
  const stat = fs.statSync(filePath);
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Cache-Control': 'max-age=604800' });
  fs.createReadStream(filePath).pipe(res);
}

// ── Komga 호환 API ─────────────────────────────────────────
function apiLibraries(req, res) {
  const roots = _db.prepare('SELECT * FROM root_paths ORDER BY label').all();
  jsonRes(res, {
    content: roots.map(r => ({ id: String(r.id), name: r.label || r.path, root: r.path })),
    totalPages: 1, totalElements: roots.length, number: 0, size: roots.length,
  });
}

function apiSeries(req, res, query) {
  const page     = parseInt(query.page || '0');
  const size     = Math.min(parseInt(query.size || '50'), 200);
  const search   = query.search || '';
  const libraryId = query.library_id || '';

  const rootIds = libraryId ? [parseInt(libraryId)] : [];
  const works = _db.prepare(buildWorksSQL(search, rootIds, size, page * size)).all(
    ...(search ? [`%${search}%`] : []), ...rootIds, size, page * size
  );
  const total = _db.prepare(buildCountSQL(search, rootIds)).get(
    ...(search ? [`%${search}%`] : []), ...rootIds
  ).cnt;

  jsonRes(res, {
    content:       works.map(w => seriesDto(w)),
    totalPages:    Math.ceil(total / size),
    totalElements: total,
    number:        page,
    size,
  });
}

function apiSeriesById(req, res, pathname) {
  const id   = parseInt(pathname.split('/').pop());
  const work = _db.prepare('SELECT * FROM works WHERE id = ?').get(id);
  if (!work) { res.writeHead(404); res.end(); return; }
  jsonRes(res, seriesDto(work));
}

function apiSeriesBooks(req, res, pathname) {
  const id   = parseInt(pathname.split('/')[4]);
  const work = _db.prepare('SELECT * FROM works WHERE id = ?').get(id);
  if (!work) { res.writeHead(404); res.end(); return; }
  jsonRes(res, {
    content: [bookDto(work)],
    totalPages: 1, totalElements: 1, number: 0, size: 1,
  });
}

function apiBookPages(req, res, pathname) {
  const id   = parseInt(pathname.split('/')[4]);
  const work = _db.prepare('SELECT * FROM works WHERE id = ?').get(id);
  if (!work) { res.writeHead(404); res.end(); return; }

  const { getWorkFiles } = require('./scan-engine');
  const { images } = getWorkFiles(work.folder_path);

  jsonRes(res, images.map((imgPath, i) => ({
    number:    i + 1,
    fileName:  path.basename(imgPath),
    mediaType: getMime(path.extname(imgPath).toLowerCase()),
    url:       `/api/v1/books/${id}/pages/${i + 1}/raw`,
    width:     0, height: 0,
  })));
}

function apiPageRaw(req, res, pathname) {
  const parts  = pathname.split('/');
  const workId = parseInt(parts[4]);
  const pageNo = parseInt(parts[6]);
  const work   = _db.prepare('SELECT * FROM works WHERE id = ?').get(workId);
  if (!work) { res.writeHead(404); res.end(); return; }

  const { getWorkFiles } = require('./scan-engine');
  const { images } = getWorkFiles(work.folder_path);
  const imgPath = images[pageNo - 1];
  if (!imgPath || !fs.existsSync(imgPath)) { res.writeHead(404); res.end(); return; }

  const mime = getMime(path.extname(imgPath).toLowerCase());
  const stat = fs.statSync(imgPath);
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Cache-Control': 'max-age=86400' });
  fs.createReadStream(imgPath).pipe(res);
}

function apiSeriesThumb(req, res, pathname) {
  const id = parseInt(pathname.split('/')[4]);
  const work = _db.prepare('SELECT cover_path FROM works WHERE id = ?').get(id);
  if (!work || !work.cover_path || !fs.existsSync(work.cover_path)) {
    res.writeHead(404); res.end(); return;
  }
  fallbackServe(res, work.cover_path);
}

// ── Manga Library 전용 Mihon 확장 API ─────────────────────────
function mihonHealth(req, res) {
  jsonRes(res, {
    ok: true,
    name: 'Manga Library',
    version: 1,
    serverTime: new Date().toISOString(),
  });
}

function mihonCatalog(req, res, query) {
  return mihonArtists(req, res, query);
}

function mihonLatest(req, res, query) {
  return mihonWorkList(req, res, query, { search: '', sort: 'date_added', order: 'DESC' });
}

function mihonSearch(req, res, query) {
  return mihonArtists(req, res, { ...query, search: query.q || query.search || '' });
}

function mihonArtists(req, res, query) {
  const page = Math.max(0, parseInt(query.page || '0', 10) || 0);
  const size = Math.min(Math.max(1, parseInt(query.size || '50', 10) || 50), 100);
  const offset = page * size;
  const search = query.q || query.search || '';
  const params = [];
  const wheres = [`artist IS NOT NULL AND artist != ''`];
  if (search) {
    wheres.push('(artist LIKE ? OR title LIKE ? OR series LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const whereSql = wheres.join(' AND ');
  const artists = _db.prepare(
    `SELECT artist, COUNT(*) as work_count, MIN(id) as sample_id,
            MIN(cover_path) as cover_path, MAX(date_added) as last_added
       FROM works
      WHERE ${whereSql}
      GROUP BY artist
      ORDER BY artist
      LIMIT ? OFFSET ?`
  ).all(...params, size, offset);
  const total = _db.prepare(
    `SELECT COUNT(*) as cnt FROM (
       SELECT artist FROM works WHERE ${whereSql} GROUP BY artist
     )`
  ).get(...params).cnt;

  jsonRes(res, {
    page,
    size,
    total,
    hasNextPage: offset + artists.length < total,
    items: artists.map(a => mihonArtistDto(req, a)),
  });
}

function mihonArtist(req, res, pathname) {
  const artist = decodeURIComponent(pathname.slice('/mihon/artist/'.length));
  const row = _db.prepare(
    `SELECT artist, COUNT(*) as work_count, MIN(id) as sample_id,
            MIN(cover_path) as cover_path, MAX(date_added) as last_added
       FROM works
      WHERE artist = ?
      GROUP BY artist`
  ).get(artist);
  if (!row) { res.writeHead(404); res.end('Not found'); return; }

  jsonRes(res, {
    ...mihonArtistDto(req, row),
    description: `${row.work_count} works`,
    status: 'completed',
  });
}

function mihonArtistWorks(req, res, pathname) {
  const encoded = pathname.slice('/mihon/artist/'.length, -'/works'.length);
  const artist = decodeURIComponent(encoded);
  const works = _db.prepare(
    `SELECT * FROM works
      WHERE artist = ?
      ORDER BY COALESCE(series, ''), title`
  ).all(artist);

  jsonRes(res, {
    artist,
    total: works.length,
    items: works.map(w => mihonWorkDto(req, w)),
    chapters: works.map(w => mihonChapterDto(w)),
  });
}

function mihonWorkList(req, res, query, defaults) {
  const page = Math.max(0, parseInt(query.page || '0', 10) || 0);
  const size = Math.min(Math.max(1, parseInt(query.size || '50', 10) || 50), 100);
  const offset = page * size;
  const search = defaults.search || '';

  const works = _db.prepare(buildWorksSQL(search, [], size, offset)).all(
    ...(search ? [`%${search}%`] : []), size, offset
  );
  const total = _db.prepare(buildCountSQL(search, [])).get(
    ...(search ? [`%${search}%`] : [])
  ).cnt;

  jsonRes(res, {
    page,
    size,
    total,
    hasNextPage: offset + works.length < total,
    items: works.map(w => mihonWorkDto(req, w)),
  });
}

function mihonWork(req, res, pathname) {
  const id = parseInt(pathname.split('/')[3], 10);
  const work = _db.prepare('SELECT * FROM works WHERE id = ?').get(id);
  if (!work) { res.writeHead(404); res.end('Not found'); return; }

  const { getWorkFiles } = require('./scan-engine');
  const files = getWorkFiles(work.folder_path);
  jsonRes(res, {
    ...mihonWorkDto(req, work),
    description: work.folder_path,
    pageCount: files.images.length,
    videoCount: files.videos.length,
    status: 'completed',
  });
}

function mihonPages(req, res, pathname) {
  const id = parseInt(pathname.split('/')[3], 10);
  const work = _db.prepare('SELECT * FROM works WHERE id = ?').get(id);
  if (!work) { res.writeHead(404); res.end('Not found'); return; }

  const { getWorkFiles } = require('./scan-engine');
  const { images } = getWorkFiles(work.folder_path);
  jsonRes(res, {
    workId: String(id),
    pages: images.map((imgPath, i) => ({
      index: i,
      number: i + 1,
      fileName: path.basename(imgPath),
      imageUrl: `${origin(req)}/mihon/work/${id}/pages/${i + 1}/raw`,
      mediaType: getMime(path.extname(imgPath).toLowerCase()),
    })),
  });
}

function mihonPageRaw(req, res, pathname) {
  const parts = pathname.split('/');
  const workId = parseInt(parts[3], 10);
  const pageNo = parseInt(parts[5], 10);
  const work = _db.prepare('SELECT * FROM works WHERE id = ?').get(workId);
  if (!work) { res.writeHead(404); res.end('Not found'); return; }

  const { getWorkFiles } = require('./scan-engine');
  const { images } = getWorkFiles(work.folder_path);
  const imgPath = images[pageNo - 1];
  if (!imgPath || !fs.existsSync(imgPath)) { res.writeHead(404); res.end('Not found'); return; }

  const mime = getMime(path.extname(imgPath).toLowerCase());
  const stat = fs.statSync(imgPath);
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size, 'Cache-Control': 'max-age=86400' });
  fs.createReadStream(imgPath).pipe(res);
}

function mihonWorkDto(req, w) {
  const title = w.title || 'Untitled';
  return {
    id: String(w.id),
    kind: 'work',
    title,
    artist: w.artist || '',
    series: w.series || '',
    author: w.artist || '',
    thumbnailUrl: `${origin(req)}/thumb/${w.id}`,
    url: `/work/${w.id}`,
    detailUrl: `${origin(req)}/mihon/work/${w.id}`,
    pagesUrl: `${origin(req)}/mihon/work/${w.id}/pages`,
    pageCount: Number(w.page_count || 0),
    hasVideo: Number(w.has_video || 0) === 1,
    isRead: Number(w.is_read || 0) === 1,
    grade: Number(w.grade || 0),
    lastModified: toIso(w.date_scanned || w.date_added),
  };
}

// ── OPDS 피드 ──────────────────────────────────────────────
function mihonArtistDto(req, a) {
  const artist = a.artist || 'Unknown';
  const encoded = encodeURIComponent(artist);
  return {
    id: `artist:${artist}`,
    kind: 'artist',
    title: artist,
    artist,
    author: artist,
    series: '',
    thumbnailUrl: a.sample_id ? `${origin(req)}/thumb/${a.sample_id}` : '',
    url: `/artist/${encoded}`,
    detailUrl: `${origin(req)}/mihon/artist/${encoded}`,
    worksUrl: `${origin(req)}/mihon/artist/${encoded}/works`,
    pageCount: Number(a.work_count || 0),
    workCount: Number(a.work_count || 0),
    hasVideo: false,
    isRead: false,
    grade: 0,
    lastModified: toIso(a.last_added),
  };
}

function mihonChapterDto(w) {
  const title = w.title || 'Untitled';
  const series = w.series || '';
  const name = series && series !== title ? `${series} / ${title}` : title;
  return {
    id: String(w.id),
    name,
    url: `/work/${w.id}/pages`,
    chapterNumber: 1,
    dateUpload: toIso(w.date_scanned || w.date_added),
    pageCount: Number(w.page_count || 0),
  };
}

function opdsRoot(req, res) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:manga-library:root</id>
  <title>Manga Library</title>
  <updated>${new Date().toISOString()}</updated>
  <link rel="self" href="/opds/" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link rel="start" href="/opds/" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  <link rel="search" href="/opds/search?q={searchTerms}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
  <entry>
    <id>urn:manga-library:all</id>
    <title>전체 작품</title>
    <updated>${new Date().toISOString()}</updated>
    <content>모든 작품 목록</content>
    <link rel="subsection" href="/opds/series/" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
  </entry>
</feed>`;
  xmlRes(res, xml);
}

function opdsSeries(req, res, pathname) {
  const isDetail = pathname.match(/^\/opds\/series\/(\d+)$/);
  if (isDetail) {
    const work = _db.prepare('SELECT * FROM works WHERE id = ?').get(parseInt(isDetail[1]));
    if (!work) { res.writeHead(404); res.end(); return; }
    const { getWorkFiles } = require('./scan-engine');
    const { images } = getWorkFiles(work.folder_path);
    const entries = images.map((imgPath, i) => `
  <entry>
    <id>urn:manga-library:page:${work.id}:${i}</id>
    <title>Page ${i + 1}</title>
    <updated>${new Date().toISOString()}</updated>
    <link rel="http://opds-spec.org/image" href="${encodeFilePath(imgPath)}" type="${getMime(path.extname(imgPath).toLowerCase())}"/>
    <link rel="http://opds-spec.org/acquisition" href="${encodeFilePath(imgPath)}" type="${getMime(path.extname(imgPath).toLowerCase())}"/>
  </entry>`).join('');

    xmlRes(res, `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:manga-library:series:${work.id}</id>
  <title>${escXml(work.title)}</title>
  <updated>${new Date().toISOString()}</updated>${entries}
</feed>`);
    return;
  }

  // 목록
  const works = _db.prepare('SELECT * FROM works ORDER BY title LIMIT 500').all();
  const entries = works.map(w => `
  <entry>
    <id>urn:manga-library:series:${w.id}</id>
    <title>${escXml(w.title)}</title>
    <updated>${new Date().toISOString()}</updated>
    <link rel="subsection" href="/opds/series/${w.id}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
    <link rel="http://opds-spec.org/image" href="/thumb/${w.id}" type="image/webp"/>
    <link rel="http://opds-spec.org/image/thumbnail" href="/thumb/${w.id}?w=100" type="image/webp"/>
  </entry>`).join('');

  xmlRes(res, `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:manga-library:series</id>
  <title>전체 작품</title>
  <updated>${new Date().toISOString()}</updated>
  <link rel="self" href="/opds/series/" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
  ${entries}
</feed>`);
}

function opdsSearch(req, res, query) {
  const q = query.q || '';
  const works = _db.prepare('SELECT * FROM works WHERE title LIKE ? ORDER BY title LIMIT 100')
    .all(`%${q}%`);
  const entries = works.map(w => `
  <entry>
    <id>urn:manga-library:series:${w.id}</id>
    <title>${escXml(w.title)}</title>
    <updated>${new Date().toISOString()}</updated>
    <link rel="subsection" href="/opds/series/${w.id}" type="application/atom+xml;profile=opds-catalog;kind=acquisition"/>
    <link rel="http://opds-spec.org/image" href="/thumb/${w.id}" type="image/webp"/>
  </entry>`).join('');

  xmlRes(res, `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:manga-library:search</id><title>검색: ${escXml(q)}</title>
  <updated>${new Date().toISOString()}</updated>${entries}
</feed>`);
}

// ── 헬퍼 ───────────────────────────────────────────────────
function opdsBook(req, res, pathname) {
  const match = pathname.match(/^\/opds\/book\/(\d+)$/);
  if (!match) { res.writeHead(404); res.end(); return; }

  const work = _db.prepare('SELECT * FROM works WHERE id = ?').get(parseInt(match[1], 10));
  if (!work) { res.writeHead(404); res.end(); return; }

  return opdsSeries(req, res, `/opds/series/${work.id}`);
}

function seriesDto(w) {
  const title = w.title || 'Untitled';
  const created = toIso(w.date_added);
  const modified = toIso(w.date_scanned || w.date_added);
  return {
    id:            String(w.id),
    libraryId:     String(w.root_id),
    name:          title,
    url:           w.folder_path,
    booksCount:    1,
    booksReadCount: w.is_read ? 1 : 0,
    booksUnreadCount: w.is_read ? 0 : 1,
    booksInProgressCount: w.is_read ? 0 : 1,
    deleted:       false,
    metadata: {
      status:               'ENDED',
      statusLock:           false,
      title,
      titleLock:            false,
      titleSort:            title,
      titleSortLock:        false,
      summary:              '',
      summaryLock:          false,
      readingDirection:     'LEFT_TO_RIGHT',
      readingDirectionLock: false,
      publisher:            '',
      publisherLock:        false,
      ageRating:            null,
      ageRatingLock:        false,
      language:             'ko',
      languageLock:         false,
      genres:               [],
      genresLock:           false,
      tags:                 [],
      tagsLock:             false,
    },
    booksMetadata: {
      authors:              [],
      authorsLock:          false,
      tags:                 [],
      tagsLock:             false,
      releaseDate:          null,
      releaseDateLock:      false,
      summary:              '',
      summaryLock:          false,
      summaryNumber:        '1',
      summaryNumberLock:    false,
      number:               '1',
      numberLock:           false,
      numberSort:           1,
      numberSortLock:       false,
    },
    thumbnailUrl: `/thumb/${w.id}`,
    created,
    lastModified: modified,
    fileLastModified: modified,
  };
}

function bookDto(w) {
  const title = w.title || 'Untitled';
  const created = toIso(w.date_added);
  const modified = toIso(w.date_scanned || w.date_added);
  return {
    id:        String(w.id),
    seriesId:  String(w.id),
    name:      title,
    number:    '1',
    url:       w.folder_path,
    size:      '0',
    pagesCount: w.page_count,
    deleted:   false,
    media:     { status: 'READY', mediaType: 'application/zip', pagesCount: w.page_count },
    metadata:  {
      title,
      titleLock: false,
      summary: '',
      summaryLock: false,
      number: '1',
      numberLock: false,
      numberSort: 1,
      numberSortLock: false,
      releaseDate: null,
      releaseDateLock: false,
      authors: [],
      authorsLock: false,
      tags: [],
      tagsLock: false,
      isbn: '',
      isbnLock: false,
      links: [],
      linksLock: false,
      readingDirection: 'LEFT_TO_RIGHT',
      readingDirectionLock: false,
    },
    readProgress: { page: 0, completed: w.is_read === 1 },
    thumbnailUrl: `/thumb/${w.id}`,
    created,
    lastModified: modified,
    fileLastModified: modified,
  };
}

function toIso(seconds) {
  const n = Number(seconds);
  return new Date((Number.isFinite(n) && n > 0 ? n : Math.floor(Date.now() / 1000)) * 1000).toISOString();
}

function origin(req) {
  const host = req.headers.host || `127.0.0.1:${_port}`;
  return `http://${host}`;
}

function buildWorksSQL(search, rootIds, limit, offset) {
  const wheres = ['1=1'];
  if (search)        wheres.push('title LIKE ?');
  if (rootIds.length) wheres.push(`root_id IN (${rootIds.map(() => '?').join(',')})`);
  return `SELECT * FROM works WHERE ${wheres.join(' AND ')} ORDER BY title LIMIT ? OFFSET ?`;
}

function buildCountSQL(search, rootIds) {
  const wheres = ['1=1'];
  if (search)        wheres.push('title LIKE ?');
  if (rootIds.length) wheres.push(`root_id IN (${rootIds.map(() => '?').join(',')})`);
  return `SELECT COUNT(*) as cnt FROM works WHERE ${wheres.join(' AND ')}`;
}

function encodeFilePath(filePath) {
  return '/file/' + encodeURIComponent(Buffer.from(filePath, 'utf8').toString('base64'));
}

function getMime(ext) {
  const map = {
    '.jpg':'.jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif',
    '.webp':'image/webp','.avif':'image/avif','.bmp':'image/bmp',
    '.mp4':'video/mp4','.mkv':'video/x-matroska','.avi':'video/x-msvideo',
    '.mov':'video/quicktime','.webm':'video/webm','.m4v':'video/mp4',
  };
  return map[ext] || map[map[ext]] || 'application/octet-stream';
}

const VIDEO_EXTS = new Set(['.mp4','.mkv','.avi','.mov','.wmv','.m4v','.flv','.webm','.ts']);
function isVideo(ext) { return VIDEO_EXTS.has(ext); }

function jsonRes(res, data) {
  const body = JSON.stringify(data);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function xmlRes(res, xml) {
  res.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' });
  res.end(xml);
}

function escXml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function getPort() { return _port; }

module.exports = { start, stop, getPort, encodeFilePath };
