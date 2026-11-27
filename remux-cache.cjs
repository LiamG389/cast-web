const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const maxAge = 3 * 24 * 60 * 60 * 1000;
const cachedFile = /^saved-remux-([a-f0-9]{24})\.mp4$/;
const indexHeader = 'id,position_seconds,title\n';

function createCache(directory) {
  const entries = new Map();
  const index = path.join(directory, 'resume.csv');
  let timer;
  let dirty = false;

  function writeIndex() {
    if (!dirty) return;
    const records = [...entries.values()].map(entry =>
      entry.key + ',' + entry.position + ',"' + entry.title.replaceAll('"','""') + '"\n');
    const temp = index + '.tmp';
    fs.writeFileSync(temp, indexHeader + records.join(''));
    fs.renameSync(temp, index);
    dirty = false;
  }

  function scheduleExpiry() {
    clearTimeout(timer);
    let next = Infinity;
    for (const entry of entries.values()) {
      if (!entry.active) next = Math.min(next, entry.usedAt + maxAge);
    }
    if (Number.isFinite(next)) {
      timer = setTimeout(expire, Math.max(1, next-Date.now()));
      timer.unref();
    }
  }

  function expire() {
    const cutoff = Date.now() - maxAge;
    for (const [key,entry] of entries) {
      if (entry.active || entry.usedAt > cutoff) continue;
      try {
        fs.rmSync(entry.file,{force:true});
        entries.delete(key);
        dirty = true;
      } catch (err) {
        // Retry later if the storage drive is unavailable.
        entry.usedAt = Date.now() - maxAge + 60*60*1000;
        console.error('Remux cleanup:',err.message);
      }
    }
    try { writeIndex(); } catch (err) { console.error('Remux index:',err.message); }
    scheduleExpiry();
  }

  const records = new Map();
  if (fs.existsSync(index)) {
    for (const line of fs.readFileSync(index,'utf8').split('\n')) {
      const record = /^([a-f0-9]{24}),(\d+(?:\.\d+)?),"((?:[^"]|"")*)"$/.exec(line);
      if (record) records.set(record[1], {position:Number(record[2]), title:record[3].replaceAll('""','"')});
    }
  }
  for (const name of fs.readdirSync(directory)) {
    const match = cachedFile.exec(name);
    if (!match) continue;
    const file = path.join(directory,name);
    const usedAt = fs.statSync(file).mtimeMs;
    const key = match[1];
    entries.set(key,{key,file,usedAt,position:0,title:'Saved video',...records.get(key)});
  }
  expire();

  function touch(entry) {
    const now = Date.now();
    fs.utimesSync(entry.file,now/1000,now/1000);
    entry.usedAt = now;
    scheduleExpiry();
  }

  return {
    list() {
      return [...entries.values()].sort((a,b)=>b.usedAt-a.usedAt).map(entry=>({
        id:'remux:'+entry.key,
        url:'/saved-remux/'+entry.key+'.mp4',
        title:entry.title,
        format:'MP4',
        saved:true,
        position:entry.position
      }));
    },
    open(key) {
      const entry = entries.get(key);
      if (!entry || (!entry.active && entry.usedAt + maxAge <= Date.now())) return null;
      return entry;
    },
    markUsed: touch,
    acquire(entry) {
      touch(entry);
      entry.active = true;
      return {entry,file:entry.file,route:'/video/'+randomUUID()+'.mp4',ready:true,complete:true};
    },
    store(key,job,title,resumePosition=0) {
      const file = path.join(directory,'saved-remux-'+key+'.mp4');
      fs.renameSync(job.file,file);
      job.file = file;
      const entry = {key,file,title:String(title || 'Saved video').replace(/[\r\n]/g,' ').slice(0,250),
        position:entries.get(key)?.position ?? resumePosition,usedAt:Date.now(),active:true};
      job.entry = entry;
      entries.set(key,entry);
      dirty = true;
      try { touch(entry); writeIndex(); } catch (err) { console.error('Remux index:',err.message); }
    },
    checkpoint(job,position) {
      if (!job?.entry || !Number.isFinite(position) || position < 0) return;
      const entry = job.entry;
      try {
        const seconds = Math.round(position*1000)/1000;
        if (entry.position !== seconds) {
          entry.position = seconds;
          dirty = true;
        }
        touch(entry);
        writeIndex();
      } catch (err) { console.error('Remux checkpoint:',err.message); }
    },
    release(job) {
      job.entry.active = false;
      try { touch(job.entry); } catch (err) {
        console.error('Remux cache:',err.message);
        scheduleExpiry();
      }
    }
  };
}

module.exports = {createCache};
