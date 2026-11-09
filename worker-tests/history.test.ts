import {beforeAll,afterAll,it,expect} from 'vitest';
import {Miniflare} from 'miniflare';
import {bookingHistory} from '../src/dashboard/history';
let mf:Miniflare,db:D1Database;
const now=Date.parse('2030-01-03T12:00:00+09:00');
const params=(extra:Record<string,string>={})=>new URLSearchParams({resource:'equipment',from:'2030-01-01',to:'2030-01-03',...extra});
beforeAll(async()=>{
 mf=new Miniflare({workers:[{config:{name:'history-test',compatibilityDate:'2026-10-07',manifest:{mainModule:'index.js',modules:{'index.js':{type:'esm',contents:'export default {fetch(){return new Response("ok")}}'}}},env:{DB:{type:'d1',id:'history-qa'}}}}]});
 db=await mf.getD1Database('DB') as unknown as D1Database;
 await db.prepare('CREATE TABLE resources(id TEXT PRIMARY KEY,schedule_event INTEGER)').run();
 await db.prepare("INSERT INTO resources VALUES('equipment',0),('event',1)").run();
 await db.prepare('CREATE TABLE reservations(id TEXT PRIMARY KEY,resource_id TEXT,slack_user_name TEXT,start_at INTEGER,end_at INTEGER,quantity INTEGER,purpose TEXT,purpose_choice TEXT,pool_id TEXT,version INTEGER,status TEXT)').run();
 const end=Date.parse('2030-01-02T10:00:00+09:00');
 for(let i=0;i<35;i++)await db.prepare("INSERT INTO reservations VALUES(?,'equipment','テスト利用者',?,?,2,'試験','',NULL,1,'active')").bind('r'+String(i).padStart(2,'0'),end-86400000,end).run();
 await db.prepare("INSERT INTO reservations VALUES('cancelled','equipment','取消',?,?,1,'','',NULL,1,'cancelled')").bind(end-3600000,end).run();
 await db.prepare("INSERT INTO reservations VALUES('future','equipment','未来',?,?,1,'','',NULL,1,'active')").bind(now-3600000,now+3600000).run();
});
afterAll(async()=>{await mf?.dispose();});
it('pages equal end timestamps without gaps or duplicates and excludes cancelled/in-progress bookings',async()=>{
 const first=await bookingHistory(db,params(),now);expect(first.bookings).toHaveLength(30);expect(first.next).not.toBeNull();
 const second=await bookingHistory(db,params({before:String(first.next!.end),before_id:first.next!.id}),now);
 const ids=[...first.bookings,...second.bookings].map(b=>b.id);
 expect(new Set(ids).size).toBe(35);expect(second.bookings).toHaveLength(5);expect(second.next).toBeNull();
 expect(ids).not.toContain('cancelled');expect(ids).not.toContain('future');
 expect(first.bookings[0].start_at).toBeLessThan(first.bookings[0].end_at-3600000);
 expect(JSON.stringify(first)).not.toMatch(/slack_user_id|pin_hash|channel_id/);
});
it('validates JST dates, date ranges, cursors and non-equipment resources',async()=>{
 const invalid:Record<string,string>[]=[{from:'2030-02-30'},{to:'2030-01-04'},{from:'2028-01-01'},{before:'NaN',before_id:'r'},{before:'1'},{resource:'event'}];
 for(const bad of invalid)await expect(bookingHistory(db,params(bad),now)).rejects.toThrow();
 expect((await bookingHistory(db,params({from:'2030-01-03'}),now)).bookings).toEqual([]);
});
