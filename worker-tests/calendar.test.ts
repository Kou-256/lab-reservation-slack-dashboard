import {it,expect,beforeAll,afterAll} from 'vitest';
import {Miniflare} from 'miniflare';
import {calendarData} from '../src/dashboard/calendar';
import {calendarRange,itemsOnDate} from '../shared/calendar';
import {DAY,midnight} from '../shared/dashboard';
let mf:Miniflare,db:D1Database;const now=midnight('2030-01-01')+12*3600000;
beforeAll(async()=>{
 mf=new Miniflare({workers:[{config:{name:'calendar-test',compatibilityDate:'2026-10-07',manifest:{mainModule:'index.js',modules:{'index.js':{type:'esm',contents:'export default {fetch(){return new Response("ok")}}'}}},env:{DB:{type:'d1',id:'calendar-test'}}}}]});db=await mf.getD1Database('DB') as unknown as D1Database;
 await db.prepare('CREATE TABLE resources(id TEXT PRIMARY KEY,name TEXT,schedule_event INTEGER,enabled INTEGER,capacity INTEGER,booking_pools TEXT,created_at INTEGER)').run();
 for(const [id,name,event] of [['english_seminar','論ゼミ',1],['biweekly_report','隔週報',1],['custom_schedule','共有イベント',1],['device','装置',0]])await db.prepare('INSERT INTO resources VALUES(?,?,?,1,4,?,0)').bind(id,name,event,'[]').run();
 await db.prepare('CREATE TABLE reservations(id TEXT PRIMARY KEY,resource_id TEXT,start_at INTEGER,end_at INTEGER,slack_user_name TEXT,presenters TEXT,purpose TEXT,purpose_choice TEXT,event_title TEXT,quantity INTEGER,location TEXT,pool_id TEXT,status TEXT)').run();
 await db.prepare('CREATE TABLE schedule_sessions(id TEXT PRIMARY KEY,resource_id TEXT,reservation_id TEXT,session_date TEXT,state TEXT,presenters TEXT)').run();
 for(const [id,resource,offset,status] of [['seminar','english_seminar',1,'active'],['report','biweekly_report',2,'active'],['named','custom_schedule',3,'active'],['cancelled','custom_schedule',4,'cancelled'],['no-session','english_seminar',5,'active'],['outside-month','custom_schedule',80,'active'],['equipment','device',0,'active']] as const){
  await db.prepare('INSERT INTO reservations VALUES(?,?,?,?,?,?,?,?,?,2,?,NULL,?)').bind(id,resource,now+offset*DAY,now+offset*DAY+3600000,'登録者',JSON.stringify([{id:'private-member',name:'元の担当'}]),'内容','',resource==='custom_schedule'?'研究打合せ':'','会議室',status).run();
 }
 await db.prepare('INSERT INTO schedule_sessions VALUES(?,?,?,?,?,?)').bind('linked','english_seminar','seminar','2030-01-02','held',JSON.stringify([{id:'private-id',name:'最新担当'}])).run();
 await db.prepare("INSERT INTO schedule_sessions VALUES('no','english_seminar','no-session','2030-01-06','not_held','[]'),('date-only','english_seminar',NULL,'2030-01-08','held','[]')").run();
});
afterAll(async()=>{await mf?.dispose();});
it('reads event titles, updated presenters, equipment and date-only sessions from the existing tables',async()=>{
 const result=await calendarData(db,'2030-01',now),seminar=result.items.find(i=>i.id==='reservation:seminar')!;
 expect(seminar.person).toBe('最新担当');expect(result.items.find(i=>i.id==='reservation:named')?.title).toBe('研究打合せ');
 expect(result.resources.filter(r=>r.kind==='event')).toHaveLength(3);expect(result.items.find(i=>i.id==='reservation:equipment')?.person).toBe('登録者');
 const dateOnly=result.items.find(i=>i.id==='session:date-only')!;expect(dateOnly.start_at).toBeNull();expect(dateOnly.date).toBe('2030-01-08');expect(dateOnly.person).toBe('担当未定');
 expect(result.items.some(i=>i.id==='reservation:cancelled')).toBe(false);expect(result.items.find(i=>i.id==='reservation:no-session')?.not_held).toBe(true);
 expect(result.upcoming.some(i=>i.id==='reservation:no-session'||i.id==='reservation:cancelled')).toBe(false);expect(result.upcoming.some(i=>i.id==='reservation:outside-month')).toBe(true);
 expect(JSON.stringify(result)).not.toMatch(/private-member|private-id|slack_user_id|online_url|pin_hash|schedule_attendance/);
});
it('uses a Monday-first JST grid and half-open cross-day reservations',()=>{
 const range=calendarRange('2030-01');expect(range.end-range.start).toBe(42*DAY);expect(new Date(range.start+9*3600000).getUTCDay()).toBe(1);
 const item={id:'i',resource_id:'device',title:'装置',description:'',person:'利用者',date:'2030-01-01',start_at:midnight('2030-01-01'),end_at:midnight('2030-01-02'),quantity:1,location:'',pool_id:null,not_held:false};
 expect(itemsOnDate([item],'2030-01-01')).toHaveLength(1);expect(itemsOnDate([item],'2030-01-02')).toHaveLength(0);
});
it('rejects invalid month ranges without guessing recurring events',async()=>{
 for(const month of ['2030-13','2030-00','bad','2201-01'])await expect(calendarData(db,month,now)).rejects.toThrow();
 const result=await calendarData(db,'2030-02',now);expect(result.items).toEqual([]);expect(result.upcoming.length).toBeGreaterThan(0);
});
