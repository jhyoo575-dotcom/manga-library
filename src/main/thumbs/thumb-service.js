'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const sharp  = require('sharp');
const { isZipEntryPath, getZipEntryBuffer } = require('../../zip-utils');

let thumbDir = path.join(process.cwd(), 'data', 'thumbs');

function init(dir) {
  thumbDir = dir || thumbDir;
  ensureThumbDir();
}

function ensureThumbDir() {
  fs.mkdirSync(thumbDir, { recursive: true });
  return thumbDir;
}

function getIdentity(item) {
  const rootPath = item.rootPath || item.root_path || '';
  const leafPath = item.leafPath || item.leaf_path ||
    (rootPath && item.folder_path ? path.relative(rootPath, item.folder_path) : '') ||
    item.folder_path ||
    item.cover_path ||
    item.id ||
    item.title ||
    'unknown';
  return `${rootPath}|${leafPath}`;
}

function getThumbFilename(item) {
  return `${crypto.createHash('sha1').update(getIdentity(item)).digest('hex')}.webp`;
}

function getThumbPath(item) {
  return path.join(ensureThumbDir(), getThumbFilename(item));
}

function thumbnailExists(item) {
  const thumbPath = item.thumbPath || item.thumb_path || getThumbPath(item);
  return !!thumbPath && fs.existsSync(thumbPath);
}

function getSourceImage(item) {
  if (Array.isArray(item.image_files) && item.image_files.length) return item.image_files[0];
  if (Array.isArray(item.images) && item.images.length) return item.images[0];
  return item.firstImage || item.first_image || item.coverPath || item.cover_path || null;
}

async function generateThumbnail(item) {
  const sourcePath = getSourceImage(item);
  if (!sourcePath) return null;

  const outputPath = getThumbPath(item);
  const source = isZipEntryPath(sourcePath) ? getZipEntryBuffer(sourcePath) : sourcePath;
  if (!source || (typeof source === 'string' && !fs.existsSync(source))) return null;

  await sharp(source, { failOn: 'none' })
    .rotate()
    .resize({
      width: 320,
      height: 450,
      fit: 'cover',
      withoutEnlargement: false,
    })
    .webp({ quality: 78, effort: 4 })
    .toFile(outputPath);

  return outputPath;
}

async function ensureThumbnail(item) {
  const existingPath = item.thumbPath || item.thumb_path;
  if (existingPath && fs.existsSync(existingPath)) return existingPath;

  const targetPath = getThumbPath(item);
  if (fs.existsSync(targetPath)) return targetPath;

  try {
    return await generateThumbnail(item);
  } catch (err) {
    console.warn('[ThumbService] thumbnail generation failed:', err.message);
    return null;
  }
}

module.exports = {
  init,
  ensureThumbDir,
  getThumbFilename,
  getThumbPath,
  thumbnailExists,
  generateThumbnail,
  ensureThumbnail,
};
