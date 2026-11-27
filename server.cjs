const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {BlockList,isIPv4} = require('node:net');
const {createHash,randomUUID} = require('node:crypto');
let scanJob=null,scanSequence=0,polling=false;
const { extract, resolveDurations } = require('./extractor.cjs');
let durationJob=null;
const detected = new Map();
let scanning = false;
const { Bonjour } = require('bonjour-service');
const { Client, DefaultMediaReceiver } = require('castv2-client');
const remux = require('./remux.cjs');
const {createCache} = require('./remux-cache.cjs');
const {fingerprint} = require('./media-info.cjs');
remux.cleanStale();
const remuxCache = createCache(remux.directory);
const VERSION='0.2.31';
const settingsPath = remux.directory && path.join(remux.directory,'device-settings.json');
const castModes = new Set(['remux','hls']);
let deviceModes = new Map();
if (settingsPath) {
  try {
    const saved = new Map(JSON.parse(fs.readFileSync(settingsPath,'utf8')));
    deviceModes = new Map([...saved].filter(([name,mode])=>typeof name==='string' && castModes.has(mode)));
  } catch(err) {
    if (err.code !== 'ENOENT') console.error('Cast settings:',err.message);
  }
}
const castModeFor = name => deviceModes.get(name) || 'remux';
const sampleDirectory = process.env.CAST_TEST_TS_DIR;
const testMediaTypes = new Map([
  ['local-original.m3u8','application/x-mpegURL'],
  ['local-audio-video-only.m3u8','application/x-mpegURL'],
  ['local-control.m3u8','application/x-mpegURL'],
  ['local-baseline-video.m3u8','application/x-mpegURL'],
  ['local-reencoded-audio.m3u8','application/x-mpegURL'],
  ['original.ts','video/mp2t'],
  ['audio-video-only.ts','video/mp2t'],
  ['control-0.ts','video/mp2t'],
  ['baseline-video.ts','video/mp2t'],
  ['reencoded-audio.ts','video/mp2t']
]);
const port = Number(process.env.PORT || 3000);
const video = 'https://websooty.tech/media/big-buck-bunny/big-buck-bunny-720p.mp4';
const devices = new Map();
const interfaces = Object.values(os.networkInterfaces()).flat().filter(x=>x.family==='IPv4' && !x.internal);
const ips = interfaces.map(x=>x.address);
const localSubnets = new BlockList();
for (const {address,cidr} of interfaces) {
  if (cidr) localSubnets.addSubnet(address,Number(cidr.split('/')[1]),'ipv4');
}
const isLocalAddress = address => localSubnets.check(address,'ipv4');
const allowedHosts = new Set(['localhost', '127.0.0.1', ...ips].map(x => `${x}:${port}`));
let connection = null, player = null, busy = false, volume = null, loadGeneration=0, cancelLoad=null;
let receiveMediaStatus = null;
let playback = { state: 'IDLE', device: null, currentTime: 0 };
const bonjour = new Bonjour({}, err => console.error('Discovery:', err.message));
const discoveryOptions = {type:'googlecast'};
const browser = bonjour.find(discoveryOptions);

function receiverFromService(service) {
  const addresses = (service.addresses || []).filter(isIPv4);
  const localAddresses = addresses.filter(isLocalAddress);
  const candidates = localAddresses.length ? localAddresses : addresses;
  const host = candidates.includes(service.referer?.address) ? service.referer.address : candidates[0];
  if (!host) return null;
  return {id:service.txt?.id || service.fqdn, name:service.txt?.fn || service.name, host, port:service.port || 8009};
}

function rememberReceiver(service) {
  const receiver = receiverFromService(service);
  if (!receiver) return null;
  const previous = devices.get(receiver.id);
  if (previous && isLocalAddress(previous.host) && !isLocalAddress(receiver.host)) return receiver;
  devices.set(receiver.id,receiver);
  if (previous?.host !== receiver.host || previous.port !== receiver.port) {
    console.log(previous ? 'Updated Chromecast address:' : 'Found Chromecast:',receiver.name,receiver.host);
  }
  return receiver;
}

for (const event of ['up','srv-update','txt-update']) browser.on(event,rememberReceiver);
browser.on('down', service => {
  const receiver = receiverFromService(service);
  const current = receiver && devices.get(receiver.id);
  if (current && current.host===receiver.host && current.port===receiver.port) {
    devices.delete(receiver.id);
  }
});

