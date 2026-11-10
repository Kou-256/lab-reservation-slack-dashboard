import {equipmentState,availability,DAY,jstDate,midnight,type Snapshot,type Equipment,type BookingView,type EquipmentState} from '../shared/dashboard.js';
import {occupancySegments} from '../shared/occupancy.js';
import {stirrerIllustration} from './stirrer.js';
import {durationLabel} from '../shared/duration.js';
import {ganttView} from './gantt.js';
import {dateFields,selectedDateTime} from './date-fields.js';
import {bookingPeriod} from './booking-period.js';
import {bookingStamp} from '../shared/booking-format.js';
import {parseResourceOrder,orderedResources} from '../shared/resource-order.js';
import {calendarView,calendarDetail,calendarDayDetail,calendarUpcoming} from './calendar.js';
import type {CalendarData} from '../shared/calendar.js';

const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const time=(ms:number)=>new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',hour12:false}).format(ms);
const dateLabel=(date:string)=>new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'long',day:'numeric',weekday:'short'}).format(midnight(date));
const stamp=bookingStamp;
const interval=(b:BookingView)=>`${stamp(b.start_at)} ～ ${stamp(b.end_at)}`;
const actionButton=(text:string,command:string,id:string,disabled=false,cls='')=>`<button class="${cls}" data-command="${command}" data-id="${esc(id)}" ${disabled?'disabled':''}>${text}</button>`;
let data:Snapshot|null=null,selected=new URL(location.href).searchParams.get('resource')??'',selectedDate=jstDate(Date.now()),received=0,receivedWall=0,serverTime=0,loading=false,failures=0;
let displayMode=['calendar','gantt'].includes(new URL(location.href).searchParams.get('view')??'')?new URL(location.href).searchParams.get('view')!:'cards',ganttRange:'day'|'workday'='day',ganttExpanded=false,ganttFilters=false;
let pollTimer:ReturnType<typeof setTimeout>|undefined,lastSignature='',lastRender='',busy=false;
let pending:{action:string;resource:Equipment;row?:BookingView;minutes?:number;requestId:string;wire?:Record<string,unknown>;confirmed:boolean}|null=null;
let wake:WakeLockSentinel|null=null;
let calendarWeekStart:0|1=preferences('lab-calendar-week-start')==='0'?0:1;
let calendarState:CalendarData|null=null,calendarMonth=jstDate(Date.now()).slice(0,7),calendarDay=jstDate(Date.now()),calendarReceived=0,calendarWall=0,calendarLoading=false,calendarError='',calendarRequest=0,calendarSignature='';
const calendarEquipment=new Set(parseResourceOrder(preferences('lab-calendar-equipment'))),calendarHiddenEvents=new Set(parseResourceOrder(preferences('lab-calendar-hidden-events')));
const calendarFresh=()=>Boolean(calendarState&&calendarState.month===calendarMonth&&Math.max(performance.now()-calendarReceived,Date.now()-calendarWall)<=30000);
const elapsed=()=>Math.max(performance.now()-received,Date.now()-receivedWall,0);
const now=()=>data?serverTime+elapsed():Date.now();
const fresh=()=>Boolean(data&&elapsed()<=30000);
const state=(r:Equipment):EquipmentState=>equipmentState(r,data!.reservations,data!.maintenance,now(),fresh());
function preferences(key:string,value?:string){try{if(value!==undefined)localStorage.setItem(key,value);return localStorage.getItem(key);}catch{return null;}}
function setTheme(theme:string){document.documentElement.dataset.theme=theme;$('theme').textContent=theme==='dark'?'ライト表示':'ダーク表示';preferences('lab-theme',theme);}
setTheme(preferences('lab-theme')??(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'));
$('theme').onclick=()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');
$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{toast('全画面にできませんでした。EdgeのF11も利用できます。');}};
document.addEventListener('fullscreenchange',()=>{$('fullscreen').textContent=document.fullscreenElement?'全画面を終了':'全画面';});
async function keepAwake(){try{if('wakeLock' in navigator&&!wake) {wake=await navigator.wakeLock.request('screen');wake.addEventListener('release',()=>{wake=null;});}}catch{/* Windows側の電源設定も導入手順で案内する。 */}}
function toast(message:string){$('toast').textContent=message;$('toast').hidden=false;setTimeout(()=>{$('toast').hidden=true;},9000);}
async function api(path:string,body?:Record<string,unknown>) {
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),9000);
  try {
    const response=await fetch('/dashboard/api/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,credentials:'same-origin',cache:'no-store',signal:controller.signal});
    if(!response.headers.get('Content-Type')?.includes('application/json'))throw new Error('サーバーから正しい応答を取得できませんでした。');
    const result=await response.json();
    if(response.status===401){showUnlock();throw new Error(result.error??'端末の認証が必要です。');}
    if(!response.ok)throw new Error(result.error??'通信に失敗しました。');
    return result;
  } finally {clearTimeout(timeout);}
}
function showUnlock(){calendarState=null;calendarRequest++;calendarLoading=false;calendarSignature='';document.body.dataset.ganttExpanded='false';data=null;lastSignature='';$('workspace').hidden=true;$('lock').hidden=true;$('pin-settings').hidden=true;$('unlock').hidden=false;$('main').replaceChildren();for(const id of ['booking-dialog','pin-dialog','history-dialog','gantt-dialog','order-dialog'])if($<HTMLDialogElement>(id).open)$<HTMLDialogElement>(id).close();if(pollTimer)clearTimeout(pollTimer);}
$<HTMLFormElement>('unlock-form').onsubmit=async event=>{
  event.preventDefault();const form=event.currentTarget as HTMLFormElement,button=form.querySelector('button')!;button.disabled=true;$('unlock-error').textContent='';
  try{await api('unlock',{key:(new FormData(form).get('key')??'').toString()});form.reset();await refresh();}catch(error){$('unlock-error').textContent=message(error);}finally{button.disabled=false;}
};
$('lock').onclick=async()=>{try{await api('lock',{});showUnlock();}catch(error){toast(message(error));}};
function message(error:unknown){return error instanceof Error?error.message:'処理に失敗しました。';}
async function refresh(){
  if(loading)return;loading=true;clearTimeout(pollTimer);const started=performance.now();let rerun=false;
  try {
    const result=await api('snapshot'+(data?'?date='+selectedDate:'')) as Snapshot;
    if(!Array.isArray(result.resources)||!Array.isArray(result.reservations)||!Array.isArray(result.maintenance)||!Number.isFinite(result.server_time))throw new Error('予約情報の形式を確認できませんでした。');
    // 日付を素早く切り替えた場合、前の取得結果を新しい日付の情報として表示しない。
    if(data&&result.date!==selectedDate){rerun=true;return;}
    if(!data)selectedDate=result.date;
    data=result;serverTime=result.server_time+(performance.now()-started)/2;received=performance.now();receivedWall=Date.now();failures=0;
    $('unlock').hidden=true;$('workspace').hidden=false;$('lock').hidden=false;$('pin-settings').hidden=false;
    const signature=JSON.stringify({...result,server_time:0});
    if(signature!==lastSignature){lastSignature=signature;render();}update();void keepAwake();if(displayMode==='calendar')void refreshCalendar();
  } catch(error){failures++;if(data){$('warning').textContent='通信が不安定です。自動で再接続します。 '+message(error);$('warning').hidden=false;update();}else $('unlock-error').textContent=message(error);}
  finally{loading=false;if(data)pollTimer=setTimeout(()=>void refresh(),rerun?0:Math.min(10000*2**Math.min(failures,2),40000));}
}
$('refresh').onclick=()=>void refresh();

