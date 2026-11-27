const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const directory = process.env.CAST_MEDIA_DIR || path.join(os.tmpdir(),'cast-web-media');
const prefix = 'cast-web-remux-';
const owned = /^cast-web-remux-[a-f0-9-]{36}\.mp4$/;
function cleanStale() {
  if (!process.env.CAST_MEDIA_DIR) fs.mkdirSync(directory,{recursive:true,mode:0o700});
  for (const name of fs.readdirSync(directory)) {
    if (owned.test(name)) fs.unlinkSync(path.join(directory, name));
  }
}
function remove(job) {
  if (!job || job.removed) return;
  job.removed = true;
  job.child?.kill();
  fs.rmSync(job.file, { force: true });
}
function start(url, onError, onComplete) {
  const id = randomUUID();
  const job = { route: '/video/' + id + '.mp4', file: path.join(directory, prefix + id + '.mp4') };
  const fd = fs.openSync(job.file, 'wx');
  let child;
  try {
    child = spawn('ffmpeg', ['-nostdin','-loglevel','error','-protocol_whitelist','http,https,tcp,tls,crypto',
      '-rw_timeout','20000000','-i',url,'-map','0:v:0','-map','0:a:0?',
      '-c:v','copy','-c:a','aac','-profile:a','aac_low','-ac','2','-ar','48000','-b:a','160k',
      // Wait for codec setup before writing the initial metadata for Chrome Cast.
      '-movflags','+delay_moov+default_base_moof+frag_keyframe',
      '-frag_duration','2000000','-flush_packets','1','-f','mp4','pipe:1'], {stdio:['ignore',fd,'pipe']});
  } catch (err) {
    remove(job);
    throw err;
  } finally { fs.closeSync(fd); }
  job.child = child;
  let reason = 'FFmpeg could not remux this stream.';
  child.stderr.on('data', chunk => {
    if (/403 Forbidden/i.test(chunk)) reason = 'The source refused the video request (HTTP 403).';
    if (/No space left/i.test(chunk)) reason = 'The video drive is full.';
  });
  function fail(message) {
    if (job.removed || job.error) return;
    job.error = message;
    remove(job);
    onError(message);
  }
  child.once('error', err => fail(err.code === 'ENOENT' ? 'FFmpeg is missing on the helper.' : reason));
  child.once('close', code => {
    job.child = null;
    if (job.removed) return;
    if (code !== 0 || !fs.statSync(job.file).size) return fail(reason);
    job.complete = true;
    onComplete?.(job);
  });
  return job;
}
async function waitForFragment(job) {
  let offset = 0;
  const header = Buffer.alloc(8);
  while (!job.removed) {
    const size = fs.statSync(job.file).size;
    const fd = fs.openSync(job.file, 'r');
    try {
      while (offset + 8 <= size && fs.readSync(fd, header, 0, 8, offset) === 8) {
        const length = header.readUInt32BE();
        if (length < 8 || offset + length > size) break;
        if (header.toString('ascii',4,8) === 'mdat') { job.ready = true; return; }
        offset += length;
      }
    } finally { fs.closeSync(fd); }
    if (job.complete) throw new Error('No playable MP4 fragment was produced.');
    await delay(150);
  }
  throw new Error(job.error || 'Preparation cancelled.');
}
async function serve(req, res, job) {
  const headers = {'Content-Type':job.contentType || 'video/mp4','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'};
  if (req.method === 'OPTIONS') {
    res.writeHead(204,{...headers,'Access-Control-Allow-Methods':'GET, HEAD, OPTIONS','Access-Control-Allow-Headers':'Range'});
    return res.end();
  }
  if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  // An open request at zero can follow the growing file. Suffix and seek
  // requests need a stable length, so wait for the writer to finish.
  if (!job.complete && range?.[1] && range[2]) {
    const first=Number(range[1]), last=Number(range[2]);
    if (first<=last && last<fs.statSync(job.file).size) {
      res.writeHead(206,{...headers,'Content-Length':last-first+1,'Content-Range':'bytes '+first+'-'+last+'/*'});
      if (req.method==='HEAD') return res.end();
      return pipeline(fs.createReadStream(job.file,{start:first,end:last}),res);
    }
  }
  const growing = !job.complete && (!req.headers.range || req.headers.range === 'bytes=0-');
  if (!growing) {
    while (!job.complete && !job.removed && !res.destroyed) await delay(200);
    if (res.destroyed || job.removed) return res.destroy();
    const size = fs.statSync(job.file).size;
    let start = 0, end = size - 1;
    if (req.headers.range) {
      if (!range || !(range[1] || range[2])) start = size;
      else if (!range[1]) start = Math.max(0,size-Number(range[2]));
      else { start = Number(range[1]); if (range[2]) end = Math.min(end,Number(range[2])); }
      if (start > end) { res.writeHead(416,{...headers,'Content-Range':'bytes */'+size}); return res.end(); }
      headers['Content-Range'] = 'bytes '+start+'-'+end+'/'+size;
    }
    res.writeHead(range ? 206 : 200,{...headers,'Accept-Ranges':'bytes','Content-Length':end-start+1});
    if (req.method === 'HEAD') return res.end();
    return pipeline(fs.createReadStream(job.file,{start,end}),res);
  }
  res.writeHead(200,headers);
  if (req.method === 'HEAD') return res.end();
  async function* chunks() {
    let offset = 0;
    while (!job.removed && !res.destroyed) {
      const size = fs.statSync(job.file).size;
      if (offset < size) {
        yield* fs.createReadStream(job.file,{fd:fs.openSync(job.file,'r'),start:offset,end:size-1});
        offset = size;
      } else if (job.complete) return;
      else await delay(150);
    }
    if (job.removed) throw new Error('Cast ended.');
  }
  return pipeline(Readable.from(chunks()),res);
}
module.exports = {directory, start, remove, cleanStale, waitForFragment, serve};
