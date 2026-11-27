const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const base=path.resolve(__dirname,'..');
const media=()=>({id:'one',url:'https://cdn.example/a.m3u8',sourcePage:'https://site.example/watch',contentType:'application/x-mpegURL',title:'Movie'});
function harness(directory,shared){
 const tv=shared||{active:false,status:{playerState:'IDLE'},volume:{level:.37,muted:false},launches:0,joins:0,loads:[],trackRequests:[],startupRequests:[]};
 const discovery=new EventEmitter();
 const advertisements=new Map();
 discovery.on('up',service=>advertisements.set(service.txt.id,service));
 let watching=false;
 class Bonjour {
  find(){
   if(!watching){watching=true;return discovery;}
   const lookup=new EventEmitter();
   lookup.stop=()=>{};
   lookup.services=[...advertisements.values()];
   return lookup;
  }
  destroy(){}
 }
 let handler,scanImpl=async()=>({videos:[media()]});
 function remote(Type){
  const r=new EventEmitter();tv.report=()=>r.emit('status',structuredClone(tv.status));r.getStatus=done=>tv.failStatus?done(new Error('Connection lost')):done(null,structuredClone(tv.status));
  r.load=(item,options,done)=>{if(tv.delayLoad){tv.loadCallback=done;return;}tv.loads.push({item,options});tv.active=true;tv.status={playerState:options.autoplay?'PLAYING':'PAUSED',currentTime:options.currentTime,media:{...item,duration:600,tracks:[{trackId:1,type:'AUDIO',name:'English',language:'en'},{trackId:2,type:'AUDIO',name:'French',language:'fr'},{trackId:3,type:'TEXT',name:'English captions',language:'en'}]},mediaSessionId:9,activeTrackIds:[1],supportedMediaCommands:4099};if(tv.bufferOnLoad){tv.status.playerState='BUFFERING';delete tv.status.media.duration;}done(null,structuredClone(tv.status));};
  r.seek=(seconds,done)=>{tv.status.currentTime=seconds;done(null,structuredClone(tv.status));};
  for(const [action,state] of [['pause','PAUSED'],['play','PLAYING'],['stop','IDLE']])r[action]=done=>{(tv.commands ||= []).push(action.toUpperCase());if(action==='play'&&tv.requireSession&&!r.media.currentSession)return done(new Error('No media session'));tv.status.playerState=state;if(action==='stop')tv.status.idleReason='CANCELLED';done(null,structuredClone(tv.status));};
  r.media={currentSession:null,request:(request,done)=>{
   if (request.type==='LOAD') {
    if(tv.loadError)return done(null,tv.loadError);
    return r.load(request.media,request,(err,status)=>done(err,{type:'MEDIA_STATUS',status:[status]}));
   }
   if (['PAUSE','PLAY'].includes(request.type)) {
    tv.startupRequests.push(request);
    return r[request.type.toLowerCase()]((err,status)=>done(err,{type:'MEDIA_STATUS',status:[status]}));
   }
   tv.trackRequests.push(request);tv.status.activeTrackIds=request.activeTrackIds;done(null,{type:'MEDIA_STATUS',status:[structuredClone(tv.status)]});}};
  if(Type===require('chromecast-api/apps/default/DefaultMediaReceiver')){
   r.media.load=r.load;
   r.load=Type.prototype.load;
  }
  return r;
 }
 class Client extends EventEmitter{
  constructor(){super();this.receiver={};}connect(address,done){tv.address=address;done();}close(){tv.closed=(tv.closed||0)+1;}getVolume(done){done(null,tv.volume);}setVolume(update,done){Object.assign(tv.volume,update);done(null,tv.volume);}
  stop(receiver,done){tv.stopped=(tv.stopped||0)+1;tv.active=false;done(null,[]);}launch(Type,done){tv.launches++;done(null,remote(Type));}getSessions(done){if(tv.noReceiverStatus)return;done(null,tv.active?[{appId:tv.otherApp?'OTHER':'CC1AD845',sessionId:'s'}]:[]);}join(session,Type,done){tv.joins++;done(null,remote(Type));}
 }
 const remux={...require('../remux.cjs'),directory,cleanStale(){}};
 const cache=directory ? require('../remux-cache.cjs').createCache(directory) : {
  list:()=>[],open:()=>null,checkpoint(){},release(){}
 };
 const context={require:name=>name==='./remux.cjs'?remux:name==='./remux-cache.cjs'?{createCache:()=>cache}:name==='./media-info.cjs'?require('../media-info.cjs'):name==='node:os'?{networkInterfaces:()=>({lan:[{family:'IPv4',internal:false,address:'192.168.1.9',cidr:'192.168.1.9/24'}]})}:name==='node:http'?{createServer:fn=>(handler=fn,{listen(){},close(){}})}:name==='bonjour-service'?{Bonjour}:name==='castv2-client'?{Client,DefaultMediaReceiver:class{static APP_ID='CC1AD845'}}:name==='./extractor.cjs'?{extract:(...args)=>scanImpl(...args),resolveDurations:async items=>items.map(x=>({id:x.id,duration:x.duration||{status:'vod',seconds:600}}))}:require(name),process:{env:{PORT:'3000',DATA_DIR:directory},on(){}},console:{log(){},error:console.error},AbortController,URL,setTimeout:(fn,ms)=>setTimeout(fn,tv.fastTimeouts?1:ms),clearTimeout,setInterval(){return{unref(){}}},clearInterval(){},__dirname:base};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(base,'server.cjs'),'utf8'),context);
 discovery.emit('up',{addresses:['192.168.1.10'],txt:{id:'tv',fn:'Living Room'},port:8009});
 async function request(route,data){return new Promise((resolve,reject)=>{let code,headers;const req={method:data===undefined?'GET':'POST',url:'/api/'+route,headers:{host:'127.0.0.1:3000'},async *[Symbol.asyncIterator](){if(data!==undefined)yield JSON.stringify(data);}};handler(req,{writeHead(c,h){code=c;headers=h;},end(body){resolve({code,data:JSON.parse(body),headers});}}).catch(reject);});}
 return {tv,context,request,remux,addReceiver(id,name){
  discovery.emit('up',{addresses:['192.168.1.11'],txt:{id,fn:name},port:8009});
 },changeAddress(id,host){
  const previous=advertisements.get(id);
  advertisements.set(id,{...previous,addresses:[host]});
 },advertiseAlternate(id,host){
  const alternate={...advertisements.get(id),addresses:[host],referer:{address:host}};
  // Also make the competing advertisement arrive first during the fresh lookup.
  discovery.emit('srv-update',alternate);
  const latest=advertisements.get(id);
  advertisements.delete(id);
  advertisements.set(id+'-alternate',alternate);
  advertisements.set(id,latest);
 },setScan(fn){scanImpl=fn;}};
}

