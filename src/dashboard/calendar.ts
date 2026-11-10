import {calendarRange,type CalendarData,type CalendarItem,type CalendarResource} from '../../shared/calendar';
import {jstDate} from '../../shared/dashboard';
import {DashboardError} from './auth';
type Row={id:string;resource_id:string;start_at:number;end_at:number;slack_user_name:string;presenters:string;session_presenters:string|null;session_state:string|null;purpose:string;purpose_choice:string;event_title:string;quantity:number;location:string;pool_id:string|null};
type ResourceRow={id:string;name:string;schedule_event:number;enabled:number;capacity:number|null;booking_pools:string};
type Session={id:string;resource_id:string;session_date:string;state:string;presenters:string};
const fields='b.id,b.resource_id,b.start_at,b.end_at,b.slack_user_name,b.presenters,b.purpose,b.purpose_choice,b.event_title,b.quantity,b.location,b.pool_id,s.presenters AS session_presenters,s.state AS session_state';
export async function calendarData(db:D1Database,month:string,now:number):Promise<CalendarData>{
 let range;try{range=calendarRange(month);}catch{throw new DashboardError('表示する年月を確認してください。');}
 const sunday=calendarRange(month,0);range={start:Math.min(range.start,sunday.start),end:Math.max(range.end,sunday.end)};
 const today=jstDate(now),from=jstDate(range.start),to=jstDate(range.end);
 // 登録済み予約と時刻のない担当履歴を一括で読む。繰り返し予定を推測して作らない。
 const result=await db.batch([
  db.prepare('SELECT id,name,schedule_event,enabled,capacity,booking_pools FROM resources ORDER BY created_at,id LIMIT 1001'),
  db.prepare(`SELECT ${fields} FROM reservations b LEFT JOIN schedule_sessions s ON s.reservation_id=b.id WHERE b.status='active' AND b.start_at<? AND b.end_at>? ORDER BY b.start_at,b.id LIMIT 5001`).bind(range.end,range.start),
  db.prepare(`SELECT s.id,s.resource_id,s.session_date,s.state,s.presenters FROM schedule_sessions s JOIN resources r ON r.id=s.resource_id WHERE r.schedule_event=1 AND s.reservation_id IS NULL AND s.session_date>=? AND s.session_date<? ORDER BY s.session_date,s.id LIMIT 1001`).bind(from,to),
  db.prepare(`SELECT * FROM (SELECT ${fields},ROW_NUMBER() OVER(PARTITION BY b.resource_id ORDER BY b.start_at,b.id) AS rank FROM reservations b JOIN resources r ON r.id=b.resource_id LEFT JOIN schedule_sessions s ON s.reservation_id=b.id WHERE r.schedule_event=1 AND b.status='active' AND b.end_at>? AND coalesce(s.state,'')<>'not_held') WHERE rank<=3 ORDER BY start_at,id LIMIT 3001`).bind(now),
  db.prepare(`SELECT * FROM (SELECT s.id,s.resource_id,s.session_date,s.state,s.presenters,ROW_NUMBER() OVER(PARTITION BY s.resource_id ORDER BY s.session_date,s.id) AS rank FROM schedule_sessions s JOIN resources r ON r.id=s.resource_id WHERE r.schedule_event=1 AND s.reservation_id IS NULL AND s.state<>'not_held' AND s.session_date>=?) WHERE rank<=3 ORDER BY session_date,id LIMIT 3001`).bind(today)
 ]);
 if(result[0].results.length>1000||result[1].results.length>5000||result[2].results.length>1000||result[3].results.length>3000||result[4].results.length>3000)throw new DashboardError('予定の表示件数が上限を超えました。',503);
 const resources=(result[0].results as unknown as ResourceRow[]).map((r):CalendarResource=>({id:r.id,name:r.name,kind:r.schedule_event?'event':'equipment',enabled:r.enabled,capacity:r.capacity,pools:JSON.parse(r.booking_pools??'[]')}));
 const byId=new Map(resources.map(r=>[r.id,r]));
 const people=(raw:string)=>{try{return (JSON.parse(raw) as {name:string}[]).map(p=>p.name).filter(n=>typeof n==='string').join('、');}catch{return '';}};
 const timed=(b:Row):CalendarItem=>{const r=byId.get(b.resource_id)!;return {id:'reservation:'+b.id,resource_id:b.resource_id,title:r.kind==='event'?(b.event_title||r.name):r.name,description:b.purpose||b.purpose_choice,person:r.kind==='equipment'?b.slack_user_name:b.resource_id==='english_seminar'?people(b.session_presenters??b.presenters)||'担当未定':'',date:jstDate(b.start_at),start_at:b.start_at,end_at:b.end_at,quantity:b.quantity,location:b.location??'',pool_id:b.pool_id??null,not_held:b.session_state==='not_held'};};
 const untimed=(s:Session):CalendarItem=>({id:'session:'+s.id,resource_id:s.resource_id,title:byId.get(s.resource_id)!.name,description:'',person:s.resource_id==='english_seminar'?people(s.presenters)||'担当未定':'',date:s.session_date,start_at:null,end_at:null,quantity:0,location:'',pool_id:null,not_held:s.state==='not_held'});
 const items=[...(result[1].results as unknown as Row[]).map(timed),...(result[2].results as unknown as Session[]).map(untimed)];
 const upcoming=[...(result[3].results as unknown as Row[]).map(timed),...(result[4].results as unknown as Session[]).map(untimed)].sort((a,b)=>(a.start_at??Date.parse(a.date+'T00:00:00+09:00'))-(b.start_at??Date.parse(b.date+'T00:00:00+09:00'))||a.id.localeCompare(b.id));
 return {server_time:now,month,range_start:range.start,range_end:range.end,resources,items,upcoming};
}
