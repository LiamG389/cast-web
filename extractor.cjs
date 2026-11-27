const path = require('node:path');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(__dirname, '.browser-cache');
const { chromium } = require('playwright');
const { randomUUID } = require('node:crypto');
const {parsePlaylist,hlsCastInfo,enrichVideos}=require('./media-info.cjs');

function mediaType(url, contentType = '') {
  let pathname;
  try { pathname = new URL(url).pathname; } catch { return null; }
  if (/\.(?:ts|m4s)$/i.test(pathname)) return null;
  if (/mpegurl/i.test(contentType) || /\.m3u8$/i.test(pathname)) return 'application/x-mpegURL';
  if (/dash\+xml/i.test(contentType) || /\.mpd$/i.test(pathname)) return 'application/dash+xml';
  if (/\.mp4$/i.test(pathname)) return 'video/mp4';
  if (/\.webm$/i.test(pathname)) return 'video/webm';
  if (/^video\//i.test(contentType) && !/mp2t/i.test(contentType)) return contentType.split(';')[0];
  return null;
}
async function extract(pageURL, { timeoutMs = 25000, signal } = {}) {
  const cancelled=()=>Object.assign(new Error('Scan cancelled'),{name:'AbortError'});
  if(signal?.aborted)throw cancelled();
  const input = new URL(pageURL);
  if (!['http:', 'https:'].includes(input.protocol)) throw new Error('Enter an http:// or https:// page URL.');
  const started = Date.now();
  const stats = { requests: 0, blockedImages: 0, blockedFonts: 0, blockedMedia: 0, receivedBytes: 0, elapsedMs: 0 };
  const found = new Map();
  function add(url, contentType, source) {
    if (!/^https?:\/\//i.test(url)) return;
    const type = mediaType(url, contentType);
    if (!type) return;
    if (found.has(url)) {
      if (source === 'response headers') Object.assign(found.get(url), {contentType:type, source});
      return;
    }
    found.set(url, { id: randomUUID(), url, contentType: type, source });
  }
  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (err) {
    if(signal?.aborted)throw cancelled();
    if (/Permission denied|bootstrap_check_in/.test(err.message)) throw new Error('The helper cannot launch its browser from this restricted session. Start it from Terminal with npm start, then retry.');
    if (/Executable doesn't exist/.test(err.message)) throw new Error('The helper browser is missing. Follow the browser installation step in README.md.');
    throw new Error('The helper browser could not start: ' + err.message.split('\n')[0]);
  }
  const abort=()=>browser.close().catch(()=>{});
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted){await browser.close();throw cancelled();}
  let navigationError = null;
  const metadata=new Map(),playlists=new Map(),roles=new Map(),playlistTasks=new Set();
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 720 } });
    // Browser network events cover requests from frames and popups.
    // Never discover links by scraping video element attributes.
    context.on('request', request => {
      stats.requests++;
      add(request.url(), '', 'network request');
    });
    await context.route('**/*', async route => {
      const request = route.request();
      const kind = request.resourceType();
      if (kind === 'image') { stats.blockedImages++; return route.abort(); }
      if (kind === 'font') { stats.blockedFonts++; return route.abort(); }
      const type = mediaType(request.url());
      const playlist = type === 'application/x-mpegURL' || type === 'application/dash+xml';
      // Master and variant playlists must load so players can expose the stream.
      if (!playlist && (type || kind === 'media' || /\.(?:ts|m4s|aac)(?:[?#]|$)/i.test(request.url()))) {
        stats.blockedMedia++;
        return route.abort();
      }
      await route.continue();
    });
    context.on('response', response => {
      const type=response.headers()['content-type']||'';add(response.url(),type,'response headers');
      if(mediaType(response.url(),type)!=='application/x-mpegURL'||!response.ok()||playlistTasks.size>=16||Number(response.headers()['content-length'])>512*1024)return;
      const task=(async()=>{try{const data=await response.body();if(data.length>512*1024)return;const manifest=data.toString('utf8');
        if(!manifest.trimStart().startsWith('#EXTM3U'))return;
        const parsed=parsePlaylist(manifest,response.url());
        playlists.set(response.url(),parsed);
        for(const variant of parsed.variants){metadata.set(variant.url,{...variant,masterURL:response.url()});add(variant.url,'application/x-mpegURL','playlist variant');}
        for(const rendition of parsed.renditions)roles.set(rendition.url,rendition.type);
      }catch{}})();playlistTasks.add(task);
    });
    context.on('requestfinished', request => {
      request.sizes().then(size => { stats.receivedBytes += Math.max(0, size.responseBodySize || 0); }).catch(() => {});
    });
    context.on('page', page => page.on('dialog', dialog => dialog.dismiss().catch(() => {})));
    const page = await context.newPage();
    await page.goto(input.href, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 15000) }).catch(err => { navigationError = err.message.split('\n')[0]; });
    const clickedFrames = new WeakSet();
    while (Date.now() - started < timeoutMs && !signal?.aborted) {
      for (const openPage of context.pages()) for (const frame of openPage.frames()) {
        // Use DOM interaction only to trigger playback, never to obtain stream URLs.
        // A header video must not suppress activation of the main player.
        await frame.evaluate(() => {
          const videos = [...document.querySelectorAll('video')].sort((a,b) => {
            const x=a.getBoundingClientRect(), y=b.getBoundingClientRect();
            return y.width*y.height-x.width*x.height;
          });
          if (videos[0]) { videos[0].muted=true; videos[0].play().catch(()=>{}); }
        }).catch(() => {});
        if (!clickedFrames.has(frame)) {
          const buttons = frame.getByRole('button', { name: /^(play|play video|watch now|start video)$/i })
            .or(frame.locator('.vjs-big-play-button,.jw-display-icon-container .jw-icon-playback,.plyr__control--overlaid'));
          for (let i=0, count=Math.min(await buttons.count().catch(()=>0),8); i<count; i++) {
            const button=buttons.nth(i);
            if (!await button.isVisible().catch(()=>false)) continue;
            const clicked=await button.click({timeout:700,noWaitAfter:true}).then(()=>true).catch(()=>false);
            if (clicked) { clickedFrames.add(frame); break; }
          }
        }
      }
      // Listen for the full window: header/ad videos often appear before the main stream.
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if(signal?.aborted)throw cancelled();
    let settleTimer;
    await Promise.race([Promise.allSettled([...playlistTasks]),new Promise(resolve=>{settleTimer=setTimeout(resolve,1000);})]);clearTimeout(settleTimer);
    const title=await page.title().catch(()=>new URL(pageURL).hostname);
    const videos=enrichVideos([...found.values()].map(item=>({...item,...metadata.get(item.url),...hlsCastInfo(item.url,playlists),role:roles.get(item.url)})),title,pageURL);
    stats.elapsedMs = Date.now() - started;
    return { videos, stats, note: videos.length ? 'Captured from browser network traffic; playlists appear first. Ads/header videos may also appear. Chromecast compatibility has not been verified.' : 'No direct video links detected. The player may need interaction, use protected video, or block automated browsers.', navigationError };
  } catch(err){if(signal?.aborted)throw cancelled();throw err;} finally {
    signal?.removeEventListener('abort',abort);
    await browser.close();
  }
}
module.exports = { extract, mediaType };