function refreshReceiverAddress(device) {
  // The long-lived Bonjour browser does not emit an update when only the IP changes.
  // A fresh query before each cast matches the current address by the stable Cast ID.
  return new Promise(resolve => {
    const lookup = bonjour.find(discoveryOptions);
    const timer = setTimeout(()=>finish(devices.get(device.id) || device),1200);
    function finish(receiver) {
      clearTimeout(timer);
      lookup.removeListener('up',onup);
      lookup.stop();
      resolve(receiver);
    }
    function onup(service) {
      const receiver = rememberReceiver(service);
      if (receiver?.id!==device.id || !isLocalAddress(receiver.host)) return false;
      finish(receiver);
      return true;
    }
    lookup.on('up',onup);
    for (const service of lookup.services || []) {
      if (onup(service)) break;
    }
  });
}
function send(res, code, data) { res.writeHead(code, {'Content-Type':'application/json', 'Cache-Control':'no-store'}); res.end(JSON.stringify(data)); }
const receiverErrorTypes = new Set(['LOAD_FAILED','LOAD_CANCELLED','INVALID_REQUEST','INVALID_PLAYER_STATE','ERROR','MEDIA_ERROR']);
function receiverErrorDetails(message) {
  const fields = ['reason','errorCode','detailedErrorCode','httpStatus','httpStatusCode','networkErrorCode'];
  const details = {};
  for (const field of fields) {
    const value = message?.[field] ?? message?.customData?.[field];
    if (Number.isFinite(value) || (typeof value === 'string' && /^[A-Z0-9_ -]{1,64}$/.test(value))) {
      details[field] = value;
    }
  }
  return details;
}
// Preserve nested error codes and payload structure without including signed URLs
// or arbitrary receiver strings in the report copied from the browser.
function redactedReceiverMessage(message) {
  const enumFields = new Set(['type','reason','code','errorCode','detailedErrorCode',
    'severity','category','playerState','idleReason']);
  const privateField = /url|uri|host|address|token|signature|cookie|credential|authorization|password|secret|header|vhash/i;
  let remaining = 120;
  function redact(value, key, depth) {
    if (remaining-- <= 0 || depth >= 6) return '[truncated]';
    if (value === null || typeof value === 'boolean' || Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      if (enumFields.has(key) && /^(?:[A-Z][A-Z0-9_]{0,63}|\d{1,10})$/.test(value)) return value;
      return '[redacted]';
    }
    if (Array.isArray(value)) return value.slice(0, 12).map(item => redact(item, key, depth+1));
    if (typeof value !== 'object') return '[redacted]';
    const result = Object.create(null);
    for (const [field, item] of Object.entries(value)) {
      if (remaining <= 0) { result.truncated = true; break; }
      if (/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field) && !privateField.test(field)) {
        result[field] = redact(item, field, depth+1);
      } else {
        result.redactedFields = (result.redactedFields || 0)+1;
      }
    }
    return result;
  }
  return message && redact(message, '', 0);
}
function cast(device, media = { id:'',url:video,contentType:'video/mp4',title:'Big Buck Bunny' }, swiftAutoplay = false) {
  return new Promise((resolve, reject) => {
    ++loadGeneration;
    cancelLoad?.();
    connection?.close();
    const client = new Client();
    connection = client;
    player = null;
    receiveMediaStatus = null;
    volume = null;
    const castURL=media.url;
    const startAt=media.resumePosition || 0;
    const isHLS = /mpegurl/i.test(media.contentType);
    const autoplay = media.remuxed === true || (isHLS && swiftAutoplay) || media.contentType === 'video/mp2t';
    const contentType=isHLS?'application/x-mpegURL':media.contentType;
    const started = Date.now();
    const diagnostics = {
      load: {contentType, streamType:'BUFFERED', sender:'castv2-client', autoplay, currentTime:startAt, directLink:media.directLink || undefined, remuxed:media.remuxed || undefined},
      events:[]
    };
    playback = {
      state:'CONNECTING', device:device.name, deviceId:device.id, title:media.title,
      mediaId:media.id, sourcePage:media.sourcePage||null, media:{...media}, paused:false,
      currentTime:startAt, duration:media.duration?.status==='vod'?media.duration.seconds:null,
      streamType:'BUFFERED', startup:'Connecting to TV…', startupSteps:[], diagnostics
    };
    let settled = false, mediaSessionId, receiverDuration, latestStatus, startRequested = false;
    const connected = () => connection === client;
    const finishRequest = err => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(currentPlayback());
    };
    function trace(event, details = {}) {
      const entry = {event, ...details};
      const signature = JSON.stringify(entry);
      if (signature === trace.last) return;
      trace.last = signature;
      diagnostics.events.push({ms:Date.now()-started, ...entry});
      if (diagnostics.events.length > 24) diagnostics.events.splice(1,1);
    }
    const startupError = message => {
      clearTimeout(timer);
      if (mp4Job && castURL.endsWith(mp4Job.route)) discardMP4();
      trace('Playback failed', {beforePlay: !autoplay && !playback.startupSteps.includes('Play sent')});
      playback = {...playback, startup:null, state:'ERROR', error:message};
    };
    let timer;
    let stage = 'TCP connection';
    function waitFor(nextStage, message, timeout) {
      clearTimeout(timer);
      stage = nextStage;
      timer = setTimeout(() => {
        if (!connected()) return;
        trace('Cast stage timed out', {stage});
        const error = typeof message === 'function' ? message() : message;
        if (!player) {
          fail(new Error(error));
        } else {
          startupError(error);
          finishRequest(new Error(error));
        }
      }, timeout);
    }
    cancelLoad = () => {
      clearTimeout(timer);
      finishRequest(new Error('Disconnected from TV.'));
    };
    const fail = err => {
      if (!connected()) return;
      startupError(err.message);
      finishRequest(err);
      player = null;
      receiveMediaStatus = null;
      connection = null;
      volume = null;
      if (!client.client || client.client.socket) client.close();
    };
    function record(step) {
      playback.startupSteps.push(step);
      console.log('Cast startup:', step);
    }
    waitFor('TCP connection','Could not reach the TV’s Cast port.',12000);
    trace('Connecting to Cast port',{host:device.host,port:device.port});
    client.on('error', err => {
      if (!connected()) return;
      trace('Cast connection error',{stage,code:err.code});
      fail(err);
    });
    client.on('status', status => {if(connected() && status?.volume) volume = status.volume;});
    client.connect({host: device.host, port: device.port}, () => {
      if (!connected()) return;
      trace('Secure Cast connection established');
      playback.startup = 'Checking the TV’s Cast status…';
      waitFor('receiver status','The TV connected but did not answer the Cast status request.',12000);
      client.getVolume((err,current) => {if(!err && connected()) volume = current;});
      let joined = false;
      const attach = callback => client.getSessions((err, sessions) => {
        if (!connected()) return;
        if (err) trace('Cast status request failed',{code:err.code});
        else trace('Cast status received');
        const active = !err && sessions?.find(session => session.appId === DefaultMediaReceiver.APP_ID);
        playback.startup = 'Opening the TV’s media receiver…';
        if (active) {
          joined = true;
          trace('Joining existing receiver');
          waitFor('receiver join','The TV did not open its existing media receiver.',15000);
          client.join(active, DefaultMediaReceiver, callback);
        } else {
          trace('Launching receiver');
          waitFor('receiver launch','The TV did not start its media receiver.',40000);
          client.launch(DefaultMediaReceiver, callback);
        }
      });
      attach((err, receiver) => {
        if (!connected()) return;
        if (err) {
          trace('Media receiver failed to open',{stage,code:err.code});
          return fail(err);
        }
        trace(joined ? 'Joined existing receiver' : 'Launched receiver');
        player = receiver;
        waitFor('media startup', () => autoplay || startRequested ?
          'The TV did not confirm playback.' : 'The TV never reported that the video was ready to play.',45000);

        function sendStartupCommand(type, label, timeout) {
          return command(done => {
            receiver.media.request({type, mediaSessionId}, (err, response) => {
              if (err) return done(err);
              if (response?.type !== 'MEDIA_STATUS') {
                trace(label+' reply', {type:response?.type, ...receiverErrorDetails(response), receiverMessage:redactedReceiverMessage(response)});
                return done(new Error('The TV rejected '+label+'.'));
              }
              done(null, response.status?.[0]);
            });
            record(label+' sent');
          }, timeout);
        }

        async function startPlaying() {
          startRequested = true;
          try {
            // HLS is already paused by LOAD. Match the Swift sender and go straight to PLAY.
            if (!isHLS) {
              playback.startup = 'Pausing…';
              const paused = await sendStartupCommand('PAUSE', 'Pause', 2000).catch(err => {
                // Some receivers omit a reply to PAUSE when the session is already paused.
                if (latestStatus?.playerState !== 'PAUSED' || !playback.startupSteps.includes('Pause sent')) throw err;
              });
              if (!connected() || !playback.startup) return;
              if (paused?.mediaSessionId === mediaSessionId && paused.playerState === 'PAUSED') {
                record('Pause confirmed');
                updatePlayback(paused);
              }
            }
            playback.startup = 'Starting playback…';
            const playing = await sendStartupCommand('PLAY', 'Play', 12000);
            if (!connected() || !playback.startup) return;
            acceptStatus(playing,'play-reply');
            if (playback.startup) playback.startup = 'Waiting for playback…';
          } catch (err) {
            if (connected() && playback.startup) startupError(err.message);
          }
        }

        function acceptStatus(status, source = 'event') {
          const loadReply=source==='load-reply';
          if (!connected() || !status) return;
          // A joined receiver can broadcast the previous video's final status.
          if (joined && mediaSessionId === undefined && !loadReply) return;
          if (mediaSessionId === undefined && Number.isInteger(status.mediaSessionId) &&
              (loadReply || status.media?.contentId === castURL || status.media?.contentUrl === castURL)) {
            mediaSessionId = status.mediaSessionId;
          }
          if (mediaSessionId === undefined || status.mediaSessionId !== mediaSessionId) return;
          if (playback.startup || (status.playerState === 'IDLE' && !playback.error)) {
            trace('Receiver status', {
              state:status.playerState, idleReason:status.idleReason,
              extendedState:status.extendedStatus?.playerState,
              position:status.currentTime, duration:status.media?.duration,
              ...receiverErrorDetails(status),
              receiverMessage:status.idleReason==='ERROR' ? redactedReceiverMessage(status) : undefined
            });
          }
          if (mp4Job && status.playerState==='IDLE' && ['FINISHED','CANCELLED','INTERRUPTED','ERROR'].includes(status.idleReason)) {
            if (status.idleReason==='FINISHED') remuxCache.checkpoint(mp4Job,0);
            if (['CANCELLED','INTERRUPTED'].includes(status.idleReason)) saveRemuxPosition();
            discardMP4();
          }
          if (status.playerState==='PAUSED' && playback.state!=='PAUSED' && !playback.startup) {
            remuxCache.checkpoint(mp4Job,status.currentTime);
          }
          latestStatus = status;
          if (receiver.media) receiver.media.currentSession = status;
          updatePlayback(status);
          if(status.playerState==='PLAYING' && status.currentTime>0 && !playback.startupSteps.includes('Playback confirmed')){
            record('Playback confirmed');
          }
          if (status.media) receiverDuration=status.media.duration ?? 0;
          if (isHLS && !autoplay && !playback.error && ['event','load-reply'].includes(source) &&
              status.playerState==='PAUSED' && status.currentTime<1 && receiverDuration>0) {
            trace('Swift play condition met',{source,position:status.currentTime,duration:receiverDuration});
            record('TV reported Paused');
            void startPlaying();
            return;
          }
          if (!playback.startup) {
            if (status.playerState === 'IDLE' && status.idleReason === 'ERROR' && !playback.error) {
              startupError('The TV reported a playback error.');
            }
            return;
          }
          if (status.playerState === 'IDLE' && status.idleReason) {
            startupError(autoplay ? 'The TV stopped during autoplay.' : playback.startupSteps.includes('Play sent') ?
              'The TV stopped loading after Play.' : 'The TV stopped loading before Play.');
            return;
          }
          if (autoplay || startRequested) {
            if (status.playerState === 'PLAYING' && (autoplay || playback.startupSteps.includes('Play sent'))) {
              if(!(status.currentTime>0))record('TV reported Playing at 0:00');
              playback.startup = null;
              clearTimeout(timer);
            }
            return;
          }
          if (!isHLS && ['PAUSED','PLAYING','BUFFERING'].includes(status.playerState)) {
            void startPlaying();
          }
        }

        receiveMediaStatus = (status,source) => {
          acceptStatus(status,source);
          if (connected() && mediaSessionId !== undefined) finishRequest();
        };
        receiver.on('status', status=>receiveMediaStatus(status,'event'));
        playback.startup = autoplay ? 'Waiting for the TV to start…' : 'Waiting for the TV to load paused…';
        record('Load sent');
        // Retain structured errors from the receiver.
        receiver.media.on?.('message', message => {
          if (connected() && receiverErrorTypes.has(message?.type)) {
            trace('Receiver error', {type:message.type, ...receiverErrorDetails(message), receiverMessage:redactedReceiverMessage(message)});
          }
        });
        receiver.media.request({
          type:'LOAD', autoplay, currentTime:startAt,
          ...(isHLS || autoplay ? {} : {activeTrackIds:[], repeatMode:'REPEAT_OFF'}),
          media:{
            ...(isHLS ? {contentUrl:castURL,contentId:castURL} : {contentId:castURL}),
            contentType, streamType:'BUFFERED',
            metadata:{metadataType:1,title:media.title||'Detected video'}
          }
        }, (err, response) => {
          if (!connected()) return;
          trace('LOAD reply', {
            type:response?.type || (err ? 'REQUEST_ERROR' : 'NO_RESPONSE'),
            ...receiverErrorDetails(response),
            receiverMessage:response?.type !== 'MEDIA_STATUS' ? redactedReceiverMessage(response) : undefined
          });
          if (err || response?.type !== 'MEDIA_STATUS') {
            const message = 'The TV rejected the load request.';
            startupError(message);
            finishRequest(new Error(message));
            return;
          }
          if (!startRequested) acceptStatus(response.status?.[0], 'load-reply');
          finishRequest();
        });
      });
    });
    client.client?.socket?.once('connect', () => {
      if (!connected() || stage !== 'TCP connection') return;
      trace('TCP connection established');
      waitFor('TLS handshake','The TV accepted the connection but did not finish the secure Cast handshake.',12000);
    });
    client.client?.once('close', () => {
      if (!connected() || !playback.startup) return;
      trace('Cast connection closed',{stage});
      fail(new Error('The TV closed the Cast connection during '+stage+'.'));
    });

  });
}
function updatePlayback(status) {
  if (!status) return;
  const duration=status.media?.duration;
  const errorReset=status.playerState==='IDLE'&&status.idleReason==='ERROR'&&!(status.currentTime>0);
  playback={...playback,statusWarning:null,state:status.playerState || playback.state,currentTime:!errorReset&&Number.isFinite(status.currentTime)?status.currentTime:playback.currentTime,idleReason:status.idleReason,
    duration:Number.isFinite(duration) && duration>0?duration:playback.duration,
    streamType:status.media?.streamType || playback.streamType,
    supportedMediaCommands:status.supportedMediaCommands ?? playback.supportedMediaCommands,
    liveSeekableRange:status.liveSeekableRange || playback.liveSeekableRange,
    paused:status.playerState==='PAUSED'?true:status.playerState==='PLAYING'?false:playback.paused,tracks:status.media?.tracks || playback.tracks || [],activeTrackIds:status.activeTrackIds || playback.activeTrackIds || []};

}
function seekRange() {
  if (!['PLAYING','PAUSED','BUFFERING'].includes(playback.state)) return null;
  if (typeof playback.supportedMediaCommands==='number' && !(playback.supportedMediaCommands & 2)) return null;
  const range=playback.liveSeekableRange;
  if (range && Number.isFinite(range.start) && Number.isFinite(range.end) && range.end>range.start) return {start:range.start,end:range.end,live:true};
  if (playback.streamType==='LIVE') return null;
  return Number.isFinite(playback.duration) && playback.duration>0 ? {start:0,end:playback.duration,live:false}:null;
}
function scanState(){return scanJob?{id:scanJob.id,state:scanJob.state,sourcePage:scanJob.sourcePage,kind:scanJob.kind,error:scanJob.error||null}:null;}
function currentPlayback(){return {...playback,remuxUrl:mp4Job?.ready && !mp4Job.removed ? mp4Job.route : null,volume,seekRange:seekRange(),scan:scanState(),version:VERSION};}
async function body(req) {
  let data = ''; for await (const chunk of req) { data += chunk; if (data.length > 16384) throw new Error('Request too large'); }
  return data ? JSON.parse(data) : {};
}
let mp4Job = null;

