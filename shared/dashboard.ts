export interface Equipment {
  id:string; name:string; room:string; type:'exclusive_room'|'quantity_resource';
  capacity:number|null; enabled:number; multi_day:number; pools:{id:string;name:string;capacity:number}[];
  purposes:string[];
}
export interface BookingView {
  id:string; resource_id:string; person:string; start_at:number; end_at:number;
  quantity:number; purpose:string; pool_id:string|null; version:number;
}
export interface Downtime {
  id:string; resource_id:string; start_at:number; end_at:number|null;
  quantity:number|null; kind:string; reason:string;
}
export interface Snapshot {
  server_time:number; date:string; range_end:number; resources:Equipment[];
  reservations:BookingView[]; maintenance:Downtime[]; members:{id:string;name:string}[];
}
export type Status='free'|'soon'|'booked'|'unavailable'|'unknown';
export interface EquipmentState {
  status:Status; label:string; current:BookingView[]; next:BookingView[];
  available:number; offline:number; poolAvailable:{id:string;name:string;available:number}[];
}
export const DAY=86400000;
export function jstDate(ms:number):string {return new Date(ms+9*3600000).toISOString().slice(0,10);}
export function midnight(date:string):number {return Date.parse(date+'T00:00:00+09:00');}
// 終了と次の開始が同時なら重複しない。場所不明予約は両方の場所から差し引く。
export function equipmentState(r:Equipment,rows:BookingView[],maintenance:Downtime[],now:number,fresh=true):EquipmentState {
  const current=rows.filter(b=>b.resource_id===r.id&&b.start_at<=now&&now<b.end_at);
  const future=rows.filter(b=>b.resource_id===r.id&&b.start_at>now).sort((a,b)=>a.start_at-b.start_at||a.id.localeCompare(b.id));
  const next=future.filter(b=>b.start_at===future[0]?.start_at);
  const offline=maintenance.filter(m=>m.resource_id===r.id&&m.start_at<=now&&(m.end_at===null||now<m.end_at)).reduce((sum,m)=>sum+(m.quantity??r.capacity??1),0);
  const used=current.reduce((n,b)=>n+b.quantity,0),capacity=r.type==='exclusive_room'?1:r.capacity??0;
  const available=Math.max(0,capacity-used-offline);
  const poolAvailable=r.pools.map(p=>({id:p.id,name:p.name,available:Math.min(available,Math.max(0,p.capacity-offline-current.filter(b=>!b.pool_id||b.pool_id===p.id).reduce((n,b)=>n+b.quantity,0)))}));
  let status:Status=!fresh?'unknown':!r.enabled||r.capacity===null||offline>=capacity?'unavailable':current.length?'booked':next.length&&next[0].start_at-now<=600000?'soon':'free';
  const label={unknown:'情報を確認できません',unavailable:!r.enabled?'予約受付停止':'利用不可',booked:r.type==='quantity_resource'&&available>0?'予約時間中・空きあり':'予約時間中',soon:'まもなく予約開始',free:'空き'}[status];
  return {status,label,current,next,available,offline,poolAvailable};
}
// 予約・停止期間の全境界で区切る。数量型は時間帯ごとの残台数を返す。
export function availability(r:Equipment,rows:BookingView[],maintenance:Downtime[],start:number,end:number,pool?:string) {
  const cuts=new Set([start,end]);
  for(const b of [...rows.filter(b=>b.resource_id===r.id),...maintenance.filter(m=>m.resource_id===r.id)]) {
    if(b.start_at>start&&b.start_at<end)cuts.add(b.start_at);
    if(b.end_at!==null&&b.end_at>start&&b.end_at<end)cuts.add(b.end_at);
  }
  const times=[...cuts].sort((a,b)=>a-b),result:{start:number;end:number;quantity:number}[]=[];
  for(let i=0;i<times.length-1;i++) {
    const state=equipmentState(r,rows,maintenance,times[i]);
    const quantity=state.status==='unavailable'?0:pool?state.poolAvailable.find(p=>p.id===pool)?.available??0:state.available;
    const last=result.at(-1);
    if(last?.quantity===quantity)last.end=times[i+1];else result.push({start:times[i],end:times[i+1],quantity});
  }
  return result;
}