// HLS duration needs playlists only. Bound total time, bytes, requests and nesting.
async function resolveDurations(videos, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cache = new Map();
  const budget = { requests: 0, bytes: 0 };
  async function playlist(url) {
    if (cache.has(url)) return cache.get(url);
    const pending = (async () => {
      if (++budget.requests > 24 || controller.signal.aborted) throw new Error('Lookup limit');
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid playlist URL');
      const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain' } });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Playlist unavailable'); }
      const type = response.headers.get('content-type') || '';
      if (/^(video|audio)\//i.test(type) && !/mpegurl/i.test(type)) { await response.body?.cancel(); throw new Error('Not a playlist'); }
      if (Number(response.headers.get('content-length')) > 512*1024) { await response.body?.cancel(); throw new Error('Playlist too large'); }
      if (!response.body) throw new Error('Empty response');
      const reader=response.body.getReader(), decoder=new TextDecoder();
      let text='', bytes=0;
      try {
        while (true) {
          const {done,value}=await reader.read(); if(done)break;
          bytes+=value.byteLength;budget.bytes+=value.byteLength;
          if(bytes>512*1024 || budget.bytes>1024*1024)throw new Error('Lookup size limit');
          text+=decoder.decode(value,{stream:true});
        }
        text+=decoder.decode();
      } finally { await reader.cancel().catch(()=>{}); }
      if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('Not an HLS playlist');
      return {text, url:response.url || url};
    })();
    cache.set(url,pending);return pending;
  }
  async function inspect(url, depth=0, seen=new Set()) {
    if(depth>2 || seen.has(url))throw new Error('Playlist nesting limit');
    seen.add(url);
    const result=await playlist(url), lines=result.text.split(/\r?\n/).map(x=>x.trim());
    const master=lines.findIndex(line=>line.startsWith('#EXT-X-STREAM-INF:'));
    if(master>=0){
      const variant=lines.slice(master+1).find(line=>line && !line.startsWith('#'));
      if(!variant)throw new Error('Missing variant');
      return inspect(new URL(variant,result.url).href,depth+1,seen);
    }
    const segments=lines.filter(line=>line.startsWith('#EXTINF:')).map(line=>Number(line.slice(8).split(',')[0]));
    if(!segments.length || segments.some(x=>!Number.isFinite(x) || x<0))throw new Error('Invalid timing');
    if(!lines.includes('#EXT-X-ENDLIST'))return {status:'live'};
    const seconds=segments.reduce((sum,x)=>sum+x,0);
    return seconds>0?{status:'vod',seconds}:{status:'unavailable'};
  }
  let cursor=0;
  const results=new Array(videos.length);
  async function worker(){
    while(cursor<videos.length){
      const index=cursor++, item=videos[index];
      if(item.duration){results[index]={id:item.id,duration:item.duration};continue;}
      if(mediaType(item.url,item.contentType)!=='application/x-mpegURL'){results[index]={id:item.id,duration:{status:'unsupported'}};continue;}
      try{results[index]={id:item.id,duration:await inspect(item.url)};}
      catch{results[index]={id:item.id,duration:{status:'unavailable'}};}
    }
  }
  try{await Promise.all([worker(),worker()]);return results;}
  finally{clearTimeout(timer);controller.abort();}
}
module.exports.resolveDurations=resolveDurations;