function discardMP4(){
  const job = mp4Job;
  mp4Job = null;
  if (!job) return;
  if (job.entry) remuxCache.release(job);
  else remux.remove(job);
}
function saveRemuxPosition(){
  if (!playback.startup && ['PLAYING','PAUSED','BUFFERING'].includes(playback.state)) {
    remuxCache.checkpoint(mp4Job,playback.currentTime);
  }
}
function closeRemux(){
  saveRemuxPosition();
  discardMP4();
}
process.on('exit',closeRemux);

async function localAddressFor(device){
  const socket = require('node:dgram').createSocket('udp4');
  try {
    await new Promise((resolve,reject)=>{
      socket.once('error',reject);
      socket.connect(device.port,device.host,resolve);
    });
    return socket.address().address;
  } finally { socket.close(); }
}

// An audio-compatible remux must be rebuilt when the old cache used audio copying.
function remuxKey(media) {
  return createHash('sha256').update('aac-stereo-remux:'+fingerprint(media)).digest('hex').slice(0,24);
}
async function prepareMP4(media,device,key,savedEntry){
  const cached = savedEntry || remuxCache.open(key);
  const resumePosition = cached?.position ?? remuxCache.open(fingerprint(media))?.position ?? 0;
  const job = cached ? remuxCache.acquire(cached) : remux.start(media.url, message => {
    if (mp4Job === job) playback = {...playback,state:'ERROR',startup:null,error:message};
  }, completed => {
    try { remuxCache.store(key,completed,media.title,resumePosition); }
    catch (err) { console.error('Could not retain remux:',err.message); }
  });
  mp4Job = job;
  job.key = key;
  job.deviceHost = device.host;
  job.devicePort = device.port;
  try {
    const host = await localAddressFor(device);
    if (!job.ready) await remux.waitForFragment(job);
    if (mp4Job !== job) throw new Error('Preparation cancelled.');
    return {...media,url:'http://'+host+':'+port+job.route,contentType:'video/mp4',
      remuxed:true,resumePosition};
  } catch (err) {
    if (mp4Job === job) discardMP4();
    throw err;
  }
}
const server = http.createServer(async (req, res) => {
  if (!allowedHosts.has(req.headers.host)) return send(res,403,{error:'Open this helper using its printed local address.'});
  if(mp4Job?.ready && req.url===mp4Job.route)return remux.serve(req,res,mp4Job).catch(()=>res.destroy());
  const testFilename = req.url.startsWith('/cast-test/') ? req.url.slice('/cast-test/'.length) : '';
  const testContentType = testMediaTypes.get(testFilename);
  if (sampleDirectory && testContentType) {
    const file = path.join(sampleDirectory,testFilename);
    const peer = req.socket.remoteAddress;
    res.once('close', () => {
      const result = res.writableFinished ? res.statusCode : 'closed early';
      const range = res.getHeader('Content-Range');
      const length = res.getHeader('Content-Length');
      console.log('[Cast test]', peer, req.method, testFilename, result,
        range || (length ? length+' bytes' : ''));
    });
    if (!fs.existsSync(file)) return send(res,404,{error:'Test media file is missing.'});
    return remux.serve(req,res,{file,complete:true,contentType:testContentType}).catch(()=>res.destroy());
  }
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res,403,{error:'Origin not allowed'});
  const route = req.url.split('?')[0];
  try {
    const savedRoute = /^\/saved-remux\/([a-f0-9]{24})\.mp4$/.exec(route);
    if (savedRoute) {
      const entry = remuxCache.open(savedRoute[1]);
      if (!entry) return send(res,404,{error:'That saved remux has expired.'});
      if (req.method==='GET') remuxCache.markUsed(entry);
      return remux.serve(req,res,{file:entry.file,complete:true}).catch(()=>res.destroy());
    }
    if(req.method==='GET' && route==='/api/remuxes')return send(res,200,{videos:remuxCache.list()});
    if(req.method==='GET' && route==='/api/version')return send(res,200,{version:VERSION});
    if(req.method==='GET' && route==='/api/library')return send(res,200,{videos:[...detected.values()],playback:currentPlayback(),scan:scanState()});
    if(req.method==='POST' && route==='/api/scan/cancel'){
      if(scanJob?.state==='scanning'){scanJob.state='cancelling';scanJob.controller.abort();await scanJob.promise.catch(()=>{});}
      return send(res,200,{scan:scanState()});
    }
    if(req.method==='POST' && route==='/api/disconnect'){
      closeRemux();
      ++loadGeneration;
      if(cancelLoad){cancelLoad();cancelLoad=null;}
      const client=connection,remote=player;
      connection=null;player=null;receiveMediaStatus=null;volume=null;busy=false;
      playback={state:'IDLE',device:null,currentTime:0};
      if(client && remote){
        try{await command(done=>client.stop(remote,done),5000);}catch(err){console.error('Could not stop receiver:',err.message);client.close();return send(res,502,{error:'Disconnected, but the TV did not confirm it stopped.'});}
      }
      if(client)client.close();
      return send(res,200,currentPlayback());
    }
    if(req.method==='POST' && route==='/api/tracks'){
      const {type,trackId}=await body(req);
      if(!['TEXT','AUDIO'].includes(type)||!(trackId===null&&type==='TEXT')&&(!Number.isInteger(trackId)||trackId<0))return send(res,400,{error:'Invalid track selection.'});
      if(busy||!player)return send(res,409,{error:'Cast a video before changing tracks.'});
      const tracks=playback.tracks||[];
      if(trackId!==null&&!tracks.some(x=>x.trackId===trackId&&x.type===type))return send(res,400,{error:'That track is not available.'});
      const ids=(playback.activeTrackIds||[]).filter(id=>tracks.find(x=>x.trackId===id)?.type!==type);if(trackId!==null)ids.push(trackId);
      const remote=player,sessionId=remote.media?.currentSession?.mediaSessionId;
      if(!Number.isInteger(sessionId))return send(res,409,{error:'Track selection is not ready.'});
      busy=true;
      try{
        const result=await command(done=>remote.media.request({type:'EDIT_TRACKS_INFO',mediaSessionId:sessionId,activeTrackIds:ids},(err,response)=>{
          if(err)return done(err);if(!response?.status?.[0])return done(new Error(response?.reason||'The receiver could not change tracks.'));done(null,response.status[0]);
        }));
        if(player!==remote)return send(res,409,{error:'The casting connection changed.'});updatePlayback(result);return send(res,200,currentPlayback());
      }finally{busy=false;}
    }
    if (req.method === 'GET' && route === '/api/devices') {
      return send(res,200,{devices:[...devices.values()].map(({id,name})=>({id,name,castMode:castModeFor(name)})),playback:currentPlayback()});
    }
    if (req.method === 'POST' && route === '/api/device-settings') {
      const {deviceId,castMode} = await body(req);
      const device = devices.get(deviceId);
      if (!device || !castModes.has(castMode)) return send(res,400,{error:'Choose a discovered receiver and a casting mode.'});
      if (castModeFor(device.name) !== castMode) {
        const updated = new Map(deviceModes);
        if (castMode==='remux') updated.delete(device.name);
        else updated.set(device.name,castMode);
        const temp = settingsPath+'.tmp';
        fs.writeFileSync(temp,JSON.stringify([...updated],null,2)+'\n',{mode:0o600});
        fs.renameSync(temp,settingsPath);
        deviceModes=updated;
      }
      return send(res,200,{name:device.name,castMode});
    }
    if (req.method === 'GET' && route === '/api/status') {
      
      if(connection?.receiver && !busy) {const client=connection; client.getVolume((err,current)=>{if(!err && connection===client)volume=current;});}
      return send(res,200,currentPlayback());
    }
    if (req.method === 'POST' && route === '/api/seek') {
      const {seconds}=await body(req);
      if(typeof seconds!=='number' || !Number.isFinite(seconds) || seconds<0)return send(res,400,{error:'Invalid seek time.'});
      if(busy || !player)return send(res,409,{error:'Cast a video before seeking.'});
      const range=seekRange();
      if(!range)return send(res,409,{error:'This stream does not currently support seeking.'});
      if(seconds<range.start || seconds>range.end)return send(res,400,{error:'Seek time is outside the available range.'});
      const remote=player;
      busy=true;
      try {
        const result=await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(new Error('Seek command timed out.')),5000);
          remote.seek(seconds,(err,status)=>{clearTimeout(timer);if(err)reject(err);else resolve(status);});
        });
        if(remote!==player)return send(res,409,{error:'The casting connection changed. Try again.'});
        updatePlayback(result);playback.currentTime=Number.isFinite(result?.currentTime)?result.currentTime:seconds;
        return send(res,200,currentPlayback());
      } finally {busy=false;}
    }
    if (req.method === 'POST' && route === '/api/volume') {
      const options = await body(req);
      if (!options || typeof options !== 'object' || Array.isArray(options)) return send(res,400,{error:'Invalid volume request.'});
      const update = {};
      if ('level' in options) {
        if (typeof options.level !== 'number' || !Number.isFinite(options.level) || options.level < 0 || options.level > 1) return send(res,400,{error:'Volume must be between 0 and 1.'});
        update.level=options.level;
      }
      if ('muted' in options) {
        if (typeof options.muted !== 'boolean') return send(res,400,{error:'Mute must be true or false.'});
        update.muted=options.muted;
      }
      if (!Object.keys(update).length) return send(res,400,{error:'Specify volume or mute.'});
      if (busy || !connection?.receiver) return send(res,409,{error:'Cast a video before adjusting audio.'});
      if ('level' in update && volume?.controlType === 'fixed') return send(res,409,{error:'This device uses a fixed volume level.'});
      const client=connection;
      const current=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Volume command timed out.')),5000);
        client.setVolume(update,(err,result)=>{clearTimeout(timer);if(err)reject(err);else resolve(result);});
      });
      if (connection !== client) return send(res,409,{error:'The casting connection changed. Try again.'});
      volume=current;
      return send(res,200,{volume});
    }
    if (req.method === 'POST' && route === '/api/durations') {
      if (scanning) return send(res,409,{error:'Wait for the video scan to finish.'});
      if (!durationJob) {
        const candidates=[...detected.values()].filter(item=>!item.directLink).slice(0,12);
        durationJob=resolveDurations(candidates).then(results=>{
          for(const result of results){const item=detected.get(result.id);if(item)item.duration=result.duration;}
          return results;
        }).finally(()=>{durationJob=null;});
      }
      return send(res,200,{videos:await durationJob});
    }
    if (req.method === 'POST' && route === '/api/scan') {
      const {url}=await body(req);return send(res,200,await runScan(url));
    }
    if (req.method === 'POST' && route === '/api/cast') {
      if (busy) return send(res,409,{error:'A cast request is already running.'});
      const { deviceId, videoId, directHLS, swiftAutoplay } = await body(req);
      if (busy) return send(res,409,{error:"A cast request is already running."});
      const selectedDevice = devices.get(deviceId);
      const savedEntry = typeof videoId==='string' && videoId.startsWith('remux:') ? remuxCache.open(videoId.slice(6)) : null;
      if (typeof videoId==='string' && videoId.startsWith('remux:') && !savedEntry) {
        return send(res,404,{error:'That saved remux has expired. Scan the video again.'});
      }
      const media = savedEntry ? {id:videoId,title:savedEntry.title} : detected.get(videoId);
      if (videoId && !media) return send(res,400,{error:'This detected link is no longer available. Scan the page again.'});
      if (!selectedDevice) return send(res,400,{error:'Choose a discovered Chromecast first.'});
      busy = true;
      let generation=loadGeneration;
      try{
        const device = await refreshReceiverAddress(selectedDevice);
        if (generation!==loadGeneration) throw new Error('Cast cancelled.');
        const preferDirect = directHLS === true || (directHLS !== false && castModeFor(device.name)==='hls');
        const needsRemux = savedEntry || (media && !preferDirect && (/mpegurl/i.test(media.contentType) || media.format==='HLS'));
        const key = needsRemux ? savedEntry?.key || remuxKey(media) : null;
        if (key && mp4Job?.key===key && player && playback.deviceId===deviceId &&
            mp4Job.deviceHost===device.host && mp4Job.devicePort===device.port &&
            !playback.error && !['ERROR','IDLE'].includes(playback.state)) {
          return send(res,200,currentPlayback());
        }
        closeRemux();
        let source=media;
        if (needsRemux) {
          const previous=connection;
          connection=null;player=null;receiveMediaStatus=null;
          cancelLoad?.();cancelLoad=null;previous?.close();
          playback={state:'PREPARING',startup:'Preparing MP4…',device:device.name,deviceId,title:media.title};
          source=await prepareMP4(media,device,key,savedEntry);
          if(generation!==loadGeneration)throw new Error('Preparation cancelled.');
        }
        const result=cast(device,source,directHLS && swiftAutoplay === true);
        generation=loadGeneration;
        return send(res,200,await result);
      }catch(err){
        if(generation===loadGeneration){
          discardMP4();
          playback={...playback,state:'ERROR',startup:null,error:err.message};
        }
        throw err;
      }finally{if(generation===loadGeneration)busy=false;}
    }
    if (req.method === 'POST' && ['/api/pause','/api/play','/api/stop'].includes(route)) {
      if (busy || !player || playback.startup) return send(res,409,{error:'Wait for playback to start.'});
      const action = route.slice(5);
      const remote = player;
      const position = playback.currentTime;
      return remote[action]((err,status) => {
        if (err) return send(res,502,{error:err.message});
        if (remote!==player) return send(res,409,{error:'The casting connection changed.'});
        updatePlayback(status||{playerState:action==='stop'?'IDLE':action==='pause'?'PAUSED':'PLAYING'});
        if (action==='pause') remuxCache.checkpoint(mp4Job,playback.currentTime);
        if (action==='stop') {
          remuxCache.checkpoint(mp4Job,position);
          playback.idleReason='CANCELLED';
          discardMP4();
        }
        send(res,200,currentPlayback());
      });
    }
    const files={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript'],'/favicon.ico':['public/favicon.ico','image/x-icon'],'/icon.svg':['public/icon.svg','image/svg+xml'],'/apple-touch-icon.png':['public/apple-touch-icon.png','image/png'],'/icon-192.png':['public/icon-192.png','image/png'],'/icon-512.png':['public/icon-512.png','image/png'],'/manifest.webmanifest':['public/manifest.webmanifest','application/manifest+json']};
    const asset=files[route],file=asset?.[0];
    if (req.method === 'GET' && file) {
      res.writeHead(200,{'Content-Type':asset[1],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      return res.end(fs.readFileSync(path.join(__dirname,file)));
    }
    send(res,404,{error:'Not found'});
  } catch (err) { send(res,err.name==='AbortError'?499:err.status||502,{error:err.message}); }
});
server.listen(port,'0.0.0.0',() => {
  console.log(`Desktop: http://localhost:${port}`);
  for (const ip of ips) console.log(`iPhone (same Wi-Fi): http://${ip}:${port}`);
});
function shutdown() {++loadGeneration;cancelLoad?.();closeRemux();clearInterval(pollTimer);scanJob?.controller.abort();browser.stop();bonjour.destroy();connection?.close();server.close();}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