for(const id of ['filter','sort'])$(id).addEventListener('change',render);
$('calendar-toggle').onclick=()=>{selected='';displayMode='calendar';render();void refreshCalendar();};
$('gantt-toggle').onclick=()=>{selected='';displayMode=displayMode==='gantt'?'cards':'gantt';render();};
if(parseResourceOrder(preferences('lab-resource-order')).length)$<HTMLSelectElement>('sort').value='custom';
$('edit-order').onclick=()=>openOrder();
$('search').addEventListener('input',()=>{selected='';render();});
function update(){
  $('clock').textContent=new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(now());
  if(!data)return;
  const states=data.resources.map(state),calendarPending=displayMode==='calendar'&&calendarLoading&&(!calendarState||calendarState.month!==calendarMonth),good=fresh()&&(displayMode!=='calendar'||calendarPending||calendarFresh());
  $('connection').textContent=calendarPending?'予定取得中':!good?'情報が古くなっています':(failures||(displayMode==='calendar'&&calendarError))?'再接続中':'接続正常';$('connection').dataset.health=good&&!failures?'ok':'error';
  if($('gantt-clock'))$('gantt-clock').textContent=time(now());if($('gantt-health'))$('gantt-health').textContent=$('connection').textContent;
  $('updated').textContent=`最終取得 ${time(serverTime)}:${new Date(serverTime).getUTCSeconds().toString().padStart(2,'0')}（${Math.floor(elapsed()/1000)}秒前）`;
  $('counts').innerHTML=`<span>登録設備 <b>${data.resources.length}</b></span><span>空きあり <b>${good?states.filter(s=>s.status!=='unavailable'&&s.available>0).length:'—'}</b></span><span>予約時間中 <b>${good?states.filter(s=>s.current.length).length:'—'}</b></span>`;
  if(!good){$('warning').textContent='最新の予約状態を確認できません。前回取得した情報を参考表示しています。予約操作は再接続後に行ってください。';$('warning').hidden=false;}
  else if(!failures)$('warning').hidden=true;
  const signature=JSON.stringify([states.map(s=>[s.status,s.current.map(b=>b.id),s.next.map(b=>b.id),s.available,s.offline]),displayMode==='calendar'?[calendarFresh(),calendarPending,calendarError]:null]);
  if(signature!==lastRender){lastRender=signature;render();}
  document.querySelectorAll<HTMLElement>('[data-countdown]').forEach(el=>{const delta=Number(el.dataset.countdown)-now();el.textContent=delta>0?`あと${durationLabel(delta)}`:'開始時刻です';});
  // 日付が変わったら当日表示を追従する。閲覧中の過去・未来日は勝手に切り替えない。
  const today=jstDate(now());if(data.date===jstDate(serverTime)&&selectedDate!==today){selectedDate=today;void refresh();}
}
function render(){
  if(!data)return;
  const previousEquipment=document.querySelector<HTMLDetailsElement>('.calendar-equipment'),equipmentOpen=previousEquipment?.open??false,equipmentScroll=previousEquipment?.querySelector<HTMLElement>(':scope > div')?.scrollTop??0;
  const previousScroll=document.querySelector<HTMLElement>('.gantt-scroll');
  const chartScroll={top:previousScroll?.scrollTop??0,left:previousScroll?.scrollLeft??0};
  const main=$('main'),active=document.activeElement as HTMLElement|null,focus=active?.dataset.command&&{command:active.dataset.command,id:active.dataset.id};
  const resource=data.resources.find(r=>r.id===selected);if(selected&&!resource){selected='';toast('この設備の表示情報が変更されました。');}
  document.body.dataset.view=resource?'detail':displayMode==='gantt'?'gantt':displayMode==='calendar'?'calendar':'overview';
  document.body.dataset.ganttExpanded=String(!resource&&displayMode==='gantt'&&ganttExpanded);document.body.dataset.ganttFilters=String(ganttFilters);
  $('calendar-toggle').setAttribute('aria-pressed',String(!resource&&displayMode==='calendar'));
  $('gantt-toggle').textContent=displayMode==='gantt'&&!resource?'カード表示':'全体スケジュール';$('gantt-toggle').setAttribute('aria-pressed',String(displayMode==='gantt'&&!resource));
  if($<HTMLDialogElement>('gantt-dialog').open)$<HTMLDialogElement>('gantt-dialog').close();
  const displayURL=new URL(location.href);if(resource)displayURL.searchParams.set('resource',resource.id);else displayURL.searchParams.delete('resource');if(!resource&&['gantt','calendar'].includes(displayMode))displayURL.searchParams.set('view',displayMode);else displayURL.searchParams.delete('view');history.replaceState(null,'',displayURL);

  if(resource){main.innerHTML=detail(resource);}
  else if(displayMode==='calendar'){main.innerHTML=calendarView(calendarState,calendarMonth,calendarDay,visibleCalendarResources(),now(),calendarFresh(),calendarError,calendarWeekStart);}
  else {
    const search=$<HTMLInputElement>('search').value.trim().toLocaleLowerCase(),filter=$<HTMLSelectElement>('filter').value;
    let resources=data.resources.filter(r=>(r.name+' '+r.room).toLocaleLowerCase().includes(search)).filter(r=>{const s=state(r);return filter==='all'||filter==='free'&&s.available>0&&s.status!=='unavailable'&&s.status!=='unknown'||filter===s.status;});
    const sort=$<HTMLSelectElement>('sort').value;
    if(sort==='custom')resources=orderedResources(resources,parseResourceOrder(preferences('lab-resource-order')));
    if(sort==='name')resources.sort((a,b)=>a.name.localeCompare(b.name,'ja'));
    if(sort==='next')resources.sort((a,b)=>(state(a).next[0]?.start_at??Infinity)-(state(b).next[0]?.start_at??Infinity));
    if(displayMode==='gantt')main.innerHTML=ganttView(data,selectedDate,resources,now(),fresh(),ganttRange,ganttExpanded,ganttFilters);
    else main.innerHTML=`<div class="list-heading"><h2>設備の予約状況</h2><span>設備を選ぶと大きく表示できます</span></div><div class="equipment-grid">${resources.map(card).join('')}</div>${resources.length?'':'<p class="empty">該当する設備はありません。絞り込みを変更してください。</p>'}`;
  }
  if(focus)main.querySelectorAll<HTMLElement>('[data-command]').forEach(el=>{if(el.dataset.command===focus.command&&el.dataset.id===focus.id)el.focus({preventScroll:true});});
  const weekSelect=main.querySelector<HTMLSelectElement>('#calendar-week-start');if(weekSelect)weekSelect.value=String(calendarWeekStart);
  const nextEquipment=main.querySelector<HTMLDetailsElement>('.calendar-equipment');if(nextEquipment){nextEquipment.open=equipmentOpen;const list=nextEquipment.querySelector<HTMLElement>(':scope > div');if(list)list.scrollTop=equipmentScroll;}
  const nextScroll=main.querySelector<HTMLElement>('.gantt-scroll');if(nextScroll){nextScroll.scrollTop=chartScroll.top;nextScroll.scrollLeft=chartScroll.left;}
}
function bookingInfo(r:Equipment,s:EquipmentState,large=false){
  const rows=s.current.length?s.current:s.next,b=rows[0];
  if(!b)return `<p class="booking-time no-booking">次の予約なし</p><p class="muted">本日の空き時間は下のスケジュールで確認できます</p>`;
  if(large)return `<div class="reservation-caption"><p class="purpose">${esc(b.purpose||'用途の記載なし')}</p><span class="reservation-context">${s.current.length?'現在の予約':'次の予約'}${rows.length>1?`（${rows.length}件中1件）`:''}</span></div><div class="reservation-owner booking-person"><span><span class="owner-label">予約者</span> <strong>${esc(b.person)}</strong>${rows.length>1?` <small>ほか${rows.length-1}件</small>`:''}</span>${r.type==='quantity_resource'?`<span class="reservation-quantity">${b.quantity}台${b.pool_id?'・'+esc(r.pools.find(p=>p.id===b.pool_id)?.name??''):''}</span>`:''}${!s.current.length?`<span class="period-countdown" data-countdown="${b.start_at}">あと${durationLabel(b.start_at-now())}</span>`:''}</div>${bookingPeriod(b.start_at,b.end_at)}`;

  return `<p class="purpose">${esc(b.purpose||'用途の記載なし')}</p><p class="booking-date">${s.current.length?'現在の予約':'次の予約'}${s.current.length>1?`・${s.current.length}件`:''} ／ ${esc(dateLabel(jstDate(b.start_at)))}${jstDate(b.start_at)!==jstDate(b.end_at)?' ～ '+esc(dateLabel(jstDate(b.end_at))):''}${large&&!s.current.length?` ／ <span data-countdown="${b.start_at}">あと${durationLabel(b.start_at-now())}</span>`:''}</p><p class="booking-time ${large?'large':''} ${jstDate(b.start_at)!==jstDate(b.end_at)?'cross-day':''}">${esc(interval(b))}</p><div class="booking-person"><span>${esc(b.person)}${rows.length>1?` ほか${rows.length-1}件`:''}</span>${r.type==='quantity_resource'?`<span>${b.quantity}台${b.pool_id?'・'+esc(r.pools.find(p=>p.id===b.pool_id)?.name??''):''}</span>`:''}</div>${s.next[0]&&!large?`<p class="next-note">${s.current.length?'次回 '+esc(stamp(s.next[0].start_at))+' ／ ':''}<span data-countdown="${s.next[0].start_at}">あと${durationLabel(s.next[0].start_at-now())}</span></p>`:''}`;
}
// 予約時間中だけ左側に次の予約を表示する。空き状態では中央の表示と重複させない。
function nextPreview(s:EquipmentState){if(!s.current.length)return '';const b=s.next[0];return `<aside class="next-preview"><h3>次の予約</h3>${b?`<p class="next-person">${esc(b.person)}${s.next.length>1?` ほか${s.next.length-1}件`:''}</p><p class="next-range"><span>開始 ${esc(bookingStamp(b.start_at,false))}</span><span>終了 ${esc(bookingStamp(b.end_at,false))}</span></p>`:'<p>予定なし</p>'}</aside>`;}
function statusCircle(s:EquipmentState){const label=s.label.split('・').map(part=>`<span>${esc(part)}</span>`).join('');const shape={free:'<path d="m5 12 4 4 10-10"/>',soon:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6h5"/>',booked:'<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4m8-4v4M4 10h16"/>',unavailable:'<path d="M5 12h14"/><circle cx="12" cy="12" r="9"/>',unknown:'<path d="M8 8a4 4 0 1 1 6 3.5c-2 1-2 2-2 3M12 18v1"/>'}[s.status];return `<div class="status-circle ${s.status}" aria-label="${esc(s.label)}"><svg class="status-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shape}</svg><strong>${label}</strong>${s.status==='unknown'?'<small>最終取得時点の情報</small>':''}</div>`;}
function quantities(r:Equipment,s:EquipmentState){return r.type==='quantity_resource'?`<div class="quantities"><strong>予約可能 ${fresh()?s.available:'—'} / ${r.capacity??'未設定'}台</strong><span class="quantity-item">予約中 ${s.current.reduce((n,b)=>n+b.quantity,0)}台</span><span class="quantity-item">故障点検 ${s.offline}台</span>${s.poolAvailable.map(p=>`<span class="pool-free">${esc(p.name)}：${fresh()?p.available:'—'}台空き</span>`).join('')}${s.current.some(b=>!b.pool_id)&&r.pools.length?'<small>場所未設定予約は各場所の空きから差し引いています</small>':''}</div>`:'';}
function card(r:Equipment){const s=state(r);return `<article class="equipment-card ${s.status}"><header><h3>${esc(r.name)}</h3></header><div class="card-body"><div class="card-status">${statusCircle(s)}</div><div class="card-booking">${bookingInfo(r,s)}</div></div>${quantities(r,s)}<div class="card-actions">${actionButton('大きく表示・詳細','detail',r.id)}${actionButton('予約する','create',r.id,!fresh()||!r.enabled||r.capacity===null,'primary')}</div>${timeline(r,selectedDate,true)}</article>`;}
function timeline(r:Equipment,date:string,compact=false){
  const start=midnight(date),end=start+DAY,rows=data!.reservations.filter(b=>b.resource_id===r.id&&b.start_at<end&&b.end_at>start),stops=data!.maintenance.filter(m=>m.resource_id===r.id&&m.start_at<end&&(m.end_at===null||m.end_at>start));
  const pos=(n:number)=>Math.max(0,Math.min(100,(n-start)/DAY*100));
  // 重複する予約を別レーンへ割り当て、数量予約も重ねて隠さない。
  const lanes:BookingView[][]=[];for(const b of rows){const lane=lanes.find(l=>l[l.length-1].end_at<=b.start_at);if(lane)lane.push(b);else lanes.push([b]);}
  const blocks=lanes.map(l=>`<div class="timeline-lane">${l.map(b=>`<button class="time-block ${b.start_at<=now()&&now()<b.end_at?'active':''}" data-command="${compact?'detail':'booking-detail'}" data-id="${esc(compact?r.id:b.id)}" style="left:${pos(b.start_at)}%;width:${Math.max(.35,pos(b.end_at)-pos(b.start_at))}%" aria-label="${esc(interval(b)+' '+b.person+' '+b.purpose+(r.type==='quantity_resource'?' '+b.quantity+'台':''))}" title="${esc(interval(b)+' '+b.person)}">${compact?'':esc((r.type==='quantity_resource'?b.quantity+'台 ':'')+time(b.start_at)+' '+b.person)}</button>`).join('')}</div>`).join('');
  if(r.type==='quantity_resource'&&!compact)return quantityTimeline(r,date,start,end,pos);
  return `<div class="schedule ${compact?'compact':''}"><div class="schedule-heading"><strong>${esc(dateLabel(date))}</strong><span>本日の予約 ${rows.length}件</span></div><div class="timeline-scroll"><div class="timeline"><div class="time-ruler">${Array.from({length:13},(_,i)=>`<span style="left:${i/12*100}%">${String(i*2).padStart(2,'0')}</span>`).join('')}</div><div class="timeline-tracks">${blocks||'<div class="timeline-lane empty-lane">予約なし</div>'}${stops.map(m=>`<div class="timeline-lane"><span class="maintenance-block" style="left:${pos(m.start_at)}%;width:${Math.max(.35,pos(m.end_at??end)-pos(m.start_at))}%" title="${esc(m.reason)}">故障・点検</span></div>`).join('')}${now()>=start&&now()<end?`<span class="now-line" style="left:${pos(now())}%" aria-label="現在時刻"></span>`:''}</div></div></div></div>`;
}
function quantityTimeline(r:Equipment,date:string,start:number,end:number,pos:(n:number)=>number){
  const groups=r.pools.length?r.pools:[{id:undefined,name:'予約台数',capacity:r.capacity??0}];
  return `<div class="schedule quantity-schedule"><div class="schedule-heading"><strong>${esc(dateLabel(date))}の予約台数</strong><span>数字は予約中の台数 ／ 各区間をタップで詳細</span></div><div class="usage-axis"><span>場所</span><div class="time-ruler">${Array.from({length:13},(_,i)=>`<span style="left:${i/12*100}%">${String(i*2).padStart(2,'0')}</span>`).join('')}</div></div><div class="usage-rows">${groups.map(group=>`<div class="usage-row"><strong>${esc(group.name)}<small>${group.capacity}台</small></strong><div class="usage-track">${occupancySegments(r,data!.reservations,data!.maintenance,start,end,group.id).map(s=>{
    const endTime=s.end===end?'24:00':time(s.end);const label=`${group.name} ${time(s.start)}～${endTime}：予約中${s.booked}台${s.unknown?'・場所未設定'+s.unknown+'台':''}・故障点検${s.offline}台・予約可能${s.free}台`;
    return `<button class="usage-block ${s.booked?'reserved':s.offline||s.unknown?'uncertain':'available'}" data-command="usage-info" data-label="${esc(label)}" aria-label="${esc(label)}" style="left:${pos(s.start)}%;width:${Math.max(.1,pos(s.end)-pos(s.start))}%"><span>${s.booked}台${s.unknown?'＋?':''}</span></button>`;
  }).join('')}${now()>=start&&now()<end?`<span class="now-line" style="left:${pos(now())}%"></span>`:''}</div></div>`).join('')}</div></div>`;
}
function detail(r:Equipment){
  const s=state(r),start=midnight(selectedDate),end=start+DAY,rows=data!.reservations.filter(b=>b.resource_id===r.id&&b.start_at<end&&b.end_at>start);
  const gaps=availability(r,data!.reservations,data!.maintenance,start,end).filter(g=>g.quantity>0);
  const stops=data!.maintenance.filter(m=>m.resource_id===r.id&&m.start_at<end&&(m.end_at===null||m.end_at>start));
  return `<section class="equipment-detail ${s.status} ${r.pools.length?'has-stirrers':''}"><div class="equipment-title"><div><span class="room">${esc(r.room)}</span><h2>${esc(r.name)}</h2></div><button class="gantt-open" data-command="gantt">全体スケジュール</button></div><div class="display-board"><div class="display-status">${statusCircle(s)}${quantities(r,s)}${nextPreview(s)}</div><div class="display-reservation">${bookingInfo(r,s,true)}<div class="display-actions">${actionButton('今すぐ予約','now',r.id,!fresh()||!r.enabled||r.capacity===null,'primary')}${actionButton('日時を指定して予約','create',r.id,!fresh()||!r.enabled||r.capacity===null)}</div></div>${r.pools.length?stirrerIllustration(r,data!.reservations,data!.maintenance,now(),fresh()):''}</div><div class="date-navigation"><button data-day="-1" aria-label="前日の予約">前日</button><label>表示日<input id="schedule-date" type="date" value="${selectedDate}"></label><button data-day="1" aria-label="翌日の予約">翌日</button><button data-day="today">今日</button><span class="selected-day">${esc(dateLabel(selectedDate))}</span><button data-command="history" data-id="${esc(r.id)}">過去の履歴</button></div>${timeline(r,selectedDate)}<div class="detail-columns"><section><h3>${esc(dateLabel(selectedDate))}の予約</h3>${rows.length?rows.map(b=>bookingRow(r,b)).join(''):'<p class="empty">この日の予約はありません</p>'}${stops.map(m=>`<p class="maintenance-note">故障・点検：${esc(m.reason)}<br>${esc(stamp(m.start_at))} ～ ${m.end_at===null?'復旧まで':esc(stamp(m.end_at))}${m.quantity?`・${m.quantity}台`:''}</p>`).join('')}</section><section><h3>空き時間${r.type==='quantity_resource'?'・予約可能台数':''}</h3>${fresh()?gaps.length?gaps.map(g=>`<p class="gap"><span>${time(g.start)} ～ ${g.end===end?'24:00':time(g.end)}</span><strong>${r.type==='quantity_resource'?g.quantity+'台':'空き'}</strong></p>`).join(''):'<p class="empty">予約できる時間帯はありません</p>':'<p class="empty">再接続後に確認できます</p>'}<p class="muted">${r.pools.length?'台数は全体の空きです。場所別の上限は予約時に確認します。':'確定時に最新の空きを再確認します。'}</p><p class="muted">翌日以降は上の日付で確認できます。</p></section></div></section>`;
}
function bookingRow(r:Equipment,b:BookingView){const active=b.start_at<now()&&now()<b.end_at;return `<article class="booking-row" id="booking-${esc(b.id)}"><div><strong>${esc(interval(b))}</strong><span>${esc(b.person)}${r.type==='quantity_resource'?'・'+b.quantity+'台':''}${b.pool_id?'・'+esc(r.pools.find(p=>p.id===b.pool_id)?.name??''):''}</span><p>${esc(b.purpose||'用途の記載なし')}</p></div>${b.end_at>now()?`<div class="row-actions">${actionButton('変更','edit',b.id,!fresh())}${actionButton('キャンセル','cancel',b.id,!fresh())}${active?actionButton('今すぐ終了','finish',b.id,!fresh())+actionButton('30分延長','extend',b.id,!fresh()):''}</div>`:'<span class="ended">終了</span>'}</article>`;}
document.addEventListener('click',event=>{
  const target=(event.target as Element).closest<HTMLElement>('[data-command],[data-day],[data-close]');if(!target)return;
  if(target.hasAttribute('data-close')){if(!busy)$<HTMLDialogElement>('booking-dialog').close();return;}
  if(target.dataset.day){selectedDate=target.dataset.day==='today'?jstDate(now()):jstDate(midnight(selectedDate)+Number(target.dataset.day)*DAY);void refresh();return;}
  const command=target.dataset.command,id=target.dataset.id!;if(!data)return;
  if(command==='calendar'){selected='';displayMode='calendar';render();void refreshCalendar();return;}
  if(command?.startsWith('calendar-')){calendarCommand(command,target);return;}
  if(command==='gantt'){selected='';displayMode='gantt';render();$('main').focus();return;}
  if(command==='order-up'||command==='order-down'){moveOrder(id,command==='order-up'?-1:1);return;}
  if(command==='gantt-expand'){ganttExpanded=!ganttExpanded;render();return;}
  if(command==='gantt-filters'){ganttExpanded=false;ganttFilters=!ganttFilters;render();return;}
  if(command==='gantt-booking'){openGanttBooking(id);return;}
  if(command==='history'){void openHistory(id);return;}
  if(command==='usage-info'){toast(target.dataset.label!);return;}
  if(command==='overview'){selected='';displayMode='cards';render();$('main').focus();return;}
  if(command==='detail'){selected=id;render();$('main').focus();return;}
  if(command==='booking-detail'){$('booking-'+id)?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'});return;}
  const row=data.reservations.find(b=>b.id===id),r=data.resources.find(r=>r.id===(row?.resource_id??id));if(!r)return;
  openBooking(r,command==='now'?'create':command==='edit'?'update':command!,row,command==='now');
});
document.addEventListener('change',event=>{const target=event.target as HTMLInputElement;if(target.id.startsWith('calendar-')||target.hasAttribute('data-calendar-resource')){calendarChange(target);return;}if(target.id==='gantt-range'){ganttRange=target.value==='workday'?'workday':'day';render();return;}if((target.id==='schedule-date'||target.id==='gantt-date')&&target.value){selectedDate=target.value;void refresh();}if(target.name==='purpose_choice')togglePurpose();if(/^(start|end)_(year|month)$/.test(target.name))syncDays(target.name.split('_')[0]);});
function togglePurpose(){const form=$<HTMLFormElement>('booking-form'),choice=form.elements.namedItem('purpose_choice') as HTMLSelectElement|null,purpose=form.elements.namedItem('purpose') as HTMLTextAreaElement|null;if(purpose)purpose.closest('label')!.hidden=Boolean(choice&&choice.value&&choice.value!=='自由入力');}
function openBooking(r:Equipment,action:string,row?:BookingView,startNow=false){
  if(!fresh()){toast('最新情報を取得してから予約してください。');return;}
  const dialog=$<HTMLDialogElement>('booking-dialog'),form=$<HTMLFormElement>('booking-form');form.reset();
  pending={action,resource:r,row,minutes:30,requestId:crypto.randomUUID(),confirmed:false};
  const start=startNow||selectedDate===jstDate(now())?Math.ceil(now()/60000)*60000:midnight(selectedDate)+9*3600000;
  $('booking-title').textContent=({create:startNow?'今すぐ予約':'日時を指定して予約',update:'予約を変更',cancel:'予約をキャンセル',finish:'利用を今すぐ終了',extend:'予約を30分延長'} as Record<string,string>)[action];
  $('booking-equipment').textContent=r.name+(row?' ／ '+row.person+' ／ '+interval(row):'');
  const choice=row?(row.purpose&&r.purposes.includes(row.purpose)?row.purpose:'自由入力'):r.purposes[0]??'';
  $('booking-fields').innerHTML=['create','update'].includes(action)?`<div class="form-grid">${startNow?'<p class="start-now">開始：予約確定時の現在時刻</p>':dateFields('start',row?.start_at??start,now())}${dateFields('end',row?.end_at??start+3600000,now())}${r.type==='quantity_resource'?`<label class="booking-choice">使用台数<select name="quantity" required>${row&&row.quantity>(r.capacity??1)?`<option value="${row.quantity}" selected>${row.quantity}台（現在の予約）</option>`:''}${Array.from({length:r.capacity??1},(_,i)=>`<option value="${i+1}" ${i+1===(row?.quantity??1)?'selected':''}>${i+1}台</option>`).join('')}</select></label>`:''}${r.pools.length?`<label class="booking-choice">使用場所<select name="pool_id" required><option value="">選択してください</option>${r.pools.map(p=>`<option value="${esc(p.id)}" ${row?.pool_id===p.id?'selected':''}>${esc(p.name)}（${p.capacity}台）</option>`).join('')}</select></label>`:''}</div>${r.purposes.length?`<label>用途<select name="purpose_choice">${r.purposes.map(p=>`<option ${p===choice?'selected':''}>${esc(p)}</option>`).join('')}</select></label>`:''}<label>用途の内容<textarea name="purpose" maxlength="300" rows="2" placeholder="例：試料の測定">${esc(row?.purpose??'')}</textarea></label><input type="hidden" name="start_now" value="${startNow?'1':'0'}">`:`<p class="confirm-operation">${esc(({cancel:'この予約をキャンセルします。確定後は予約枠が解放されます。',finish:'終了時刻を確定時点の現在時刻に変更します。実稼働の記録ではありません。',extend:'終了時刻を30分延長します。他の予約と重なる場合は保存できません。'} as Record<string,string>)[action])}</p>`;
  const users=form.elements.namedItem('user') as HTMLSelectElement;users.innerHTML='<option value="">選択してください</option>'+data!.members.map(m=>`<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
  $('booking-error').textContent='';$('booking-submit').textContent='内容を確認する';$('booking-note').textContent='個人PINはこの操作の確認にだけ使い、端末に保存しません。';togglePurpose();dialog.showModal();
}
const form=$<HTMLFormElement>('booking-form');
// PINの再入力では操作IDを変更しない。通信切断後の再試行も同じ予約として扱う。
function invalidateConfirmation(event:Event){if((event.target as HTMLInputElement).name==='pin')return;if(pending?.confirmed&&!busy){pending.confirmed=false;pending.wire=undefined;pending.requestId=crypto.randomUUID();$('booking-submit').textContent='内容を確認する';}}
form.addEventListener('input',invalidateConfirmation);
form.addEventListener('change',invalidateConfirmation);
form.onsubmit=async event=>{
  event.preventDefault();if(!pending||busy)return;
  if(!fresh()){$('booking-error').textContent='接続を確認してから確定してください。';void refresh();return;}
  const values=new FormData(form),p=pending;
  const wire:Record<string,unknown>={request_id:p.requestId,action:p.action,resource_id:p.resource.id,user:values.get('user'),reservation_id:p.row?.id,version:p.row?.version,minutes:p.minutes};
  if(['create','update'].includes(p.action)){
    const startNow=values.get('start_now')==='1',start=startNow?Math.ceil(now()/60000)*60000:Date.parse(selectedDateTime(values,'start')+'+09:00'),end=Date.parse(selectedDateTime(values,'end')+'+09:00');
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end<=now()){$('booking-error').textContent='終了は開始・現在時刻より後にしてください。';return;}
    const choice=values.get('purpose_choice')?.toString()??'';
    Object.assign(wire,{start_now:startNow,start_at:start,end_at:end,quantity:Number(values.get('quantity')??1),pool_id:values.get('pool_id')||null,purpose_choice:choice==='自由入力'?'':choice,purpose:!choice||choice==='自由入力'?values.get('purpose')?.toString().trim()??'':choice});
  }
  if(!p.confirmed){p.wire=wire;p.confirmed=true;$('booking-submit').textContent='この内容で確定する';$('booking-note').textContent='内容と氏名を確認し、もう一度押すと確定します。';$('booking-error').textContent='';return;}
  busy=true;const pin=form.elements.namedItem('pin') as HTMLInputElement,pinValue=pin.value;
  form.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('button,input,select,textarea').forEach(el=>el.disabled=true);$('booking-submit').textContent='保存しています…';$('booking-error').textContent='';
  try{
    const result=await api('bookings',{...p.wire,pin:pinValue});pin.value='';$<HTMLDialogElement>('booking-dialog').close();toast(result.message);await refresh();
  }catch(error){$('booking-error').textContent=message(error)+' 通信エラーの場合は、内容を変えずにPINを再入力して再試行できます。';pin.value='';}
  finally{busy=false;form.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('button,input,select,textarea').forEach(el=>el.disabled=false);$('booking-submit').textContent='この内容で確定する';}
};
const dialog=$<HTMLDialogElement>('booking-dialog');dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});dialog.addEventListener('close',()=>{form.reset();pending=null;});
window.addEventListener('online',()=>{failures=0;void refresh();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden){void refresh();void keepAwake();}});
setInterval(update,1000);
setInterval(()=>{if((selected||displayMode==='gantt')&&data&&fresh())render();},60000);

const pinDialog=$<HTMLDialogElement>('pin-dialog'),pinForm=$<HTMLFormElement>('pin-form');let changingPIN=false;
$('pin-settings').onclick=()=>{
  if(!data)return;pinForm.reset();$('pin-error').textContent='';
  (pinForm.elements.namedItem('user') as HTMLSelectElement).innerHTML='<option value="">選択してください</option>'+data.members.map(m=>`<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');pinDialog.showModal();
};
$('pin-close').onclick=()=>{if(!changingPIN)pinDialog.close();};
pinDialog.addEventListener('cancel',event=>{if(changingPIN)event.preventDefault();});pinDialog.addEventListener('close',()=>pinForm.reset());
pinForm.onsubmit=async event=>{
  event.preventDefault();if(changingPIN)return;
  const values=new FormData(pinForm);if(values.get('new_pin')!==values.get('confirm_pin')){$('pin-error').textContent='新しいPINと確認用PINが一致しません。';return;}
  changingPIN=true;pinForm.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button').forEach(el=>el.disabled=true);$('pin-error').textContent='';
  try{const result=await api('pin',Object.fromEntries(values));pinDialog.close();toast(result.message);}
  catch(error){$('pin-error').textContent=message(error)+' 通信結果が不明な場合は新しいPINも確認してください。';}
  finally{changingPIN=false;pinForm.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button').forEach(el=>el.disabled=false);pinForm.querySelectorAll<HTMLInputElement>('input').forEach(el=>el.value='');}
};
const qrDialog=$<HTMLDialogElement>('qr-dialog');let qrAbort:AbortController|null=null;
function qrKey(text:string):string {
  if(/^[A-Za-z0-9_-]{32,200}$/.test(text))return text;
  try{const url=new URL(text);if(url.origin!==location.origin||!['/dashboard','/dashboard/'].includes(url.pathname))throw 0;const key=new URLSearchParams(url.hash.slice(1)).get('device');if(key&&/^[A-Za-z0-9_-]{32,200}$/.test(key))return key;}catch{}
  throw new Error('このダッシュボード用の端末QRではありません。');
}
async function connectQR(text:string){
  let key:string;try{key=qrKey(text);}catch(error){$('qr-message').textContent=message(error);return;}
  qrAbort?.abort();qrDialog.close();$('unlock-error').textContent='';
  try{await api('unlock',{key});await refresh();}catch(error){$('unlock-error').textContent=message(error);}
}
$('scan-qr').onclick=async()=>{
  qrAbort?.abort();qrAbort=new AbortController();const signal=qrAbort.signal;qrDialog.showModal();$('qr-message').textContent='カメラを起動しています…';
  try{const module=await import('./qr-scan.js');if(signal.aborted)return;await module.scanCamera($<HTMLVideoElement>('qr-video'),signal,text=>void connectQR(text));if(!signal.aborted)$('qr-message').textContent='このタブレット用のQRを枠内に映してください。';}
  catch{if(!signal.aborted)$('qr-message').textContent='カメラを利用できません。Edgeのカメラ許可を確認するか、下の画像ファイルを選んでください。';}
};
$('qr-close').onclick=()=>qrDialog.close();qrDialog.addEventListener('close',()=>{qrAbort?.abort();$<HTMLInputElement>('qr-file').value='';});
$<HTMLInputElement>('qr-file').onchange=async event=>{
  const file=(event.target as HTMLInputElement).files?.[0];if(!file)return;
  if(file.size>15*1024*1024){$('qr-message').textContent='15MB以下の画像を選んでください。';return;}
  try{const text=await(await import('./qr-scan.js')).readQRImage(file);if(!qrDialog.open)return;if(!text)throw new Error('QRを読み取れませんでした。鮮明な画像でお試しください。');await connectQR(text);}catch(error){$('qr-message').textContent=message(error);}
};
// QRの秘密値はURLフラグメントだけに入れる。サーバーへ送らず、読み込み直後に履歴から除く。
let initialQR=location.hash.startsWith('#device=')?location.href:'';
if(initialQR){const url=new URL(location.href);url.hash='';history.replaceState(null,'',url);const value=initialQR;initialQR='';void connectQR(value);}else void refresh();



// 履歴は端末認証済みの閲覧専用APIから取得する。PINやSlackの内部IDは取得しない。
const historyDialog=$<HTMLDialogElement>('history-dialog'),historyForm=$<HTMLFormElement>('history-form');
let historyResource:Equipment|null=null,historyCursor:{end:number;id:string}|null=null,historySequence=0;
async function openHistory(id:string){
 historyResource=data?.resources.find(r=>r.id===id)??null;if(!historyResource)return;
 $('history-equipment').textContent=historyResource.name;
 (historyForm.elements.namedItem('from') as HTMLInputElement).value=jstDate(now()-30*DAY);
 (historyForm.elements.namedItem('to') as HTMLInputElement).value=jstDate(now());
 historyDialog.showModal();await loadHistory(true);
}
async function loadHistory(reset:boolean){
 if(!historyResource)return;const sequence=++historySequence,values=new FormData(historyForm);
 const params=new URLSearchParams({resource:historyResource.id,from:String(values.get('from')),to:String(values.get('to'))});
 if(!reset&&historyCursor){params.set('before',String(historyCursor.end));params.set('before_id',historyCursor.id);}
 if(reset){historyCursor=null;$('history-list').replaceChildren();}
 $('history-more').hidden=true;$('history-message').textContent='履歴を取得しています…';
 try {
  const result=await api('history?'+params) as {bookings:BookingView[];next:{end:number;id:string}|null};
  if(sequence!==historySequence||!historyDialog.open)return;
  $('history-list').insertAdjacentHTML('beforeend',result.bookings.map(b=>`<article class="history-row"><strong>${esc(stamp(b.start_at))} 〜 ${esc(stamp(b.end_at))}</strong><p>${esc(b.person)}${historyResource!.type==='quantity_resource'?'・'+b.quantity+'台':''}${b.pool_id?'・'+esc(historyResource!.pools.find(p=>p.id===b.pool_id)?.name??'場所未設定'):''}</p><p>${esc(b.purpose||'用途の記載なし')}</p></article>`).join(''));
  historyCursor=result.next;$('history-more').hidden=!historyCursor;
  $('history-message').textContent=$('history-list').children.length?`${$('history-list').children.length}件を表示${historyCursor?'（続きがあります）':''}`:'この期間の履歴はありません。';
 }catch(error){if(sequence===historySequence&&historyDialog.open){$('history-message').textContent=message(error);$('history-more').hidden=!historyCursor;}}
}
$('history-close').onclick=()=>historyDialog.close();
historyDialog.addEventListener('close',()=>{historySequence++;historyResource=null;historyCursor=null;$('history-list').replaceChildren();});
historyForm.onsubmit=event=>{event.preventDefault();void loadHistory(true);};
$('history-more').onclick=()=>void loadHistory(false);

function openGanttBooking(id:string){
 const b=data?.reservations.find(row=>row.id===id);if(!b)return;$('gantt-dialog-title').textContent='予約の詳細';$('gantt-detail').hidden=false;const r=data!.resources.find(item=>item.id===b.resource_id)!;
 $('gantt-info').innerHTML=`<h3>${esc(r.name)}</h3><p class="gantt-info-time">${esc(stamp(b.start_at))} 〜 ${esc(stamp(b.end_at))}</p><dl><dt>予約者</dt><dd>${esc(b.person)}</dd><dt>用途</dt><dd>${esc(b.purpose||'用途の記載なし')}</dd>${r.type==='quantity_resource'?`<dt>台数・場所</dt><dd>${b.quantity}台・${esc(r.pools.find(p=>p.id===b.pool_id)?.name??'場所未設定')}</dd>`:''}</dl>`;
 $('gantt-detail').onclick=()=>{$<HTMLDialogElement>('gantt-dialog').close();selected=r.id;render();$('main').focus();};
 $<HTMLDialogElement>('gantt-dialog').showModal();
}
$('gantt-close').onclick=()=>$<HTMLDialogElement>('gantt-dialog').close();

function syncDays(prefix:string){
 const field=(suffix:string)=>form.elements.namedItem(prefix+'_'+suffix) as HTMLSelectElement;
 const year=Number(field('year').value),month=Number(field('month').value),previous=Number(field('day').value),max=new Date(Date.UTC(year,month,0)).getUTCDate();
 field('day').innerHTML=Array.from({length:max},(_,i)=>`<option value="${i+1}" ${i+1===Math.min(previous,max)?'selected':''}>${i+1}日</option>`).join('');
 if(previous>max)toast(`日数に合わせて${month}月${max}日に調整しました。`);
}


// ブラウザの全画面とは別に、Escapeで表の拡大表示を解除できる。
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&ganttExpanded&&!document.querySelector('dialog[open]')){ganttExpanded=false;render();}});

const orderDialog=$<HTMLDialogElement>('order-dialog');let orderDraft:string[]=[];
function openOrder(){if(!data)return;orderDraft=orderedResources(data.resources,parseResourceOrder(preferences('lab-resource-order'))).map(r=>r.id);renderOrder();orderDialog.showModal();}
function renderOrder(){if(!data)return;$('order-list').innerHTML=orderDraft.map((id,index)=>`<li><span>${index+1}. ${esc(data!.resources.find(r=>r.id===id)?.name??id)}</span><div><button type="button" data-command="order-up" data-id="${esc(id)}" ${index===0?'disabled':''}>上へ</button><button type="button" data-command="order-down" data-id="${esc(id)}" ${index===orderDraft.length-1?'disabled':''}>下へ</button></div></li>`).join('');}
function moveOrder(id:string,direction:number){const index=orderDraft.indexOf(id),next=index+direction;if(index<0||next<0||next>=orderDraft.length)return;[orderDraft[index],orderDraft[next]]=[orderDraft[next],orderDraft[index]];renderOrder();const button=[...$('order-list').querySelectorAll<HTMLButtonElement>('button')].find(b=>b.dataset.id===id&&b.dataset.command===(direction<0?'order-up':'order-down')&&!b.disabled);button?.focus();}
$('order-close').onclick=()=>orderDialog.close();
$('order-save').onclick=()=>{preferences('lab-resource-order',JSON.stringify(orderDraft));$<HTMLSelectElement>('sort').value='custom';orderDialog.close();render();toast('この端末の並び順を保存しました。');};
$('order-reset').onclick=()=>{preferences('lab-resource-order','[]');$<HTMLSelectElement>('sort').value='default';orderDialog.close();render();toast('登録順に戻しました。');};

function visibleCalendarResources(){return new Set((calendarState?.resources??[]).filter(r=>r.kind==='equipment'?calendarEquipment.has(r.id):!calendarHiddenEvents.has(r.id)).map(r=>r.id));}
async function refreshCalendar(){
 if(!data||calendarLoading)return;const month=calendarMonth,sequence=++calendarRequest;calendarLoading=true;
 try{
  const result=await api('calendar?month='+encodeURIComponent(month)) as CalendarData;
  if(sequence!==calendarRequest||!data)return;if(result.month!==calendarMonth)return;
  if(!Array.isArray(result.items)||!Array.isArray(result.resources)||!Array.isArray(result.upcoming))throw new Error('予定情報の形式を確認できません。');
  calendarError='';const signature=JSON.stringify({...result,server_time:0});calendarState=result;calendarReceived=performance.now();calendarWall=Date.now();
  if(signature!==calendarSignature&&displayMode==='calendar'){calendarSignature=signature;render();}
 }catch(error){if(sequence===calendarRequest){calendarError=message(error);if(displayMode==='calendar')render();}}
 finally{if(sequence===calendarRequest){calendarLoading=false;if(month!==calendarMonth)void refreshCalendar();if(displayMode==='calendar')update();}}
}
function calendarCommand(command:string,target:HTMLElement){
 if(command==='calendar-info'){
  const item=[...(calendarState?.items??[]),...(calendarState?.upcoming??[])].find(i=>i.id===target.dataset.id),resource=calendarState?.resources.find(r=>r.id===item?.resource_id);if(!item||!resource)return;
  $('gantt-dialog-title').textContent='予定の詳細';$('gantt-info').innerHTML=calendarDetail(item,resource);$('gantt-detail').hidden=true;if(!$<HTMLDialogElement>('gantt-dialog').open)$<HTMLDialogElement>('gantt-dialog').showModal();return;
 }
 if(command==='calendar-day'||command==='calendar-upcoming'){
  if(!calendarState)return;if(command==='calendar-day')calendarDay=target.dataset.date!;
  $('gantt-dialog-title').textContent=command==='calendar-day'?'日別の予定':'次の開催予定';$('gantt-info').innerHTML=command==='calendar-day'?calendarDayDetail(calendarState,calendarDay,visibleCalendarResources()):calendarUpcoming(calendarState,visibleCalendarResources(),now());$('gantt-detail').hidden=true;$<HTMLDialogElement>('gantt-dialog').showModal();return;
 }
 if(command==='calendar-retry'){void refreshCalendar();return;}
 if(command==='calendar-today'){calendarMonth=jstDate(now()).slice(0,7);calendarDay=jstDate(now());}
 else {const [year,month]=calendarMonth.split('-').map(Number);calendarMonth=new Date(Date.UTC(year,month-1+(command==='calendar-prev'?-1:1),1)).toISOString().slice(0,7);calendarDay=calendarMonth+'-01';}
 render();void refreshCalendar();
}
function calendarChange(target:HTMLInputElement){
 if(target.id==='calendar-week-start'){calendarWeekStart=target.value==='0'?0:1;preferences('lab-calendar-week-start',String(calendarWeekStart));render();return;}
 if(target.id==='calendar-year'||target.id==='calendar-month'){calendarMonth=$<HTMLSelectElement>('calendar-year').value+'-'+$<HTMLSelectElement>('calendar-month').value.padStart(2,'0');calendarDay=calendarMonth+'-01';render();void refreshCalendar();return;}
 if(target.id==='calendar-all-equipment'){calendarEquipment.clear();if(target.checked)for(const r of calendarState?.resources??[])if(r.kind==='equipment')calendarEquipment.add(r.id);}
 else {const r=calendarState?.resources.find(r=>r.id===target.dataset.calendarResource);if(!r)return;const set=r.kind==='equipment'?calendarEquipment:calendarHiddenEvents;if(r.kind==='equipment'){if(target.checked)set.add(r.id);else set.delete(r.id);}else{if(target.checked)set.delete(r.id);else set.add(r.id);}}
 preferences('lab-calendar-equipment',JSON.stringify([...calendarEquipment]));preferences('lab-calendar-hidden-events',JSON.stringify([...calendarHiddenEvents]));render();
}
