'use strict';
const fs   = require('fs');
const path = require('path');

const IMAGE_EXT = new Set(['.jpg','.jpeg','.png','.gif','.webp','.avif','.bmp','.tiff','.tif']);
const VIDEO_EXT = new Set(['.mp4','.mkv','.avi','.mov','.wmv','.m4v','.flv','.webm','.ts','.m2ts']);
const IGNORED_INTERMEDIATE_FILES = new Set(['cover.jpg']);

function isImage(file) { return IMAGE_EXT.has(path.extname(file).toLowerCase()); }
function isVideo(file) { return VIDEO_EXT.has(path.extname(file).toLowerCase()); }
function isIgnoredIntermediateFile(file) { return IGNORED_INTERMEDIATE_FILES.has(path.basename(file).toLowerCase()); }

/**
 * 핵심 로직: 폴더를 재귀 탐색하면서
 * "이미지/영상 파일이 직접 들어있는 폴더"만 작품(leaf work)으로 판단.
 *
 * @param {string}   rootPath   - 탐색할 루트 경로
 * @param {Function} onWork     - 작품 발견 시 콜백 (workInfo 객체 전달)
 * @param {Function} onProgress - 진행 상황 콜백 (message 문자열)
 * @param {Function} isCancelled - true를 반환하면 스캔 중단
 */
async function scanRoot(rootPath, onWork, onProgress, isCancelled) {
  let workCount = 0;

  async function walk(dirPath) {
    if (isCancelled && isCancelled()) return;

    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return; // 권한 없음 등 - 스킵
    }

    // 현재 폴더의 파일 목록 분류
    const files   = entries.filter(e => e.isFile());
    const subdirs = entries.filter(e => e.isDirectory());

    const imageFiles = files.filter(e => isImage(e.name)).map(e => e.name).sort(naturalSort);
    const videoFiles = files.filter(e => isVideo(e.name)).map(e => e.name).sort(naturalSort);

    const hasDirectMedia = imageFiles.length > 0 || videoFiles.length > 0;

    if (hasDirectMedia) {
      const anySubHasMedia = subdirs.some(sub => hasMediaDescendant(path.join(dirPath, sub.name)));
      const directImages = anySubHasMedia ? imageFiles.filter(f => !isIgnoredIntermediateFile(f)) : imageFiles;
      const directVideos = videoFiles;
      const hasDirectWorkMedia = directImages.length > 0 || directVideos.length > 0;

      if (hasDirectWorkMedia) {
        workCount++;
        const allMedia  = [...directImages, ...directVideos];
        const coverFile = directImages[0] || directVideos[0] || imageFiles[0] || videoFiles[0];

        // 상대경로에서 '망가' 기준으로 작가/시리즈 추출
        // Case 1: 루트 자체가 '망가(X~Y)' 형태 → 첫 레벨이 작가
        // Case 2: 루트 하위에 '망가(X~Y)' 폴더 존재 → 그 다음 레벨이 작가
        // 예) 만화\망가(A~D)\Abi\작품        → artist=Abi, series=null
        //     만화\망가(T~Y)\TM\흑인...\H   → artist=TM, series=흑인...
        let artist = null, series = null;
        const rel   = path.relative(rootPath, dirPath);
        const parts = rel.split(path.sep).filter(Boolean);
        if (path.basename(rootPath).includes('망가')) {
          // Case 1: 루트가 망가 폴더 — parts[0]=작가, parts[1]=시리즈(3레벨 이상)
          artist = parts[0] || null;
          series = parts.length > 2 || (anySubHasMedia && parts.length > 1) ? parts[1] : null;
        } else {
          // Case 2: 상대경로 안에서 '망가' 폴더를 찾아 그 직후가 작가
          const mi = parts.findIndex(p => p.includes('망가'));
          if (mi >= 0 && mi + 1 < parts.length) {
            artist = parts[mi + 1];
            // 작가 기준으로 2레벨 이상 남아있으면 시리즈
            series = (parts.length - mi - 1) > 2 || (anySubHasMedia && mi + 2 < parts.length) ? parts[mi + 2] : null;
          }
        }

        const workInfo = {
          folder_path: dirPath,
          title:       path.basename(dirPath),
          cover_path:  coverFile ? path.join(dirPath, coverFile) : null,
          page_count:  directImages.length,
          has_video:   directVideos.length > 0 ? 1 : 0,
          image_files: directImages.map(f => path.join(dirPath, f)),
          video_files: directVideos.map(f => path.join(dirPath, f)),
          all_files:   allMedia.map(f => path.join(dirPath, f)),
          artist,
          series,
        };

        if (onProgress) onProgress(`스캔 중 (${workCount}): ${workInfo.title}`);
        if (onWork) await onWork(workInfo);
      }

      if (anySubHasMedia) {
        for (const sub of subdirs) {
          await walk(path.join(dirPath, sub.name));
        }
      }
    } else {
      // ── 분류 폴더 (작가, 장르 등) — 재귀 탐색 ──
      for (const sub of subdirs) {
        await walk(path.join(dirPath, sub.name));
      }
    }
  }

  await walk(rootPath);
  return workCount;
}

function hasMediaDescendant(folderPath) {
  let entries;
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.some(e => e.isFile() && (isImage(e.name) || isVideo(e.name)))) return true;
  return entries.some(e => e.isDirectory() && hasMediaDescendant(path.join(folderPath, e.name)));
}

/**
 * 자연 정렬 비교 함수 (001, 002, 010 순서 보장)
 */
function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * 특정 작품 폴더의 파일 목록을 다시 읽어 반환
 */
function getWorkFiles(folderPath) {
  let entries;
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch {
    return { images: [], videos: [], all: [] };
  }
  const hasChildMedia = entries
    .filter(e => e.isDirectory())
    .some(e => hasMediaDescendant(path.join(folderPath, e.name)));
  const files = entries.filter(e => e.isFile()).map(e => e.name);
  const imageNames = hasChildMedia ? files.filter(f => !isIgnoredIntermediateFile(f)) : files;
  const images = imageNames.filter(isImage).sort(naturalSort).map(f => path.join(folderPath, f));
  const videos = files.filter(isVideo).sort(naturalSort).map(f => path.join(folderPath, f));
  return { images, videos, all: [...images, ...videos] };
}

/**
 * 경로가 여전히 유효한 작품 폴더인지 확인
 */
function isValidWorkFolder(folderPath) {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    return entries.some(e => e.isFile() && (isImage(e.name) || isVideo(e.name)));
  } catch {
    return false;
  }
}

module.exports = { scanRoot, getWorkFiles, isValidWorkFolder, naturalSort, isImage, isVideo };