function command(start,timeout=6000){
 return new Promise((resolve,reject)=>{let settled=false;const timer=setTimeout(()=>done(new Error('The receiver did not respond.')),timeout);
  function done(err,value){if(settled)return;settled=true;clearTimeout(timer);err?reject(err):resolve(value);}
  try{start(done);}catch(err){done(err);}
 });
}
async function runScan(url){
 if(scanning)throw Object.assign(new Error('A scan is already running.'),{status:409});
 if(typeof url!=='string'||!/^https?:\/\//i.test(url))throw Object.assign(new Error('Enter a complete http:// or https:// page URL.'),{status:400});
 let parsed;
 try{parsed=new URL(url);}catch{throw Object.assign(new Error('Enter a valid video page or HLS URL.'),{status:400});}
 const transportStream=/\.ts$/i.test(parsed.pathname);
 const directLink=transportStream || /\.m3u8$/i.test(parsed.pathname);
 const controller=new AbortController(),job={id:++scanSequence,state:'scanning',sourcePage:directLink?null:url,kind:'scan',controller};
 scanning=true;scanJob=job;
 job.promise=(async()=>{
  try{
   const result=directLink ? {videos:[{
    id:randomUUID(), url, directLink:true,
    contentType:transportStream?'video/mp2t':'application/x-mpegURL',
    format:transportStream?'TS':'HLS',
    title:transportStream?'Direct TS segment':'Direct HLS stream'
   }]} : await extract(url,{signal:controller.signal});
   if(controller.signal.aborted)throw Object.assign(new Error('Scan cancelled'),{name:'AbortError'});
   detected.clear();for(const item of result.videos)detected.set(item.id,item);job.state='complete';return result;
  }catch(err){job.state=controller.signal.aborted?'cancelled':'error';job.error=controller.signal.aborted?null:err.message;throw err;}
  finally{scanning=false;}
 })();return job.promise;
}
async function pollPlayback(){
 if(polling || !player || (busy && !playback.startup))return;
 const remote=player;
 polling=true;
 try{
   const status=await command(done=>remote.getStatus(done));
   if(player===remote)receiveMediaStatus?.(status,'poll');
 }catch(err){
   if(player===remote && !playback.startup)playback={...playback,statusWarning:'TV is slow to respond; still connected.'};
 }finally{polling=false;}
}
const pollTimer=setInterval(()=>pollPlayback().catch(err=>console.error('Playback update:',err.message)),2000);pollTimer.unref?.();
