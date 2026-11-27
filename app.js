const $ = id => document.getElementById(id);
(() => {
 const system=matchMedia('(prefers-color-scheme: dark)');
 let override=false;
 try {override=['dark','light'].includes(localStorage.getItem('cast-theme'));} catch {}
 function apply(theme) {
  document.documentElement.dataset.theme=theme;
  const dark=theme==='dark';
  $('theme-toggle').setAttribute('aria-pressed',String(dark));
  $('theme-toggle').setAttribute('aria-label',dark?'Switch to light mode':'Switch to dark mode');
  $('theme-toggle').title=dark?'Light mode':'Dark mode';
  $('theme-icon').setAttribute('href',dark?'#i-sun':'#i-moon');
  document.querySelector('meta[name="theme-color"]').content=dark?'#1c1c1e':'#ffffff';
 }
 apply(document.documentElement.dataset.theme || (system.matches?'dark':'light'));
 $('theme-toggle').onclick=()=>{
  const theme=document.documentElement.dataset.theme==='dark'?'light':'dark';
  override=true;apply(theme);try{localStorage.setItem('cast-theme',theme);}catch{}
 };
 system.addEventListener('change',event=>{if(!override)apply(event.matches?'dark':'light');});
})();
const sample = {id:'',url:'https://websooty.tech/media/big-buck-bunny/big-buck-bunny-720p.mp4',title:'Big Buck Bunny',subtitle:'Test video'};
let seekDragging=false, seekSending=false;
let durationEnabled=true, durationLoading=false;
try{durationEnabled=localStorage.getItem('cast-duration')!=='false';}catch{}
$('show-duration').checked=durationEnabled;
let audio=null, audioPending=null, audioSending=false, audioTimer, audioDragging=false, audioGeneration=0, detailsVideo=null;
let libraryLoading=false,libraryScanKey=null,scanRequest=false,trackSignature='';
let rowCastButtons=[];
let savedVideos=[], showingRemuxes=false, savedSelection='', savedRequest=0;
let videos=[sample], selectedVideo='', devices=[], selectedDevice='', working=false, scanning=false, online=false;
let playback={state:'IDLE'}, activeTitle='', refreshPending=false, toastTimer, explicitlyDisconnected=false;
try {selectedDevice=localStorage.getItem('cast-device') || '';} catch {}
const selected = () => showingRemuxes ? savedVideos.find(item=>item.id===savedSelection) : videos.find(item=>item.id===selectedVideo) || sample;
function selectVideo(id) {
 if(showingRemuxes)savedSelection=id;
 else selectedVideo=id;
}
const active = () => !!playback.device && !['ERROR','IDLE'].includes(playback.state);
function icon(name) {const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('aria-hidden','true');const use=document.createElementNS(svg.namespaceURI,'use');use.setAttribute('href','#i-'+name);svg.append(use);return svg;}
function toast(message) {clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,3000);}
async function api(name,data) {
 const response=await fetch('/api/'+name,{method:data?'POST':'GET',headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});
 const result=await response.json();if(!response.ok)throw new Error(result.error || 'Request failed');return result;
}
function controls() {
 audioControls();seekControls();
 const video=selected();
 $('cast').disabled=working || scanning || !online || !selectedDevice || !video;
 $('copy-link').disabled=!video;
 $('toggle-play').disabled=working || !!playback.startup || !online || !active();$('stop').disabled=working || !!playback.startup || !online || !active();
 $('disconnect').disabled=!online || !playback.device;
 $('refresh').disabled=refreshPending;$('scan').disabled=durationLoading;
 $('scan').setAttribute('aria-label',scanning?'Stop scan':'Find videos');$('scan-icon').setAttribute('href',scanning?'#i-stop':'#i-search');
 $('track-picker').disabled=working || !online || !active() || !(playback.tracks||[]).some(x=>['TEXT','AUDIO'].includes(x.type));
 for(const [type,id] of [['AUDIO','audio-track'],['TEXT','subtitle-track']])$(id).disabled=working||!online||!active()||!(playback.tracks||[]).some(x=>x.type===type);
 $('cast-label').textContent=working?'Connecting…':`Cast ${video?.title || 'video'}`;
 for(const button of rowCastButtons)button.disabled=working || scanning || !online;
 $('play-icon').setAttribute('href',playback.state==='PLAYING'?'#i-pause':'#i-play');
 $('toggle-play').setAttribute('aria-label',playback.state==='PLAYING'?'Pause':'Play');
 $('device-name').textContent=devices.find(x=>x.id===selectedDevice)?.name || 'Choose a TV';
 $('now-title').textContent=video?.title || 'Choose a video';
 $('now-subtitle').textContent=video?.subtitle || '';
}
function renderVideos() {
 const listing=showingRemuxes ? savedVideos : videos;
 const current=selected()?.id;
 $('tracks').replaceChildren();$('video-count').textContent=listing.length;rowCastButtons=[];
 if(!listing.length){const empty=document.createElement('p');empty.className='list-empty';empty.textContent=showingRemuxes?'No saved remuxes':'No videos found';$('tracks').append(empty);}
 for(const video of listing) {
  const row=document.createElement('div');row.className='track'+(video.id===current?' selected':'');
  const select=document.createElement('button');select.className='select-track';select.setAttribute('aria-pressed',String(video.id===current));select.setAttribute('aria-label',`Select ${video.title}`);
  const check=document.createElement('span');check.className='check';check.append(icon('check'));
  const copy=document.createElement('span');copy.className='track-copy';const title=document.createElement('span');title.className='track-title';title.textContent=video.title;const subtitle=document.createElement('span');subtitle.className='track-sub';subtitle.textContent=video.subtitle;copy.append(title,subtitle);if(durationEnabled && !video.saved){const duration=document.createElement('span');duration.className='track-duration';duration.textContent=durationText(video);copy.append(duration);}
  select.append(check,copy);
  select.onclick=()=>{selectVideo(video.id);renderVideos();controls();};
  const castButton=document.createElement('button');castButton.className='row-cast';castButton.textContent='Cast';castButton.setAttribute('aria-label',`Cast ${video.title}`);
  castButton.onclick=()=>{selectVideo(video.id);renderVideos();if(!selectedDevice){$('device-dialog').showModal();refresh();return;}return action('cast',{deviceId:selectedDevice,videoId:video.id || undefined});};
  const more=document.createElement('button');more.className='icon-button row-more';more.setAttribute('aria-label',`More details for ${video.title}`);more.setAttribute('aria-haspopup','dialog');more.append(icon('more'));more.onclick=()=>openDetails(video);
  rowCastButtons.push(castButton);row.append(select,castButton);
  row.append(more);$('tracks').append(row);
 }
 controls();
}
function renderDevices() {
 $('device-list').replaceChildren();
 if(!devices.length){const p=document.createElement('p');p.className='device-empty';p.textContent=online?'No TVs found':'Helper offline';$('device-list').append(p);}
 for(const device of devices){const button=document.createElement('button');button.className='device-option';button.setAttribute('aria-pressed',String(device.id===selectedDevice));button.append(icon('cast'),document.createTextNode(device.name));button.onclick=()=>{selectedDevice=device.id;explicitlyDisconnected=false;try{localStorage.setItem('cast-device',selectedDevice);}catch{}renderDevices();controls();$('device-dialog').close();};$('device-list').append(button);}
 controls();
}
function showPlayback(status) {
 if(showingRemuxes && status.idleReason==='FINISHED' && playback.idleReason!=='FINISHED')void loadRemuxes();
 playback=status;if(status.version)$('version').textContent=`v${status.version}`;if(status.title)activeTitle=status.title;syncScan(status.scan);renderTracks();if('volume' in status && !audioPending && !audioSending && !audioDragging)audio=status.volume;audioControls();$('status').classList.toggle('error',status.state==='ERROR'||!!status.error);
 if(status.error)$('status').textContent=status.error;
 else if(status.startup)$('status').textContent=status.startup;
 else if(active()){$('status').textContent=({PLAYING:'Playing',PAUSED:'Paused',BUFFERING:'Buffering…',CONNECTING:'Connecting…'})[status.state] || status.state; if(activeTitle)$('status').textContent+=` · ${activeTitle}`; if(status.currentTime){const seconds=Math.floor(status.currentTime);$('status').textContent+=` · ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;}}
 else $('status').textContent=explicitlyDisconnected?'Disconnected':devices.length?'Ready to cast':'Searching for TVs…';
 if(status.statusWarning && !status.error && !status.startup)$('status').textContent=status.statusWarning;
 $('open-remux').hidden=!status.remuxUrl;
 if(status.remuxUrl)$('open-remux').href=status.remuxUrl;
 $('cast-diagnostics').hidden=!(status.error && status.diagnostics);
 controls();
}
async function refresh() {
 if(refreshPending)return;refreshPending=true;controls();
 try {const result=await api('devices');online=true;devices=result.devices;if(!devices.some(x=>x.id===selectedDevice))selectedDevice=explicitlyDisconnected?'':devices[0]?.id || '';renderDevices();showPlayback(result.playback);}
 catch {online=false;devices=[];$('status').textContent='Helper offline';$('status').classList.add('error');renderDevices();}
 finally {refreshPending=false;controls();}
}
async function action(name,data={}) {
 if(working)return;if(name==='cast'){$('cast-diagnostics').hidden=true;audioGeneration++;audio=null;audioPending=null;clearTimeout(audioTimer);}const requestedTitle=selected()?.title;working=true;controls();$('status').textContent=name==='cast'?'Connecting…':'Updating…';
 try {const result=await api(name,data);online=true;if(name==='cast')activeTitle=result.title||requestedTitle;showPlayback(result);}
 catch(err){$('status').textContent=err.message;$('status').classList.add('error');if(name==='tracks')renderTracks(true);if(name==='cast'){try{showPlayback(await api('status'));}catch{}}}
 finally {working=false;controls();if(showingRemuxes && ['cast','pause','stop'].includes(name))void loadRemuxes();}
}
let settingsRequest=0;
function settingsStatus(message) {
 const status=$('settings-status');
 status.textContent=message;
 status.hidden=!message;
}
async function openSettings() {
 const request=++settingsRequest;
 const list=$('settings-devices');
 list.replaceChildren();
 settingsStatus('Looking for receivers…');
 $('settings-dialog').showModal();
 try{
  const {devices:receivers}=await api('devices');
  if(request!==settingsRequest)return;
  const names=new Set();
  for(const receiver of receivers){
   if(names.has(receiver.name))continue;
   names.add(receiver.name);
   const row=document.createElement('label');
   row.className='settings-device';
   const title=document.createElement('span');
   title.textContent=receiver.name;
   const select=document.createElement('select');
   for(const [value,label] of [['remux','MP4 remux'],['hls','Direct HLS']]){
    const option=document.createElement('option');
    option.value=value;
    option.textContent=label;
    select.append(option);
   }
   select.value=receiver.castMode || 'remux';
   select.onchange=async()=>{
    const castMode=select.value;
    select.disabled=true;
    try{
     const saved=await api('device-settings',{deviceId:receiver.id,castMode});
     receiver.castMode=saved.castMode;
     if(request===settingsRequest)settingsStatus('Saved');
    }catch(err){
     select.value=receiver.castMode || 'remux';
     if(request===settingsRequest)settingsStatus(err.message);
    }finally{select.disabled=false;}
   };
   row.append(title,select);
   list.append(row);
  }
  settingsStatus(names.size?'':'No Cast receivers found.');
 }catch(err){if(request===settingsRequest)settingsStatus(err.message);}
}
$('settings-toggle').onclick=openSettings;
$('close-settings').onclick=()=>$('settings-dialog').close();
$('device-picker').onclick=()=>{$('device-dialog').showModal();refresh();};
$('close-devices').onclick=()=>$('device-dialog').close();
$('device-dialog').onclick=event=>{if(event.target===$('device-dialog')){const r=event.target.getBoundingClientRect();if(event.clientX<r.left || event.clientX>r.right || event.clientY<r.top || event.clientY>r.bottom)event.target.close();}};
$('refresh').onclick=refresh;
$('disconnect').onclick=async()=>{try{const result=await api('disconnect',{});explicitlyDisconnected=true;selectedDevice='';try{localStorage.removeItem('cast-device');}catch{}showPlayback(result);renderDevices();$('device-dialog').close();toast('Disconnected');if(showingRemuxes)void loadRemuxes();}catch(err){toast(err.message);}};
$('cast').onclick=()=>{
 const video=selected();
 if(video)return action('cast',{deviceId:selectedDevice,videoId:video.id || undefined});
};
$('toggle-play').onclick=()=>action(playback.state==='PLAYING'?'pause':'play');
$('stop').onclick=()=>action('stop');
async function copyURL(value, label = 'link', feedback) {
 const notify=message=>{
  if(!feedback)return toast(message);
  feedback.hidden=false;
  feedback.textContent=message;
 };
 try {
  if(navigator.clipboard && window.isSecureContext){
   await navigator.clipboard.writeText(value);
  }else{
   const previousFocus=document.activeElement;
   const input=document.createElement('textarea');
   input.value=value;
   input.readOnly=true;
   input.style.cssText='position:fixed;top:0;left:-9999px';
   (feedback?.closest('dialog') || document.body).append(input);
   try{
    input.select();
    input.setSelectionRange(0,value.length);
    if(!document.execCommand('copy'))throw new Error('Copy unavailable');
   }finally{
    input.remove();
    previousFocus?.focus();
   }
  }
  notify(label[0].toUpperCase()+label.slice(1)+' copied');
 }catch {notify('Could not copy '+label);}
}
function castDirectHLS(swiftAutoplay) {
 if(!detailsVideo)return;
 $('details-dialog').close();
 if(!selectedDevice){$('device-dialog').showModal();return;}
 return action('cast',{deviceId:selectedDevice,videoId:detailsVideo.id,directHLS:true,swiftAutoplay});
}
$('direct-hls').onclick=()=>castDirectHLS(false);
$('swift-autoplay').onclick=()=>castDirectHLS(true);
$('cast-diagnostics').onclick=()=>{
 if(!playback.diagnostics)return;
 const report={version:playback.version, steps:playback.startupSteps, ...playback.diagnostics};
 return copyURL(JSON.stringify(report,null,2), 'diagnostics');
};
$('copy-link').onclick=()=>{
 const video=selected();
 if(video)return copyURL(video.url);
};
function openDetails(video) {
 detailsVideo=video;
 $('details-link-section').open=false;
 $('details-advanced').open=false;
 const isHLS=video.format==='HLS' || /mpegurl/i.test(video.contentType);
 $('direct-hls').hidden=!isHLS;
 $('details-advanced').hidden=!isHLS;
 $('details-feedback').hidden=true;
 $('details-meta').textContent=[video.format,video.height?`${video.height}p`:null].filter(Boolean).join(' · ');
 $('details-name').textContent=video.title;
 $('details-url').value=video.url;
 $('details-open').href=video.url;
 $('details-open').textContent=video.saved?'Open MP4':'Open source';
 updateDetailsDuration();
 $('details-dialog').showModal();
}
$('close-details').onclick=()=>$('details-dialog').close();
$('details-copy').onclick=()=>detailsVideo && copyURL(detailsVideo.url,'link',$('details-feedback'));
$('details-dialog').onclick=event=>{if(event.target===$('details-dialog')){const r=event.target.getBoundingClientRect();if(event.clientX<r.left || event.clientX>r.right || event.clientY<r.top || event.clientY>r.bottom)event.target.close();}};
function timeLabel(seconds) {
 const n=Math.max(0,Math.floor(Number(seconds)||0)),h=Math.floor(n/3600),m=Math.floor(n%3600/60),s=String(n%60).padStart(2,'0');
 return h?`${h}:${String(m).padStart(2,'0')}:${s}`:`${m}:${s}`;
}
function seekControls() {
 const range=playback.seekRange;
 $('seek').disabled=!online || working || seekSending || !active() || !range;
 $('skip-back').disabled=$('seek').disabled;$('skip-forward').disabled=$('seek').disabled;
 if(seekDragging || seekSending)return;
 $('seek').min=range?.start || 0;$('seek').max=range?.end || 1;
 $('seek').value=Math.max(range?.start || 0,Math.min(range?.end || Infinity,playback.currentTime || 0));
 $('seek-current').textContent=timeLabel(playback.currentTime);
 $('seek-end').textContent=range?.live?'Live':playback.duration?timeLabel(playback.duration):'—';
 $('seek').setAttribute('aria-valuetext',range?.live?timeLabel(playback.currentTime):`${timeLabel(playback.currentTime)} of ${timeLabel(playback.duration)}`);
}
$('seek').onpointerdown=()=>{seekDragging=true;};
$('seek').onpointercancel=()=>{seekDragging=false;seekControls();};
$('seek').onpointerup=()=>{seekDragging=false;};
$('seek').oninput=()=>{seekDragging=true;$('seek-current').textContent=timeLabel($('seek').value);$('seek').setAttribute('aria-valuetext',timeLabel($('seek').value));};
async function seekTo(seconds) {
 const range=playback.seekRange;
 if(seekSending || working || !online || !active() || !range || !Number.isFinite(seconds))return;
 seconds=Math.max(range.start,Math.min(range.end,seconds));
 seekDragging=false;seekSending=true;seekControls();
 try{showPlayback(await api('seek',{seconds}));}
 catch(err){toast(err.message);}
 finally{seekSending=false;seekControls();}
}
$('seek').onchange=()=>seekTo(Number($('seek').value));
$('skip-back').onclick=()=>seekTo((playback.currentTime || 0)-10);
$('skip-forward').onclick=()=>seekTo((playback.currentTime || 0)+10);
function audioControls() {
 const available=online && !working && !!audio;
 const levelKnown=typeof audio?.level==='number';
 $('volume').disabled=!available || !levelKnown || audio.controlType==='fixed';
 $('mute').disabled=!available || typeof audio?.muted!=='boolean';
 if(!audioDragging && !audioPending && !audioSending){
  const percent=levelKnown?Math.round(audio.level*100):0;
  $('volume').value=percent;$('volume-value').textContent=levelKnown?`${percent}%`:'—';
 }
 $('mute').setAttribute('aria-label',audio?.muted?'Unmute':'Mute');
 $('mute').setAttribute('aria-pressed',String(!!audio?.muted));
 $('mute-icon').setAttribute('href',audio?.muted?'#i-muted':'#i-volume');
}
function queueAudio(update,immediate=false) {
 audioPending={...audioPending,...update};audio={...audio,...update};clearTimeout(audioTimer);audioControls();
 if(immediate)return flushAudio();
 audioTimer=setTimeout(flushAudio,150);
}
async function flushAudio() {
 clearTimeout(audioTimer);if(audioSending || !audioPending)return;
 const update=audioPending, generation=audioGeneration;audioPending=null;audioSending=true;
 try {const result=await api('volume',update);if(generation===audioGeneration && !audioPending)audio=result.volume;}
 catch(err){toast(err.message);}
 finally {audioSending=false;audioControls();if(audioPending)flushAudio();}
}
$('volume').onpointerdown=()=>{audioDragging=true;};
$('volume').onpointerup=()=>{audioDragging=false;};
$('volume').onpointercancel=()=>{audioDragging=false;audioControls();};
$('volume').oninput=()=>{const level=Number($('volume').value)/100;$('volume-value').textContent=`${Math.round(level*100)}%`;queueAudio({level,muted:false});};
$('volume').onchange=()=>{audioDragging=false;flushAudio();};
$('mute').onclick=()=>queueAudio({muted:!audio?.muted},true);
function durationText(video) {
 if(video.duration?.status==='vod'){
  const total=Math.round(video.duration.seconds), h=Math.floor(total/3600), m=Math.floor(total%3600/60), s=String(total%60).padStart(2,'0');
  return h?`${h}:${String(m).padStart(2,'0')}:${s}`:`${m}:${s}`;
 }
 if(video.duration?.status==='live')return 'Live';
 if(durationLoading && !video.duration && video.id)return 'Checking…';
 return 'Duration unavailable';
}
function updateDetailsDuration(){
 $('details-duration').hidden=!durationEnabled || !detailsVideo || detailsVideo.saved;
 if(detailsVideo)$('details-duration').textContent=durationText(videos.find(x=>x.id===detailsVideo.id) || detailsVideo);
}
async function loadDurations(){
 if(!durationEnabled || durationLoading || scanning || !videos.some(x=>x.id && !x.duration && !x.directLink))return;
 durationLoading=true;renderVideos();updateDetailsDuration();
 try{
  const result=await api('durations',{}), byId=new Map(result.videos.map(x=>[x.id,x.duration]));
  videos=videos.map(video=>byId.has(video.id)?{...video,duration:byId.get(video.id)}:video);
 }catch(err){if(durationEnabled)toast('Duration lookup failed');}
 finally{durationLoading=false;renderVideos();updateDetailsDuration();}
}
$('show-duration').onchange=()=>{
 durationEnabled=$('show-duration').checked;
 try{localStorage.setItem('cast-duration',String(durationEnabled));}catch{}
 renderVideos();updateDetailsDuration();if(durationEnabled)loadDurations();
};
function labelVideo(video,index){return {...video,title:video.title||`Video ${index+1}`,subtitle:[video.height?`${video.height}p`:null,video.format,new URL(video.url).hostname].filter(Boolean).join(' · ')};}
async function loadRemuxes() {
 const request=++savedRequest;
 try{
  const result=await api('remuxes');
  if(request!==savedRequest)return;
  savedVideos=result.videos.map(video=>({...video,
   url:new URL(video.url,window.location.origin).href,
   subtitle:video.position>0?'Resume at '+timeLabel(video.position):'Saved MP4'
  }));
  if(!savedVideos.some(video=>video.id===savedSelection))savedSelection=savedVideos[0]?.id || '';
  if(showingRemuxes)renderVideos();
 }catch(err){if(showingRemuxes)toast(err.message);}
}
function showLibraryTab(remuxes) {
 showingRemuxes=remuxes;
 $('videos-tab').setAttribute('aria-pressed',String(!remuxes));
 $('remuxes-tab').setAttribute('aria-pressed',String(remuxes));
 renderVideos();
 if(remuxes)void loadRemuxes();
}
$('videos-tab').onclick=()=>showLibraryTab(false);
$('remuxes-tab').onclick=()=>showLibraryTab(true);
async function loadLibrary(preserve=false){
 if(libraryLoading)return;libraryLoading=true;
 try{
  const result=await api('library');
  if(Array.isArray(result.videos)){videos=[sample,...result.videos.map(labelVideo)];if(!preserve||!videos.some(x=>x.id===selectedVideo))selectedVideo=videos.find(x=>x.id===result.playback?.mediaId)?.id ?? videos[0].id;}
  if(result.scan?.sourcePage&&!$('page-url').value)$('page-url').value=result.scan.sourcePage;
  if(result.playback)showPlayback(result.playback);renderVideos();if(durationEnabled&&!scanning)loadDurations();
 }catch(err){console.warn('Library unavailable:',err.message);}
 finally{libraryLoading=false;}
}
function syncScan(scan){
 if(!scan)return;const key=scan.id+':'+scan.state;if(key===libraryScanKey)return;libraryScanKey=key;
 if(['scanning','cancelling'].includes(scan.state)){
  scanning=true;$('scan-line').classList.add('busy');$('scan-status').textContent=scan.state==='cancelling'?'Stopping…':'Finding videos…';
 }else{
  scanning=false;$('scan-line').classList.remove('busy');
  if(!scanRequest){$('scan-status').textContent=scan.state==='cancelled'?'Scan cancelled':scan.state==='error'?'Scan failed':'Ready';if(scan.state==='complete')loadLibrary(true);}
 }
}
async function cancelScan(){
 if(!scanning)return;$('scan-status').textContent='Stopping…';
 try{await api('scan/cancel',{});scanning=false;$('scan-line').classList.remove('busy');$('scan-status').textContent='Scan cancelled';}
 catch(err){toast(err.message);}finally{controls();}
}
$('scan').onclick=event=>{if(scanning){event.preventDefault();cancelScan();}};
$('scan-form').onsubmit=async event=>{
 event.preventDefault();if(scanning)return cancelScan();if(durationLoading)return;
 const url=$('page-url').value.trim();if(!url)return;showLibraryTab(false);$('page-url').blur();scanning=true;scanRequest=true;controls();$('scan-line').classList.add('busy');$('scan-status').textContent='Finding videos…';
 const started=Date.now();const timer=setInterval(()=>{if(scanning)$('scan-status').textContent=`Finding videos… ${Math.floor((Date.now()-started)/1000)}s`;},1000);
 try{
  const result=await api('scan',{url});videos=[sample,...result.videos.map(labelVideo)];
  if(result.videos.length){selectedVideo=videos[1].id;$('scan-status').textContent=`${result.videos.length} video${result.videos.length===1?'':'s'} found`;}
  else{videos=[sample];selectedVideo='';$('scan-status').textContent='No videos found';}
  renderVideos();
 }catch(err){$('scan-status').textContent=/cancel/i.test(err.message)?'Scan cancelled':'Scan failed';if(!/cancel/i.test(err.message))toast(err.message);}
 finally{clearInterval(timer);scanRequest=false;scanning=false;$('scan-line').classList.remove('busy');controls();if(durationEnabled)loadDurations();}
};
function renderTracks(force=false){
 const tracks=playback.tracks||[],ids=playback.activeTrackIds||[],signature=JSON.stringify([tracks,ids]);if(!force&&signature===trackSignature)return;trackSignature=signature;
 for(const [type,id] of [['AUDIO','audio-track'],['TEXT','subtitle-track']]){
  const list=tracks.filter(x=>x.type===type),select=$(id);select.replaceChildren();
  const first=document.createElement('option');first.value='';first.textContent=type==='TEXT'?(list.length?'Off':'No subtitles'):(list.length?'Default':'No alternate audio');first.disabled=type==='AUDIO';select.append(first);
  for(const track of list){const option=document.createElement('option');option.value=String(track.trackId);option.textContent=track.name||track.language||`${type==='TEXT'?'Subtitle':'Audio'} ${track.trackId}`;select.append(option);}
  select.value=String(list.find(x=>ids.includes(x.trackId))?.trackId??'');select.disabled=!list.length||working;
 }
}
$('track-picker').onclick=()=>{renderTracks(true);$('tracks-dialog').showModal();};
$('close-tracks').onclick=()=>$('tracks-dialog').close();
$('audio-track').onchange=()=>action('tracks',{type:'AUDIO',trackId:Number($('audio-track').value)});
$('subtitle-track').onchange=()=>action('tracks',{type:'TEXT',trackId:$('subtitle-track').value===''?null:Number($('subtitle-track').value)});
renderVideos();refresh();loadLibrary();setInterval(async()=>{
 if(refreshPending||seekSending)return;if(working){try{const result=await api('status');showPlayback(result);}catch{}return;}if(!active())return refresh();
 try{const result=await api('status');online=true;showPlayback(result);}catch{online=false;$('status').textContent='Helper offline';controls();}
},3000);

