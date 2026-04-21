'use strict';

const fs   = require('fs');
const path = require('path');
const {
  isZip,
  zipHasImages,
  encodeZipEntryPath,
  getZipImageEntries,
  isZipEntryPath,
  getMediaExt,
} = require('./zip-utils');

const IMAGE_EXT = new Set(['.jpg','.jpeg','.png','.gif','.webp','.avif','.bmp','.tiff','.tif']);
const VIDEO_EXT = new Set(['.mp4','.mkv','.avi','.mov','.wmv','.m4v','.flv','.webm','.ts','.m2ts']);
const IGNORED_INTERMEDIATE_FILES = new Set(['cover.jpg']);

function isImage(file) { return IMAGE_EXT.has(path.extname(file).toLowerCase()); }
function isVideo(file) { return VIDEO_EXT.has(path.extname(file).toLowerCase()); }
function isIgnoredIntermediateFile(file) { return IGNORED_INTERMEDIATE_FILES.has(path.basename(file).toLowerCase()); }

async function scanRoot(rootPath, onWork, onProgress, isCancelled) {
  let workCount = 0;

  async function emitWork(workInfo) {
    workCount++;
    if (onProgress) onProgress(`스캔 중 (${workCount}): ${workInfo.title}`);
    if (onWork) await onWork(workInfo);
  }

  async function walk(dirPath) {
    if (isCancelled && isCancelled()) return;

    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    const files   = entries.filter(e => e.isFile());
    const subdirs = entries.filter(e => e.isDirectory());

    const imageFiles = files.filter(e => isImage(e.name)).map(e => e.name).sort(naturalSort);
    const videoFiles = files.filter(e => isVideo(e.name)).map(e => e.name).sort(naturalSort);
    const zipFiles   = files.filter(e => isZip(e.name)).map(e => e.name).sort(naturalSort);

    for (const zipFile of zipFiles) {
      const zipPath = path.join(dirPath, zipFile);
      const mangaInfo = extractMangaInfo(rootPath, zipPath, false);
      if (!mangaInfo || mangaInfo.depth < 2) continue;

      const zipImages = getZipImageEntries(zipPath);
      if (!zipImages.length) continue;

      const imageFilesInZip = zipImages.map(entryName => encodeZipEntryPath(zipPath, entryName));
      await emitWork({
        folder_path: zipPath,
        title:       path.basename(zipPath, path.extname(zipPath)),
        cover_path:  imageFilesInZip[0],
        page_count:  imageFilesInZip.length,
        has_video:   0,
        image_files: imageFilesInZip,
        video_files: [],
        all_files:   imageFilesInZip,
        artist:      mangaInfo.artist,
        series:      mangaInfo.series,
      });
    }

    const hasDirectMedia = imageFiles.length > 0 || videoFiles.length > 0;

    if (hasDirectMedia) {
      const anySubHasMedia = subdirs.some(sub => hasMediaDescendant(path.join(dirPath, sub.name)));
      const directImages = anySubHasMedia ? imageFiles.filter(f => !isIgnoredIntermediateFile(f)) : imageFiles;
      const directVideos = videoFiles;
      const hasDirectWorkMedia = directImages.length > 0 || directVideos.length > 0;

      if (hasDirectWorkMedia) {
        const allMedia  = [...directImages, ...directVideos];
        const coverFile = directImages[0] || directVideos[0] || imageFiles[0] || videoFiles[0];
        const mangaInfo = extractMangaInfo(rootPath, dirPath, anySubHasMedia) || {};

        await emitWork({
          folder_path: dirPath,
          title:       path.basename(dirPath),
          cover_path:  coverFile ? path.join(dirPath, coverFile) : null,
          page_count:  directImages.length,
          has_video:   directVideos.length > 0 ? 1 : 0,
          image_files: directImages.map(f => path.join(dirPath, f)),
          video_files: directVideos.map(f => path.join(dirPath, f)),
          all_files:   allMedia.map(f => path.join(dirPath, f)),
          artist:      mangaInfo.artist || null,
          series:      mangaInfo.series || null,
        });
      }

      if (anySubHasMedia) {
        for (const sub of subdirs) {
          await walk(path.join(dirPath, sub.name));
        }
      }
    } else {
      for (const sub of subdirs) {
        await walk(path.join(dirPath, sub.name));
      }
    }
  }

  await walk(rootPath);
  return workCount;
}

function extractMangaInfo(rootPath, candidatePath, anySubHasMedia) {
  let artist = null;
  let series = null;
  let depth = 0;
  const rel = path.relative(rootPath, candidatePath);
  const parts = rel.split(path.sep).filter(Boolean);

  if (path.basename(rootPath).includes('망가')) {
    depth = parts.length;
    artist = parts[0] || null;
    series = parts.length > 2 || (anySubHasMedia && parts.length > 1) ? parts[1] : null;
  } else {
    const mi = parts.findIndex(p => p.includes('망가'));
    if (mi >= 0 && mi + 1 < parts.length) {
      depth = parts.length - mi - 1;
      artist = parts[mi + 1];
      series = depth > 2 || (anySubHasMedia && mi + 2 < parts.length) ? parts[mi + 2] : null;
    }
  }

  return artist ? { artist, series, depth } : null;
}

function hasMediaDescendant(folderPath) {
  let entries;
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.some(e => {
    if (!e.isFile()) return false;
    const filePath = path.join(folderPath, e.name);
    return isImage(e.name) || isVideo(e.name) || (isZip(e.name) && zipHasImages(filePath));
  })) return true;
  return entries.some(e => e.isDirectory() && hasMediaDescendant(path.join(folderPath, e.name)));
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function getWorkFiles(folderPath) {
  if (isZip(folderPath)) {
    const images = getZipImageEntries(folderPath).map(entryName => encodeZipEntryPath(folderPath, entryName));
    return { images, videos: [], all: images };
  }

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

function isValidWorkFolder(folderPath) {
  if (isZip(folderPath)) return zipHasImages(folderPath);
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    return entries.some(e => e.isFile() && (isImage(e.name) || isVideo(e.name)));
  } catch {
    return false;
  }
}

module.exports = {
  scanRoot,
  getWorkFiles,
  isValidWorkFolder,
  naturalSort,
  isImage,
  isVideo,
  isZipEntryPath,
  getMediaExt,
};
