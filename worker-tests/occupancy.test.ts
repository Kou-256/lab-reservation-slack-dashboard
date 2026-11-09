import {expect,it} from 'vitest';
import {poolOccupancy,occupancySegments} from '../shared/occupancy';
import {stirrerIllustration} from '../dashboard/stirrer';
import type {Equipment,BookingView,Downtime} from '../shared/dashboard';
const resource:Equipment={id:'stirrer',name:'スターラー',room:'実験室',type:'quantity_resource',capacity:20,enabled:1,multi_day:1,pools:[{id:'inside',name:'ドラフト内',capacity:8},{id:'outside',name:'ドラフト外',capacity:12}],purposes:[]};
const booking=(id:string,start:number,end:number,quantity:number,pool:string|null):BookingView=>({id,resource_id:'stirrer',person:'テスト利用者',start_at:start,end_at:end,quantity,purpose:'試験',pool_id:pool,version:1});
it('counts overlapping reservations separately by location and uses half-open boundaries',()=>{
 const rows=[booking('a',-10,20,3,'inside'),booking('b',10,30,5,'outside')];
 expect(poolOccupancy(resource,rows,[],15).map(p=>[p.booked,p.free])).toEqual([[3,5],[5,7]]);
 expect(occupancySegments(resource,rows,[],0,40).map(s=>[s.start,s.end,s.booked])).toEqual([[0,10,3],[10,20,8],[20,30,5],[30,40,0]]);
 expect(poolOccupancy(resource,rows,[],20)[0].booked).toBe(0);
});
it('clips cross-day bookings and conservatively subtracts unknown locations and downtime',()=>{
 const rows=[booking('a',-100,100,2,null)];
 const stops:Downtime[]=[{id:'m',resource_id:'stirrer',start_at:10,end_at:null,quantity:1,kind:'fault',reason:'点検'}];
 const parts=occupancySegments(resource,rows,stops,0,40,'inside');
 expect(parts.map(s=>[s.start,s.end,s.booked,s.unknown,s.offline,s.free])).toEqual([[0,10,0,2,0,6],[10,40,0,2,1,5]]);
 expect(poolOccupancy({...resource,enabled:0},rows,[],20).every(p=>p.free===0)).toBe(true);
});
it('SVG depicts counts rather than device identity and stops reservation animation on stale data',()=>{
 const rows=[booking('a',0,100,3,'inside')];
 const live=stirrerIllustration(resource,rows,[],50,true);
 expect((live.match(/data-state="reserved"/g)||[]).length).toBe(3);
 expect((live.match(/<svg /g)||[]).length).toBe(20);
 expect(live).toContain('実稼働・個体の割当は示しません');
 const stale=stirrerIllustration(resource,rows,[],50,false);
 expect(stale).not.toContain('data-state="reserved"');
 expect((stale.match(/data-state="unknown"/g)||[]).length).toBe(20);
});
