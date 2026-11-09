import {equipmentState,type Equipment,type BookingView,type Downtime} from './dashboard.js';

// 数量予約から台数の概念図を作る。装置個体の割当・実稼働を推定しない。
export function poolOccupancy(resource:Equipment,rows:BookingView[],maintenance:Downtime[],now:number) {
  const state=equipmentState(resource,rows,maintenance,now);
  const unknown=state.current.filter(b=>!b.pool_id).reduce((n,b)=>n+b.quantity,0);
  return resource.pools.map(pool=>({
    ...pool,booked:state.current.filter(b=>b.pool_id===pool.id).reduce((n,b)=>n+b.quantity,0),
    unknown,offline:state.offline,free:resource.enabled?state.poolAvailable.find(p=>p.id===pool.id)!.available:0
  }));
}
export function occupancySegments(resource:Equipment,rows:BookingView[],maintenance:Downtime[],start:number,end:number,pool?:string) {
  const points=new Set([start,end]);
  for(const b of [...rows,...maintenance].filter(b=>b.resource_id===resource.id)) {
    if(b.start_at>start&&b.start_at<end)points.add(b.start_at);
    if(b.end_at!==null&&b.end_at>start&&b.end_at<end)points.add(b.end_at);
  }
  const times=[...points].sort((a,b)=>a-b),result:{start:number;end:number;booked:number;unknown:number;offline:number;free:number}[]=[];
  for(let i=0;i<times.length-1;i++) {
    const s=equipmentState(resource,rows,maintenance,times[i]);
    const value=pool?poolOccupancy(resource,rows,maintenance,times[i]).find(p=>p.id===pool)!:{booked:s.current.reduce((n,b)=>n+b.quantity,0),unknown:0,offline:s.offline,free:s.status==='unavailable'?0:s.available};
    const last=result.at(-1);
    if(last&&['booked','unknown','offline','free'].every(k=>last[k as keyof typeof last]===value[k as keyof typeof value]))last.end=times[i+1];
    else result.push({start:times[i],end:times[i+1],booked:value.booked,unknown:value.unknown,offline:value.offline,free:resource.enabled?value.free:0});
  }
  return result;
}
