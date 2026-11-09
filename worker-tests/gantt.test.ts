import {it,expect} from 'vitest';
import {ganttLanes} from '../shared/gantt';
import {ganttView} from '../dashboard/gantt';
import {midnight,DAY,type BookingView,type Snapshot} from '../shared/dashboard';
const start=midnight('2030-01-01');
const booking=(id:string,a:number,b:number,resource='room'):BookingView=>({id,resource_id:resource,start_at:start+a,end_at:start+b,person:'<利用者>',purpose:'<用途>',quantity:2,pool_id:null,version:1});
const rows=[booking('cross',-DAY,4*3600000),booking('touch',4*3600000,5*3600000),booking('overlap',2*3600000,6*3600000),booking('tomorrow',DAY,DAY+3600000),booking('other',0,3600000,'other')];
const data:Snapshot={server_time:start,date:'2030-01-01',range_end:start+DAY,resources:[{id:'room',name:'<設備>',room:'',type:'quantity_resource',capacity:4,enabled:1,multi_day:1,pools:[],purposes:[]}],reservations:rows,maintenance:[],members:[]};
it('separates overlaps, shares touching endpoints and filters resources/day boundaries without mutation',()=>{
 const original=JSON.stringify(rows),lanes=ganttLanes(rows,'room',start,start+DAY);
 expect(lanes.map(l=>l.map(b=>b.id))).toEqual([['cross','touch'],['overlap']]);
 expect(JSON.stringify(rows)).toBe(original);
});
it('escapes all text and shows clipped cross-day hours and quantities',()=>{
 const html=ganttView(data,data.date,data.resources,start+3600000,true,'day');
 expect(html).toContain('← 00:00〜04:00');expect(html).toContain('2台');
 expect(html).toContain('&lt;利用者&gt;');expect(html).not.toContain('<利用者>');expect(html).not.toContain('data-id="tomorrow"');
 expect(html).toContain('gantt-booking purpose-');expect(html).toContain('current');
});
it('does not render another day as current, supports visible hour range and stale data',()=>{
 expect(ganttView(data,'2030-01-02',data.resources,start,true,'day')).toContain('データを取得しています');
 const html=ganttView(data,data.date,data.resources,start,false,'workday');
 expect(html).toContain('gantt-panel stale');expect(html).not.toContain('data-command="gantt-booking"');expect(html).toContain('08:00');expect(html).toContain('20:00');
});