test('scanning, casting, playback controls, and tracks work without history storage',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cast-no-history-'));try{
 const h=harness(dir);assert.equal((await h.request('scan',{url:'https://site.example/watch'})).code,200);
 let r=await h.request('cast',{deviceId:'tv',videoId:'one',directHLS:true});assert.equal(r.code,200);
 r=await h.request('seek',{seconds:125});assert.equal(r.data.currentTime,125);
 assert.equal((await h.request('pause',{})).data.state,'PAUSED');
 assert.equal((await h.request('play',{})).data.state,'PLAYING');
 assert.equal((await h.request('volume',{level:.5})).code,200);
 assert.equal((await h.request('tracks',{type:'TEXT',trackId:3})).code,200);
 assert.equal((await h.request('stop',{})).code,200);
 assert.equal((await h.request('checkpoint',{})).code,404);
 assert.equal((await h.request('resume',{})).code,404);
 assert.equal(fs.readdirSync(dir).length,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('cancelling a scan allows a new scan',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cast-no-history-'));try{
 const h=harness(dir);h.setScan((url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('Scan cancelled'),{name:'AbortError'})))));
 const pending=h.request('scan',{url:'https://site.example/watch'});await new Promise(setImmediate);assert.equal((await h.request('scan/cancel',{})).code,200);assert.equal((await pending).code,499);h.setScan(async()=>({videos:[media()]}));assert.equal((await h.request('scan',{url:'https://site.example/watch'})).code,200);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('slow status response keeps the receiver connection and disconnect closes it',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cast-no-history-'));try{const h=harness(dir);await h.request('cast',{deviceId:'tv'});h.tv.failStatus=true;await h.context.pollPlayback();let state=(await h.request('devices')).data.playback;assert.equal(state.state,'PLAYING');assert.match(state.statusWarning,/slow/);assert.equal(h.tv.closed||0,0);const result=await h.request('disconnect',{});assert.equal(result.data.device,null);assert.equal(h.tv.closed,1);assert.equal(h.tv.stopped,1);assert.equal((await h.request('pause',{})).code,409);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('disconnect while loading cancels the pending request and ignores a late receiver callback',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cast-no-history-'));try{const h=harness(dir);h.tv.delayLoad=true;const pending=h.request('cast',{deviceId:'tv'});await new Promise(setImmediate);assert.equal((await h.request('disconnect',{})).code,200);assert.match((await pending).data.error,/Disconnected/);h.tv.loadCallback(null,{playerState:'PLAYING'});assert.equal((await h.request('devices')).data.playback.device,null);h.tv.delayLoad=false;assert.equal((await h.request('cast',{deviceId:'tv'})).code,200);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('loads paused and starts the receiver after it reports ready',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cast-no-history-'));try{const h=harness(dir);h.tv.requireSession=true;const response=await h.request('cast',{deviceId:'tv'});assert.equal(h.tv.loads[0].options.autoplay,false);await new Promise(setImmediate);assert.deepEqual(h.tv.commands.slice(0,2),['PAUSE','PLAY']);assert.equal(h.tv.status.playerState,'PLAYING');await h.request('pause',{});assert.equal(h.tv.status.playerState,'PAUSED');assert.deepEqual(h.tv.commands.slice(0,3),['PAUSE','PLAY','PAUSE']);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a pasted HLS link skips scanning and loads the exact URL using the Swift-style fields',async()=>{
 const h=harness();
 h.setScan(async()=>assert.fail('A pasted HLS link does not need a page scan'));
 const url='https://cdn.example/video.m3u8?sig=a%2Fb&x=+';
 const scan=await h.request('scan',{url});
 assert.equal(scan.data.videos[0].url,url);
 const result=await h.request('cast',{deviceId:'tv',videoId:scan.data.videos[0].id,directHLS:true});
 const {item,options}=h.tv.loads[0];
 assert.equal(result.code,200);
 assert.equal(item.contentUrl,url);
 assert.equal(item.contentType,'application/x-mpegURL');
 assert.equal(item.streamType,'BUFFERED');
 assert.equal(options.autoplay,false);
 assert.equal(options.currentTime,0);
 for(const key of ['hlsSegmentFormat','hlsVideoSegmentFormat'])assert.equal(key in item,false);
 assert.doesNotMatch(JSON.stringify(result.data.diagnostics),/cdn\.example/);
});

test('HLS plays on each qualifying receiver event, never on a status poll',async()=>{
 const h=harness();
 h.tv.bufferOnLoad=true;
 h.tv.requireSession=true;
 await h.request('scan',{url:'https://site.example/watch'});
 const result=await h.request('cast',{deviceId:'tv',videoId:'one',directHLS:true});
 const {item,options}=h.tv.loads[0];
 assert.equal(item.contentUrl,media().url);
 assert.equal(item.contentType,'application/x-mpegURL');
 assert.equal(item.streamType,'BUFFERED');
 assert.equal(options.currentTime,0);
 assert.equal(options.autoplay,false);
 assert.deepEqual(result.data.startupSteps,['Load sent']);
 h.tv.status.playerState='PAUSED';
 await h.context.pollPlayback();
 assert.deepEqual((await h.request('status')).data.startupSteps,['Load sent']);
 h.tv.status.media.duration=600;
 await h.context.pollPlayback();
 assert.equal(h.tv.commands,undefined);
 h.tv.report();
 await new Promise(setImmediate);
 await h.context.pollPlayback();
 assert.deepEqual(h.tv.commands,['PLAY']);
 assert.deepEqual(h.tv.startupRequests.map(({type,mediaSessionId})=>[type,mediaSessionId]),[['PLAY',9]]);
 assert.deepEqual((await h.request('status')).data.startupSteps,
  ['Load sent','TV reported Paused','Play sent','TV reported Playing at 0:00']);
 h.tv.status.playerState='PAUSED';h.tv.status.currentTime=1;h.tv.report();
 assert.deepEqual(h.tv.commands,['PLAY']);
 h.tv.status.currentTime=0.5;h.tv.report();
 await new Promise(setImmediate);
 assert.deepEqual(h.tv.commands,['PLAY','PLAY']);
});

test('the startup record stays accurate when the receiver stops during load',async()=>{
 const h=harness();
 h.tv.bufferOnLoad=true;
 await h.request('scan',{url:'https://site.example/watch'});
 await h.request('cast',{deviceId:'tv',videoId:'one',directHLS:true});
 h.tv.status.playerState='IDLE';
 h.tv.status.idleReason='ERROR';
 await h.context.pollPlayback();
 const {error,startupSteps,diagnostics}= (await h.request('status')).data;
 assert.match(error,/before Play/);
 assert.deepEqual(startupSteps,['Load sent']);
 assert.equal(h.tv.commands,undefined);
 assert.deepEqual(diagnostics.events.filter(event=>event.state).map(event=>[event.state,event.idleReason]),
  [['BUFFERING',undefined],['IDLE','ERROR']]);
 assert.doesNotMatch(JSON.stringify(diagnostics),/cdn\.example/);
});

test('the report preserves the receiver load error code without copying the media URL',async()=>{
 const h=harness();
 h.tv.loadError={type:'LOAD_FAILED', reason:'GENERIC_LOAD_ERROR', detailedErrorCode:103,
  customData:{httpStatus:403, url:'https://cdn.example/a.m3u8?token=private',
   playerError:{category:'NETWORK',code:3016, data:[{status:403}], message:'signed text private'}}};
 const result=await h.request('cast',{deviceId:'tv'});
 assert.equal(result.code,502);
 const {diagnostics}= (await h.request('status')).data;
 const reply=diagnostics.events.find(event=>event.event==='LOAD reply');
 assert.equal(reply.type,'LOAD_FAILED');
 assert.equal(reply.reason,'GENERIC_LOAD_ERROR');
 assert.equal(reply.detailedErrorCode,103);
 assert.equal(reply.httpStatus,403);
 assert.deepEqual(reply.receiverMessage.customData.playerError,{
  category:'NETWORK',code:3016,data:[{status:403}],message:'[redacted]'
 });
 assert.doesNotMatch(JSON.stringify(diagnostics),/token|cdn\.example|private/);
});

test('Big Buck Bunny stays available after scanning and disconnect clears the chosen TV',async()=>{
 class Element{constructor(){this.children=[];this.value='';this.textContent='';this.classList={add(){},remove(){},toggle(){}};this.style={};}append(...x){this.children.push(...x)}replaceChildren(){this.children=[]}setAttribute(k,v){this[k]=v}blur(){}close(){}showModal(){}remove(){}}
 const elements={};for(const m of fs.readFileSync(path.join(base,'index.html'),'utf8').matchAll(/id="([^"]+)"/g))elements[m[1]]=new Element();let state={state:'IDLE',device:null},lastCast;
 const ui={document:{documentElement:{dataset:{theme:'light'}},querySelector:()=>({}),getElementById:id=>{assert.ok(elements[id],id);return elements[id]},createElement:()=>new Element(),createElementNS:()=>new Element(),createTextNode:x=>x,body:new Element()},matchMedia:()=>({matches:false,addEventListener(){}}),localStorage:{getItem(){return null},setItem(){},removeItem(){}},navigator:{},window:{location:{origin:'http://127.0.0.1:3000'}},URL,console,setInterval(){return 1},clearInterval(){},setTimeout,clearTimeout,fetch:async(url,options)=>({ok:true,json:async()=>{
 if(url.endsWith('devices'))return{devices:[{id:'tv',name:'TV'}],playback:state};
 if(url.endsWith('library'))return{videos:[],playback:state};
 if(url.endsWith('remuxes'))return{videos:[{id:'remux:test',url:'/saved-remux/test.mp4',title:'Saved movie',format:'MP4',position:125,saved:true}]};
 if(url.endsWith('scan'))return{videos:[media()]};
 if(url.endsWith('durations'))return{videos:[]};
 if(url.endsWith('cast')){lastCast=JSON.parse(options.body);return state={state:'PLAYING',device:'TV',startupSteps:['Load sent','Pause sent','Play sent','Playback confirmed']};}
 if(url.endsWith('disconnect'))return state={state:'IDLE',device:null};
 return state;
 }})};
 vm.runInNewContext(fs.readFileSync(path.join(base,'app.js'),'utf8'),ui);await new Promise(setImmediate);elements['page-url'].value='https://site.example/watch';await elements['scan-form'].onsubmit({preventDefault(){}});assert.equal(elements.tracks.children.length,2);
 elements.tracks.children[1].children[2].onclick();
 assert.equal(elements['direct-hls'].hidden,false);
 assert.equal(elements['details-advanced'].hidden,false);
 assert.equal(elements['details-advanced'].open,false);
 assert.equal(elements['details-link-section'].open,false);
 assert.equal(elements['details-url'].value,media().url);
 await elements['direct-hls'].onclick();
 assert.equal(lastCast.videoId,'one');
 assert.equal(lastCast.directHLS,true);
 assert.equal(lastCast.swiftAutoplay,false);
 elements.tracks.children[0].children[0].onclick();assert.equal(elements['now-title'].textContent,'Big Buck Bunny');await elements.cast.onclick();assert.equal(lastCast.deviceId,'tv');assert.equal(lastCast.videoId,undefined);assert.equal(elements['cast-diagnostics'].hidden,true);await ui.refresh();
 elements['remuxes-tab'].onclick();
 await new Promise(setImmediate);
 assert.equal(elements['now-title'].textContent,'Saved movie');
 assert.equal(elements['now-subtitle'].textContent,'Resume at 2:05');
 elements.tracks.children[0].children[2].onclick();
 assert.equal(elements['direct-hls'].hidden,true);
 await elements.cast.onclick();
 assert.equal(lastCast.videoId,'remux:test');
 await elements.disconnect.onclick();await ui.refresh();assert.equal(elements['device-name'].textContent,'Choose a TV');assert.equal(elements.status.textContent,'Disconnected');assert.equal(elements.cast.disabled,true);
});

test('recasting uses the existing default receiver session',async()=>{
 const h=harness();
 await h.request('cast',{deviceId:'tv'});
 await h.request('cast',{deviceId:'tv'});
 assert.equal(h.tv.launches,1);
 assert.equal(h.tv.joins,1);
});


test('ordinary HLS cast prepares the exact link and serves the MP4 until playback finishes',async()=>{
 const h=harness();
 h.context.localAddressFor=async()=> '192.168.1.9';
 const fake={route:'/video/test.mp4',ready:true};
 h.remux.start=url=>{fake.source=url;return fake};
 h.remux.waitForFragment=async()=>{};
 // Give the real cleanup routine a private, disposable file.
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'remux-finish-'));
 try{
  fake.file=path.join(dir,'video.mp4');fs.writeFileSync(fake.file,'test');
  const {data}=await h.request('scan',{url:'https://cdn.example/a.m3u8'});
  const r=await h.request('cast',{deviceId:'tv',videoId:data.videos[0].id});
  assert.equal(r.code,200);assert.equal(fake.source,data.videos[0].url);
  assert.equal(h.tv.loads[0].item.contentType,'video/mp4');
  assert.equal(r.data.remuxUrl,fake.route);
  assert.equal(h.tv.loads[0].options.autoplay,true);
  const repeated=await h.request('cast',{deviceId:'tv',videoId:data.videos[0].id});
  assert.equal(repeated.code,200);
  assert.equal(repeated.data.remuxUrl,fake.route);
  assert.equal(h.tv.loads.length,1);
  assert.deepEqual(h.tv.startupRequests,[]);
  h.tv.status.playerState='IDLE';h.tv.status.idleReason='FINISHED';h.tv.report();
  assert.equal(fs.existsSync(fake.file),false);
  assert.equal((await h.request('status')).data.remuxUrl,null);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('the CDN chunklist keeps its latest signature and a different playlist from the same host', () => {
 const {mediaType}=require('../extractor.cjs');
 const {enrichVideos}=require('../media-info.cjs');
 const cdn='https://cdn.example/video.mp4/';
 const chunklist=cdn+'chunklist.m3u8';
 const first=chunklist+'?vendtime=1&vhash=old%2Bvalue';
 const renewed=chunklist+'?vendtime=2&vhash=new%2Bvalue';
 const alternate=cdn+'playlist.m3u8';
 assert.equal(mediaType(cdn+'media_1.ts?redirect=.mp4','video/mp4'),null);
 assert.equal(mediaType(cdn+'empty.mp4'), 'video/mp4');
 const items=[first,renewed,alternate].map(url=>({url,contentType:mediaType(url)}));
 assert.deepEqual(enrichVideos(items,'Video',cdn).map(video=>video.url),[renewed,alternate]);
});

test('standalone TS and the earlier Swift HLS test use one autoplay load',async()=>{
 for(const [extension,contentType] of [['ts','video/mp2t'],['m3u8','application/x-mpegURL']]){
  const h=harness();
  h.setScan(async()=>assert.fail('Direct URL should skip scanning'));
  const url='https://cdn.example/test.'+extension+'?sig=a%2Bb';
  const {data}=await h.request('scan',{url});
  const result=await h.request('cast',{deviceId:'tv',videoId:data.videos[0].id,
    ...(extension==='m3u8'?{directHLS:true,swiftAutoplay:true}:{})});
  assert.equal(result.code,200);
  assert.equal(result.data.state,'PLAYING');
  assert.equal(result.data.diagnostics.load.autoplay,true);
  assert.equal(h.tv.loads[0].item.contentId,url);
  assert.equal(h.tv.loads[0].item.contentType,contentType);
  assert.equal(h.tv.loads[0].options.autoplay,true);
  assert.deepEqual(h.tv.startupRequests,[]);
 }
});


test('finished remux survives restart and resumes after stop without remuxing again',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cast-cache-'));
 try{
  const first=harness(dir);
  first.context.localAddressFor=async()=> '192.168.1.9';
  first.remux.start=(url,onError,onComplete)=>{
   const job={file:path.join(dir,'new.mp4'),route:'/video/new.mp4',ready:true,complete:true};
   fs.writeFileSync(job.file,'test');
   queueMicrotask(()=>onComplete(job));
   return job;
  };
  await first.request('scan',{url:'https://site.example/watch'});
  assert.equal((await first.request('cast',{deviceId:'tv',videoId:'one'})).code,200);
  assert.equal((await first.request('seek',{seconds:125})).code,200);
  assert.equal((await first.request('stop',{})).code,200);
  const cached=(await first.request('remuxes')).data.videos[0];
  assert.equal(cached.position,125);
  assert.match(fs.readFileSync(path.join(dir,'resume.csv'),'utf8'),/,125,"Movie"/);

  const restarted=harness(dir);
  restarted.context.localAddressFor=async()=> '192.168.1.9';
  restarted.remux.start=()=>assert.fail('The existing MP4 should be reused');
  const result=await restarted.request('cast',{deviceId:'tv',videoId:cached.id});
  assert.equal(result.code,200);
  assert.equal(restarted.tv.loads[0].options.currentTime,125);
  restarted.tv.status.playerState='IDLE';
  restarted.tv.status.idleReason='FINISHED';
  restarted.tv.report();
  assert.equal((await restarted.request('remuxes')).data.videos[0].position,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('remux cleanup expires only saved MP4s unused for three days',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cast-cache-'));
 try{
  const old=path.join(dir,'saved-remux-'+('0'.repeat(24))+'.mp4');
  const fresh=path.join(dir,'saved-remux-'+('1'.repeat(24))+'.mp4');
  const unrelated=path.join(dir,'personal.mp4');
  for(const filename of [old,fresh,unrelated])fs.writeFileSync(filename,'test');
  const fourDaysAgo=new Date(Date.now()-4*24*60*60*1000);
  fs.utimesSync(old,fourDaysAgo,fourDaysAgo);
  fs.utimesSync(unrelated,fourDaysAgo,fourDaysAgo);
  const cache=require('../remux-cache.cjs').createCache(dir);
  assert.equal(fs.existsSync(old),false);
  assert.equal(fs.existsSync(fresh),true);
  assert.equal(fs.existsSync(unrelated),true);
  assert.equal(cache.list().length,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});


test('a secure connection that never gets Cast status reports the precise stalled stage',async()=>{
 const h=harness();
 h.tv.noReceiverStatus=true;
 h.tv.fastTimeouts=true;
 const result=await h.request('cast',{deviceId:'tv'});
 assert.equal(result.code,502);
 assert.match(result.data.error,/did not answer the Cast status/);
 const status=(await h.request('status')).data;
 assert.equal(status.state,'ERROR');
 assert.equal(h.tv.launches,0);
 assert.ok(status.diagnostics.events.some(event=>event.event==='Secure Cast connection established'));
 assert.ok(status.diagnostics.events.some(event=>event.event==='Cast stage timed out' &&
  event.stage==='receiver status'));
});


test('casting mode persists by receiver name and direct HLS bypasses remux',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cast-device-settings-'));
 try {
  const first=harness(dir);
  first.addReceiver('tcl','TCL Smart TV');
  assert.equal((await first.request('device-settings',{deviceId:'tcl',castMode:'hls'})).code,200);
  const restarted=harness(dir);
  restarted.addReceiver('tcl-new-id','TCL Smart TV');
  const devices=(await restarted.request('devices')).data.devices;
  assert.equal(devices.find(device=>device.id==='tv').castMode,'remux');
  assert.equal(devices.find(device=>device.id==='tcl-new-id').castMode,'hls');
  restarted.remux.start=()=>assert.fail('Direct HLS must not start an MP4 remux');
  await restarted.request('scan',{url:'https://site.example/watch'});
  assert.equal((await restarted.request('cast',{deviceId:'tcl-new-id',videoId:'one'})).code,200);
  assert.equal(restarted.tv.loads[0].item.contentId,media().url);
  assert.equal(restarted.tv.loads[0].item.contentType,'application/x-mpegURL');
  assert.equal((await restarted.request('device-settings',{deviceId:'tcl-new-id',castMode:'remux'})).code,200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'device-settings.json'),'utf8')).length,0);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});


test('cast resolves a new IP by stable receiver ID before connecting',async()=>{
 const h=harness();
 h.addReceiver('tcl','TCL Smart TV');
 h.changeAddress('tcl','192.168.1.15');
 const result=await h.request('cast',{deviceId:'tcl'});
 assert.equal(result.code,200);
 assert.equal(h.tv.address.host,'192.168.1.15');
 assert.equal(result.data.device,'TCL Smart TV');
});


test('the same receiver advertising an off-subnet address does not displace its LAN endpoint',async()=>{
 const h=harness();
 h.addReceiver('tcl','TCL Smart TV');
 h.advertiseAlternate('tcl','10.6.0.128');
 const result=await h.request('cast',{deviceId:'tcl'});
 assert.equal(result.code,200);
 assert.equal(h.tv.address.host,'192.168.1.11');
 assert.ok(result.data.diagnostics.events.some(event=>event.event==='Connecting to Cast port' &&
  event.host==='192.168.1.11'));
});
