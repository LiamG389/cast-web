const {createHash}=require('node:crypto');
const volatile=/^(token|access_token|auth|authorization|signature|sig|expires|expiry|exp|policy|key-pair-id|hdnts|hdnea|jwt|__gda__|X-Amz-Algorithm|X-Amz-Credential|X-Amz-Date|X-Amz-Expires|X-Amz-SignedHeaders|X-Amz-Signature|X-Amz-Security-Token|X-Goog-Algorithm|X-Goog-Credential|X-Goog-Date|X-Goog-Expires|X-Goog-SignedHeaders|X-Goog-Signature|_HLS_msn|_HLS_part)$/i;
function stableURL(value) {
 try {
  const url = new URL(value);
  url.hash = '';
  // The CDN refreshes both signing parameters for the same chunklist.
  // Only normalize its identity here. Callers still use the captured URL.
  if (/\/chunklist\.m3u8$/i.test(url.pathname) &&
      url.searchParams.has('vendtime') && url.searchParams.has('vhash')) {
   url.searchParams.delete('vendtime');
   url.searchParams.delete('vhash');
   if (url.hostname.endsWith('.pipecdn.vip')) {
    url.searchParams.delete('vv');
    url.searchParams.delete('pub');
   }
  }
  for (const key of [...url.searchParams.keys()]) {
   if (volatile.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
 } catch {
  return value;
 }
}
function fingerprint(item){return createHash('sha256').update(stableURL(item.url)).digest('hex').slice(0,24);}
function attributes(text){const out={};for(const m of text.matchAll(/([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g))out[m[1]]=m[2]??m[3];return out;}
function parsePlaylist(text,base){
 const lines=text.split(/\r?\n/).map(x=>x.trim()),variants=[],renditions=[];
 for(let i=0;i<lines.length;i++){
  if(lines[i].startsWith('#EXT-X-STREAM-INF:')){const a=attributes(lines[i].slice(18));const uri=lines.slice(i+1).find(x=>x&&!x.startsWith('#'));if(!uri)continue;const resolution=a.RESOLUTION?.split('x').map(Number);variants.push({url:new URL(uri,base).href,width:resolution?.[0]||null,height:resolution?.[1]||null,bandwidth:Number(a.BANDWIDTH)||null,codecs:a.CODECS||null});}
  if(lines[i].startsWith('#EXT-X-MEDIA:')){const a=attributes(lines[i].slice(13));if(a.URI&&['AUDIO','SUBTITLES'].includes(a.TYPE))renditions.push({url:new URL(a.URI,base).href,type:a.TYPE,name:a.NAME||a.LANGUAGE||a.TYPE,language:a.LANGUAGE||null});}
 }
 const initFiles=lines.filter(line=>line.startsWith('#EXT-X-MAP:'))
  .map(line=>attributes(line.slice(11)).URI);
 const segments=lines.filter(line=>line && !line.startsWith('#'));
 const fragmentedMP4=segments.length>0 && initFiles.length>0 &&
  initFiles.every(uri=>/\.(?:mp4|m4[av]|cmf[av])(?:[?#]|$)/i.test(uri||'')) &&
  !segments.some(uri=>/\.ts(?:[?#]|$)/i.test(uri));
 const transportStream=!variants.length && segments.length>0 && segments.every(uri=>/\.ts(?:[?#]|$)/i.test(uri));
 return {variants,renditions,fragmentedMP4,transportStream};
}
function hlsCastInfo(url, playlists) {
 const playlist=playlists.get(url);
 if(!playlist)return {};
 const {variants,renditions,fragmentedMP4}=playlist;
 const isMaster=variants.length>0;
 const info={playlistType:isMaster?'master':'media'};
 // A master can advertise alternate audio. Only declare a format when all
 // referenced video and audio playlists agree.
 if(playlist.transportStream)return {...info,transportStream:true};
 if(isMaster){
  if(!variants.every(variant=>playlists.get(variant.url)?.fragmentedMP4))return info;
  if(renditions.some(track=>track.type==='AUDIO' && !playlists.get(track.url)?.fragmentedMP4))return info;
 }else if(!fragmentedMP4)return info;
 return {...info,hlsVideoSegmentFormat:'fmp4',hlsSegmentFormat:'fmp4'};
}
function enrichVideos(items,title,sourcePage){
 const unique=new Map();
 for(const original of items){if(original.role)continue;const item={...original,title:title||new URL(sourcePage).hostname,sourcePage};item.format=/mpegurl/i.test(item.contentType)?'HLS':/dash/i.test(item.contentType)?'DASH':/webm/i.test(item.contentType)?'WebM':/mp4/i.test(item.contentType)?'MP4':(item.contentType?.split('/')[1]||'Video').toUpperCase();
  const size=item.url.match(/(?:^|[\/_.?=&-])(\d{3,4})[xX](\d{3,4})(?:[\/_.?=&-]|$)/);const quality=item.url.match(/(?:^|[\/_.?=&-])(\d{3,4})p(?:[\/_.?=&-]|$)/i);item.height ||= size?Number(size[2]):quality?Number(quality[1]):null;
  item.fingerprint=fingerprint(item);const previous=unique.get(item.fingerprint);unique.set(item.fingerprint,previous?{...previous,...item,id:previous.id}:item);
 }
 return [...unique.values()].sort((a,b)=>(a.format==='HLS'?0:1)-(b.format==='HLS'?0:1)||(b.height||0)-(a.height||0));
}
function replacement(previous,candidates){
 const eligible=candidates.filter(x=>x.contentType===previous.contentType);
 const exact=eligible.find(x=>fingerprint(x)===fingerprint(previous));if(exact)return exact;
 const samePath=eligible.filter(x=>new URL(x.url).pathname===new URL(previous.url).pathname&&(!previous.height||x.height===previous.height));if(samePath.length===1)return samePath[0];
 return candidates.length===1&&eligible.length===1?eligible[0]:null;
}
module.exports={stableURL,fingerprint,parsePlaylist,hlsCastInfo,enrichVideos,replacement};
