'use strict';

const path   = require('path');
const AdmZip = require('adm-zip');

const ZIP_EXT = new Set(['.zip']);
const IMAGE_EXT = new Set(['.jpg','.jpeg','.png','.gif','.webp','.avif','.bmp','.tiff','.tif']);
const ZIP_ENTRY_PREFIX = 'zip://';

function isZip(filePath) {
  return ZIP_EXT.has(path.extname(filePath).toLowerCase());
}

function isZipEntryPath(filePath) {
  return typeof filePath === 'string' && filePath.startsWith(ZIP_ENTRY_PREFIX);
}

function isZipEntryImage(entryName) {
  return IMAGE_EXT.has(path.extname(entryName).toLowerCase());
}

function encodeZipEntryPath(zipPath, entryName) {
  const raw = JSON.stringify({ zipPath, entryName });
  return ZIP_ENTRY_PREFIX + Buffer.from(raw, 'utf8').toString('base64url');
}

function decodeZipEntryPath(filePath) {
  if (!isZipEntryPath(filePath)) return null;
  try {
    return JSON.parse(Buffer.from(filePath.slice(ZIP_ENTRY_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function getZipImageEntries(zipPath) {
  try {
    const zip = new AdmZip(zipPath);
    return zip.getEntries()
      .filter(entry => !entry.isDirectory && isZipEntryImage(entry.entryName))
      .map(entry => entry.entryName)
      .sort(naturalSort);
  } catch {
    return [];
  }
}

function zipHasImages(zipPath) {
  return getZipImageEntries(zipPath).length > 0;
}

function getZipEntryBuffer(filePath) {
  const parsed = decodeZipEntryPath(filePath);
  if (!parsed) return null;
  try {
    const zip = new AdmZip(parsed.zipPath);
    const entry = zip.getEntry(parsed.entryName);
    if (!entry || entry.isDirectory) return null;
    return entry.getData();
  } catch {
    return null;
  }
}

function getMediaBasename(filePath) {
  const parsed = decodeZipEntryPath(filePath);
  return parsed ? path.basename(parsed.entryName) : path.basename(filePath);
}

function getMediaExt(filePath) {
  const parsed = decodeZipEntryPath(filePath);
  return path.extname(parsed ? parsed.entryName : filePath).toLowerCase();
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

module.exports = {
  ZIP_ENTRY_PREFIX,
  isZip,
  isZipEntryPath,
  encodeZipEntryPath,
  decodeZipEntryPath,
  getZipImageEntries,
  zipHasImages,
  getZipEntryBuffer,
  getMediaBasename,
  getMediaExt,
};
