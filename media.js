const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const imageTypes = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif'
};

function readAsset(directory, name, kind) {
  const extension = path.extname(name).toLowerCase();
  const type = kind === 'audio' ? (extension === '.mp3' ? 'audio/mpeg' : undefined) : imageTypes[extension];
  if (!type) throw new Error(kind === 'audio' ? 'use an .mp3 file.' : 'use a PNG, JPEG, WebP, GIF, or AVIF image.');
  if (name.split('/').some(part => !part || part === '.' || part === '..' || /[\\:*?"<>|\x00-\x1f]/.test(part))) {
    throw new Error('use a path relative to the media folder with forward slashes.');
  }
  let file;
  try {
    const root = fs.realpathSync(directory);
    file = fs.realpathSync(path.join(root, name));
    const relative = path.relative(root, file);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('File outside media folder');
    }
    const info = fs.statSync(file);
    if (!info.isFile() || !info.size) throw new Error('Missing media file');
  } catch {
    throw new Error(`could not read "media/${name}". Add a nonempty file inside the media folder.`);
  }
  return { file, type, url: `/media/image/${randomUUID()}` };
}

function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (start >= size || start > end) return null;
  return { start, end };
}

async function serveMedia(request, response, asset) {
  let handle;
  try {
    handle = await fs.promises.open(asset.file, 'r');
    const { size } = await handle.stat();
    const range = request.headers.range && byteRange(request.headers.range, size);
    if (request.headers.range && !range) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    const headers = { 'Content-Type': asset.type, 'Accept-Ranges': 'bytes', 'Content-Length': size };
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
      headers['Content-Length'] = range.end - range.start + 1;
    }
    response.writeHead(range ? 206 : 200, headers);
    if (request.method === 'HEAD') response.end();
    else await pipeline(handle.createReadStream({ ...range, autoClose: false }), response);
  } catch {
    if (!response.headersSent) response.writeHead(404).end('Media file not found.');
    else response.destroy();
  } finally {
    await handle?.close().catch(() => {});
  }
}

module.exports = { readAsset, serveMedia };
