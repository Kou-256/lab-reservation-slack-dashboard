import {reserveWash} from '../src/services/washing';
import {dashboardRoute} from '../src/dashboard/routes';
import {manageDevice,listDevices} from '../src/dashboard/devices';
import {pinHash} from '../src/dashboard/auth';
import {snapshot as dashboardSnapshot} from '../src/dashboard/data';
import {equipmentState,availability,midnight,DAY,type Equipment,type BookingView} from '../shared/dashboard';
import {washForm,washBookings,washAction,submitWash} from '../src/washing-ui';
import {changeResource,type ResourceInput} from '../src/services/resources';
import {resourceAction,resourceForm,resourceManagement,submitResource,refreshResourceHistory} from '../src/resource-ui';
import {scheduleAudit,scheduleAuditAction} from '../src/services/schedule-audit';
import { afterAll,beforeAll,beforeEach,describe,it,expect,vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';
import { Reservations } from '../src/services/reservations';
import {extendBooking,maintenanceWarnings,reusableBookings,editPurpose,calendarStatus} from '../src/services/booking-tools';
import {setReminders,sendDueReminders} from '../src/services/reminders';
import {toolsAction,submitTools} from '../src/booking-tools-ui';
import { deliver, refreshHistorical, refreshOperations, refreshPanel } from '../src/services/notifications';
import { action, checkAvailability, parseBooking, publishHome, submit, submitSettings, submitRepair } from '../src/handlers';
import { saveMaintenance, cancelMaintenance, addRepairUpdate, repairUpdates } from '../src/services/maintenance';
import { bookingModal, listModal, currentStatus, notification, operationPanel, panel, schedulePanel, maintenanceModal, maintenanceDetail } from '../src/ui';
import { verifySlack } from '../src/signature';
import { calendarICS, calendarResponse, calendarRows, calendarSetupResponse, subscriptionToken, changeSubscription, weekBounds } from '../src/services/calendar';
import { googleEvent, googleEventId, syncGoogleReservation, seedGoogleSync } from '../src/services/google-calendar';
import { calendarModal } from '../src/ui-calendar';
import {createMeeting,editMeeting,meetingAction,meetingById,meetingList,presenterCounts,saveAttendance,submitMeeting} from '../src/services/meetings';
import {changeProfessor,parseProfessor,professorAction,professorForm,refreshProfessor,submitProfessor} from '../src/services/professor';
import {parseProfessorDates,professorCalendar,professorCalendarAction,saveProfessorDates,submitProfessorDates} from '../src/services/professor-batch';
import {professorToken,changeProfessorToken,professorICS,professorCalendarResponse,professorSetup,professorGoogleEvent,professorGoogleId,professorSubscription,submitProfessorSubscription,syncProfessorEvent} from '../src/services/professor-calendar';
import worker from '../src/index';
import type { Booking, Change, Env, Receipt, SlackJSON } from '../src/types';

let mf:Miniflare,db:D1Database,service:Reservations;
const now=Date.parse('2030-01-01T00:00:00+09:00');
const at=(hour:number,day=2)=>Date.parse(`2030-01-${String(day).padStart(2,'0')}T${String(hour).padStart(2,'0')}:00:00+09:00`);
const booking=(start=10,end=12,quantity=1):Booking=>({start_at:at(start),end_at:at(end),quantity,purpose:'PL測定',purpose_choice:''});
const panelButtons=(p:SlackJSON):SlackJSON[]=>p.blocks.flatMap((b:SlackJSON)=>b.elements??[]);
const change=(key:string,b=booking(),resource='room',user='U1')=>service.change(key,'created',resource,user,'利用者A',b);
beforeAll(async()=>{
  mf=new Miniflare({workers:[{config:{name:'test',compatibilityDate:'2026-10-01',
    manifest:{mainModule:'index.js',modules:{'index.js':{type:'esm',contents:'export default {fetch(){return new Response("ok")}}'}}},env:{DB:{type:'d1',id:'test-db'}}}}]});
  db=await mf.getD1Database('DB') as unknown as D1Database;
  const sql=(await readFile('migrations/0001_initial.sql','utf8')).replace(/^--.*$/gm,'');
  for(const statement of sql.split(/(?=^CREATE )/m).filter(x=>x.trim())) await db.prepare(statement).run();
  await db.prepare((await readFile('migrations/0002_operation_panel.sql','utf8')).replace(/^--.*$/gm,'')).run();
  await db.prepare((await readFile('migrations/0003_calendar_subscriptions.sql','utf8')).replace(/^--.*$/gm,'')).run();
  for(const statement of (await readFile('migrations/0004_google_calendar_sync.sql','utf8')).replace(/^--.*$/gm,'').split(/(?=^CREATE )/m).filter(x=>x.trim()))await db.prepare(statement).run();
  for(const statement of (await readFile('migrations/0005_schedule_resources.sql','utf8')).split(';').filter(x=>x.trim()))await db.prepare(statement).run();
  const locationSQL=await readFile('migrations/0006_schedule_location.sql','utf8');
  const triggerStart=locationSQL.indexOf('CREATE TRIGGER');
  for(const statement of locationSQL.slice(0,triggerStart).split(';').filter(x=>x.trim()))await db.prepare(statement).run();
  await db.prepare(locationSQL.slice(triggerStart)).run();
  for(const statement of (await readFile('migrations/0007_maintenance_subscription.sql','utf8')).split(/(?=^(?:CREATE|ALTER) )/m).filter(x=>x.trim()))await db.prepare(statement).run();
  await db.prepare("INSERT INTO resources(id,channel_id,name,type,capacity,created_at,updated_at) VALUES('migration_room','CROOM','旧設備','exclusive_room',1,0,0)").run();
  await db.prepare("INSERT INTO maintenance_periods(id,resource_id,start_at,end_at,reason,slack_user_id,created_at,updated_at) VALUES('old_period','migration_room',0,1000,'旧点検','U1',0,0)").run();
  const faultMigration=await readFile('migrations/0008_fault_without_end.sql','utf8');
  for(const group of faultMigration.split(/(?=^CREATE TRIGGER)/m).filter(x=>x.trim())) {
    if(group.startsWith('CREATE TRIGGER'))await db.prepare(group).run();
    else for(const statement of group.split(';').filter(x=>x.trim()))await db.prepare(statement).run();
  }
  expect(await db.prepare("SELECT end_at,kind,reason FROM maintenance_periods WHERE id='old_period'").first()).toEqual({end_at:1000,kind:'inspection',reason:'旧点検'});
  for(const group of (await readFile('migrations/0009_inspection_end_guard.sql','utf8')).split(/(?=^CREATE TRIGGER)/m).filter(x=>x.trim()))await db.prepare(group).run();
  for(const statement of (await readFile('migrations/0010_repair_updates.sql','utf8')).split(';').filter(x=>x.trim()))await db.prepare(statement).run();
  await db.prepare((await readFile('migrations/0011_maintenance_quantity.sql','utf8')).replace(/^--.*$/gm,'')).run();
  for(const statement of (await readFile('migrations/0012_personal_calendar.sql','utf8')).split(';').filter(x=>x.trim()))await db.prepare(statement).run();
  await db.prepare(await readFile('migrations/0013_member_names.sql','utf8')).run();
  await db.prepare(await readFile('migrations/0014_shared_purposes.sql','utf8')).run();
  for(const statement of (await readFile('migrations/0015_meeting_rosters.sql','utf8')).split(/(?=^(?:ALTER TABLE|CREATE TABLE|CREATE INDEX|CREATE TRIGGER|DROP TRIGGER|INSERT INTO))/m).filter(s=>s.trim()))await db.prepare(statement).run();
  for(const statement of (await readFile('migrations/0016_meeting_creation.sql','utf8')).split(/(?=^CREATE )/m).filter(s=>s.trim()))await db.prepare(statement).run();
  for(const statement of (await readFile('migrations/0017_professor_days.sql','utf8')).split(/(?=^CREATE )/m).filter(s=>s.trim()))await db.prepare(statement).run();
  for(const statement of (await readFile('migrations/0018_professor_day_batches.sql','utf8')).split(/(?=^CREATE )/m).filter(s=>s.trim()))await db.prepare(statement).run();
  for(const statement of (await readFile('migrations/0019_professor_calendar.sql','utf8')).split(/(?=^(?:CREATE TABLE|CREATE TRIGGER|INSERT INTO))/m).filter(s=>s.trim()))await db.prepare(statement).run();
  for(const statement of (await readFile('migrations/0020_booking_improvements.sql','utf8')).split(/(?=^(?:CREATE TABLE|CREATE TRIGGER|DROP TRIGGER))/m).filter(s=>s.trim()))await db.prepare(statement).run();
  for(const statement of (await readFile('migrations/0021_shared_schedule_editing.sql','utf8')).replace(/^--.*$/gm,'').split(/(?=^CREATE TRIGGER)/m).filter(x=>x.trim()))await db.prepare(statement).run();
  for(const statement of (await readFile('migrations/0022_resource_management.sql','utf8')).split(/(?=^(?:ALTER TABLE|UPDATE resources|CREATE TABLE|CREATE TRIGGER))/m).filter(s=>s.trim()))await db.prepare(statement).run();
  for(const statement of (await readFile('migrations/0023_stirrer_washing.sql','utf8')).split(/(?=^(?:ALTER TABLE|UPDATE resources|CREATE TABLE|CREATE TRIGGER|DROP TRIGGER))/m).filter(s=>s.trim()))await db.prepare(statement).run();
  for(const statement of (await readFile('migrations/0024_dashboard_auth.sql','utf8')).replace(/^--.*$/gm,'').split(';').filter(s=>s.trim()))await db.prepare(statement).run();
  for(const statement of (await readFile('migrations/0025_dashboard_devices.sql','utf8')).replace(/^--.*$/gm,'').split(';').filter(s=>s.trim()))await db.prepare(statement).run();
  await db.prepare((await readFile('migrations/0026_dashboard_read_index.sql','utf8')).replace(/^--.*$/gm,'')).run();
  for(const statement of (await readFile('migrations/0027_dashboard_pin_events.sql','utf8')).replace(/^--.*$/gm,'').split(';').filter(s=>s.trim()))await db.prepare(statement).run();
},30000);
afterAll(async()=>{await mf?.dispose();});
beforeEach(async()=>{
  await db.batch(['dashboard_pin_events','dashboard_devices','dashboard_operations','dashboard_auth_attempts','dashboard_members'].map(t=>db.prepare(`DELETE FROM ${t}`)));
  await db.batch(['wash_batches','resource_display_sync','resource_changes','reminder_preferences','reminder_preference_requests','reminder_deliveries','purpose_hidden','purpose_edits','professor_google_sync','professor_calendar_subscriptions','professor_day_batches','professor_day_requests','professor_days','professor_panels','meeting_creations','schedule_attendance','schedule_edits','schedule_sessions','schedule_settings','member_names','maintenance_updates','maintenance_periods','google_calendar_sync','calendar_subscriptions','operation_panels','notifications','processed_requests','panel_messages','reservations','resources'].map(t=>db.prepare(`DELETE FROM ${t}`)));
  for(const [id,type,capacity,channel] of [['room','exclusive_room',1,'CROOM'],['stirrer','quantity_resource',8,'CSTIR']]) {
    await db.prepare('INSERT INTO resources(id,channel_id,name,type,capacity,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind(id,channel,id==='room'?'測定室A':'スターラー',type,capacity,now,now).run();
    await db.prepare('INSERT INTO panel_messages VALUES(?,?,?,?,?)').bind(id,channel,'123.4',now,now).run();
  }
  service=new Reservations(db,()=>now);
});
describe('tablet dashboard API and shared reservation compatibility',()=>{
  let env:Env,cookie:string,jobs:Promise<unknown>[];
  let notify=vi.fn(async(_receipt:Receipt)=>({warnings:[] as string[]}));
  const request=(path:string,body?:Record<string,unknown>,options:{cookie?:string;origin?:string}={})=>new Request('https://test'+path,{
    method:body?'POST':'GET',headers:{Cookie:options.cookie??cookie,Origin:options.origin??'https://test',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined
  });
  const call=(path:string,body?:Record<string,unknown>,options?:{cookie?:string;origin?:string})=>dashboardRoute(request(path,body,options),env,{waitUntil:(p:Promise<unknown>)=>{jobs.push(p);}},{clock:()=>now,notify});
  const input=(overrides:Record<string,unknown>={})=>({action:'create',request_id:crypto.randomUUID(),resource_id:'room',user:'U1',pin:'1234',start_at:at(10),end_at:at(12),quantity:1,purpose:'PL測定',purpose_choice:'',...overrides});
  beforeEach(async()=>{
    env={DB:db,SLACK_TEAM_ID:'TEXAMPLE0003',SLACK_APP_ID:'AEXAMPLE0004',SLACK_BOT_TOKEN:'test',SLACK_SIGNING_SECRET:'test',ADMIN_TOKEN:'test',DASHBOARD_SECRET:'test-signing-secret-'.repeat(3),DASHBOARD_DEVICE_KEY:'test-device-key-'.repeat(3)};
    jobs=[];notify=vi.fn(async(_receipt:Receipt)=>({warnings:[] as string[]}));cookie='';
    for(const user of ['U1','U2']){
      await db.prepare('INSERT INTO member_names VALUES(?,?,?)').bind(user,user==='U1'?'予約者一':'予約者二',now).run();
      const salt=crypto.randomUUID();await db.prepare('INSERT INTO dashboard_members VALUES(?,?,?,?,?)').bind(user,salt,await pinHash(env,user,'1234',salt),1,now).run();
    }
    const device=await manageDevice(env,{action:'create',name:'テスト端末'},now);
    env.DASHBOARD_DEVICE_KEY=device.key;
    const response=await call('/dashboard/api/unlock',{key:device.key});expect(response.status).toBe(200);cookie=response.headers.get('Set-Cookie')!.split(';')[0];
  });
  it('requires device authentication, validates origin and fails closed without configuration',async()=>{
    expect((await call('/dashboard/api/snapshot',undefined,{cookie:''})).status).toBe(401);
    expect((await call('/dashboard/api/history?resource=room&from=2030-01-01&to=2030-01-02',undefined,{cookie:''})).status).toBe(401);
    expect((await call('/dashboard/api/bookings',input(),{origin:'https://attacker.test'})).status).toBe(403);
    env.DASHBOARD_SECRET=undefined;expect((await call('/dashboard/api/snapshot')).status).toBe(503);
    expect(await db.prepare('SELECT count(*) AS n FROM reservations').first('n')).toBe(0);
  });
  it('does not expose user IDs, PIN hashes, channel IDs, receipts or cancelled reservations in snapshots',async()=>{
    await change('slack-create');await service.change('slack-cancel','cancelled','room','U1','',undefined,(await service.list('room'))[0].id,1);
    const response=await call('/dashboard/api/snapshot'),body=await response.json() as any;
    expect(response.headers.get('Cache-Control')).toContain('no-store');expect(body.reservations).toHaveLength(0);
    const output=JSON.stringify(body);for(const field of ['pin_hash','pin_salt','channel_id','processed_requests'])expect(output).not.toContain(field);
    expect(body.members).toEqual([{id:'U1',name:'予約者一'},{id:'U2',name:'予約者二'}]);
  });
  it('tablet create uses the same store and receipt; Slack change and cancellation appear on the next read',async()=>{
    const body=input(),response=await call('/dashboard/api/bookings',body);expect(response.status).toBe(200);
    const row=(await service.list('room'))[0];expect(row.slack_user_id).toBe('U1');expect(row.slack_user_name).toBe('予約者一');
    await Promise.all(jobs);expect(notify).toHaveBeenCalledTimes(1);
    await service.change('slack-edit','updated','room','U1','',booking(12,14),row.id,1);
    expect((await dashboardSnapshot(db,'2030-01-02',now)).reservations[0].end_at).toBe(at(14));
    await service.change('slack-cancel','cancelled','room','U1','',undefined,row.id,2);
    expect((await dashboardSnapshot(db,'2030-01-02',now)).reservations).toHaveLength(0);
  });
  it('same request retries save and notify once; changing its contents is rejected',async()=>{
    const body=input();expect((await call('/dashboard/api/bookings',body)).status).toBe(200);
    const retry=await call('/dashboard/api/bookings',body);expect((await retry.json() as any).replayed).toBe(true);
    expect((await call('/dashboard/api/bookings',{...body,end_at:at(13)})).status).toBe(409);
    await Promise.all(jobs);expect(notify).toHaveBeenCalledTimes(1);expect(await db.prepare('SELECT count(*) AS n FROM reservations').first('n')).toBe(1);
  });
  it('owner can update and cancel from the tablet while preserving the original reservation ID',async()=>{
    const saved=await change('edit-from-tablet');
    expect((await call('/dashboard/api/bookings',input({action:'update',reservation_id:saved.reservation_id,version:1,end_at:at(13)}))).status).toBe(200);
    expect((await service.owned(saved.reservation_id,'U1')).end_at).toBe(at(13));
    expect((await call('/dashboard/api/bookings',input({action:'cancel',reservation_id:saved.reservation_id,version:1}))).status).toBe(409);
    expect((await call('/dashboard/api/bookings',input({action:'cancel',reservation_id:saved.reservation_id,version:2}))).status).toBe(200);
    expect((await service.owned(saved.reservation_id,'U1')).status).toBe('cancelled');
  });
  it('forged cookies and device-key rotation invalidate access without changing bookings',async()=>{
    expect((await call('/dashboard/api/snapshot',undefined,{cookie:cookie.slice(0,-1)+'z'})).status).toBe(401);
    const device=(await listDevices(env))[0];await manageDevice(env,{action:'rotate',id:device.id},now);
    expect((await call('/dashboard/api/snapshot')).status).toBe(401);
  });
  it('supports more than four devices, and disabling one leaves every other device active',async()=>{
    const originals=await listDevices(env),cookies:string[]=[];
    for(let i=0;i<5;i++){
      const device=await manageDevice(env,{action:'create',name:'追加端末'+i},now);
      const response=await call('/dashboard/api/unlock',{key:device.key});cookies.push(response.headers.get('Set-Cookie')!.split(';')[0]);
    }
    expect(await listDevices(env)).toHaveLength(6);
    await manageDevice(env,{action:'disable',id:originals[0].id},now);
    expect((await call('/dashboard/api/snapshot')).status).toBe(401);
    for(const activeCookie of cookies)expect((await call('/dashboard/api/snapshot',undefined,{cookie:activeCookie})).status).toBe(200);
    await manageDevice(env,{action:'enable',id:originals[0].id},now);
    expect((await call('/dashboard/api/snapshot')).status).toBe(401);
    const restored=await call('/dashboard/api/unlock',{key:env.DASHBOARD_DEVICE_KEY});expect(restored.status).toBe(200);
  });
  it('device management requires admin authentication and list responses never reveal keys',async()=>{
    expect((await call('/admin/dashboard/devices')).status).toBe(401);
    const response=await dashboardRoute(new Request('https://test/admin/dashboard/devices',{headers:{Authorization:'Bearer test'}}),env,{waitUntil:()=>{}},{clock:()=>now});
    expect(response.status).toBe(200);const body=await response.text();expect(body).not.toContain('key_hash');expect(body).not.toContain(env.DASHBOARD_DEVICE_KEY!);
  });
  it('member can change a four-digit PIN; old PIN stops working and no raw PIN is persisted',async()=>{
    const changed=await call('/dashboard/api/pin',{user:'U1',pin:'1234',new_pin:'5678',confirm_pin:'5678'});expect(changed.status).toBe(200);
    expect((await call('/dashboard/api/bookings',input())).status).toBe(403);
    expect((await call('/dashboard/api/bookings',input({pin:'5678'}))).status).toBe(200);
    const row=await db.prepare("SELECT * FROM dashboard_members WHERE slack_user_id='U1'").first<any>();expect(row.pin_hash).toMatch(/^[a-f0-9]{64}$/);
    const events=(await db.prepare('SELECT * FROM dashboard_pin_events').all()).results;expect(events).toHaveLength(1);expect(events[0].action).toBe('changed');
    expect(JSON.stringify(events)).not.toContain('5678');expect(Object.keys(row)).not.toContain('pin');
  });
  it('PIN change checks current PIN, confirmation and exactly four ASCII digits',async()=>{
    for(const next of ['123','12345','１２３４','abcd'])expect((await call('/dashboard/api/pin',{user:'U1',pin:'1234',new_pin:next,confirm_pin:next})).status).toBe(400);
    expect((await call('/dashboard/api/pin',{user:'U1',pin:'1234',new_pin:'5678',confirm_pin:'5679'})).status).toBe(400);
    expect((await call('/dashboard/api/pin',{user:'U1',pin:'9999',new_pin:'5678',confirm_pin:'5678'})).status).toBe(403);
    expect((await call('/dashboard/api/pin',{user:'U1',pin:'1234',new_pin:'5678',confirm_pin:'5678'},{cookie:''})).status).toBe(401);
    expect((await db.prepare('SELECT * FROM dashboard_pin_events').all()).results).toHaveLength(0);
  });
  it('admin reset restores 0000, clears lockout, uses a unique salt and preserves disabled state',async()=>{
    const reset=async(user:string)=>dashboardRoute(new Request('https://test/admin/dashboard/member',{method:'POST',headers:{Origin:'https://test','Content-Type':'application/json',Authorization:'Bearer test'},body:JSON.stringify({user,action:'reset'})}),env,{waitUntil:()=>{}},{clock:()=>now});
    for(let i=0;i<5;i++)await call('/dashboard/api/pin',{user:'U1',pin:'9999',new_pin:'5678',confirm_pin:'5678'});
    expect((await call('/dashboard/api/pin',{user:'U1',pin:'1234',new_pin:'5678',confirm_pin:'5678'})).status).toBe(429);
    expect((await call('/admin/dashboard/member',{user:'U1',action:'reset'})).status).toBe(401);
    expect((await reset('U1')).status).toBe(200);expect((await call('/dashboard/api/pin',{user:'U1',pin:'0000',new_pin:'1357',confirm_pin:'1357'})).status).toBe(200);
    await reset('U1');await reset('U2');const hashes=(await db.prepare('SELECT pin_hash FROM dashboard_members').all<{pin_hash:string}>()).results;expect(hashes[0].pin_hash).not.toBe(hashes[1].pin_hash);
    await db.prepare("UPDATE dashboard_members SET enabled=0 WHERE slack_user_id='U2'").run();await reset('U2');expect((await db.prepare("SELECT enabled FROM dashboard_members WHERE slack_user_id='U2'").first<any>()).enabled).toBe(0);
  });
  it('concurrent PIN changes cannot overwrite a change authenticated against an older hash',async()=>{
    const statuses=await Promise.all(['2468','1357'].map(new_pin=>call('/dashboard/api/pin',{user:'U1',pin:'1234',new_pin,confirm_pin:new_pin}).then(r=>r.status)));
    expect(statuses.filter(s=>s===200)).toHaveLength(1);expect(statuses.every(s=>[200,403,409].includes(s))).toBe(true);
    expect((await db.prepare('SELECT * FROM dashboard_pin_events').all()).results).toHaveLength(1);
  });
  it('external notification failures do not undo a committed reservation or turn its retry into a new booking',async()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try{notify.mockRejectedValueOnce(new Error('external unavailable'));const body=input();expect((await call('/dashboard/api/bookings',body)).status).toBe(200);await Promise.all(jobs);expect((await call('/dashboard/api/bookings',body)).status).toBe(200);expect((await service.list('room'))).toHaveLength(1);}
    finally{log.mockRestore();}
  });
  it('concurrent overlapping bookings from Slack and tablet cannot both succeed',async()=>{
    const results=await Promise.allSettled([change('parallel-slack'),call('/dashboard/api/bookings',input())]);
    const successful=Number(results[0].status==='fulfilled')+Number(results[1].status==='fulfilled'&&results[1].value.status===200);
    expect(successful).toBe(1);expect((await service.list('room')).length).toBe(1);
  });
  it('wrong PIN and another person cannot change, cancel or finish a reservation',async()=>{
    expect((await call('/dashboard/api/bookings',input({pin:'9999'}))).status).toBe(403);
    const saved=await change('slack-owned');
    for(const action of ['update','cancel','finish','extend'])expect((await call('/dashboard/api/bookings',input({action,user:'U2',reservation_id:saved.reservation_id,version:1,minutes:30}))).status).toBe(409);
    expect((await service.owned(saved.reservation_id,'U1')).status).toBe('active');
  });
  it('PIN attempts are bounded across requests, and revoked members are rejected',async()=>{
    for(let i=0;i<5;i++)expect((await call('/dashboard/api/bookings',input({pin:'9999'}))).status).toBe(403);
    expect((await call('/dashboard/api/bookings',input())).status).toBe(429);
    await db.prepare("UPDATE dashboard_members SET enabled=0 WHERE slack_user_id='U2'").run();
    expect((await call('/dashboard/api/bookings',input({user:'U2'}))).status).toBe(403);
  });
  it('quantity, pool and maintenance conflicts use existing booking validation',async()=>{
    await db.prepare("UPDATE resources SET capacity=8,booking_pools=? WHERE id='stirrer'").bind(JSON.stringify([{id:'inside',name:'内',capacity:3},{id:'outside',name:'外',capacity:5}])).run();
    expect((await call('/dashboard/api/bookings',input({resource_id:'stirrer',quantity:4,pool_id:'inside'}))).status).toBe(409);
    expect((await call('/dashboard/api/bookings',input({resource_id:'stirrer',quantity:3,pool_id:'inside'}))).status).toBe(200);
    await saveMaintenance(service,'U1','fault-api','room',{...booking(),purpose:'修理',end_at:null},'fault');
    expect((await call('/dashboard/api/bookings',input())).status).toBe(409);
  });
  it('snapshots include ended bookings today, cross-midnight bookings and the next booking beyond today',async()=>{
    await change('past-today',{...booking(),start_at:now+3600000,end_at:now+7200000});
    await change('overnight',{...booking(),start_at:now+23*3600000,end_at:now+26*3600000});
    await change('future-next',{...booking(),start_at:now+5*DAY,end_at:now+5*DAY+3600000});
    const response=await dashboardSnapshot(db,'2030-01-01',now+3*3600000);expect(response.reservations).toHaveLength(2);
    expect(response.reservations[0].end_at).toBe(now+7200000);
    const tomorrow=await dashboardSnapshot(db,'2030-01-02',now+3*3600000);expect(tomorrow.reservations.some(b=>b.start_at===now+23*3600000)).toBe(true);
    const later=await dashboardSnapshot(db,'2030-01-03',now+27*3600000);expect(later.reservations[0].start_at).toBe(now+5*DAY);
  });
  it('future maintenance and resource changes are reflected, and date range is bounded',async()=>{
    await saveMaintenance(service,'U1','future-maint','room',{...booking(),purpose:'点検'});
    await db.prepare("UPDATE resources SET name='変更後設備',capacity=6 WHERE id='stirrer'").run();
    const result=await dashboardSnapshot(db,'2030-01-02',now);expect(result.maintenance).toHaveLength(1);expect(result.resources.find(r=>r.id==='stirrer')?.capacity).toBe(6);
    expect((await call('/dashboard/api/snapshot?date=2030-02-31')).status).toBe(400);
    expect((await call('/dashboard/api/snapshot?date=2099-01-01')).status).toBe(400);
  });
  it('oversized requests and unknown API routes are rejected without writing reservations',async()=>{
    expect((await call('/dashboard/api/bookings',{...input(),purpose:'x'.repeat(17000)})).status).toBe(413);
    expect((await call('/dashboard/api/missing')).status).toBe(404);
    expect(await db.prepare('SELECT count(*) AS n FROM reservations').first('n')).toBe(0);
  });
});

describe('tablet status and free time calculations',()=>{
  const r:Equipment={id:'room',name:'設備',room:'181',type:'exclusive_room',capacity:1,enabled:1,multi_day:1,pools:[],purposes:[]};
  const b:BookingView={id:'b',resource_id:'room',person:'予約者',start_at:at(10),end_at:at(12),quantity:1,purpose:'測定',pool_id:null,version:1};
  it('switches ten minutes before, at start, and at the exclusive end boundary without a data update',()=>{
    expect(equipmentState(r,[b],[],at(9)).status).toBe('free');
    expect(equipmentState(r,[b],[],at(10)-600000).status).toBe('soon');
    expect(equipmentState(r,[b],[],at(10)).status).toBe('booked');
    expect(equipmentState(r,[b],[],at(12)).status).toBe('free');
    expect(equipmentState(r,[b],[],at(11),false).status).toBe('unknown');
  });
  it('shows every concurrent booking and conservative pool availability for unknown allocations',()=>{
    const resource={...r,type:'quantity_resource' as const,capacity:8,pools:[{id:'in',name:'内',capacity:3},{id:'out',name:'外',capacity:5}]};
    const rows=[{...b,quantity:2},{...b,id:'c',pool_id:'out',quantity:2}];
    const result=equipmentState(resource,rows,[],at(11));expect(result.current).toHaveLength(2);expect(result.available).toBe(4);expect(result.poolAvailable.map(p=>p.available)).toEqual([1,1]);
  });
  it('merges overlap boundaries into correct gaps, includes maintenance and clips cross-day periods',()=>{
    const start=midnight('2030-01-02'),maintenance=[{id:'m',resource_id:'room',start_at:at(14),end_at:null,quantity:1,kind:'fault',reason:'故障'}];
    const slots=availability(r,[b,{...b,id:'c',start_at:at(11),end_at:at(13)}],maintenance,start,start+DAY);
    expect(slots.filter(s=>s.quantity>0)).toEqual([{start,end:at(10),quantity:1},{start:at(13),end:at(14),quantity:1}]);
    expect(equipmentState(r,[],maintenance,at(15)).status).toBe('unavailable');
  });
});

describe('stirrer pools and optional washing rounds',()=>{
  const pools=[{id:'inside',name:'ドラフト内',capacity:8},{id:'outside',name:'ドラフト外',capacity:12}];
  const wash=(start=10,end=12,date=2,pool_id='inside',quantity=4):Booking=>({...booking(start,end,quantity),start_at:at(start,date),end_at:at(end,date),pool_id,purpose:'洗浄（1回目）'});
  beforeEach(async()=>{await db.prepare("UPDATE resources SET capacity=20,multi_day=1,room='実験室B',booking_pools=?,revision=revision+1 WHERE id='stirrer'").bind(JSON.stringify(pools)).run();});
  it('finishes each washing round independently through the normal owner button and keeps the later round',async()=>{
    const receipts=await reserveWash(service,'U1','利用者A','wash-finish','stirrer',[wash(),{...wash(10,12,5),purpose:'洗浄（2回目）'}]);
    const active=new Reservations(db,()=>at(11));
    const row=await active.owned(receipts[0].reservation_id,'U1'),resource=await active.resource('stirrer');
    for(const view of [notification('created',{resource,before:null,after:row},at(11)),listModal([row],[resource],{viewer:'U1',now:at(11),resource:'stirrer'})])expect(panelButtons(view).some(b=>b.action_id==='finish'&&b.value===row.id)).toBe(true);
    await expect(active.finish('wash-not-owner','U2',row.id,1)).rejects.toThrow();
    await active.finish('wash-finish-now','U1',row.id,1);await active.finish('wash-finish-now','U1',row.id,1);
    expect((await active.owned(row.id,'U1')).end_at).toBe(at(11));
    expect((await active.owned(receipts[1].reservation_id,'U1'))).toMatchObject({end_at:at(12,5),version:1,status:'active'});
  });
  it('enforces 8 inside and 12 outside independently, accepts boundaries and shows location in calendars',async()=>{
    await service.change('inside-eight','created','stirrer','U1','利用者A',wash(10,12,2,'inside',8));
    await expect(service.change('inside-nine','created','stirrer','U2','利用者X',wash(11,13,2,'inside',1))).rejects.toThrow('ドラフト内');
    const outside=await service.change('outside-twelve','created','stirrer','U2','利用者X',wash(10,12,2,'outside',12));
    await expect(service.change('outside-thirteen','created','stirrer','U2','利用者X',wash(11,13,2,'outside',1))).rejects.toThrow('ドラフト外');
    await service.change('inside-boundary','created','stirrer','U1','利用者A',wash(12,14,2,'inside',8));
    const row=await service.owned(outside.reservation_id,'U2'),r=await service.resource('stirrer');expect(row.pool_id).toBe('outside');expect(googleEvent(row,r).location).toContain('ドラフト外');expect(calendarICS([row],[r],now)).toContain('ドラフト外');
  });
  it('keeps legacy reservations unassigned and counts them conservatively until their owner chooses a location',async()=>{
    await db.prepare("INSERT INTO reservations(id,resource_id,slack_user_id,slack_user_name,start_at,end_at,quantity,status,version,created_at,updated_at) VALUES('legacy','stirrer','U1','利用者A',?,?,4,'active',1,?,?)").bind(at(10),at(12),now,now).run();
    await expect(service.change('legacy-inside-over','created','stirrer','U2','利用者X',wash(10,12,2,'inside',5))).rejects.toThrow('場所未設定');
    await expect(service.change('legacy-outside-over','created','stirrer','U2','利用者X',wash(10,12,2,'outside',9))).rejects.toThrow('ドラフト外');
    expect((await service.owned('legacy','U1')).pool_id).toBeNull();
    await service.change('locate-legacy','updated','stirrer','U1','',wash(10,12,2,'outside',4),'legacy',1);
    await service.change('inside-now-free','created','stirrer','U2','利用者X',wash(10,12,2,'inside',8));
    expect(JSON.stringify(bookingModal(await service.resource('stirrer'),now,await service.owned('legacy','U1')))).toContain('outside');
    await expect(service.change('missing-place','created','stirrer','U2','',booking(14,15))).rejects.toThrow('使用場所');
  });
  it('one-round washing creates exactly one reservation and replays without creating a second round',async()=>{
    const receipts=await reserveWash(service,'U1','利用者A','wash-once','stirrer',[wash()]);expect(receipts).toHaveLength(1);
    await reserveWash(service,'U1','利用者A','wash-once','stirrer',[wash()]);
    expect((await service.list('stirrer'))).toHaveLength(1);expect((await db.prepare('SELECT * FROM google_calendar_sync').all()).results).toHaveLength(1);
    expect(await db.prepare("SELECT rounds FROM wash_batches WHERE request_key='wash-once'").first()).toMatchObject({rounds:1});
  });
  it('two-round washing reserves both dates atomically, keeps the gap free, and permits cancelling only round two',async()=>{
    const r=await reserveWash(service,'U1','利用者A','wash-twice','stirrer',[wash(),{...wash(10,12,5),purpose:'洗浄（2回目）'}]);expect(r).toHaveLength(2);
    expect((await service.list('stirrer',null,at(0,3),at(23,4)))).toHaveLength(0);
    await service.change('wash-cancel-second','cancelled','stirrer','U1','',undefined,r[1].reservation_id,1);
    expect((await service.owned(r[0].reservation_id,'U1')).status).toBe('active');expect((await service.owned(r[1].reservation_id,'U1')).status).toBe('cancelled');
    await reserveWash(service,'U1','利用者A','wash-twice','stirrer',[wash()]);expect((await db.prepare('SELECT * FROM reservations').all()).results).toHaveLength(2);
    await expect(reserveWash(service,'U2','利用者X','wash-twice','stirrer',[wash()])).rejects.toThrow('確認');
  });
  it('a conflict in round two never saves round one or sends any notification',async()=>{
    await service.change('occupied-second','created','stirrer','U2','利用者X',wash(10,12,5,'inside',8));
    await expect(reserveWash(service,'U1','利用者A','wash-conflict','stirrer',[wash(),wash(10,12,5)])).rejects.toThrow('不足');
    expect((await db.prepare('SELECT * FROM wash_batches').all()).results).toHaveLength(0);expect((await service.list('stirrer'))).toHaveLength(1);
    expect((await db.prepare('SELECT * FROM notifications').all()).results).toHaveLength(1);
  });
  it('an actual database failure on insert two rolls back insert one, purpose changes, calendar jobs and notification jobs',async()=>{
    await db.prepare("CREATE TRIGGER force_wash_failure BEFORE INSERT ON processed_requests WHEN NEW.request_key='wash-db-failure_2' BEGIN SELECT RAISE(ABORT,'forced_second_insert'); END").run();
    const before=await service.resource('stirrer');try{await expect(reserveWash(service,'U1','利用者A','wash-db-failure','stirrer',[wash(),wash(10,12,5)])).rejects.toThrow('forced_second_insert');}finally{await db.prepare('DROP TRIGGER force_wash_failure').run();}
    for(const table of ['wash_batches','reservations','processed_requests','notifications','google_calendar_sync'])expect((await db.prepare('SELECT * FROM '+table).all()).results).toHaveLength(0);
    expect((await service.resource('stirrer')).revision).toBe(before.revision);
  });
  it('concurrent wash requests cannot exceed a pool, and extending or finishing retains pool identity',async()=>{
    const results=await Promise.allSettled([reserveWash(service,'U1','利用者A','race-wash-one','stirrer',[wash(10,12,2,'inside',5)]),reserveWash(service,'U2','利用者X','race-wash-two','stirrer',[wash(10,12,2,'inside',5)])]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);const row=(await service.list('stirrer'))[0];service.clock=()=>at(11);
    await extendBooking(service,'pool-extend',row.slack_user_id,row.id,1,30);expect((await service.owned(row.id,row.slack_user_id)).pool_id).toBe('inside');
    await service.finish('pool-finish',row.slack_user_id,row.id,2);expect((await service.owned(row.id,row.slack_user_id)).pool_id).toBe('inside');
  });
  it('shows one round by default, toggles two, adjusts dates by days and parses only the selected number of rounds',async()=>{
    const resource=await service.resource('stirrer');let view:SlackJSON=washForm(resource,now);expect(JSON.stringify(view)).not.toContain('wash2_start_date');expect(view.submit.text).toBe('1回分を予約');
    view={...view,state:{values:{wash_pool:{wash_pool:{selected_option:{value:'inside'}}},wash_quantity:{wash_quantity:{selected_option:{value:'2'}}}}}};
    view=washForm(resource,now,view,{action_id:'wash_count',selected_option:{value:'2'}});expect(JSON.stringify(view)).toContain('wash2_start_date');
    view=washForm(resource,now,view,{action_id:'wash_gap',selected_option:{value:'5'}});const date=view.blocks.find((b:SlackJSON)=>b.block_id==='wash2_start_date').element.initial_date;expect(date).toBe('2030-01-07');
    expect(washBookings(view)).toHaveLength(2);view=washForm(resource,now,view,{action_id:'wash_count',selected_option:{value:'1'}});expect(washBookings(view)).toHaveLength(1);expect(JSON.stringify(view.blocks)).not.toContain('wash2_start_date');
  });
  it.each([1,2])('saving a %i-round wash shows completion and sends each channel notice once across retries',async(count)=>{
    let view:SlackJSON=washForm(await service.resource('stirrer'),now);view.state={values:{wash_pool:{wash_pool:{selected_option:{value:'inside'}}},wash_count:{wash_count:{selected_option:{value:String(count)}}},wash_quantity:{wash_quantity:{selected_option:{value:'2'}}}}};
    view=washForm(await service.resource('stirrer'),now,view,{action_id:'wash_count',selected_option:{value:String(count)}});view.id='wash-view';
    const slack=vi.fn(async(_method:string,_payload:SlackJSON)=>({ok:true,ts:'notice',user:{profile:{real_name:'利用者F'}}}));
    const body={user:{id:'U1'},view,completion_external_id:'wash-result'};
    await submitWash(service,slack,body);await submitWash(service,slack,body);
    expect((await service.list('stirrer'))).toHaveLength(count);expect(slack.mock.calls.filter(c=>c[0]==='chat.postMessage')).toHaveLength(count);expect(slack.mock.calls.some(c=>c[0]==='chat.postEphemeral')).toBe(false);
    const messages=JSON.stringify(slack.mock.calls.filter(c=>c[0]==='chat.postMessage'));expect(messages).toContain('洗浄（1回目）');if(count===1)expect(messages).not.toContain('洗浄（2回目）');else expect(messages).toContain('洗浄（2回目）');
  });
  it('the confirmed delete and restore UI handles pooled stirrers without requiring hidden capacity fields',async()=>{
    let r=await service.resource('stirrer');const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true}));
    const body={user:{id:'U1'},view:{id:'pool-delete',callback_id:'save_resource',private_metadata:JSON.stringify({id:r.id,revision:r.revision,operation:'disabled',nonce:'delete-pooled'})}};
    await submitResource(service,slack,body);expect((await service.resource(r.id)).enabled).toBe(0);
    r=await service.resource(r.id);body.view.private_metadata=JSON.stringify({id:r.id,revision:r.revision,operation:'restored',nonce:'restore-pooled'});
    await submitResource(service,slack,body);expect((await service.resource(r.id)).enabled).toBe(1);expect((await service.resource(r.id)).pools).toHaveLength(2);
  });
  it('persists editable pool capacities and rejects reducing a pool below its assigned demand',async()=>{
    let r=await service.resource('stirrer');await changeResource(service,'U1','pool-capacities',r.id,'updated',r.revision,{equipment_label:'スターラー',room:'実験室B',channel_id:'CSTIR',type:'quantity_resource',capacity:22,multi_day:1,icon:'🧪',pool_capacities:[{id:'inside',capacity:8},{id:'outside',capacity:14}]});
    r=await service.resource('stirrer');expect(r.pools?.find(p=>p.id==='outside')?.capacity).toBe(14);expect(r.capacity).toBe(22);
    await service.change('inside-pool-demand','created','stirrer','U1','利用者A',wash(10,12,2,'inside',8));r=await service.resource('stirrer');
    await expect(changeResource(service,'U2','pool-below-demand',r.id,'updated',r.revision,{equipment_label:'スターラー',room:'実験室B',channel_id:'CSTIR',type:'quantity_resource',capacity:21,multi_day:1,icon:'🧪',pool_capacities:[{id:'inside',capacity:7},{id:'outside',capacity:14}]})).rejects.toThrow('ドラフト内');
  });
  it('quantity management edits pool counts consistently and availability reflects the chosen pool',async()=>{
    const r=await service.resource('stirrer');await expect(changeResource(service,'U1','bad-pool-total',r.id,'updated',r.revision,{equipment_label:'スターラー',room:'実験室B',channel_id:'CSTIR',type:'quantity_resource',capacity:21,multi_day:1,icon:'🧪'})).rejects.toThrow('合計');
    await service.change('availability-pool','created','stirrer','U1','利用者A',wash(10,12,2,'inside',8));
    const v=viewFor(await service.resource('stirrer'),wash(10,12,2,'inside',1),'availability');v.state.values.pool_id={pool_id:{selected_option:{value:'inside'}}};expect(JSON.stringify(await checkAvailability(service,v))).toContain('予約できません');
  });
});

describe('member equipment management',()=>{
  const settings=(over:Partial<ResourceInput>={}):ResourceInput=>({equipment_label:'新しい装置',room:'実験室C',channel_id:'CNEW',type:'exclusive_room',capacity:1,icon:'🔧',multi_day:1,...over});
  it('any member creates once, renames/moves with audit and updates existing calendar jobs while retaining reservation IDs/owners',async()=>{
    const made=await changeResource(service,'U2','new-device','new_device','created',-1,settings());
    await changeResource(service,'U2','new-device','new_device','created',-1,settings());
    expect((await db.prepare('SELECT * FROM resource_changes').all()).results).toHaveLength(1);
    const r=await service.resource(made.resource_id);expect(r.name).toBe('新しい装置(実験室C)');
    const booked=await service.change('new-device-book','created',r.id,'U1','利用者F',{...booking(),purpose:'',purpose_choice:''});
    const before=await service.resource(r.id);
    await changeResource(service,'U3','move-device',r.id,'updated',before.revision,settings({equipment_label:'移動した装置',room:'実験室B',channel_id:'CMOVED'}));
    const after=await service.owned(booked.reservation_id,'U1');expect(after).toMatchObject({id:booked.reservation_id,slack_user_id:'U1',version:2,status:'active'});
    expect(await db.prepare('SELECT desired_version,status FROM google_calendar_sync WHERE reservation_id=?').bind(after.id).first()).toMatchObject({desired_version:2,status:'pending'});
    expect(googleEvent(after,await service.resource(r.id))).toMatchObject({location:'実験室B'});
    expect(await db.prepare("SELECT slack_user_id FROM resource_changes WHERE request_key='move-device'").first()).toMatchObject({slack_user_id:'U3'});
    await expect(service.change('old-editor','updated',r.id,'U1','',booking(),after.id,1)).rejects.toThrow('変更済み');
  });
  it('soft deletes only after confirmation, preserves bookings, blocks new bookings, and allows another member to restore',async()=>{
    const booked=await change('existing-on-delete'),r=await service.resource('room'),slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true}));
    await resourceAction(service,slack,{user:{id:'U2'},trigger_id:'t',actions:[{action_id:'res_delete',value:r.id}]});
    expect((await service.resource(r.id)).enabled).toBe(1);expect(slack.mock.calls.at(-1)![1].view.submit.text).toBe('削除する');
    await changeResource(service,'U2','disable-device',r.id,'disabled',r.revision);
    expect((await service.owned(booked.reservation_id,'U1')).status).toBe('active');
    const kept=await calendarRows(db,now,at(23));expect(kept.some(x=>x.id===booked.reservation_id)).toBe(true);
    expect(calendarICS(kept,await service.resources(),now)).toContain(booked.reservation_id);
    await expect(change('cannot-book-disabled',booking(13,14))).rejects.toThrow('利用できません');
    expect(JSON.stringify(operationPanel(await service.resources()))).not.toContain('測定室A');
    expect(JSON.stringify(await resourceManagement(service))).toContain('再登録する');
    const deleted=await service.resource(r.id);await changeResource(service,'U3','restore-device',r.id,'restored',deleted.revision);
    expect((await service.resource(r.id)).enabled).toBe(1);
    expect((await service.owned(booked.reservation_id,'U1')).status).toBe('active');
  });
  it('checks peak quantity with existing future reservations and faults and serializes against new bookings/maintenance',async()=>{
    await change('quantity-book',booking(10,12,6),'stirrer');
    await saveMaintenance(service,'U1','quantity-fault','stirrer',{...booking(),end_at:null,quantity:2,purpose:'故障'},'fault');
    const r=await service.resource('stirrer');
    await expect(changeResource(service,'U2','too-few',r.id,'updated',r.revision,settings({type:'quantity_resource',capacity:7}))).rejects.toThrow('下回ります');
    expect((await service.resource(r.id)).capacity).toBe(8);
    await changeResource(service,'U2','more-units',r.id,'updated',r.revision,settings({type:'quantity_resource',capacity:20}));
    expect((await service.resource(r.id)).capacity).toBe(20);
    await expect(changeResource(service,'U3','stale-resource',r.id,'updated',r.revision,settings({type:'quantity_resource',capacity:21}))).rejects.toThrow('更新されました');
    const old=await service.resource(r.id);await cancelMaintenance(service,'U1','quantity-fault');
    await expect(changeResource(service,'U3','stale-maintenance',r.id,'updated',old.revision,settings({type:'quantity_resource',capacity:21}))).rejects.toThrow('更新されました');
  });
  it('rejects seminar editing, duplicate names, invalid input and replaying another member request',async()=>{
    await changeResource(service,'U1','unique-device','unique_device','created',-1,settings());
    await expect(changeResource(service,'U2','duplicate-device','another_device','created',-1,settings())).rejects.toThrow('登録済み');
    await expect(changeResource(service,'U2','unique-device','unique_device','created',-1,settings())).rejects.toThrow('確認');
    await expect(changeResource(service,'U2','bad-device','bad_device','created',-1,settings({room:''}))).rejects.toThrow('部屋');
    await expect(changeResource(service,'U2','bad-count','bad_count','created',-1,settings({capacity:0}))).rejects.toThrow('総台数');
    await db.prepare("UPDATE resources SET schedule_event=1 WHERE id='room'").run();
    await expect(changeResource(service,'U2','no-seminar','room','disabled',0)).rejects.toThrow('更新されました');
  });
  it('paginates equipment panels below Slack message limits and restores visible pages',async()=>{
    for(let i=0;i<22;i++)await changeResource(service,'U1','device-'+i,'device_'+i,'created',-1,settings({equipment_label:'設備'+i}));
    const rows=await service.resources();for(let page=0;page<2;page++){const panel=operationPanel(rows,[],now,page);expect(panel.blocks.length).toBeLessThanOrEqual(50);expect(panelButtons(panel).some(b=>b.action_id==='res_manage')).toBe(true);}
    const first=operationPanel(rows,[],now,0);expect(panelButtons(first).some(b=>b.action_id==='res_panel'&&b.value==='1')).toBe(true);
    const second=operationPanel(rows,[],now,1);expect(panelButtons(second).some(b=>b.action_id==='res_panel'&&b.value==='0')).toBe(true);
  });
  it('keeps form drafts on reservation-type changes and reports panel failure as saved without rolling back or duplicating',async()=>{
    const initial=resourceForm(),v={...initial,id:'form',state:{values:{res_label:{res_label:{value:'試験装置'}},res_room:{res_room:{value:'実験室C'}},res_type:{res_type:{selected_option:{value:'quantity_resource'}}},res_capacity:{res_capacity:{value:'20'}},res_channel:{res_channel:{selected_conversation:'CNEW'}},res_days:{res_days:{selected_option:{value:'1'}}}}}};
    const rebuilt=resourceForm(undefined,v);expect(rebuilt.blocks.find((b:SlackJSON)=>b.block_id==='res_label')!.element.initial_value).toBe('試験装置');expect(rebuilt.blocks.some((b:SlackJSON)=>b.block_id==='res_capacity')).toBe(true);
    const slack=vi.fn(async(m:string,_p:SlackJSON)=>{if(m.startsWith('chat.'))throw new Error('slack_not_in_channel');return {ok:true};});
    await submitResource(service,slack,{view:v,user:{id:'U2'},completion_external_id:'saved-view'});
    expect((await service.resource(JSON.parse(v.private_metadata).id)).capacity).toBe(20);
    expect(JSON.stringify(slack.mock.calls.at(-1)![1])).toContain('保存済み');
    await submitResource(service,slack,{view:v,user:{id:'U2'},completion_external_id:'saved-view'});
    expect((await db.prepare('SELECT * FROM resource_changes').all()).results).toHaveLength(1);
  });
});

describe('booking improvements',()=>{
  it('extends by 30 minutes up to the next booking boundary, rejects an overlap and deduplicates retries',async()=>{
    const own=await change('extend-own');await change('next-room',{...booking(12,14),start_at:at(12)+30*60000},'room','U2');service.clock=()=>at(11);
    await expect(extendBooking(service,'extend-hour','U1',own.reservation_id,1,60)).rejects.toThrow('予約');
    const saved=await extendBooking(service,'extend-half','U1',own.reservation_id,1,30);await extendBooking(service,'extend-half','U1',own.reservation_id,1,30);
    expect((await service.owned(own.reservation_id,'U1')).end_at).toBe(at(12)+30*60000);expect(JSON.parse(saved.payload).after.version).toBe(2);
    await expect(extendBooking(service,'not-owner','U2',own.reservation_id,2,30)).rejects.toThrow('ご本人');
    expect((await db.prepare("SELECT count(*) AS n FROM processed_requests WHERE operation='updated'").first())?.n).toBe(1);
  });
  it('extension checks quantity during the extra interval and maintenance before committing',async()=>{
    const own=await change('extend-stir',booking(10,12,3),'stirrer');await change('tail-stir',booking(12,14,6),'stirrer','U2');service.clock=()=>at(11);
    await expect(extendBooking(service,'no-capacity','U1',own.reservation_id,1,30)).rejects.toThrow('不足');
    expect((await service.owned(own.reservation_id,'U1')).version).toBe(1);
    const room=await change('extend-room',booking(12,14));service.clock=()=>at(13);
    await saveMaintenance(service,'U2','tail-inspection','room',{...booking(14,15),purpose:'点検'});
    await expect(extendBooking(service,'no-maintenance','U1',room.reservation_id,1,30)).rejects.toThrow('故障・点検');
  });
  it('reminders default OFF, notify only the owner once, and OFF or cancellation stops later reminders',async()=>{
    const own=await change('remind-own'),slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true}));service.clock=()=>at(12)-4*60000;
    await sendDueReminders(service,slack);expect(slack).not.toHaveBeenCalled();
    await setReminders(db,'U1','remind-on',true,now);await sendDueReminders(service,slack);await sendDueReminders(service,slack);
    expect(slack).toHaveBeenCalledTimes(1);expect(slack.mock.calls[0][1].channel).toBe('U1');expect(JSON.stringify(slack.mock.calls[0][1])).toContain('extend_30');
    await setReminders(db,'U1','remind-off',false,service.clock());await setReminders(db,'U1','remind-on',true,now);
    service.clock=()=>at(12);await sendDueReminders(service,slack);expect(slack).toHaveBeenCalledTimes(1);
    expect((await db.prepare("SELECT enabled FROM reminder_preferences WHERE slack_user_id='U1'").first())?.enabled).toBe(0);
    await service.change('remind-cancel','cancelled','room','U1','',undefined,own.reservation_id,1);await setReminders(db,'U1','on-again',true,now);await sendDueReminders(service,slack);expect(slack).toHaveBeenCalledTimes(1);
  });
  it('end reminders and changed end times use the latest version without duplicating earlier reminders',async()=>{
    const own=await change('version-remind'),slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true}));await setReminders(db,'U1','ver-on',true,now);
    service.clock=()=>at(12)-4*60000;await sendDueReminders(service,slack);await extendBooking(service,'remind-extend','U1',own.reservation_id,1,30);
    service.clock=()=>at(12);await sendDueReminders(service,slack);expect(slack).toHaveBeenCalledTimes(1);
    service.clock=()=>at(12)+26*60000;await sendDueReminders(service,slack);service.clock=()=>at(12)+30*60000;await sendDueReminders(service,slack);await sendDueReminders(service,slack);
    expect(slack).toHaveBeenCalledTimes(3);expect(JSON.stringify(slack.mock.calls.at(-1)![1])).toContain('終了時刻になりました');
  });
  it('manual finish suppresses an extra end reminder and uncertain DM delivery is not blindly retried',async()=>{
    const own=await change('finish-remind'),slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true}));await setReminders(db,'U1','finish-on',true,now);service.clock=()=>at(11);await service.finish('finish-with-reminder','U1',own.reservation_id,1);
    await sendDueReminders(service,slack);expect(slack).not.toHaveBeenCalled();
    service.clock=()=>now;await change('failed-reminder',booking(13,14));service.clock=()=>at(14)-3*60000;slack.mockImplementation(async()=>{throw Error('secret payload');});const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try{await sendDueReminders(service,slack);await sendDueReminders(service,slack);expect(slack).toHaveBeenCalledTimes(1);expect(JSON.stringify(log.mock.calls)).not.toContain('secret payload');expect((await db.prepare("SELECT status FROM reminder_deliveries WHERE kind='before'").first())?.status).toBe('failed');}finally{log.mockRestore();}
  });
  it('purpose hide and restore do not rewrite history or automatically resurrect a hidden free-text value',async()=>{
    const r=await change('purpose-original',{...booking(),purpose:'旧用途'}),before=await service.owned(r.reservation_id,'U1');let resource=await service.resource('room');
    await editPurpose(service,'U2','hide-purpose','room',resource.revision,'旧用途','');
    expect((await service.owned(r.reservation_id,'U1')).purpose).toBe('旧用途');expect(JSON.parse((await service.resource('room')).purpose_options)).not.toContain('旧用途');
    await service.change('keep-purpose-history','updated','room','U1','',{...booking(11,13),purpose:'旧用途'},before.id,1);
    expect(JSON.parse((await service.resource('room')).purpose_options)).not.toContain('旧用途');resource=await service.resource('room');
    await editPurpose(service,'U1','restore-purpose','room',resource.revision,'旧用途','',true);expect(JSON.parse((await service.resource('room')).purpose_options)).toContain('旧用途');
    await editPurpose(service,'U1','restore-purpose','room',resource.revision,'旧用途','',true);expect((await db.prepare('SELECT count(*) AS n FROM purpose_edits').first())?.n).toBe(2);
  });
  it('purpose rename merges duplicates and rejects stale edits without losing another members new option',async()=>{
    await change('purpose-a',{...booking(),purpose:'A'});await change('purpose-b',{...booking(13,14),purpose:'B'});const r=await service.resource('room');
    await editPurpose(service,'U1','merge-purpose','room',r.revision,'A','B');expect(JSON.parse((await service.resource('room')).purpose_options)).toEqual(['B','自由入力']);
    await expect(editPurpose(service,'U2','stale-purpose','room',r.revision,'B','C')).rejects.toThrow('更新');
    expect((await db.prepare("SELECT purpose FROM reservations WHERE purpose='A'").first())?.purpose).toBe('A');
  });
  it('reservation reuse only exposes own equipment templates and creates a new booking draft',async()=>{
    const r=await change('template-own',booking(10,12,2),'stirrer');await change('template-other',booking(13,14,3),'stirrer','U2');const rows=await reusableBookings(service,'U1');expect(rows.map(r=>r.id)).toEqual([r.reservation_id]);
    const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true}));await toolsAction(service,slack,{user:{id:'U1'},trigger_id:'t',actions:[{action_id:'tools_reuse_pick',value:r.reservation_id}]});
    const v=slack.mock.calls.at(-1)![1].view;expect(v.callback_id).toBe('save_booking');expect(JSON.parse(v.private_metadata).reservation).toBeUndefined();expect(v.blocks.find((b:SlackJSON)=>b.block_id==='quantity').element.initial_option.value).toBe('2');
    await toolsAction(service,slack,{user:{id:'U1'},trigger_id:'t',view:{id:'parent',callback_id:'reservation_list',private_metadata:JSON.stringify({resource:'stirrer',period:'all'})},actions:[{action_id:'tools_reuse_pick',value:r.reservation_id}]});expect(JSON.parse(slack.mock.calls.at(-1)![1].view.private_metadata).return_view).toBe('parent');
    expect((await db.prepare('SELECT count(*) AS n FROM reservations').first())?.n).toBe(2);
    await expect(toolsAction(service,slack,{user:{id:'U2'},trigger_id:'t',actions:[{action_id:'tools_reuse_pick',value:r.reservation_id}]})).rejects.toThrow('ご本人');
  });
  it('existing reservations get a warning for overlapping faults including partial quantities, but not boundaries',async()=>{
    const own=await change('maintenance-warning',booking(10,12,2),'stirrer');await saveMaintenance(service,'U2','warning-fault','stirrer',{...booking(),end_at:null,quantity:1,purpose:'故障'},'fault');const row=await service.owned(own.reservation_id,'U1');
    expect((await maintenanceWarnings(service,[row]))[0].maintenance_warning).toContain('1台');
    expect((await maintenanceWarnings(service,[{...row,end_at:at(10),start_at:at(9)}]))[0].maintenance_warning).toBe('');
  });
  it('finishing from a list refreshes the parent list and returns privately without a duplicate channel result',async()=>{
    const own=await change('auto-list-own');service.clock=()=>at(11);const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true,ts:'x'}));await action(service,slack,{user:{id:'U1'},trigger_id:'t',actions:[{action_id:'hub_list'}]});
    const list={...slack.mock.calls.at(-1)![1].view,id:'parent',hash:'h'};await action(service,slack,{user:{id:'U1'},trigger_id:'t',view:list,actions:[{action_id:'finish',value:own.reservation_id}]});
    const view={...slack.mock.calls.at(-1)![1].view,id:'child'};expect(JSON.parse(view.private_metadata).return_view).toBe('parent');await submit(service,slack,{user:{id:'U1'},view});
    const parent=slack.mock.calls.find(c=>c[0]==='views.update'&&c[1].view_id==='parent')![1].view;expect(JSON.stringify(parent)).not.toContain(own.reservation_id);expect(slack.mock.calls.some(c=>c[0]==='chat.postEphemeral')).toBe(false);
    expect(slack.mock.calls.at(-1)![1].view.close.text).toBe('一覧に戻る');
  });
  it('sync status separates calendars and shows retry state without exposing provider error bodies',async()=>{
    await change('sync-status');await change('sync-other-equipment',booking(10,12,2),'stirrer');await db.prepare("UPDATE google_calendar_sync SET last_error='google_events_http_503'").run();const s=await calendarStatus(service,'U1',{DB:db} as Env);expect(s.groups).toHaveLength(1);expect(s.groups[0]).toMatchObject({name:'設備予約',errors:2,count:2});expect(s.configured).toBe(false);
    const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true}));await toolsAction(service,slack,{user:{id:'U1'},trigger_id:'t',actions:[{action_id:'tools_sync'}]});const v=JSON.stringify(slack.mock.calls.at(-1)![1]);expect(v).toContain('自動再試行中');expect(v).not.toContain('google_events_http_503');
  });
  it('simultaneous reminder runs claim a notification only once',async()=>{
    await change('race-reminder');await setReminders(db,'U1','race-on',true,now);service.clock=()=>at(12)-3*60000;
    const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true}));await Promise.all([sendDueReminders(service,slack),sendDueReminders(service,slack)]);expect(slack).toHaveBeenCalledTimes(1);
  });
  it('purpose UI submissions are idempotent and do not overwrite later shared changes',async()=>{
    await change('ui-purpose',{...booking(),purpose:'表記ゆれ'});const r=await service.resource('room'),slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true}));
    const view:SlackJSON={id:'V',callback_id:'save_tools_purpose',private_metadata:JSON.stringify({resource:'room',revision:r.revision,nonce:'ui-purpose-edit'}),state:{values:{source:{source:{selected_option:{value:'表記ゆれ'}}},target:{target:{value:'統一した用途'}}}}};
    await submitTools(service,slack,{user:{id:'U1'},view});await submitTools(service,slack,{user:{id:'U1'},view});
    expect(JSON.stringify(slack.mock.calls.at(-1)![1])).toContain('更新しました');expect((await db.prepare('SELECT count(*) AS n FROM purpose_edits').first())?.n).toBe(1);
    expect(JSON.parse((await service.resource('room')).purpose_options)).toContain('統一した用途');
    const latest=await service.resource('room');await editPurpose(service,'U1','hide-last','room',latest.revision,'統一した用途','');
    await toolsAction(service,slack,{user:{id:'U1'},trigger_id:'t',actions:[{action_id:'tools_purpose_resource',value:'room'}]});expect(JSON.stringify(slack.mock.calls.at(-1)![1])).toContain('tools_purpose_restore');
  });
  it('a failed extension from a list retains the booking and shows a private error without a channel notice',async()=>{
    const own=await change('list-extend-own');await change('list-next',booking(12,14),'room','U2');service.clock=()=>at(11);const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true}));
    const view={id:'child',callback_id:'extend_booking',private_metadata:JSON.stringify({resource:'room',reservation:own.reservation_id,version:1,minutes:30,nonce:'list-extend-fail',return_view:'parent',return_meta:{resource:'all',period:'all'}})};
    await submit(service,slack,{user:{id:'U1'},view});expect((await service.owned(own.reservation_id,'U1')).version).toBe(1);expect(slack.mock.calls.map(c=>c[0])).toEqual(['views.update']);expect(JSON.stringify(slack.mock.calls[0][1])).toContain('予約されています');
  });
});

describe('finish equipment use now',()=>{
  it('keeps history and all fields, releases the room immediately, and replays preserve the first finish time',async()=>{
    const receipt=await change('finish-created'),before=await service.owned(receipt.reservation_id,'U1');service.clock=()=>at(11)+1234;
    const saved=await service.finish('finish-now','U1',before.id,1),after=await service.owned(before.id,'U1');
    expect(after).toEqual({...before,end_at:at(11)+1234,version:2,updated_at:at(11)+1234});expect(after.status).toBe('active');
    expect(JSON.parse(saved.payload).finished).toBe(true);expect(await service.list('room')).toHaveLength(0);
    service.clock=()=>at(11)+60000;expect((await service.finish('finish-now','U1',before.id,1)).request_key).toBe(saved.request_key);
    expect((await service.owned(before.id,'U1')).end_at).toBe(at(11)+1234);
    await service.change('after-finish','created','room','U2','別メンバー',{...booking(11,12),start_at:at(11)+60000});
  });
  it('releases only this users stirrer quantity and works during an existing fault',async()=>{
    const a=await change('stir-a',booking(10,14,3),'stirrer'),b=await change('stir-b',booking(10,14,4),'stirrer','U2');
    service.clock=()=>at(11);await saveMaintenance(service,'U2','fault-finishing','stirrer',{...booking(),start_at:at(10),end_at:null,quantity:1,purpose:'故障'},'fault');
    await service.finish('finish-stir','U1',a.reservation_id,1);
    const rows=await service.list('stirrer'),resource=await service.resource('stirrer');expect(rows.map(r=>r.id)).toEqual([b.reservation_id]);expect(currentStatus(resource,rows,at(11))).toContain('使用中：4 / 8台');
  });
  it('rejects another user, future/ended/cancelled reservations and schedule events',async()=>{
    const r=await change('finish-guards');service.clock=()=>at(11);
    await expect(service.finish('other','U2',r.reservation_id,1)).rejects.toThrow('ご本人');
    service.clock=()=>at(9);await expect(service.finish('future','U1',r.reservation_id,1)).rejects.toThrow('開始前');
    service.clock=()=>at(12);await expect(service.finish('ended','U1',r.reservation_id,1)).rejects.toThrow('終了');
    service.clock=()=>at(11);await service.change('cancel-finish','cancelled','room','U1','',undefined,r.reservation_id,1);
    await expect(service.finish('cancelled','U1',r.reservation_id,2)).rejects.toThrow('終了済み');
    await db.prepare("UPDATE resources SET schedule_event=1 WHERE id='room'").run();
    // Use a separate equipment resource then mark it as a schedule to check the server guard.
    const s=await change('schedule-guard',booking(12,14),'stirrer');await db.prepare("UPDATE resources SET schedule_event=1 WHERE id='stirrer'").run();service.clock=()=>at(13);
    await expect(service.finish('seminar','U1',s.reservation_id,1)).rejects.toThrow('設備');
  });
  it('confirmation does not save; submit uses the confirmation time, not the time the dialog opened',async()=>{
    const r=await change('confirm-finish');service.clock=()=>at(11);const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true,ts:'finish-ts'}));
    await action(service,slack,{user:{id:'U1'},channel:{id:'CROOM'},trigger_id:'t',actions:[{action_id:'finish_resource',value:'room'}]});
    const view=slack.mock.calls.at(-1)![1].view;expect(view.callback_id).toBe('finish_booking');expect((await service.owned(r.reservation_id,'U1')).version).toBe(1);
    expect(slack.mock.calls.some(c=>c[0]==='chat.postMessage')).toBe(false);
    service.clock=()=>at(11)+5*60000;const google=vi.fn(async()=> 'synced');
    await submit(service,slack,{user:{id:'U1'},view},google);await submit(service,slack,{user:{id:'U1'},view},google);
    expect((await service.owned(r.reservation_id,'U1')).end_at).toBe(at(11)+5*60000);
    expect(slack.mock.calls.filter(c=>c[0]==='chat.postMessage')).toHaveLength(1);expect(slack.mock.calls.filter(c=>c[0]==='chat.postEphemeral')).toHaveLength(0);
    expect(JSON.stringify(slack.mock.calls.find(c=>c[0]==='chat.postMessage')![1])).toContain('利用が終了');
    expect((await db.prepare('SELECT desired_version FROM google_calendar_sync').first())?.desired_version).toBe(2);expect(google).toHaveBeenCalled();
    const token=await subscriptionToken(db,'U1',at(11));const feed=await (await calendarResponse(new Request('https://test/calendar.ics?token='+token),db,at(11))).text();expect(feed).toContain('DTEND:20300102T020500Z');
  });
  it('simultaneous finish requests cannot overwrite each other and stale confirmations fail',async()=>{
    const r=await change('race-finish');service.clock=()=>at(11);
    const results=await Promise.allSettled([service.finish('race-a','U1',r.reservation_id,1),service.finish('race-b','U1',r.reservation_id,1)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await service.owned(r.reservation_id,'U1')).version).toBe(2);
    expect((await db.prepare("SELECT * FROM processed_requests WHERE operation='updated'").all()).results).toHaveLength(1);
  });
  it('central panel and own list show the shortcut only while in use',async()=>{
    const r=await change('ui-finish'),row=await service.owned(r.reservation_id,'U1'),resources=await service.resources();
    expect(JSON.stringify(operationPanel(resources,[row],at(11)))).toContain('finish_resource');
    expect(JSON.stringify(operationPanel(resources,[row],at(9)))).not.toContain('finish_resource');
    const {listModal}=await import('../src/ui');expect(JSON.stringify(listModal([row],resources,{mine:true,viewer:'U1',now:at(11)}))).toContain('今すぐ終了');
    expect(JSON.stringify(listModal([row],resources,{mine:true,viewer:'U1',now:at(9)}))).not.toContain('今すぐ終了');
  });
  it('general reservation/availability lists show controls only for the authenticated viewer, ignoring a forged viewer',async()=>{
    const own=await change('list-own',booking(10,14,3),'stirrer'),other=await change('list-other',booking(10,14,4),'stirrer','U2');service.clock=()=>at(11);
    const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true}));
    await action(service,slack,{user:{id:'U1'},channel:{id:'CSTIR'},trigger_id:'t',actions:[{action_id:'list',value:'stirrer'}]});
    let view=slack.mock.calls.find(c=>c[0]==='views.open')![1].view;
    const buttons=(v:SlackJSON)=>panelButtons(v).filter(b=>['edit','cancel','finish'].includes(b.action_id));
    expect(buttons(view).map(b=>b.value)).toEqual([own.reservation_id,own.reservation_id,own.reservation_id]);expect(view.blocks.filter((b:SlackJSON)=>b.text?.text?.includes('使用台数：')).length).toBe(2);
    const meta=JSON.parse(view.private_metadata);meta.viewer='U2';view={...view,id:'V',hash:'h',private_metadata:JSON.stringify(meta)};
    await action(service,slack,{user:{id:'U1'},view,actions:[{action_id:'list_refresh'}]});
    view=slack.mock.calls.at(-1)![1].view;
    expect(buttons(view).every(b=>b.value===own.reservation_id)).toBe(true);expect(buttons(view).some(b=>b.value===other.reservation_id)).toBe(false);
  });
  it('the edit dialog offers immediate finish for current equipment use, but never for a future booking or seminar',async()=>{
    const r=await change('edit-shortcut'),row=await service.owned(r.reservation_id,'U1'),resource=await service.resource('room');
    const current=bookingModal(resource,at(11),row);expect(panelButtons(current).find(b=>b.action_id==='finish')).toMatchObject({value:row.id,visible_to_user_ids:['U1']});
    expect(panelButtons(bookingModal(resource,at(9),row)).some(b=>b.action_id==='finish')).toBe(false);
    expect(panelButtons(bookingModal({...resource,schedule_event:1},at(11),row)).some(b=>b.action_id==='finish')).toBe(false);
  });
  it('shared buttons restrict visibility to the reservation owner and central finish restricts current users',async()=>{
    const a=await change('visible-own',booking(10,14,3),'stirrer'),b=await change('visible-other',booking(10,14,4),'stirrer','U2');
    const content=notification('created',JSON.parse(a.payload),at(11));expect(panelButtons(content).some(b=>b.action_id==='finish')).toBe(true);
    for(const button of panelButtons(content).filter(b=>['edit','cancel','finish'].includes(b.action_id)))expect(button.visible_to_user_ids).toEqual(['U1']);
    expect(panelButtons(notification('created',JSON.parse(a.payload),at(15))).some(b=>['edit','cancel','finish'].includes(b.action_id))).toBe(false);
    const rows=[await service.owned(a.reservation_id,'U1'),await service.owned(b.reservation_id,'U2')];
    const finish=panelButtons(operationPanel(await service.resources(),rows,at(11))).find(b=>b.action_id==='finish_resource');expect(finish!.visible_to_user_ids.sort()).toEqual(['U1','U2']);
  });
  it('all configured equipment and rooms use the same owner-checked finish path',async()=>{
    for(const id of ['dark_room','cryostat','sem_edx','furnace_blue','furnace_silver','furnace_light_blue','printer_3d','centrifuge','job_room','storage_room']){
      service.clock=()=>now;await db.prepare("INSERT INTO resources(id,channel_id,name,type,capacity,created_at,updated_at) VALUES(?,?,?,'exclusive_room',1,?,?)").bind(id,'CROOM',id,now,now).run();
      const r=await change('all-'+id,booking(),id);service.clock=()=>at(11);await service.finish('end-'+id,'U1',r.reservation_id,1);
      expect((await service.owned(r.reservation_id,'U1')).end_at).toBe(at(11));
    }
  });
  it('refreshes historical messages in bounded pages so every old owner button can be updated',async()=>{
    for(let i=0;i<6;i++){const r=await change('paged-'+i,booking(i*2+1,i*2+2));await db.prepare("UPDATE notifications SET status='sent',message_ts=? WHERE request_key=?").bind('m-'+i,r.request_key).run();}
    const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true}));
    expect(await refreshHistorical(service,slack,['room'],0,5)).toEqual({updated:5,missing:0,next_offset:5});
    expect(await refreshHistorical(service,slack,['room'],5,5)).toEqual({updated:1,missing:0,next_offset:null});
    expect(new Set(slack.mock.calls.map(c=>c[1].ts)).size).toBe(6);
    for(const c of slack.mock.calls)for(const b of panelButtons(c[1]).filter(b=>['edit','cancel','finish'].includes(b.action_id)))expect(b.visible_to_user_ids).toEqual(['U1']);
  });
});

describe('actual D1 transactions',()=>{
  it('any member can add a resource purpose by booking, and the next member can choose it',async()=>{
    const receipt=await change('shared-a',{...booking(),purpose:'新しい試料作製'},'room','U2');
    const r=await service.resource('room');expect(JSON.parse(r.purpose_options)).toEqual(['新しい試料作製','自由入力']);
    const menu=bookingModal(r,now).blocks.find((b:SlackJSON)=>b.block_id==='purpose_choice');
    expect(menu.element.options.map((o:SlackJSON)=>o.value)).toContain('新しい試料作製');
    const view=viewFor(r,{...booking(13,14),purpose:''},'shared-b');
    view.state.values.purpose_choice={purpose_choice:{selected_option:{value:'新しい試料作製'}}};
    await service.change('shared-b','created','room','U3','別メンバー',parseBooking(view,r));
    expect((await service.list()).find(row=>row.slack_user_id==='U3')).toMatchObject({purpose_choice:'新しい試料作製',purpose:''});
    await service.change('shared-a','created','room','U2','',booking());
    expect(JSON.parse((await service.resource('room')).purpose_options)).toEqual(['新しい試料作製','自由入力']);
    await service.change('shared-cancel','cancelled','room','U2','',undefined,receipt.reservation_id,1);
    expect(JSON.parse((await service.resource('room')).purpose_options)).toContain('新しい試料作製');
    expect(JSON.parse((await service.resource('stirrer')).purpose_options)).not.toContain('新しい試料作製');
  });
  it('failed reservations and blank purposes do not add choices; simultaneous members add without lost updates',async()=>{
    await change('original',{...booking(),purpose:''});
    await expect(change('conflict',{...booking(),purpose:'保存しない用途'})).rejects.toThrow('予約されています');
    expect(JSON.parse((await service.resource('room')).purpose_options)).toEqual([]);
    await Promise.all([change('new-a',{...booking(),purpose:' 用途A '},'stirrer','U1'),change('new-b',{...booking(),purpose:'用途B'},'stirrer','U2')]);
    await change('duplicate',{...booking(13,14),purpose:'用途A'},'stirrer','U3');
    const options=JSON.parse((await service.resource('stirrer')).purpose_options);
    expect(options.filter((p:string)=>p==='用途A')).toHaveLength(1);
    expect(options).toEqual(expect.arrayContaining(['用途A','用途B','自由入力']));
  });
  it('grouped menus and long purpose names stay selectable and retain the full saved text',async()=>{
    const long='長い用途名'.repeat(50);
    await change('long-purpose',{...booking(),purpose:long});
    let r=await service.resource('room');
    const modal=bookingModal(r,now),menu=modal.blocks.find((b:SlackJSON)=>b.block_id==='purpose_choice').element;
    const entry=menu.options[0];expect(Array.from(entry.text.text).length).toBeLessThanOrEqual(75);expect(entry.value.length).toBeLessThanOrEqual(150);
    const view=viewFor(r,booking(13,14),'long-select');view.state.values.purpose_choice={purpose_choice:{selected_option:entry}};
    expect(parseBooking(view,r).purpose_choice).toBe(long);
    const choices=[...Array.from({length:120},(_,i)=>`用途${i}`),'自由入力'];
    await db.prepare('UPDATE resources SET purpose_options=? WHERE id=?').bind(JSON.stringify(choices),'room').run();r=await service.resource('room');
    const grouped=bookingModal(r,now).blocks.find((b:SlackJSON)=>b.block_id==='purpose_choice').element;
    expect(grouped.options).toBeUndefined();expect(grouped.option_groups).toHaveLength(2);
    expect(grouped.option_groups.every((g:SlackJSON)=>g.options.length<=100)).toBe(true);
  });
  it('uses configured member spelling for new bookings without trusting the submitted account name',async()=>{
    await db.prepare("INSERT INTO member_names VALUES('U1','利用者E',?)").bind(now).run();
    const slack=vi.fn(async()=>({ok:true,ts:'123.4'}));
    await submit(service,slack,{view:viewFor(await service.resource('room'),booking(),'member'),user:{id:'U1',name:'s233141'}});
    const row=(await service.list())[0];
    expect(row).toMatchObject({slack_user_id:'U1',slack_user_name:'利用者E'});
    expect(slack.mock.calls.some(call=>(call as unknown[])[0]==='users.info')).toBe(false);
    expect(calendarICS([row],await service.resources(),now)).toContain('利用者E');
  });
  it('prefers the full Slack profile name over a student-number display name',async()=>{
    const slack=vi.fn(async()=>({ok:true,ts:'123.4',user:{profile:{display_name:'student-example',real_name:'利用者F'}}}));
    await submit(service,slack,{view:viewFor(await service.resource('room'),booking(),'profile'),user:{id:'U1',name:'student-example'}});
    expect((await service.list())[0].slack_user_name).toBe('利用者F');
  });
  it('backfills existing names and calendar versions once, preserving bookings and moved notification channels',async()=>{
    const receipt=await service.change('old-name','created','room','UEXAMPLE0005','student-example',booking());
    const before=await service.owned(receipt.reservation_id,'UEXAMPLE0005');
    const sql=(await readFile('config/member-names-2026-10-19.sql','utf8')).replace(/^--.*$/gm,'');
    const apply=async()=>{for(const statement of sql.split(';').filter(s=>s.trim()))await db.prepare(statement).run();};
    await apply();await apply();
    const after=await service.owned(receipt.reservation_id,'UEXAMPLE0005');
    expect(after).toEqual({...before,slack_user_name:'利用者F',version:before.version+1,updated_at:after.updated_at});
    const saved=await db.prepare("SELECT payload FROM processed_requests WHERE request_key='old-name'").first<{payload:string}>();
    const payload=JSON.parse(saved!.payload);
    expect(payload.before).toBeNull();expect(payload.after.slack_user_name).toBe('利用者F');
    expect(payload.resource.channel_id).toBe('CROOM');
    expect(await db.prepare('SELECT desired_version,status FROM google_calendar_sync WHERE reservation_id=?').bind(after.id).first()).toEqual({desired_version:after.version,status:'pending'});
  });
  it('only warns about existing stirrer reservations when reduced capacity is exceeded',async()=>{
    await change('existing',booking(10,12,6),'stirrer');
    expect(await saveMaintenance(service,'U1','one','stirrer',{...booking(),quantity:1})).toHaveLength(0);
    expect(await saveMaintenance(service,'U2','two','stirrer',{...booking(),quantity:2})).toHaveLength(1);
  });
  it('partial fault reduces stirrer capacity, leaves booking available and recovery restores it',async()=>{
    await saveMaintenance(service,'U1','fault','stirrer',{...booking(),start_at:now,end_at:null,quantity:3},'fault');
    let resources=await service.resources(),r=resources.find(r=>r.id==='stirrer')!;
    expect(currentStatus(r,[],now)).toContain('故障・点検：3台');expect(currentStatus(r,[],now)).toContain('空き：5台');
    expect(panelButtons(operationPanel(resources,[],now)).some(b=>b.action_id==='book'&&b.value==='stirrer')).toBe(true);
    await change('remaining',booking(10,12,5),'stirrer');await expect(change('too-many',booking(10,12,1),'stirrer','U2')).rejects.toThrow('予約可能：0台');
    await cancelMaintenance(service,'U1','fault');await change('after-recovery',booking(10,12,3),'stirrer','U2');
    await expect(saveMaintenance(service,'U1','bad','stirrer',{...booking(),quantity:9})).rejects.toThrow('対象台数');
  });
  it('capacity uses combined interval peaks rather than adding separate reservation and maintenance peaks',async()=>{
    await change('morning',booking(10,12,7),'stirrer');
    await saveMaintenance(service,'U1','inspection','stirrer',{...booking(12,14),quantity:6},'inspection');
    await change('whole-span',booking(10,14,1),'stirrer','U2');
    await expect(change('overlap',booking(12,13,2),'stirrer','U3')).rejects.toThrow('予約可能：1台');
    await change('boundary',booking(14,15,8),'stirrer','U3');
  });
  it('legacy maintenance with no quantity still stops all stirrers',async()=>{
    await db.prepare("INSERT INTO maintenance_periods(id,resource_id,start_at,end_at,kind,reason,slack_user_id,created_at,updated_at) VALUES('legacy','stirrer',?,NULL,'fault','旧故障','U1',?,?)").bind(now,now,now).run();
    await expect(change('legacy-book',booking(),'stirrer')).rejects.toThrow('予約可能：0台');
    const r=(await service.resources()).find(r=>r.id==='stirrer')!;expect(r.maintenance_quantity).toBe(8);
  });
  it('maintenance quantity select uses configured capacity and persists choice across kind changes',async()=>{
    const r=await service.resource('stirrer'),view=maintenanceModal(r,now,'inspection');
    const select=view.blocks.find((b:SlackJSON)=>b.block_id==='maintenance_quantity');expect(select.element.options).toHaveLength(8);
    select.element.initial_option=select.element.options[2];
    const slack=vi.fn(async(_m:string,_d:SlackJSON)=>({ok:true}));
    await action(service,slack,{user:{id:'U1'},view:{...view,id:'V',hash:'H'},actions:[{action_id:'maintenance_kind',selected_option:{value:'fault'}}]});
    expect(slack.mock.calls[0][1].view.blocks.find((b:SlackJSON)=>b.block_id==='maintenance_quantity').element.initial_option.value).toBe('3');
  });
  it('members append repair history once per request, retain attribution, and cannot append after recovery',async()=>{
    await saveMaintenance(service,'U1','fault','room',{...booking(),start_at:now,end_at:null},'fault');
    await Promise.all([addRepairUpdate(service,'U2','fault','note','メーカー確認中'),addRepairUpdate(service,'U2','fault','note','メーカー確認中')]);
    await addRepairUpdate(service,'U1','fault','note2','部品待ち');
    const notes=await repairUpdates(service,'fault');expect(notes).toHaveLength(2);expect(notes.find(n=>n.id==='note')?.slack_user_id).toBe('U2');
    await expect(addRepairUpdate(service,'U2','fault','blank',' ')).rejects.toThrow('1〜1000');
    await expect(addRepairUpdate(service,'U2','fault','long','x'.repeat(1001))).rejects.toThrow('1〜1000');
    await cancelMaintenance(service,'U1','fault');await expect(addRepairUpdate(service,'U2','fault','later','追記')).rejects.toThrow('解除済み');
    expect(await service.list()).toHaveLength(0);expect((await db.prepare('SELECT * FROM notifications').all()).results).toHaveLength(0);
  });
  it('current faults expose status buttons and preserve resource names from configuration',async()=>{
    await db.prepare("UPDATE resources SET name='設備(123室)' WHERE id='room'").run();
    await saveMaintenance(service,'U1','fault','room',{...booking(),start_at:now,end_at:null},'fault');
    const panel=operationPanel(await service.resources(),[],now),control=panelButtons(panel).find(b=>b.value==='fault')!;
    expect(control.action_id).toBe('maintenance_status');expect(control.text.text).toBe('故障中・修理状況');expect(JSON.stringify(panel)).toContain('設備(123室)');
    const slack=vi.fn(async(_method:string,_data:SlackJSON)=>({ok:true}));
    await action(service,slack,{user:{id:'U2'},trigger_id:'t',actions:[{action_id:'maintenance_status',value:'fault'}]});
    expect(JSON.stringify(slack.mock.calls[0][1].view)).toContain('修理状況を追記');
    expect(JSON.stringify(slack.mock.calls[0][1].view)).not.toContain('maintenance_cancel');
    await action(service,slack,{user:{id:'U2'},trigger_id:'t',actions:[{action_id:'maintenance_repair',value:'fault'}]});
    const view=slack.mock.calls.at(-1)![1].view;view.id='V';view.state={values:{repair_status:{repair_status:{value:'問い合わせ済み'}}}};
    await submitRepair(service,slack,{user:{id:'U2'},view});expect((await repairUpdates(service,'fault'))[0].content).toBe('問い合わせ済み');
    expect(slack.mock.calls.at(-1)![0]).toBe('views.update');
    expect(slack.mock.calls.some(([method])=>method==='chat.postMessage'||method==='chat.postEphemeral')).toBe(false);
  });
  it('faults have no end date, block all future reservations, show current state and permit booking after recovery',async()=>{
    await saveMaintenance(service,'U1','fault','room',{...booking(),start_at:now,end_at:null,purpose:'冷却できない'},'fault');
    const stored=await db.prepare("SELECT * FROM maintenance_periods WHERE id='fault'").first<any>();expect(stored.end_at).toBeNull();expect(stored.kind).toBe('fault');
    expect(maintenanceDetail(stored)).toContain('復旧まで');
    const resources=await service.resources();expect(currentStatus(resources.find(r=>r.id==='room')!,[],now)).toContain('故障（復旧まで）');
    await expect(change('blocked')).rejects.toThrow('終了未定');
    const far=Date.parse('2035-01-01T10:00:00+09:00');await expect(change('far',{...booking(),start_at:far,end_at:far+3600000})).rejects.toThrow('終了未定');
    await expect(saveMaintenance(service,'U1','no-end-inspection','room',{...booking(),end_at:null},'inspection')).rejects.toThrow('終了');
    await expect(db.prepare("INSERT INTO maintenance_periods(id,resource_id,start_at,end_at,kind,reason,slack_user_id,created_at,updated_at) VALUES('invalid','room',0,NULL,'inspection','点検','U1',0,0)").run()).rejects.toThrow('inspection_end_required');
    await cancelMaintenance(service,'U1','fault');await change('recovered');
  });
  it('maintenance blocks creates and edits, permits boundaries and cancellations, and preserves existing bookings',async()=>{
    service.adminUserIds='UADMIN';
    const prior=await change('prior',booking(9,10));
    await saveMaintenance(service,'UADMIN','m','room',{...booking(10,12),purpose:'点検'});
    await expect(change('blocked')).rejects.toThrow('故障・点検');
    await expect(service.change('edit-blocked','updated','room','U1','利用者A',booking(10,11),prior.reservation_id,1)).rejects.toThrow('故障・点検');
    expect((await service.owned(prior.reservation_id,'U1')).status).toBe('active');
    await change('boundary',booking(12,13));
    await service.change('cancel-prior','cancelled','room','U1','利用者A',undefined,prior.reservation_id,1);
    await cancelMaintenance(service,'UADMIN','m');
    await change('after-clear');
  });
  it('maintenance permits members, rejects invalid periods, protects cancellation, and retries do not duplicate',async()=>{
    service.adminUserIds='UADMIN';
    await saveMaintenance(service,'U1','m','room',booking());
    await expect(saveMaintenance(service,'UADMIN','bad','room',booking(12,10))).rejects.toThrow('終了');
    await saveMaintenance(service,'UADMIN','m','room',booking());
    await saveMaintenance(service,'UADMIN','m','room',booking());
    expect((await db.prepare('SELECT * FROM maintenance_periods').all()).results).toHaveLength(1);
    await expect(cancelMaintenance(service,'U2','m')).rejects.toThrow('本人');
    await cancelMaintenance(service,'U1','m');
  });
  it('a maintenance write between checking and booking commit invalidates the decision',async()=>{
    service.adminUserIds='UADMIN';
    const original=service.list.bind(service);let injected=false;
    vi.spyOn(service,'list').mockImplementation(async(...args)=>{
      if(!injected){injected=true;await saveMaintenance(new Reservations(db,()=>now,'',false,'UADMIN'),'UADMIN','race','room',booking());}
      return original(...args);
    });
    await expect(change('race-book')).rejects.toThrow('故障・点検');
    expect(await original()).toHaveLength(0);
    expect((await db.prepare('SELECT * FROM notifications').all()).results).toHaveLength(0);
  });
  it.each([[9,10,true],[9,11,false],[10,12,false],[11,13,false],[12,13,true]])('exclusive %s-%s',async(start,end,ok)=>{
    await change('first');
    const result=change('second',booking(start as number,end as number));
    if(ok) await expect(result).resolves.toBeTruthy();else await expect(result).rejects.toThrow('予約されています');
  });
  it.each([[13,15,1,true],[13,15,2,false],[16,18,5,true]])('capacity %s-%s %s',async(start,end,n,ok)=>{
    await change('first',booking(10,18,3),'stirrer');await change('second',booking(12,16,4),'stirrer','U2');
    const result=change('third',booking(start as number,end as number,n as number),'stirrer');
    if(ok) await expect(result).resolves.toBeTruthy();else await expect(result).rejects.toThrow('予約可能：1台');
  });
  it('serializes concurrent users and keeps a single booking',async()=>{
    const results=await Promise.allSettled([change('a'),change('b',booking(),'room','U2')]);
    expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
    expect(await service.list()).toHaveLength(1);
    expect((await db.prepare('SELECT * FROM notifications').all()).results).toHaveLength(1);
  });
  it('quantity concurrency cannot oversubscribe',async()=>{
    const results=await Promise.allSettled([change('a',booking(10,12,5),'stirrer'),change('b',booking(10,12,5),'stirrer','U2')]);
    expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  });
  it('rejects other owner and stale edits; excludes own booking',async()=>{
    const first=await change('a'),id=first.reservation_id;
    await expect(service.change('b','updated','room','U2','x',booking(),id,1)).rejects.toThrow('ご本人');
    await service.change('c','updated','room','U1','利用者A',booking(11,13),id,1);
    await expect(service.change('d','updated','room','U1','利用者A',booking(),id,1)).rejects.toThrow('変更済み');
  });
  it('rolls back command, booking, revision and notification on DB error',async()=>{
    await db.prepare("CREATE TRIGGER fail_notice BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'test_failure'); END;").run();
    try { await expect(change('a')).rejects.toThrow();expect(await service.list()).toHaveLength(0);expect(await service.receipt('a','U1','created')).toBeNull();expect((await service.resource('room')).revision).toBe(0); }
    finally {await db.prepare('DROP TRIGGER fail_notice').run();}
  });
});
describe('subscription security and settings UI',()=>{
  it('fault UI hides ending fields, inspection UI requires them, and switching keeps common fields',async()=>{
    const r=await service.resource('room'),fault=maintenanceModal(r,now,'fault'),inspection=maintenanceModal(r,now,'inspection');
    expect(fault.blocks.some((b:SlackJSON)=>b.block_id==='end_date')).toBe(false);
    expect(inspection.blocks.some((b:SlackJSON)=>b.block_id==='end_date'&&b.optional===false)).toBe(true);
    const slack=vi.fn(async(_method:string,_data:SlackJSON)=>({ok:true}));
    await action(service,slack,{user:{id:'U1'},trigger_id:'t',view:{...inspection,id:'V',hash:'H'},actions:[{action_id:'maintenance_kind',selected_option:{value:'fault'}}]});
    expect(slack.mock.calls[0][0]).toBe('views.update');
    expect(slack.mock.calls[0][1].view.blocks.find((b:SlackJSON)=>b.block_id==='start_date')).toEqual(inspection.blocks.find((b:SlackJSON)=>b.block_id==='start_date'));
    const submitView=fault;submitView.private_metadata=JSON.stringify({...JSON.parse(fault.private_metadata),origin_channel:'COPS'});
    submitView.state={values:{start_date:{start_date:{selected_date:'2030-01-02'}},start_hour:{start_hour:{selected_option:{value:'10'}}},start_minute:{start_minute:{selected_option:{value:'00'}}},purpose:{purpose:{value:'故障の状況'}},maintenance_kind:{maintenance_kind:{selected_option:{value:'fault'}}}}};
    service.operationsChannel='COPS';await submitSettings(service,slack,{user:{id:'U1'},view:submitView});
    expect((await db.prepare("SELECT end_at FROM maintenance_periods WHERE status='active'").first<any>()).end_at).toBeNull();
  });
  it.each(['cryostat','sem_edx'])('%s has its own exclusive reservation slot',async(id)=>{
    await db.prepare('INSERT INTO resources(id,channel_id,name,type,capacity,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind(id,'CROOM',id,'exclusive_room',1,now,now).run();
    await change('room');await change('equipment',booking(),id);
    await expect(change('same-equipment',booking(),id,'U2')).rejects.toThrow('予約されています');
    expect(JSON.stringify(operationPanel(await service.resources(),[],now))).toContain(id);
  });
  it('rotation invalidates old feed and setup links, retries preserve the new URL, and other users are unaffected',async()=>{
    const old=await subscriptionToken(db,'U1',now),other=await subscriptionToken(db,'U2',now);
    await changeSubscription(db,'U1',1,false,now+1);
    const fresh=await subscriptionToken(db,'U1',now+2);
    expect(fresh).not.toBe(old);
    await changeSubscription(db,'U1',1,false,now+3);
    expect(await subscriptionToken(db,'U1',now+4)).toBe(fresh);
    for(const path of ['calendar.ics','calendar/setup'])expect((await (path==='calendar.ics'?calendarResponse:calendarSetupResponse)(new Request(`https://test/${path}?token=${old}`),db)).status).toBe(401);
    expect((await calendarResponse(new Request(`https://test/calendar.ics?token=${fresh}`),db,now)).status).toBe(200);
    expect((await calendarResponse(new Request(`https://test/calendar.ics?token=${other}`),db,now)).status).toBe(200);
    await changeSubscription(db,'U1',2,true,now+5);
    expect((await calendarResponse(new Request(`https://test/calendar.ics?token=${fresh}&kind=schedule`),db,now)).status).toBe(401);
    expect(await subscriptionToken(db,'U1',now+6)).not.toBe(fresh);
    await changeSubscription(db,'U1',2,true,now+7);
    expect((await db.prepare('SELECT revoked FROM calendar_subscriptions WHERE slack_user_id=?').bind('U1').first<{revoked:number}>())!.revoked).toBe(0);
  });
  it('rotation confirmation only opens a view and final submit derives ownership from authenticated Slack user',async()=>{
    const old=await subscriptionToken(db,'U1',now);const other=await subscriptionToken(db,'U2',now);
    service.operationsChannel='COPS';
    const slack=vi.fn(async(_method:string,_data:SlackJSON)=>({ok:true}));
    await action(service,slack,{user:{id:'U1'},channel:{id:'COPS'},trigger_id:'t',actions:[{action_id:'calendar_rotate'}]});
    expect(await subscriptionToken(db,'U1',now)).toBe(old);
    const view=slack.mock.calls[0][1].view;
    await submitSettings(service,slack,{user:{id:'U1'},view});
    expect(await subscriptionToken(db,'U1',now)).not.toBe(old);
    expect(await subscriptionToken(db,'U2',now)).toBe(other);
  });
  it('maintenance modal includes resource and nonce and confirmation alone leaves data untouched',async()=>{
    service.adminUserIds='UADMIN';
    const slack=vi.fn(async(_method:string,_data:SlackJSON)=>({ok:true}));
    await action(service,slack,{user:{id:'UADMIN'},trigger_id:'t',channel:{id:'COPS'},actions:[{action_id:'maintenance_resource',selected_option:{value:'room'}}]});
    const view=slack.mock.calls[0][1].view,meta=JSON.parse(view.private_metadata);
    expect(meta.resource).toBe('room');expect(meta.nonce).toBeTruthy();expect(view.callback_id).toBe('save_maintenance');
    expect((await db.prepare('SELECT * FROM maintenance_periods').all()).results).toHaveLength(0);
    await saveMaintenance(service,'UADMIN','m','room',booking());
    await action(service,slack,{user:{id:'UADMIN'},trigger_id:'t',actions:[{action_id:'maintenance_cancel',value:'m'}]});
    expect((await db.prepare('SELECT status FROM maintenance_periods WHERE id=?').bind('m').first<{status:string}>())!.status).toBe('active');
  });
});
describe('notifications after commit',()=>{
  it('keeps existing notices in their original channel after an equipment move',async()=>{
    service.operationsChannel='COPS';
    const first=await change('first');const slack=vi.fn(async(_method:string,_data:SlackJSON)=>({ok:true,ts:'999.1'}));
    await deliver(service,slack,first);
    await db.prepare("UPDATE resources SET channel_id='CNEW',name='電気炉(青) - 280実験室',revision=revision+1 WHERE id='room'").run();
    await refreshPanel(service,slack,'room',true);
    expect((await db.prepare("SELECT channel_id FROM panel_messages WHERE resource_id='room'").first<{channel_id:string}>())!.channel_id).toBe('CNEW');
    const edit=await service.change('edit','updated','room','U1','利用者A',booking(12,13),first.reservation_id,1);
    slack.mockClear();await deliver(service,slack,edit);
    expect(slack.mock.calls.some(([m,p])=>m==='chat.postMessage'&&p.channel==='CNEW')).toBe(true);
    expect(slack.mock.calls.some(([m,p])=>m==='chat.update'&&p.channel==='CROOM'&&p.ts==='999.1')).toBe(true);
  });
  const client=()=>vi.fn(async(method:string,_data:SlackJSON)=>({ok:true,ts:'999.1'}));
  it('created sends once, even with simultaneous retry and new service instance',async()=>{
    const r=await change('a'),slack=client();
    slack.mockImplementation(async(method)=>{if(method==='chat.postMessage') expect(await service.list()).toHaveLength(1);return {ok:true,ts:'999.1'};});
    await Promise.all([deliver(service,slack,r),deliver(new Reservations(db,()=>now),slack,await change('a'))]);
    expect(slack.mock.calls.filter(x=>x[0]==='chat.postMessage')).toHaveLength(1);
    expect(slack.mock.calls.find(x=>x[0]==='chat.postMessage')?.[1].channel).toBe('CROOM');
  });
  it('edit snapshots include quantity, purpose, dates and stay unchanged on replay',async()=>{
    const first=await change('a',booking(10,12,2),'stirrer');
    const r=await service.change('b','updated','stirrer','U1','利用者A',{...booking(11,13,3),purpose:''},first.reservation_id,1);
    const slack=client();await deliver(service,slack,r);await deliver(service,slack,r);
    expect(slack.mock.calls.filter(x=>x[0]==='chat.postMessage')).toHaveLength(1);
    const text=JSON.stringify(notification('updated',JSON.parse(r.payload)));
    for(const term of ['変更前','変更後','2台','3台','PL測定','未入力','10:00','11:00']) expect(text).toContain(term);
    await service.change('c','cancelled','stirrer','U1','',undefined,first.reservation_id,2);
    expect((await service.receipt('b','U1','updated'))!.payload).toBe(r.payload);
  });
  it('cancel confirmation sends nothing; commit and retry send once',async()=>{
    const first=await change('a'),slack=client();
    await action(service,slack,{user:{id:'U1'},trigger_id:'trigger',actions:[{action_id:'cancel',value:first.reservation_id}]});
    expect(slack.mock.calls.filter(x=>x[0]==='chat.postMessage')).toHaveLength(0);
    expect((await service.owned(first.reservation_id,'U1')).status).toBe('active');
    const r=await service.change('b','cancelled','room','U1','',undefined,first.reservation_id,1);
    await deliver(service,slack,r);await deliver(service,slack,await service.change('b','cancelled','room','U1','',undefined,first.reservation_id,1));
    expect(slack.mock.calls.filter(x=>x[0]==='chat.postMessage')).toHaveLength(1);
    expect((await service.owned(first.reservation_id,'U1')).status).toBe('cancelled');
  });
  it.each(['chat.postMessage','chat.update'])('%s failure retains committed data and logs context',async method=>{
    const r=await change('a'),slack=client(),log=vi.spyOn(console,'error').mockImplementation(()=>{});
    slack.mockImplementation(async m=>{if(m===method) throw new Error('test_network_error');return {ok:true,ts:'999.1'};});
    try {
      const outcome=await deliver(service,slack,r);
      expect(outcome[method==='chat.update'?'panelFailed':'notificationFailed']).toBe(true);
      expect(await service.list()).toHaveLength(1);
      expect(log.mock.calls.flat().join(' ')).toContain(r.reservation_id);
      expect(log.mock.calls.flat().join(' ')).toContain('CROOM');
      if(method==='chat.postMessage') {await deliver(service,slack,r);expect(slack.mock.calls.filter(x=>x[0]===method)).toHaveLength(1);}
    } finally {log.mockRestore();}
  });
  it('escapes user purpose and only mentions authenticated user ID',async()=>{
    const r=await change('a',{...booking(),purpose:'<!channel> <@UOTHER>'});
    const blocks=notification('created',JSON.parse(r.payload)).blocks;
    expect(blocks.filter(b=>b.text?.type==='mrkdwn').map(b=>b.text.text)).toEqual(['予約者：<@U1>']);
  });
});
function viewFor(resource:Awaited<ReturnType<Reservations['resource']>>,b:Booking,nonce:string,reservation?:string,version?:number) {
  const view=bookingModal(resource,now);
  view.private_metadata=JSON.stringify({resource:resource.id,nonce,reservation,version});
  const date=(ms:number)=>new Date(ms+9*3600000).toISOString();
  const values:SlackJSON={start_date:{selected_date:date(b.start_at).slice(0,10)},end_date:{selected_date:date(b.end_at).slice(0,10)},start_time:{selected_time:date(b.start_at).slice(11,16)},end_time:{selected_time:date(b.end_at).slice(11,16)},purpose:{value:b.purpose},quantity:{selected_option:{value:String(b.quantity)}}};
  view.state={values:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,{[k]:v}]))};return view;
}
describe('submission integration',()=>{
  it('toggles the free input field, keeps other block IDs and restores the unsaved purpose draft',async()=>{
    await db.prepare('UPDATE resources SET purpose_options=? WHERE id=?').bind(JSON.stringify(['PL測定','自由入力']),'room').run();
    const r=await service.resource('room');
    let view:SlackJSON={...bookingModal(r,now),id:'VIEW',hash:'hash1',state:{values:{start_date:{start_date:{selected_date:'2030-01-03'}}}}};
    const initialBlocks=view.blocks;
    const slack=vi.fn(async(_method:string,_payload:SlackJSON)=>({ok:true}));
    const choose=async(value:string|null)=>{
      await action(service,slack,{view,user:{id:'U1'},trigger_id:'trigger',actions:[{action_id:'purpose_choice',selected_option:value?{value}:null}]});
      const call=slack.mock.calls.at(-1)!;
      expect(call[0]).toBe('views.update');expect(call[1]).toMatchObject({view_id:'VIEW',hash:'hash1'});
      view={...call[1].view,id:'VIEW',hash:'hash1',state:view.state};
    };
    await choose('自由入力');
    expect(view.blocks.find((b:SlackJSON)=>b.block_id==='purpose').element.action_id).toBe('purpose');
    expect(view.blocks.find((b:SlackJSON)=>b.block_id==='start_date')).toEqual(initialBlocks.find((b:SlackJSON)=>b.block_id==='start_date'));
    view.state.values.purpose={purpose:{value:'独自の測定'}};
    await choose('PL測定');expect(view.blocks.some((b:SlackJSON)=>b.block_id==='purpose')).toBe(false);
    await choose('自由入力');expect(view.blocks.find((b:SlackJSON)=>b.block_id==='purpose').element.initial_value).toBe('独自の測定');
    await choose(null);expect(view.blocks.some((b:SlackJSON)=>b.block_id==='purpose')).toBe(false);
    expect(await service.list()).toHaveLength(0);expect(slack.mock.calls.every(c=>c[0]==='views.update')).toBe(true);
  });
  it('stores typed text without a free-input prefix and renders that text in Slack and both calendar formats',async()=>{
    await db.prepare('UPDATE resources SET purpose_options=? WHERE id=?').bind(JSON.stringify(['PL測定','自由入力']),'room').run();
    const r=await service.resource('room'),view=viewFor(r,{...booking(),purpose:'独自の測定'},'typed');
    view.state.values.purpose_choice={purpose_choice:{selected_option:{value:'自由入力'}}};
    await submit(service,vi.fn(async()=>({ok:true,ts:'123.4'})),{view,user:{id:'U1'}});
    const row=(await service.list())[0];expect(row).toMatchObject({purpose_choice:'',purpose:'独自の測定'});
    const legacy={...row,purpose_choice:'自由入力'};
    for(const text of [JSON.stringify(notification('created',{resource:r,before:null,after:legacy})),calendarICS([legacy],[r],now),JSON.stringify(googleEvent(legacy,r))]) {
      expect(text).toContain('独自の測定');expect(text).not.toContain('自由入力');
    }
    const old=await change('old-supplement',{...booking(13,14),purpose_choice:'PL測定',purpose:'特別条件'});
    const edit=bookingModal(r,now,await service.owned(old.reservation_id,'U1'));
    expect(edit.blocks.find((b:SlackJSON)=>b.block_id==='purpose_choice').element.initial_option.value).toBe('自由入力');
    expect(edit.blocks.find((b:SlackJSON)=>b.block_id==='purpose').element.initial_value).toBe('PL測定：特別条件');
  });
  it('dark room offers six presets and only accepts typed purpose when free input is selected',async()=>{
    const choices=['PL測定','PLE測定','電流電位測定','電着','分光光度計','AFM','自由入力'];
    await db.prepare('UPDATE resources SET purpose_options=? WHERE id=?').bind(JSON.stringify(choices),'room').run();
    const r=await service.resource('room'),v=viewFor(r,{...booking(),purpose:'試料A'},'dark');
    expect(bookingModal(r,now).blocks.find((b:SlackJSON)=>b.block_id==='purpose_choice').element.options.map((o:SlackJSON)=>o.value)).toEqual(choices);
    v.state.values.purpose_choice={purpose_choice:{selected_option:{value:'AFM'}}};
    const b=parseBooking(v,r);expect(b.purpose_choice).toBe('AFM');expect(b.purpose).toBe('');
    await change('dark',b);
    const free=viewFor(r,{...booking(12,13),purpose:'独自測定'},'free');
    free.state.values.purpose_choice={purpose_choice:{selected_option:{value:'自由入力'}}};
    const parsed=parseBooking(free,r);expect(parsed.purpose_choice).toBe('');await change('free',parsed);
  });
  it('hour and minute menus preserve minute precision, restore edits, and reject invalid values',async()=>{
    const r=await service.resource('room'),v=viewFor(r,booking(),'minute');
    for(const [key,value] of Object.entries({start_hour:'10',start_minute:'17',end_hour:'11',end_minute:'43'}))v.state.values[key]={[key]:{selected_option:{value}}};
    const b=parseBooking(v,r);expect(b.start_at).toBe(at(10)+17*60000);expect(b.end_at).toBe(at(11)+43*60000);
    const receipt=await service.change('minute','created','room','U1','利用者A',b);
    const edited=bookingModal(r,now,await service.owned(receipt.reservation_id,'U1'));
    for(const prefix of ['start','end']) {
      expect(edited.blocks.find((x:SlackJSON)=>x.block_id===`${prefix}_hour`).element.options).toHaveLength(24);
      expect(edited.blocks.find((x:SlackJSON)=>x.block_id===`${prefix}_minute`).element.options).toHaveLength(60);
    }
    expect(edited.blocks.find((x:SlackJSON)=>x.block_id==='start_minute').element.initial_option.value).toBe('17');
    v.state.values.end_minute.end_minute.selected_option.value='60';expect(()=>parseBooking(v,r)).toThrow('日付と時刻');
  });
  it('renames historical notices without reposting and skips already deleted messages',async()=>{
    const a=await change('old-a'),b=await change('old-b',booking(14,16));
    for(const [receipt,ts] of [[a,'deleted'],[b,'remaining']] as const)await db.prepare("UPDATE notifications SET status='sent',message_ts=? WHERE request_key=?").bind(ts,receipt.request_key).run();
    await db.prepare("UPDATE resources SET name='物置部屋・280室',icon='📦' WHERE id='room'").run();
    const slack=vi.fn(async(method:string,payload:SlackJSON)=>{if(payload.ts==='deleted')throw new Error('slack_message_not_found');return {ok:true};});
    expect(await refreshHistorical(service,slack,['room'])).toEqual({updated:1,missing:1});
    expect(slack.mock.calls.every(c=>c[0]==='chat.update')).toBe(true);
    expect(JSON.stringify(slack.mock.calls.find(c=>c[1].ts==='remaining')![1])).toContain('📦 物置部屋・280室');
    expect(await service.owned(a.reservation_id,'U1')).toMatchObject({start_at:booking().start_at,status:'active'});
  });
  it('schedule registrations permit overlapping presenters, separate their panel and enforce ownership',async()=>{
    await db.prepare("INSERT INTO resources(id,channel_id,name,type,capacity,schedule_event,icon,created_at,updated_at) VALUES('seminar','CSEMINAR','英論ゼミ','exclusive_room',1,1,'📖',?,?)").bind(now,now).run();
    const a=await change('seminar-a',{...booking(),location:'サンプル棟 204室'},'seminar');await change('seminar-b',{...booking(),location:'サンプル棟 206室'},'seminar','U2');
    expect((await service.list('seminar')).length).toBe(2);
    const resources=await service.resources();expect(JSON.stringify(operationPanel(resources))).not.toContain('英論ゼミ');
    expect(JSON.stringify(schedulePanel(resources))).toContain('英論ゼミ');expect(JSON.stringify(schedulePanel(resources))).not.toContain('測定室A');
    const resource=await service.resource('seminar'),view=bookingModal(resource,now);
    expect(view.submit.text).toBe('登録する');
    expect(view.blocks.find((b:SlackJSON)=>b.block_id==='location_choice').element.options.map((o:SlackJSON)=>o.value)).toEqual(['サンプル棟 204室','サンプル棟 206室','オンライン','その他']);
    const form=viewFor(resource,booking(),'location');form.state.values.location_choice={location_choice:{selected_option:{value:'その他'}}};form.state.values.location_custom={location_custom:{value:'サンプル棟 301室'}};
    expect(parseBooking(form,resource).location).toBe('サンプル棟 301室');
    await service.change('seminar-update','updated','seminar','U1','',parseBooking(form,resource),a.reservation_id,1);
    const updated=await service.owned(a.reservation_id,'U1');expect(updated.location).toBe('サンプル棟 301室');
    expect(bookingModal(resource,now,updated).blocks.find((b:SlackJSON)=>b.block_id==='location_custom').element.initial_value).toBe('サンプル棟 301室');
    await expect(service.change('missing-room','created','seminar','U1','',booking())).rejects.toThrow('使用する部屋');
    expect(JSON.stringify(notification('created',JSON.parse(a.payload)))).toContain('日程が登録');
    await expect(service.change('foreign','cancelled','seminar','U2','',undefined,a.reservation_id,1)).rejects.toThrow('ご本人');
    const scheduleService=new Reservations(db,()=>now,'CEXAMPLE0006',true),slack=vi.fn(async(_method:string,_payload:SlackJSON)=>({ok:true}));
    await action(scheduleService,slack,{user:{id:'U1'},channel:{id:'CEXAMPLE0006'},trigger_id:'t',actions:[{action_id:'hub_list'}]});
    expect(JSON.stringify(slack.mock.calls[0][1].view)).toContain('英論ゼミ');expect(JSON.stringify(slack.mock.calls[0][1].view)).not.toContain('測定室A');
  });
  it.each(['stirrer','furnace_blue','furnace_silver','furnace_light_blue'])('%s allows long bookings with optional presets and free text',async(id)=>{
    if(id!=='stirrer')await db.prepare("INSERT INTO resources(id,channel_id,name,type,capacity,created_at,updated_at) VALUES(?,'CSTIR',?,'exclusive_room',1,?,?)").bind(id,id,now,now).run();
    await db.prepare('UPDATE resources SET multi_day=1,purpose_options=? WHERE id=?').bind(JSON.stringify(['YVO4試料作製','BiVO4粉末作成','自由入力']),id).run();
    const r=await service.resource(id),modal=bookingModal(r,now);
    expect(JSON.stringify(modal)).not.toContain('long_confirm');expect(JSON.stringify(modal)).not.toContain('72時間');
    const choice=modal.blocks.find((b:SlackJSON)=>b.block_id==='purpose_choice');
    expect(choice.optional).toBe(true);expect(choice.element.initial_option).toBeUndefined();
    expect(choice.element.options.map((o:SlackJSON)=>o.value)).toEqual(['YVO4試料作製','BiVO4粉末作成','自由入力']);
    expect(choice.dispatch_action).toBe(true);
    expect(modal.blocks.some((b:SlackJSON)=>b.block_id==='purpose')).toBe(false);
    const b={...booking(),end_at:at(12,7),purpose_choice:'YVO4試料作製',purpose:'条件の補足'};
    const view=viewFor(r,b,'long');view.state.values.purpose_choice={purpose_choice:{selected_option:{value:b.purpose_choice}}};
    expect(parseBooking(view,r)).toMatchObject({purpose:'',purpose_choice:'YVO4試料作製'});
    const receipt=await service.change('long','created',id,'U1','利用者A',parseBooking(view,r));
    const row=await service.owned(receipt.reservation_id,'U1');
    expect(row.end_at-row.start_at).toBeGreaterThan(72*3600000);
    const edit=bookingModal(r,now,row);
    expect(edit.blocks.some((b:SlackJSON)=>b.block_id==='purpose')).toBe(false);
    expect(edit.blocks.find((b:SlackJSON)=>b.block_id==='purpose_choice').element.initial_option.value).toBe('YVO4試料作製');
    view.state.values.purpose_choice.purpose_choice.selected_option={value:'自由入力'};
    expect(parseBooking(view,r)).toMatchObject({purpose:'条件の補足',purpose_choice:''});
    await service.change('free','updated',id,'U1','',parseBooking(view,r),row.id,1);
    const freeEdit=bookingModal(r,now,await service.owned(row.id,'U1'));
    expect(freeEdit.blocks.find((b:SlackJSON)=>b.block_id==='purpose_choice').element.initial_option.value).toBe('自由入力');
    expect(freeEdit.blocks.find((b:SlackJSON)=>b.block_id==='purpose').element.initial_value).toBe('条件の補足');
    view.state.values.purpose_choice.purpose_choice.selected_option=null;view.state.values.purpose.purpose.value='';
    await service.change('blank','updated',id,'U1','',parseBooking(view,r),row.id,2);
    expect(await service.owned(row.id,'U1')).toMatchObject({purpose:'',purpose_choice:''});
    await expect(service.change('bad','updated',id,'U1','',{...b,purpose_choice:'不正な選択'},row.id,3)).rejects.toThrow('用途を選択');
  });
  it('failed create/edit never notify; successful edit/create each notify once',async()=>{
    const calls: string[]=[],slack=vi.fn(async(method:string,_data:SlackJSON)=>{calls.push(method);return {ok:true,ts:'123.4',user:{profile:{display_name:'利用者A'}}};});
    const r=await service.resource('room');
    const send=(view:SlackJSON)=>submit(service,slack,{view,user:{id:'U1'}});
    await send(viewFor(r,booking(),'a'));await send(viewFor(r,booking(),'a'));
    await send(viewFor(r,booking(),'conflict'));
    const row=(await service.list())[0];
    await change('other',booking(14,16));
    await send(viewFor(r,booking(13,15),'bad-edit',row.id,1));
    await send(viewFor(r,booking(11,13),'edit',row.id,1));await send(viewFor(r,booking(11,13),'edit',row.id,1));
    expect(calls.filter(x=>x==='chat.postMessage')).toHaveLength(2);
    const posted=slack.mock.calls.findIndex(x=>x[0]==='chat.postMessage');
    expect(calls.slice(posted,posted+2)).toEqual(['chat.postMessage','chat.update']);
    expect(slack.mock.calls.filter(c=>c[0]==='chat.postEphemeral').every(c=>!c[1].text.includes('✅'))).toBe(true);
  });
  it('notification failure explicitly says booking succeeded',async()=>{
    const slack=vi.fn(async(method:string,_data:SlackJSON)=>{if(method==='chat.postMessage')throw new Error('network');return {ok:true,user:{profile:{}}};});
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try {await submit(service,slack,{view:viewFor(await service.resource('room'),booking(),'a'),user:{id:'U1'}});
      expect(await service.list()).toHaveLength(1);
      const message=slack.mock.calls.find(x=>x[0]==='chat.postEphemeral')![1].text;
      expect(message).toContain('予約の保存は完了');expect(message).toContain('やり直す必要はありません');
    } finally {log.mockRestore();}
  });
});
describe('meeting presenters, shared history and silent attendance',()=>{
  beforeEach(async()=>{
    for(const [id,name] of [['english_seminar','英論ゼミ'],['biweekly_report','隔週報']])await db.prepare("INSERT INTO resources(id,channel_id,name,type,capacity,schedule_event,created_at,updated_at) VALUES(?,'CSEM',?,'exclusive_room',1,1,0,0)").bind(id,name).run();
    await db.prepare("INSERT INTO member_names VALUES('U1','利用者A',0),('U2','利用者F',0),('U3','利用者D',0)").run();
  });
  it('hides cancelled seminars from history and attendance but retains manually recorded non-held dates',async()=>{
    const b={...booking(),location:'サンプル棟 204室',presenters:['U1']};
    const old=await service.change('old-seminar','created','english_seminar','U1','利用者A',b);
    await service.change('cancel-old','cancelled','english_seminar','U1','',undefined,old.reservation_id,1);
    const current=await service.change('replacement','created','english_seminar','U1','利用者A',b);
    await createMeeting(service,'U2','historical-none','historical-none','2029-01-01','not_held',[],'開催なしの記録');
    for(const history of [true,false]) {
      const v=JSON.stringify(await meetingList(service,history));
      expect(v).not.toContain(old.reservation_id);expect(v).toContain(current.reservation_id);expect(v).toContain('開催なしの記録');
    }
    await expect(meetingById(service,old.reservation_id)).rejects.toThrow('見つかりません');
    await expect(saveAttendance(service,'U2',old.reservation_id,'attending')).rejects.toThrow('見つかりません');
    expect((await service.owned(old.reservation_id,'U1')).status).toBe('cancelled');
  });
  it('shows all planned presenter dates followed by through-today counts in Tokyo, excluding cancellations and deduplicating same dates',async()=>{
    service.clock=()=>at(9);
    await createMeeting(service,'U1','count-past','count-past','2030-01-01','held',['U1'],'');
    await createMeeting(service,'U1','count-today','count-today','2030-01-02','held',['U1'],'');
    await createMeeting(service,'U1','count-future','count-future','2030-01-03','held',['U1'],'');
    await createMeeting(service,'U1','count-none','count-none','2030-01-04','not_held',[],'');
    const scheduled=await service.change('count-booking','created','english_seminar','U1','利用者A',{...booking(),location:'サンプル棟 204室',presenters:['U1']});
    const cancelled=await service.change('count-cancel','created','english_seminar','U1','利用者A',{...booking(14,16),location:'サンプル棟 204室',presenters:['U2']});
    await service.change('count-cancelled','cancelled','english_seminar','U1','',undefined,cancelled.reservation_id,1);
    // Even if a legacy history edit marked a cancelled booking held, it must never count.
    await db.prepare("UPDATE schedule_sessions SET state='held' WHERE reservation_id=?").bind(cancelled.reservation_id).run();
    expect((await presenterCounts(service)).find(c=>c.id==='U1')).toMatchObject({total:3,count:2});
    expect((await presenterCounts(service)).find(c=>c.id==='U2')).toMatchObject({total:0,count:0});
    expect(JSON.stringify(await meetingList(service,true))).toContain('利用者A：3回（2回）');
    expect((await service.owned(scheduled.reservation_id,'U1')).status).toBe('active');
  });
  it('completes the acknowledged view by external ID before calendar work, even when the old parent no longer exists',async()=>{
    const receipt=await service.change('save-start','created','english_seminar','U1','利用者A',{...booking(),location:'サンプル棟 204室',presenters:['U1']});
    const row=await service.owned(receipt.reservation_id,'U1'),r=await service.resource('english_seminar');
    const view=viewFor(r,{...booking(11,13),location:'サンプル棟 204室',presenters:['U1']},'save-end',row.id,1);
    view.state.values.location_choice={location_choice:{selected_option:{value:'サンプル棟 204室'}}};
    view.state.values.presenters={presenters:{selected_options:[{value:'U1'}]}};
    view.id='obsolete-child';view.private_metadata=JSON.stringify({...JSON.parse(view.private_metadata),return_view:'obsolete-parent',return_meta:{resource:'all',period:'all'}});
    const events:string[]=[],log=vi.spyOn(console,'error').mockImplementation(()=>{});
    const slack=vi.fn(async(method:string,p:SlackJSON)=>{
      events.push(method==='views.update'?p.external_id??p.view_id:method);
      if(method==='views.update'&&p.view_id)throw new Error('slack_not_found');
      return {ok:true,ts:'123'};
    });
    try {
      await submit(service,slack,{view,user:{id:'U1'},completion_external_id:'stable-result'},async()=>{events.push('google');return 'pending';});
      expect(events[0]).toBe('stable-result');expect(events.indexOf('google')).toBeGreaterThan(0);
      const updates=slack.mock.calls.filter(c=>c[0]==='views.update'&&c[1].external_id==='stable-result');
      expect(updates).toHaveLength(2);expect(JSON.stringify(updates.at(-1)![1])).toContain('日程を変更しました');
      expect(JSON.stringify(updates.at(-1)![1])).toContain('最新の一覧を見る');
      expect((await service.owned(row.id,'U1')).end_at).toBe(at(13));
    }finally{log.mockRestore();}
  });
  it('separates the original registrant from the editor/canceller in new and original schedule messages',async()=>{
    const b={...booking(),location:'サンプル棟 204室',presenters:['U1']};
    const created=await service.change('actor-created','created','english_seminar','U1','利用者A',b);
    const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true,ts:'original'}));
    await deliver(service,slack,created);
    const updated=await service.change('actor-updated','updated','english_seminar','U2','', {...b,...booking(11,13),location:'サンプル棟 206室'},created.reservation_id,1);
    await deliver(service,slack,updated);
    const post=slack.mock.calls.filter(c=>c[0]==='chat.postMessage').at(-1)![1];
    expect(JSON.stringify(post)).toContain('登録者：<@U1>');expect(JSON.stringify(post)).toContain('変更者：<@U2>');
    expect(JSON.stringify(post)).not.toContain('予約者：');
    const original=slack.mock.calls.filter(c=>c[0]==='chat.update'&&c[1].ts==='original').at(-1)![1];
    expect(JSON.stringify(original)).toContain('最終変更者：<@U2>');expect(JSON.stringify(original)).toContain('登録者：<@U1>');
    expect(panelButtons(original).some(x=>x.action_id==='meeting_audit')).toBe(true);
    const cancelled=await service.change('actor-cancelled','cancelled','english_seminar','U3','',undefined,created.reservation_id,2);
    await deliver(service,slack,cancelled);
    expect(JSON.stringify(slack.mock.calls.filter(c=>c[0]==='chat.postMessage').at(-1)![1])).toContain('キャンセルした人：<@U3>');
    expect((await service.owned(created.reservation_id,'U1')).slack_user_name).toBe('利用者A');
  });
  it('shows persisted audit records, actor names, before/after and history edits, including cancelled schedules but excluding equipment',async()=>{
    const b={...booking(),location:'サンプル棟 204室',presenters:['U1']};
    const created=await service.change('audit-created','created','english_seminar','U1','利用者A',b);
    service.clock=()=>now+1000;
    await service.change('audit-updated','updated','english_seminar','U2','',{...b,...booking(11,13),location:'サンプル棟 206室'},created.reservation_id,1);
    const meeting=await meetingById(service,created.reservation_id);service.clock=()=>now+2000;
    await editMeeting(service,'U3','audit-presenters',meeting.id,meeting.version,meeting.session_date,'held',['U3'],'担当変更の備考');
    service.clock=()=>now+3000;
    await service.change('audit-cancelled','cancelled','english_seminar','U2','',undefined,created.reservation_id,3);
    const equipment=await change('audit-equipment');
    const history=JSON.stringify(await scheduleAudit(service));
    expect(history).toContain('操作者：利用者F');expect(history).toContain('登録者：利用者A');expect(history).toContain('【変更前】');expect(history).toContain('【変更後】');
    expect(history).toContain('担当変更の備考');expect(history).toContain('キャンセル');expect(history).not.toContain(equipment.reservation_id);
    const single=JSON.stringify(await scheduleAudit(service,created.reservation_id));expect(single).toContain('担当変更の備考');
    await expect(scheduleAudit(service,equipment.reservation_id)).rejects.toThrow('見つかりません');
    const empty=await scheduleAudit(service,'all',10000);expect(JSON.stringify(empty)).toContain('ありません');
  });
  it('paginates audit views privately and keeps the selected reservation filter without sending notifications',async()=>{
    for(let i=1;i<=7;i++)await createMeeting(service,'U1','audit-add-'+i,'audit-session-'+i,`2029-01-0${i}`,'held',['U1'],'');
    const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true}));
    await meetingAction(service,slack,{user:{id:'U2'},trigger_id:'t',actions:[{action_id:'meeting_audit',value:'all'}]});
    let view={...slack.mock.calls.at(-1)![1].view,id:'audit-view',hash:'h'};
    expect(panelButtons(view).some(b=>b.action_id==='meeting_audit_next')).toBe(true);
    await scheduleAuditAction(service,slack,{user:{id:'U2'},view,actions:[{action_id:'meeting_audit_next',value:'1'}]});
    view=slack.mock.calls.at(-1)![1].view;expect(panelButtons(view).some(b=>b.action_id==='meeting_audit_prev')).toBe(true);
    expect(panelButtons(view).some(b=>b.action_id==='meeting_audit_next')).toBe(false);
    expect(slack.mock.calls.map(c=>c[0])).toEqual(['views.open','views.update']);
  });
  it.each(['english_seminar','biweekly_report'])('all members can edit and cancel %s while preserving creator, audit actor and calendar version',async(id)=>{
    const b={...booking(),location:'サンプル棟 204室',presenters:['U1']};
    const created=await service.change('shared-create','created',id,'U1','利用者A',b);
    const row=await service.editable(created.reservation_id,'U2'),r=await service.resource(id);
    expect((await service.owned(row.id,'U1')).slack_user_id).toBe('U1');
    await expect(service.owned(row.id,'U2')).rejects.toThrow('ご本人');
    const list=listModal([row],[r],{resource:id,viewer:'U2',now});
    expect(panelButtons(list).filter(x=>['edit','cancel'].includes(x.action_id))).toHaveLength(2);
    expect(panelButtons(list).find(x=>x.action_id==='edit')?.visible_to_user_ids).toBeUndefined();
    const posted=notification('created',{resource:r,before:null,after:row},now);
    expect(panelButtons(posted).find(x=>x.action_id==='edit')?.visible_to_user_ids).toBeUndefined();
    const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true,ts:'123'}));
    await action(service,slack,{user:{id:'U2'},trigger_id:'t',actions:[{action_id:'edit',value:row.id}]});
    expect(slack.mock.calls.at(-1)![1].view.callback_id).toBe('save_booking');
    const updated=await service.change('shared-update','updated',id,'U2','利用者F',{...b,...booking(11,13),location:'オンライン',online_url:'https://example.com/meeting',presenters:['U2']},row.id,1);
    await service.change('shared-update','updated',id,'U2','',b,row.id,1);
    const saved=await service.owned(row.id,'U1');expect(saved).toMatchObject({slack_user_id:'U1',slack_user_name:'利用者A',version:2,location:'オンライン'});
    expect(updated.slack_user_id).toBe('U2');
    await expect(service.change('shared-stale','updated',id,'U3','',b,row.id,1)).rejects.toThrow('変更済み');
    await action(service,slack,{user:{id:'U3'},trigger_id:'t',actions:[{action_id:'cancel',value:row.id}]});
    expect(slack.mock.calls.at(-1)![1].view.callback_id).toBe('cancel_booking');
    expect((await service.owned(row.id,'U1')).status).toBe('active');
    await service.change('shared-cancel','cancelled',id,'U3','',undefined,row.id,2);
    expect(await service.owned(row.id,'U1')).toMatchObject({status:'cancelled',version:3,slack_user_id:'U1'});
    expect(await db.prepare('SELECT desired_version FROM google_calendar_sync WHERE reservation_id=?').bind(row.id).first()).toMatchObject({desired_version:3});
    const equipment=await change('still-private');await expect(service.editable(equipment.reservation_id,'U2')).rejects.toThrow('ご本人');
    await expect(service.change('illegal-private','cancelled','room','U2','',undefined,equipment.reservation_id,1)).rejects.toThrow('ご本人');
  });
  it('pages forward and back and opens attendance with action IDs accepted by Slack',async()=>{
    const validClient=vi.fn(async(_method:string,payload:SlackJSON)=>{
      if(payload.view)for(const block of payload.view.blocks) {
        const ids=(block.elements??[]).filter((e:SlackJSON)=>e.action_id).map((e:SlackJSON)=>e.action_id);
        if(new Set(ids).size!==ids.length)throw new Error('slack_invalid_blocks: duplicate action_id in one block');
      }
      return {ok:true};
    });
    for(let i=1;i<=14;i++)await createMeeting(service,'U2','add-'+i,'history-'+i,`2029-01-${String(i).padStart(2,'0')}`,'held',['U1'],'');
    await meetingAction(service,validClient,{user:{id:'U2'},trigger_id:'t',actions:[{action_id:'meeting_history'}]});
    let view={...validClient.mock.calls.at(-1)![1].view,id:'V',hash:'h'};
    const click=async(id:string)=>{
      const control=panelButtons(view).find(b=>b.action_id===id)!;expect(control).toBeDefined();
      await meetingAction(service,validClient,{user:{id:'U2'},view,trigger_id:'t',actions:[control]});
      view={...validClient.mock.calls.at(-1)![1].view,id:'V',hash:'h'};
    };
    await click('meeting_next');expect(JSON.parse(view.private_metadata).page).toBe(1);
    expect(panelButtons(view).map(b=>b.action_id)).toEqual(expect.arrayContaining(['meeting_prev','meeting_next']));
    await click('meeting_next');expect(JSON.parse(view.private_metadata).page).toBe(2);
    await click('meeting_prev');expect(JSON.parse(view.private_metadata).page).toBe(1);
    await meetingAction(service,validClient,{user:{id:'U2'},view,trigger_id:'t',actions:[{action_id:'meeting_record',value:'history-1'}]});
    view={...validClient.mock.calls.at(-1)![1].view,id:'V2',hash:'h2'};
    expect(panelButtons(view).filter(b=>b.action_id.startsWith('meeting_rsvp_')).map(b=>b.action_id)).toEqual(['meeting_rsvp_attending','meeting_rsvp_absent','meeting_rsvp_undecided']);
    await click('meeting_rsvp_absent');
    expect((await db.prepare("SELECT status FROM schedule_attendance WHERE session_id='history-1' AND slack_user_id='U2'").first<{status:string}>())?.status).toBe('absent');
    expect(validClient.mock.calls.every(c=>['views.open','views.push','views.update'].includes(c[0]))).toBe(true);
  });
  it('any member can add a past presenter session, retry safely and prevent duplicate dates',async()=>{
    const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true}));
    await meetingAction(service,slack,{user:{id:'U2'},trigger_id:'t',actions:[{action_id:'meeting_add'}]});
    expect((await db.prepare('SELECT * FROM schedule_sessions').all()).results).toHaveLength(0);
    const view=slack.mock.calls.at(-1)![1].view;
    view.state={values:{session_date:{session_date:{selected_date:'2029-04-03'}},state:{state:{selected_option:{value:'held'}}},presenters:{presenters:{selected_options:[{value:'U1'},{value:'U2'}]}},notes:{notes:{value:'過去の担当を追加'}}}};
    expect((await submitMeeting(service,{user:{id:'U2'},view})).response_action).toBe('update');
    expect((await submitMeeting(service,{user:{id:'U2'},view})).response_action).toBe('update');
    const sessions=(await db.prepare('SELECT * FROM schedule_sessions').all()).results;expect(sessions).toHaveLength(1);expect(sessions[0].reservation_id).toBeNull();
    expect((await db.prepare('SELECT * FROM meeting_creations').all()).results).toHaveLength(1);
    expect((await presenterCounts(service)).filter(c=>c.count===1)).toHaveLength(2);
    await expect(createMeeting(service,'U3','duplicate','another-id','2029-04-03','held',['U3'],'')).rejects.toThrow('登録済み');
    expect((await db.prepare('SELECT * FROM google_calendar_sync').all()).results).toHaveLength(0);
  });
  it('biweekly attendance has no presenter information or edit link, even for legacy stored presenters',async()=>{
    const receipt=await service.change('report','created','biweekly_report','U1','登録者',{...booking(),location:'オンライン',presenters:[]});
    await db.prepare('UPDATE schedule_sessions SET presenters=? WHERE id=?').bind(JSON.stringify([{id:'U1',name:'利用者A'}]),receipt.reservation_id).run();
    const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true}));
    await meetingAction(service,slack,{user:{id:'U1'},trigger_id:'t',actions:[{action_id:'meeting_record',value:receipt.reservation_id}]});
    const view=slack.mock.calls.at(-1)![1].view;expect(JSON.stringify(view)).not.toContain('担当');
    expect(panelButtons(view).some(b=>b.action_id==='meeting_rsvp_attending')).toBe(true);
    await saveAttendance(service,'U1',receipt.reservation_id,'attending');
  });
  it('both schedules accept multiple checkbox presenters and online URLs; calendar uses presenters rather than registrar',async()=>{
    for(const resourceId of ['english_seminar','biweekly_report']) {
      const r=await service.resource(resourceId),v=viewFor(r,booking(),'meeting-'+resourceId);
      v.state.values.location_choice={location_choice:{selected_option:{value:'オンライン'}}};
      v.state.values.online_url={online_url:{value:'https://meet.google.com/abc-defg-hij'}};
      v.state.values.presenters={presenters:{selected_options:[{value:'U1'},{value:'U2'}]}};
      const b=parseBooking(v,r);const receipt=await service.change('meeting-'+resourceId,'created',resourceId,'U3','登録者',b);
      const row=await service.owned(receipt.reservation_id,'U3');
      const google=googleEvent(row,r),ics=calendarICS([row],[r],now).replace(/\r\n /g,'');
      if(resourceId==='english_seminar') {
        expect(JSON.parse(row.presenters!)).toEqual(expect.arrayContaining([{id:'U1',name:'利用者A'},{id:'U2',name:'利用者F'}]));
        expect(bookingModal(r,now,row).blocks.find((x:SlackJSON)=>x.block_id==='presenters').element.initial_options.map((x:SlackJSON)=>x.value)).toEqual(expect.arrayContaining(['U1','U2']));
        expect(google.summary).toContain('利用者A');expect(google.summary).toContain('利用者F');expect(ics).toContain('利用者A、利用者F');
      } else {
        expect(JSON.parse(row.presenters!)).toEqual([]);expect(bookingModal(r,now,row).blocks.some((x:SlackJSON)=>x.block_id==='presenters')).toBe(false);
        expect(google.summary).toBe('隔週報');expect(google.description).not.toContain('担当');expect(ics).not.toContain('担当');
        expect(JSON.stringify(notification('created',{resource:r,before:null,after:row}))).not.toContain('担当者');
      }
      expect(google.summary).not.toContain('登録者');expect(google.description).not.toContain('登録者');expect(google.description).toContain('https://meet.google.com/abc-defg-hij');
      expect(ics).not.toContain('登録者');expect(ics).toContain('URL:https://meet.google.com/abc-defg-hij');
      const session=await meetingById(service,row.id);expect(session.state).toBe(resourceId==='english_seminar'?'held':'undecided');
    }
    expect((await presenterCounts(service)).every(c=>c.count===0)).toBe(true);
  });
  it.each(['javascript:alert(1)','https://bad host/'])('rejects invalid online URL %s before saving',async(online_url)=>{
    await expect(service.change('bad-online','created','english_seminar','U1','登録者',{...booking(),location:'オンライン',online_url,presenters:['U1']})).rejects.toThrow('https://');
    expect((await service.list())).toHaveLength(0);
  });
  it('rejects unknown presenter IDs without adding a meeting',async()=>{
    await expect(service.change('bad-person','created','english_seminar','U1','登録者',{...booking(),location:'オンライン',presenters:['UNKNOWN']})).rejects.toThrow('担当者');
    expect((await db.prepare('SELECT * FROM schedule_sessions').all()).results).toHaveLength(0);
  });
  it('undecided presenters are valid, and attendance only updates the caller without channel notifications',async()=>{
    const receipt=await service.change('undecided','created','biweekly_report','U1','登録者',{...booking(),location:'サンプル棟 204室',presenters:[]});
    const row=await service.owned(receipt.reservation_id,'U1'),r=await service.resource('biweekly_report');expect(googleEvent(row,r).summary).toBe('隔週報');
    const s=await meetingById(service,row.id);await saveAttendance(service,'U1',s.id,'attending');await saveAttendance(service,'U2',s.id,'absent');
    const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true}));
    await meetingAction(service,slack,{user:{id:'U1'},view:{type:'modal',id:'V',hash:'h'},actions:[{action_id:'meeting_rsvp',value:s.id+'|undecided'}]});
    expect(slack.mock.calls.map(c=>c[0])).toEqual(['views.update']);
    expect((await db.prepare('SELECT slack_user_id,status FROM schedule_attendance ORDER BY slack_user_id').all()).results).toEqual([{slack_user_id:'U1',status:'undecided'},{slack_user_id:'U2',status:'absent'}]);
    expect((await service.owned(row.id,'U1')).version).toBe(row.version);
    await expect(saveAttendance(service,'U1',s.id,'invalid')).rejects.toThrow('出席');
  });
  it('any member may edit past presenter history, while equipment ownership remains protected',async()=>{
    const receipt=await service.change('meeting','created','english_seminar','U1','登録者',{...booking(),location:'サンプル棟 204室',presenters:['U1']});
    const past=new Reservations(db,()=>at(12,5)),s=await meetingById(past,receipt.reservation_id);
    await editMeeting(past,'U2','edit-history',s.id,s.version,s.session_date,'held',['U2','U3'],'担当を訂正');
    await editMeeting(past,'U2','edit-history',s.id,s.version,s.session_date,'held',['U2'],'再送');
    expect(JSON.parse((await meetingById(past,s.id)).presenters)).toHaveLength(2);
    expect((await presenterCounts(past)).map(c=>[c.name,c.count])).toEqual(expect.arrayContaining([['利用者F',1],['利用者D',1],['利用者A',0]]));
    expect((await db.prepare('SELECT * FROM schedule_edits').all()).results).toHaveLength(1);
    await expect(editMeeting(past,'U3','stale',s.id,s.version,s.session_date,'held',['U3'],'')).rejects.toThrow('更新');
    await expect(editMeeting(past,'U3','move',s.id,s.version+1,'2030-02-01','held',['U3'],'')).rejects.toThrow('日付');
    await expect(saveAttendance(past,'U2',s.id,'absent')).rejects.toThrow('担当者');
    const equipment=await change('equipment');await expect(past.change('illegal','cancelled','room','U2','',undefined,equipment.reservation_id,1)).rejects.toThrow('ご本人');
  });

});

describe('shared professor busy days',()=>{
  const form=(mode='all_day',date='2030-01-02',end:string|null=null)=>{
    const v=professorForm(now);v.state={values:{start_date:{start_date:{selected_date:date}},end_date:{end_date:{selected_date:end}},prof_mode:{prof_mode:{selected_option:{value:mode}}},title:{title:{value:'会議'}},notes:{notes:{value:'学外'}}}};return v;
  };
  it('uses inclusive whole-day dates, accepts unspecified time and retains minute precision for timed events',()=>{
    const v=form();expect(parseProfessor(v)).toMatchObject({start_at:at(0),end_at:at(0,3),all_day:1});
    expect(parseProfessor(form('all_day','2030-01-02','2030-01-04')).end_at).toBe(at(0,5));
    const timed=form('timed');for(const [id,value] of Object.entries({start_hour:'09',start_minute:'17',end_hour:'10',end_minute:'43'}))timed.state.values[id]={[id]:{selected_option:{value}}};
    expect(parseProfessor(timed)).toMatchObject({start_at:at(9)+17*60000,end_at:at(10)+43*60000,all_day:0});
    expect(()=>parseProfessor(form('all_day','2030-01-03','2030-01-01'))).toThrow('終了');
    expect(()=>parseProfessor(form('all_day','2030-02-30'))).toThrow('日付');
  });
  it('any member can edit another member event, with retry deduplication, stale protection and confirmed soft deletion',async()=>{
    const b=parseProfessor(form());await changeProfessor(db,'U1','create','created','event',0,b,now);
    await changeProfessor(db,'U1','create','created','event',0,b,now);
    await changeProfessor(db,'U2','edit','updated','event',1,{...b,title:'出張'},now+1);
    await expect(changeProfessor(db,'U3','stale','updated','event',1,b,now+2)).rejects.toThrow('更新');
    const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true}));
    await professorAction(db,slack,{user:{id:'U3'},trigger_id:'t',actions:[{action_id:'prof_cancel',value:'event'}]},now);
    expect((await db.prepare("SELECT status FROM professor_days WHERE id='event'").first<{status:string}>())?.status).toBe('active');
    const confirm=slack.mock.calls[0][1].view;expect(confirm.submit.text).toBe('予定を削除');
    const meta=JSON.parse(confirm.private_metadata);await changeProfessor(db,'U3',meta.nonce,'cancelled',meta.id,meta.version,undefined,now+3);
    expect((await db.prepare("SELECT status,created_by,updated_by FROM professor_days WHERE id='event'").first())).toEqual({status:'cancelled',created_by:'U1',updated_by:'U3'});
    expect((await db.prepare('SELECT * FROM professor_day_requests').all()).results).toHaveLength(3);
    expect((await service.list())).toHaveLength(0);
  });
  it('reuses the posted panel, uses valid action IDs and retains data if panel refresh fails',async()=>{
    const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true,ts:'123.4'}));
    await refreshProfessor(db,slack,now,'CPROF',true);await refreshProfessor(db,slack,now,'CPROF',true);
    expect(slack.mock.calls.filter(c=>c[0]==='chat.postMessage')).toHaveLength(1);
    const v=form();slack.mockImplementation(async(method)=>{if(method==='chat.update')throw Error('network');return {ok:true,ts:'123.4'};});
    await submitProfessor(db,slack,{user:{id:'U2'},view:{...v,id:'V'}},parseProfessor(v),now);
    expect((await db.prepare('SELECT * FROM professor_days').all()).results).toHaveLength(1);
    expect(slack.mock.calls.at(-1)![0]).toBe('views.update');expect(JSON.stringify(slack.mock.calls.at(-1)![1])).toContain('保存は完了');
    expect(slack.mock.calls.some(c=>c[0]==='chat.postEphemeral')).toBe(false);
    for(let i=2;i<=18;i++)await changeProfessor(db,'U3','create-'+i,'created','event-'+i,0,parseProfessor(form('all_day',`2030-01-${String(i).padStart(2,'0')}`)),now);
    const validate=vi.fn(async(_m:string,p:SlackJSON)=>{if(p.view)for(const b of p.view.blocks){const ids=(b.elements??[]).map((e:SlackJSON)=>e.action_id).filter(Boolean);expect(new Set(ids).size).toBe(ids.length);}return {ok:true};});
    await professorAction(db,validate,{user:{id:'U3'},trigger_id:'t',actions:[{action_id:'prof_list'}]},now);
    let view={...validate.mock.calls.at(-1)![1].view,id:'V',hash:'h'};
    await professorAction(db,validate,{user:{id:'U3'},view,actions:[{action_id:'prof_next',value:'1'}]},now);
    view=validate.mock.calls.at(-1)![1].view;expect(JSON.parse(view.private_metadata).page).toBe(1);
    expect(panelButtons(view).map(b=>b.action_id)).toEqual(expect.arrayContaining(['prof_prev','prof_next']));
  });
  it('switches time controls without losing dates or creating an event',async()=>{
    const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true})),v=form();v.id='V';v.hash='h';
    await professorAction(db,slack,{view:v,actions:[{action_id:'prof_mode',selected_option:{value:'timed'}}]},now);
    const timed=slack.mock.calls.at(-1)![1].view;expect(timed.blocks.some((b:SlackJSON)=>b.block_id==='start_minute')).toBe(true);
    expect(timed.blocks.find((b:SlackJSON)=>b.block_id==='start_date')).toEqual(v.blocks.find((b:SlackJSON)=>b.block_id==='start_date'));
    expect((await db.prepare('SELECT * FROM professor_days').all()).results).toHaveLength(0);
  });
});

describe('calendar selection for multiple professor days',()=>{
  it('adds days from the native calendar, deduplicates picks and removes selected chips',async()=>{
    const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true}));let view:SlackJSON={...professorCalendar(now),id:'V',hash:'h'};
    expect(view.blocks.some((b:SlackJSON)=>b.accessory?.type==='datepicker')).toBe(true);
    const pick=async(date:string)=>{await professorCalendarAction(slack,{view,actions:[{action_id:'prof_cal_date',selected_date:date}]},now);view={...slack.mock.calls.at(-1)![1].view,id:'V',hash:'h'};};
    await pick('2030-01-02');await pick('2030-02-05');await pick('2030-01-02');
    expect(JSON.parse(view.private_metadata).dates).toEqual(['2030-01-02','2030-02-05']);
    expect(view.blocks.find((b:SlackJSON)=>b.element?.action_id==='prof_cal_selection').element.initial_options).toHaveLength(2);
    view.state={values:{selected:{prof_cal_selection:{selected_options:[{value:'2030-02-05'}]}}}};
    expect(parseProfessorDates(view).map(v=>v.start_date)).toEqual(['2030-02-05']);
    await professorCalendarAction(slack,{view,actions:[{action_id:'prof_cal_selection',selected_options:[]}]},now);
    expect(JSON.parse(slack.mock.calls.at(-1)![1].view.private_metadata).dates).toEqual([]);
  });
  it('opens a multi-date calendar and keeps selections and drafts across months',async()=>{
    const slack=vi.fn(async(_method:string,p:SlackJSON)=>{
      if(p.view)for(const b of p.view.blocks){const ids=(b.elements??[]).map((e:SlackJSON)=>e.action_id).filter(Boolean);expect(new Set(ids).size).toBe(ids.length);}
      return {ok:true};
    });
    await action(service,slack,{user:{id:'U1'},channel:{id:'CPROF'},trigger_id:'t',actions:[{action_id:'prof_add'}]});
    let view={...slack.mock.calls.at(-1)![1].view,id:'V',hash:'h'};expect(view.callback_id).toBe('save_professor_bulk');
    expect(view.blocks.some((b:SlackJSON)=>b.block_id==='end_date')).toBe(false);
    const pick=async(action_id:string,value:string)=>{
      await professorCalendarAction(slack,{view,trigger_id:'t',actions:[{action_id,value}]},now);
      view={...slack.mock.calls.at(-1)![1].view,id:'V',hash:'h'};
    };
    view.state={values:{title:{title:{value:'会議'}},notes:{notes:{value:'共通の備考'}}}};
    await pick('prof_cal_pick_2','2030-01-02');await pick('prof_cal_pick_7','2030-01-07');await pick('prof_cal_next','next');
    expect(JSON.parse(view.private_metadata)).toMatchObject({month:'2030-02',dates:['2030-01-02','2030-01-07'],title:'会議',notes:'共通の備考'});
    await pick('prof_cal_pick_4','2030-02-04');await pick('prof_cal_prev','prev');await pick('prof_cal_pick_2','2030-01-02');
    expect(JSON.parse(view.private_metadata).dates).toEqual(['2030-01-07','2030-02-04']);
    expect(parseProfessorDates(view).map(b=>[b.start_date,b.end_date])).toEqual([['2030-01-07','2030-01-07'],['2030-02-04','2030-02-04']]);
    await pick('prof_cal_clear','clear');expect(()=>parseProfessorDates(view)).toThrow('1日以上');
    expect((await db.prepare('SELECT * FROM professor_days').all()).results).toHaveLength(0);
  });
  it('registers nonconsecutive dates as separate events atomically and deduplicates retries',async()=>{
    const view=professorCalendar(now);const meta=JSON.parse(view.private_metadata);meta.dates=['2030-01-02','2030-01-05','2030-02-04'];view.private_metadata=JSON.stringify(meta);
    const inputs=parseProfessorDates(view);expect(await saveProfessorDates(db,'U1',meta.nonce,meta.id,inputs,now)).toBe(3);
    expect(await saveProfessorDates(db,'U1',meta.nonce,meta.id,inputs,now)).toBe(3);
    const list=(await db.prepare('SELECT * FROM professor_days ORDER BY start_date').all()).results;
    expect(list).toHaveLength(3);for(const row of list){expect(row.start_date).toBe(row.end_date);expect(Number(row.end_at)-Number(row.start_at)).toBe(86400000);}
    expect((await db.prepare('SELECT * FROM professor_day_batches').all()).results).toHaveLength(1);
    expect((await db.prepare('SELECT * FROM professor_day_requests').all()).results).toHaveLength(3);
    const event=list[0];await changeProfessor(db,'U2','edit-batch-item','updated',String(event.id),1,{...inputs[0],title:'個別に変更'},now+1);
    expect((await db.prepare('SELECT title FROM professor_days WHERE id=?').bind(event.id).first<{title:string}>())?.title).toBe('個別に変更');
  });
  it('rolls the whole batch back if one event conflicts; no earlier date is left partially saved',async()=>{
    const view=professorCalendar(now),meta=JSON.parse(view.private_metadata);meta.dates=['2030-01-02','2030-01-03'];view.private_metadata=JSON.stringify(meta);
    const inputs=parseProfessorDates(view);
    await changeProfessor(db,'U1','existing','created',meta.id+'_2030-01-03',0,inputs[1],now);
    await expect(saveProfessorDates(db,'U2',meta.nonce,meta.id,inputs,now)).rejects.toThrow();
    expect((await db.prepare('SELECT * FROM professor_days').all()).results).toHaveLength(1);
    expect((await db.prepare('SELECT * FROM professor_day_batches').all()).results).toHaveLength(0);
    expect((await db.prepare('SELECT * FROM professor_day_requests').all()).results).toHaveLength(1);
  });
  it('uses the same minute-precise time separately on every chosen day and only refreshes the panel once',async()=>{
    const view=professorCalendar(now),meta=JSON.parse(view.private_metadata);Object.assign(meta,{dates:['2030-01-02','2030-01-09'],mode:'timed',times:{start_hour:'10',start_minute:'17',end_hour:'11',end_minute:'43'}});view.private_metadata=JSON.stringify(meta);view.id='V';
    const inputs=parseProfessorDates(view);expect(inputs.map(b=>b.end_at-b.start_at)).toEqual([86*60000,86*60000]);
    await db.prepare("INSERT INTO professor_panels VALUES('kato','CPROF','123.4','ready',?)").bind(now).run();
    const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true}));await submitProfessorDates(db,slack,{user:{id:'U1'},view},inputs,now);
    expect(slack.mock.calls.map(c=>c[0])).toEqual(['chat.update','views.update']);
    expect(JSON.stringify(slack.mock.calls.at(-1)![1])).toContain('2日分');
  });
});

describe('separate professor subscriptions',()=>{
  const input={start_date:'2030-01-02',end_date:'2030-01-02',start_at:at(0),end_at:at(0,3),all_day:1,title:'会議',notes:'備考;改行\n続き'};
  it('queues each committed single day once and version changes atomically',async()=>{
    await saveProfessorDates(db,'U1','batch-cal','batch-id',[input,{...input,start_date:'2030-01-05',end_date:'2030-01-05',start_at:at(0,5),end_at:at(0,6)}],now);
    await saveProfessorDates(db,'U1','batch-cal','batch-id',[input],now);
    expect((await db.prepare('SELECT * FROM professor_google_sync').all()).results).toHaveLength(2);
    await changeProfessor(db,'U2','edit-cal','updated','batch-id_2030-01-02',1,{...input,title:'変更'},now+1);
    expect((await db.prepare("SELECT desired_version FROM professor_google_sync WHERE event_id='batch-id_2030-01-02'").first())?.desired_version).toBe(2);
    expect((await db.prepare('SELECT * FROM google_calendar_sync').all()).results).toHaveLength(0);
  });
  it('serves only professor days with separate secrets, correct all-day boundaries and valid HEAD/setup',async()=>{
    await changeProfessor(db,'U1','ics-prof','created','one',0,input,now);await change('equipment');
    const token=await professorToken(db,'U1',now),equipment=await subscriptionToken(db,'U1',now);
    const request=(t:string)=>new Request('https://test/professor/calendar.ics?token='+t);
    expect((await professorCalendarResponse(request(equipment),db,now)).status).toBe(401);
    expect((await calendarResponse(new Request('https://test/calendar.ics?token='+token),db,now)).status).toBe(401);
    const response=await professorCalendarResponse(request(token),db,now),ics=await response.text();
    expect(ics).toContain('X-WR-CALNAME:担当教員先生が予定ある日');expect(ics).toContain('DTSTART;VALUE=DATE:20300102');expect(ics).toContain('DTEND;VALUE=DATE:20300103');
    expect(ics).toContain('備考\\;改行\\n続き');expect(ics).not.toContain('測定室A');
    expect(response.headers.get('content-disposition')).toContain('inline');
    expect(await (await professorCalendarResponse(new Request(request(token),{method:'HEAD'}),db,now)).text()).toBe('');
    expect(await (await professorSetup(new Request('https://test/professor/calendar/setup?token='+token),db)).text()).toContain('webcal://test/professor/calendar.ics?token=');
    await changeProfessor(db,'U2','ics-delete','cancelled','one',1,undefined,now+1);
    expect(await (await professorCalendarResponse(request(token),db,now)).text()).not.toContain('BEGIN:VEVENT');
  });
  it('rotates or revokes only this calendar and CAS replay does not invalidate the new secret',async()=>{
    const token=await professorToken(db,'U1',now),equipment=await subscriptionToken(db,'U1',now);
    expect(await professorToken(db,'U1',now)).toBe(token);
    expect((await changeProfessorToken(db,'U1',1,false,now+1)).meta.changes).toBe(1);
    const next=await professorToken(db,'U1',now+2);expect(next).not.toBe(token);
    expect((await changeProfessorToken(db,'U1',1,false,now+2)).meta.changes).toBe(0);expect(await professorToken(db,'U1',now+2)).toBe(next);
    expect((await professorCalendarResponse(new Request('https://test/professor/calendar.ics?token='+token),db,now)).status).toBe(401);
    expect((await calendarResponse(new Request('https://test/calendar.ics?token='+equipment),db,now)).status).toBe(200);
    await changeProfessorToken(db,'U1',2,true,now+3);
    expect((await professorCalendarResponse(new Request('https://test/professor/calendar.ics?token='+next),db,now)).status).toBe(401);
  });
  it('opens the distinct subscription guide and only rotates after confirmation',async()=>{
    const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true}));
    await action(service,slack,{user:{id:'U1'},actions:[{action_id:'prof_subscribe'}],trigger_id:'t'},'https://test','equipment','professor');
    const view=slack.mock.calls.at(-1)![1].view;expect(JSON.stringify(view)).toContain('/professor/calendar.ics?token=');expect(JSON.stringify(view)).not.toContain('cid=equipment');
    const old=await professorToken(db,'U1',now);
    await professorSubscription(slack,db,{user:{id:'U1'},actions:[{action_id:'prof_sub_rotate'}],trigger_id:'t'},'https://test');
    expect(await professorToken(db,'U1',now)).toBe(old);
    const confirm={...slack.mock.calls.at(-1)![1].view,id:'V'};
    await submitProfessorSubscription(db,slack,{user:{id:'U1'},view:confirm});expect(await professorToken(db,'U1',now)).not.toBe(old);
  });
  it('renders timed events in Tokyo and uses stable base32-safe IDs for batched dates',()=>{
    const row={...input,id:'uuid_2030-01-02',status:'active',version:1,created_by:'U1',updated_by:'U1',created_at:now,updated_at:now};
    expect(professorGoogleId(row.id)).toMatch(/^[0-9a-v]{5,1024}$/);
    expect(professorGoogleEvent(row).end).toEqual({date:'2030-01-03'});
    const timed={...row,all_day:0,start_at:at(10),end_at:at(11)};
    expect(professorICS([timed],now)).toContain('DTSTART:20300102T010000Z');
    expect(professorGoogleEvent(timed).start).toEqual({dateTime:'2030-01-02T01:00:00.000Z',timeZone:'Asia/Tokyo'});
    expect(professorGoogleEvent(timed).summary).not.toContain('U1');
  });
});

describe('signed endpoint',()=>{
  async function signed(raw:string,ts=String(Math.floor(Date.now()/1000))) {
    const secret='test-secret',key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`v0:${ts}:${raw}`)));
    return new Headers({'x-slack-request-timestamp':ts,'x-slack-signature':'v0='+Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join(''),'content-type':'application/json'});
  }
  it('valid signature accepted; tampering and old timestamp rejected',async()=>{
    const raw='{"type":"url_verification","challenge":"abc"}',headers=await signed(raw);
    expect(await verifySlack(raw,headers,'test-secret')).toBe(true);
    expect(await verifySlack(raw+'x',headers,'test-secret')).toBe(false);
    expect(await verifySlack(raw,await signed(raw,'1'),'test-secret')).toBe(false);
    const response=await worker.fetch(new Request('https://test/slack/events',{method:'POST',headers,body:raw}),{SLACK_SIGNING_SECRET:'test-secret'} as Env,{} as ExecutionContext);
    expect(await response.json()).toEqual({challenge:'abc'});
  });
});

describe('central operation panel and compatibility',()=>{
  const client=()=>vi.fn(async(_method:string,_data:SlackJSON)=>({ok:true,ts:'central.1',user:{profile:{display_name:'利用者A'}}}));
  beforeEach(()=>{service.operationsChannel='COPS';});
  it('refresh always includes current status and the nearest future active reservation, with adjacent resource controls',async()=>{
    await change('past',booking(7,8));await change('current',booking(9,12));
    const cancelled=await change('cancelled-next',booking(12,13));
    await service.change('cancel-next','cancelled','room','U1','',undefined,cancelled.reservation_id,1);
    await change('next',booking(13,14));await change('later',booking(15,16));
    await change('stirrer-current',booking(9,12,3),'stirrer');
    await change('stirrer-next',booking(14,16,2),'stirrer');
    const current=new Reservations(db,()=>at(11),'COPS'),slack=client();
    await refreshOperations(current,slack,true);
    const content=slack.mock.calls.find(c=>c[0]==='chat.postMessage')![1];
    const roomIndex=content.blocks.findIndex((b:SlackJSON)=>b.text?.text?.includes('測定室A'));
    expect(content.blocks[roomIndex].text.text).toContain('使用中：09:00 ～ 12:00');
    expect(content.blocks[roomIndex].text.text).toContain('次の予約：01/02 13:00 ～ 14:00（利用者A）');
    expect(content.blocks[roomIndex+1].elements.map((b:SlackJSON)=>[b.text.text,b.action_id,b.value])).toEqual([['予約する','book','room'],['予約一覧・空き状況','list','room'],['今すぐ終了','finish_resource','room']]);
    const stirrer=content.blocks.find((b:SlackJSON)=>b.text?.text?.includes('スターラー'));
    expect(stirrer.text.text).toContain('使用中：3 / 8台');expect(stirrer.text.text).toContain('次の予約：01/02 14:00 ～ 16:00・2台');
    const boundary=operationPanel(await current.resources(),await current.list(),at(12));
    expect(boundary.blocks.find((b:SlackJSON)=>b.text?.text?.includes('測定室A'))!.text.text).toContain('\n空き\n次の予約：01/02 13:00');
    expect(content.blocks.length).toBeLessThanOrEqual(50);
  });
  it('adds the centrifuge without altering existing bookings and prevents overlapping use',async()=>{
    const original=await change('existing');const before=await service.owned(original.reservation_id,'U1');
    const sql=await readFile('config/centrifuge-2026-10-24.sql','utf8');
    await db.prepare(sql).run();await db.prepare(sql).run();
    expect(await service.owned(original.reservation_id,'U1')).toEqual(before);
    const r=await service.resource('centrifuge');expect(r).toMatchObject({name:'遠心分離機(実験室B)',type:'exclusive_room',capacity:1,channel_id:'CSTIR'});
    await change('centrifuge-a',booking(),'centrifuge');
    await expect(change('centrifuge-overlap',booking(11,13),'centrifuge','U2')).rejects.toThrow('予約されています');
    const modal=operationPanel(await service.resources(),[],now);
    expect(JSON.stringify(modal)).toContain('遠心分離機(実験室B)\\n空き\\n次の予約：なし');
  });
  it('resource list buttons open the selected equipment list and its availability check',async()=>{
    const slack=client();
    await action(service,slack,{user:{id:'U1'},channel:{id:'COPS'},trigger_id:'t',actions:[{action_id:'list',value:'stirrer'}]});
    const view=slack.mock.calls.find(c=>c[0]==='views.open')![1].view;
    expect(JSON.parse(view.private_metadata).resource).toBe('stirrer');
    expect(view.blocks.flatMap((b:SlackJSON)=>b.elements??[]).some((b:SlackJSON)=>b.action_id==='availability'&&b.value==='stirrer')).toBe(true);
  });
  it('equipment channels receive one normal notice and no duplicate private success on create, edit or cancel',async()=>{
    await db.prepare("INSERT INTO operation_panels(channel_id,message_ts,state,updated_at) VALUES('COPS','123.4','ready',?)").bind(now).run();
    const slack=client(),r=await service.resource('room');
    await submit(service,slack,{view:viewFor(r,booking(),'create'),user:{id:'U1'}});
    const row=(await service.list())[0];
    await submit(service,slack,{view:viewFor(r,booking(11,13),'edit',row.id,1),user:{id:'U1'}});
    const cancel=viewFor(r,booking(11,13),'cancel',row.id,2);cancel.callback_id='cancel_booking';
    await submit(service,slack,{view:cancel,user:{id:'U1'}});
    expect(slack.mock.calls.filter(c=>c[0]==='chat.postMessage').map(c=>c[1].channel)).toEqual(['CROOM','CROOM','CROOM']);
    expect(slack.mock.calls.some(c=>c[0]==='chat.postEphemeral')).toBe(false);
  });
  it('concurrent installation and repeated refresh never duplicate the panel',async()=>{
    const slack=client();
    await Promise.allSettled([refreshOperations(service,slack,true),refreshOperations(service,slack,true)]);
    await refreshOperations(service,slack,true);
    expect(slack.mock.calls.filter(x=>x[0]==='chat.postMessage')).toHaveLength(1);
    expect(slack.mock.calls.at(-1)?.[0]).toBe('chat.update');
  });
  it('uncertain post does not retry blindly',async()=>{
    const slack=client();slack.mockRejectedValue(new Error('lost response'));
    await expect(refreshOperations(service,slack,true)).rejects.toThrow();
    await expect(refreshOperations(service,slack,true)).rejects.toThrow('uncertain');
    expect(slack).toHaveBeenCalledTimes(1);
  });
  it('hub and Home can open resource booking, without success messages in operations',async()=>{
    await db.prepare("INSERT INTO operation_panels(channel_id,message_ts,state,updated_at) VALUES('COPS','123.4','ready',?)").bind(now).run();
    const slack=client();
    await action(service,slack,{user:{id:'U1'},channel:{id:'COPS'},trigger_id:'t',actions:[{action_id:'book',value:'room'}]});
    const opened=slack.mock.calls.find(x=>x[0]==='views.open')![1].view;
    expect(JSON.parse(opened.private_metadata).origin_channel).toBe('COPS');
    const view=viewFor(await service.resource('room'),booking(),'hub');
    view.private_metadata=JSON.stringify({...JSON.parse(view.private_metadata),origin_channel:'COPS'});
    slack.mockClear();await submit(service,slack,{view,user:{id:'U1'}});
    expect(slack.mock.calls.filter(x=>x[0]==='chat.postMessage').map(x=>x[1].channel)).toEqual(['CROOM']);
    expect(slack.mock.calls.filter(x=>x[0]==='chat.postEphemeral')).toHaveLength(0);
    await action(service,slack,{user:{id:'U1'},view:{type:'home'},trigger_id:'t',actions:[{action_id:'book',value:'stirrer'}]});
    expect(slack.mock.calls.filter(x=>x[0]==='views.open').at(-1)?.[1].view.callback_id).toBe('save_booking');
  });
  it('successful create, edit, cancel and retries notify equipment only and still sync the calendar',async()=>{
    await db.prepare("INSERT INTO operation_panels(channel_id,message_ts,state,updated_at) VALUES('COPS','123.4','ready',?)").bind(now).run();
    const slack=client(),sync=vi.fn(async()=> 'synced');
    const r=await service.resource('room');
    const inHub=(view:SlackJSON)=>{view.private_metadata=JSON.stringify({...JSON.parse(view.private_metadata),origin_channel:'COPS'});return view;};
    const send=async(view:SlackJSON)=>{await submit(service,slack,{view,user:{id:'U1'}},sync);await submit(service,slack,{view,user:{id:'U1'}},sync);};
    await send(inHub(viewFor(r,booking(),'hub-create')));
    const row=(await service.list())[0];
    await send(inHub(viewFor(r,booking(11,13),'hub-edit',row.id,1)));
    const cancel=inHub(viewFor(r,booking(11,13),'hub-cancel',row.id,2));cancel.callback_id='cancel_booking';
    await send(cancel);
    expect(slack.mock.calls.filter(x=>x[0]==='chat.postEphemeral')).toHaveLength(0);
    expect(slack.mock.calls.filter(x=>x[0]==='chat.postMessage').map(x=>x[1].channel)).toEqual(['CROOM','CROOM','CROOM']);
    expect(slack.mock.calls.filter(x=>x[0]==='chat.update').some(x=>x[1].channel==='COPS')).toBe(true);
    expect(sync).toHaveBeenCalledTimes(6);expect((await service.owned(row.id,'U1')).status).toBe('cancelled');
  });
  it.each(['past','conflict'])('%s error remains private in operations, with a correction button',async(kind)=>{
    const slack=client(),r=await service.resource('room');
    if(kind==='conflict')await change('existing');
    const b=kind==='past'?{...booking(),start_at:now-3600000,end_at:now+3600000}:booking();
    const view=viewFor(r,b,'invalid');view.private_metadata=JSON.stringify({...JSON.parse(view.private_metadata),origin_channel:'COPS'});
    await submit(service,slack,{view,user:{id:'U1'}});
    const messages=slack.mock.calls.filter(x=>x[0]==='chat.postEphemeral');expect(messages).toHaveLength(1);
    expect(messages[0][1].channel).toBe('COPS');expect(messages[0][1].text).toContain(kind==='past'?'過去':'予約されています');
    expect(JSON.stringify(messages[0][1].blocks)).toContain('入力を修正');
    expect(slack.mock.calls.filter(x=>x[0]==='chat.postMessage')).toHaveLength(0);
  });
  it.each(['notification','panel','calendar'])('%s warning remains visible in operations without the routine success details',async(kind)=>{
    await db.prepare("INSERT INTO operation_panels(channel_id,message_ts,state,updated_at) VALUES('COPS','123.4','ready',?)").bind(now).run();
    const slack=client(),log=vi.spyOn(console,'error').mockImplementation(()=>{});
    slack.mockImplementation(async(method:string,_data:SlackJSON)=>{if(method===(kind==='notification'?'chat.postMessage':kind==='panel'?'chat.update':'none'))throw new Error('network');return {ok:true,ts:'123.4',user:{profile:{display_name:'利用者A'}}};});
    const view=viewFor(await service.resource('room'),booking(),'warn');view.private_metadata=JSON.stringify({...JSON.parse(view.private_metadata),origin_channel:'COPS'});
    try {
      await submit(service,slack,{view,user:{id:'U1'}},async()=>kind==='calendar'?'pending':'synced');
      const feedback=slack.mock.calls.filter(x=>x[0]==='chat.postEphemeral');expect(feedback).toHaveLength(1);
      expect(feedback[0][1].channel).toBe('COPS');expect(feedback[0][1].text).toContain('⚠️');
      expect(feedback[0][1].text).not.toContain('✅');expect(feedback[0][1].text).not.toContain('開始：');
      expect(await service.list()).toHaveLength(1);
    } finally {log.mockRestore();}
  });
  it('equipment panels link to operations and retain the live list',async()=>{
    const p=JSON.stringify(panel(await service.resource('room'),[],now,'COPS'));
    expect(p).toContain('<#COPS>');expect(p).not.toContain('app_redirect');expect(p).not.toContain('"action_id":"book"');expect(p).toContain('"action_id":"list"');
    expect(panelButtons(operationPanel(await service.resources())).filter(b=>b.action_id==='book')).toHaveLength(2);
  });
  it('existing reservations remain visible with resource and date filters',async()=>{
    await change('a');await change('b',booking(13,14,2),'stirrer');
    const slack=client();await action(service,slack,{user:{id:'U1'},channel:{id:'COPS'},trigger_id:'t',actions:[{action_id:'hub_mine',value:'all'}]});
    const view=slack.mock.calls.find(x=>x[0]==='views.open')![1].view;
    expect(JSON.stringify(view)).toContain('測定室A');expect(JSON.stringify(view)).toContain('スターラー');
    await action(service,slack,{user:{id:'U1'},view:{...view,type:'modal',id:'V1',hash:'h'},actions:[{action_id:'list_resource',selected_option:{value:'stirrer'}}]});
    const filtered=slack.mock.calls.find(x=>x[0]==='views.update')![1].view;
    expect(filtered.blocks.filter((b:SlackJSON)=>b.type==='section')).toHaveLength(1);
    expect(JSON.stringify(filtered.blocks.filter((b:SlackJSON)=>b.type==='section'))).toContain('スターラー');
  });
  it('notification buttons open modals and enforce ownership for change and cancel',async()=>{
    const first=await change('a'),slack=client();
    for(const action_id of ['edit','cancel']) {
      await action(service,slack,{user:{id:'U2'},channel:{id:'CROOM'},trigger_id:'t',actions:[{action_id,value:first.reservation_id}]});
      expect(slack.mock.calls.at(-1)?.[1].text).toContain('ご本人');
    }
    expect(slack.mock.calls.filter(x=>['views.open','views.push'].includes(x[0]))).toHaveLength(0);
    await action(service,slack,{user:{id:'U1'},channel:{id:'CROOM'},trigger_id:'t',actions:[{action_id:'edit',value:first.reservation_id}]});
    expect(slack.mock.calls.at(-1)?.[0]).toBe('views.open');
  });
  it('updates original notification status without deleting history or losing mappings',async()=>{
    const first=await change('a'),slack=client();await deliver(service,slack,first);
    const edit=await service.change('edit','updated','room','U1','',booking(13,14),first.reservation_id,1);
    await deliver(service,slack,edit);
    expect(JSON.stringify(slack.mock.calls.filter(x=>x[0]==='chat.update').at(-1)?.[1])).toContain('現在の状態');
    const cancel=await service.change('cancel','cancelled','room','U1','',undefined,first.reservation_id,2);
    await deliver(service,slack,cancel);await deliver(service,slack,cancel);
    const last=slack.mock.calls.filter(x=>x[0]==='chat.update').at(-1)![1];
    expect(JSON.stringify(last)).toContain('キャンセル済み');expect(last.blocks.filter((b:SlackJSON)=>b.type==='actions')).toHaveLength(0);
    expect(slack.mock.calls.filter(x=>x[0]==='chat.postMessage')).toHaveLength(3);
    expect(slack.mock.calls.filter(x=>x[0]==='chat.delete')).toHaveLength(0);
    expect((await db.prepare('SELECT * FROM notifications').all()).results).toHaveLength(3);
  });
  it('checks requested interval without creating reservation or notification',async()=>{
    await change('a',booking(10,18,3),'stirrer');await change('b',booking(12,16,4),'stirrer');
    const r=await service.resource('stirrer');
    const no=await checkAvailability(service,viewFor(r,booking(13,15,2),'check'));
    const yes=await checkAvailability(service,viewFor(r,booking(16,18,5),'check'));
    expect(JSON.stringify(no)).toContain('予約できません');expect(JSON.stringify(yes)).toContain('予約できます');
    expect(await service.list()).toHaveLength(2);
  });
  it('publishes the same resource entry points to Home',async()=>{
    const slack=client();await publishHome(service,slack,'U1');
    expect(slack.mock.calls[0][0]).toBe('views.publish');expect(slack.mock.calls[0][1].view.type).toBe('home');
    expect(panelButtons(slack.mock.calls[0][1].view).filter(b=>b.action_id==='book')).toHaveLength(2);
  });
  it('repeat migration preserves every reservation and receipt field',async()=>{
    const active=await change('a');await change('b',booking(13,15));
    await service.change('c','cancelled','room','U1','',undefined,active.reservation_id,1);
    const tables=['reservations','resources','notifications','processed_requests','panel_messages'];
    const before=await Promise.all(tables.map(t=>db.prepare(`SELECT * FROM ${t}`).all()));
    const migration=(await readFile('migrations/0002_operation_panel.sql','utf8')).replace(/^--.*$/gm,'');
    await db.prepare(migration).run();await db.prepare(migration).run();
    const after=await Promise.all(tables.map(t=>db.prepare(`SELECT * FROM ${t}`).all()));
    expect(after.map(x=>x.results)).toEqual(before.map(x=>x.results));
  });
});

describe('263 laboratory equipment configuration',()=>{
  const configure=async()=>{
    const sql=(await readFile('config/add-equipment-2026-10-14.sql','utf8')).replace(/^--.*$/gm,'');
    await db.batch(sql.split(';').filter(s=>s.trim()).map(s=>db.prepare(s)));
  };
  it('repeat configuration retains bookings and exposes all equipment in the same channel',async()=>{
    const first=await change('existing',booking(10,18,3),'stirrer');
    const before=await service.owned(first.reservation_id,'U1');
    await configure();const revision=(await service.resource('stirrer')).revision;await configure();
    expect(await service.owned(first.reservation_id,'U1')).toEqual(before);
    expect((await service.resource('stirrer')).capacity).toBe(16);
    expect((await service.resource('stirrer')).revision).toBe(revision);
    for(const id of ['furnace_blue','furnace_silver','printer_3d']) {
      const r=await service.resource(id);
      expect(r.channel_id).toBe('CSTIR');expect(r.type).toBe('exclusive_room');expect(r.multi_day).toBe(1);
    }
    const buttons=panelButtons(operationPanel(await service.resources())).filter(b=>b.action_id==='book');
    expect(buttons).toHaveLength(5);
    expect(buttons.map(b=>b.value)).toEqual(expect.arrayContaining(['furnace_blue','furnace_silver','printer_3d']));
    const modal=bookingModal(await service.resource('stirrer'),now);
    expect(modal.blocks.find((b:SlackJSON)=>b.block_id==='quantity').element.options).toHaveLength(16);
  });
  it('equipment in one channel remains independently exclusive, including concurrent reservations',async()=>{
    await configure();
    for(const id of ['furnace_blue','furnace_silver','printer_3d']) {
      const results=await Promise.allSettled([change(id+'-a',booking(),id),change(id+'-b',booking(),id,'U2')]);
      expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    }
    expect(await service.list()).toHaveLength(3);
    await expect(change('stirrer-independent',booking(10,12,16),'stirrer')).resolves.toBeTruthy();
    await expect(change('stirrer-over',booking(10,12,1),'stirrer','U2')).rejects.toThrow('不足');
  });
});

describe('live operation status',()=>{
  it('uses start-inclusive/end-exclusive active reservations, ignoring future and cancelled rows',async()=>{
    const first=await change('usage',booking(10,12,4),'stirrer');
    const future=await change('future',booking(13,15,3),'stirrer');
    const rows=[await service.owned(first.reservation_id,'U1'),await service.owned(future.reservation_id,'U1')];
    const stirrer={...await service.resource('stirrer'),capacity:16};
    expect(currentStatus(stirrer,rows,at(10))).toBe('使用中：4 / 16台\n空き：12台');
    expect(currentStatus(stirrer,rows,at(12))).toBe('使用中：0 / 16台\n空き：16台');
    expect(currentStatus(stirrer,[{...rows[0],status:'cancelled'}],at(11))).toContain('使用中：0');
    const room=await service.resource('room');
    const row={...rows[0],resource_id:'room',quantity:1};
    expect(currentStatus(room,[row],at(11))).toBe('使用中：10:00 ～ 12:00');
    expect(currentStatus(room,[{...row,end_at:at(12,3)}],at(11))).toBe('使用中：01/02 10:00 ～ 01/03 12:00');
    expect(currentStatus(room,[row],at(12))).toBe('空き');
  });
  it('scheduled updates the existing central panel without creating messages or modifying bookings',async()=>{
    await change('usage',booking(10,12,4),'stirrer');
    await db.prepare("INSERT INTO operation_panels(channel_id,message_ts,state,updated_at) VALUES('COPS','central.1','ready',?)").bind(now).run();
    const before=(await db.prepare('SELECT * FROM reservations').all()).results;
    const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({ok:true}));
    const clock=vi.spyOn(Date,'now').mockReturnValue(at(11));
    try {
      await worker.scheduled({} as ScheduledController,{DB:db,OPERATIONS_CHANNEL_ID:'COPS',SLACK_BOT_TOKEN:'test'} as Env);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain('chat.update');
      const body=JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      expect(body.ts).toBe('central.1');expect(JSON.stringify(body)).toContain('使用中：4 / 8台');
      expect((await db.prepare('SELECT * FROM reservations').all()).results).toEqual(before);
    } finally {fetchMock.mockRestore();clock.mockRestore();}
  });
});

describe('calendar views and private subscriptions',()=>{
  it('personal tokens serve only the authenticated issuer reservations and cannot widen scope using URL parameters',async()=>{
    const mineReservation=await change('mine'),otherReservation=await change('other',booking(12,14),'room','U2');
    const all=await subscriptionToken(db,'U1',now),personal=await subscriptionToken(db,'U1',now,'mine');expect(personal).not.toBe(all);
    expect(await subscriptionToken(db,'U1',now,'mine')).toBe(personal);
    const result=await calendarResponse(new Request(`https://test/calendar.ics?token=${personal}&user=U2&scope=all`),db,now);
    const ics=await result.text();expect(ics).toContain(mineReservation.reservation_id);expect(ics).not.toContain(otherReservation.reservation_id);expect(result.headers.get('X-Lab-Calendar-Scope')).toBe('mine');
    const shared=await (await calendarResponse(new Request(`https://test/calendar.ics?token=${all}`),db,now)).text();expect(shared).toContain(otherReservation.reservation_id);
    await service.change('cancel','cancelled','room','U1','利用者A',undefined,mineReservation.reservation_id,1);
    expect(await (await calendarResponse(new Request(`https://test/calendar.ics?token=${personal}`),db,now)).text()).not.toContain(mineReservation.reservation_id);
    const head=await calendarResponse(new Request(`https://test/calendar.ics?token=${personal}`,{method:'HEAD'}),db,now);expect(head.status).toBe(200);expect(await head.text()).toBe('');
    const setup=await (await calendarSetupResponse(new Request(`https://test/calendar/setup?token=${personal}`),db)).text();expect(setup).toContain(`webcal://test/calendar.ics?token=${personal}`);
  });
  it('reissue and revocation invalidate both all and personal tokens without affecting another user',async()=>{
    const all=await subscriptionToken(db,'U1',now),personal=await subscriptionToken(db,'U1',now,'mine'),other=await subscriptionToken(db,'U2',now,'mine');
    await changeSubscription(db,'U1',1,false,now+1);
    for(const token of [all,personal])expect((await calendarResponse(new Request(`https://test/calendar.ics?token=${token}`),db,now)).status).toBe(401);
    const fresh=await subscriptionToken(db,'U1',now+2,'mine');expect((await calendarResponse(new Request(`https://test/calendar.ics?token=${fresh}`),db,now)).status).toBe(200);
    await changeSubscription(db,'U1',2,true,now+3);expect((await calendarResponse(new Request(`https://test/calendar.ics?token=${fresh}`),db,now)).status).toBe(401);
    expect((await calendarResponse(new Request(`https://test/calendar.ics?token=${other}`),db,now)).status).toBe(200);
  });
  it('Slack offers all or own reservations and own subscriptions do not offer the shared Google calendar button',async()=>{
    const slack=vi.fn(async(_m:string,_p:SlackJSON)=>({ok:true}));
    await action(service,slack,{user:{id:'U1'},trigger_id:'t',actions:[{action_id:'calendar_subscribe'}]},'https://test','calendar-1@example.invalid');
    const choice=slack.mock.calls[0][1].view;expect(JSON.stringify(choice)).toContain('自分の予約だけ');expect(JSON.stringify(choice)).toContain('全員の予約');expect(JSON.stringify(choice)).not.toContain('token=');
    await action(service,slack,{user:{id:'U1'},trigger_id:'t',view:{...choice,type:'modal'},actions:[{action_id:'calendar_subscribe_mine'}]},'https://test','calendar-1@example.invalid');
    expect(slack.mock.calls.at(-1)![0]).toBe('views.push');const view=JSON.stringify(slack.mock.calls.at(-1)![1].view);expect(view).toContain('自分の予約だけ');expect(view).not.toContain('cid=');
    expect(slack.mock.calls.some(([method])=>method==='chat.postMessage'||method==='chat.postEphemeral')).toBe(false);
  });
  it('supports authenticated HEAD and a protected iPhone webcal subscription page',async()=>{
    const token=await subscriptionToken(db,'U1',now);
    const url='https://test/calendar.ics?token='+token;
    const head=await calendarResponse(new Request(url,{method:'HEAD'}),db,now);
    expect(head.status).toBe(200);expect(await head.text()).toBe('');expect(head.headers.get('content-type')).toContain('text/calendar');
    const setup=await calendarSetupResponse(new Request('https://test/calendar/setup?token='+token),db);
    expect(setup.status).toBe(200);expect(await setup.text()).toContain('webcal://test/calendar.ics?token=');
    expect((await calendarSetupResponse(new Request('https://test/calendar/setup'),db)).status).toBe(401);
  });
  it('uses a Japanese Monday week, handles cross-day events and excludes the end boundary',async()=>{
    const [start,end]=weekBounds('2030-01-02');
    expect(new Date(start).toISOString()).toBe('2029-12-30T15:00:00.000Z');
    expect(end-start).toBe(7*86400000);
    const r=await change('multi',{...booking(10,12,2),end_at:at(12,3)},'stirrer');
    const row=await service.owned(r.reservation_id,'U1');
    const modal=calendarModal([row],await service.resources(),{date:'2030-01-02',resource:'all'});
    expect(JSON.stringify(modal)).toContain('10:00 ～ 24:00');expect(JSON.stringify(modal)).toContain('00:00 ～ 12:00');
    expect((await calendarRows(db,at(12,3),at(13,3)))).toHaveLength(0);
    expect((await calendarRows(db,start,end,'room'))).toHaveLength(0);
  });
  it('subscription token is stable per user, unguessable and required by the feed',async()=>{
    const a=await subscriptionToken(db,'U1',now),b=await subscriptionToken(db,'U2',now);
    expect(a).toMatch(/^[a-f0-9]{64}$/);expect(b).not.toBe(a);
    expect(await subscriptionToken(db,'U1',now)).toBe(a);
    expect((await calendarResponse(new Request('https://test/calendar.ics'),db,now)).status).toBe(401);
    expect((await calendarResponse(new Request('https://test/calendar.ics?token='+a+'&resource=invalid'),db,now)).status).toBe(404);
    const response=await calendarResponse(new Request('https://test/calendar.ics?token='+a),db,now);
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.text()).toContain('BEGIN:VCALENDAR');
  });
  it('preserves UID on edits, increments sequence, escapes and folds UTF-8, removes cancelled events',async()=>{
    const receipt=await change('a',{...booking(10,12,2),purpose:'日本語'.repeat(60)+'\nBEGIN:VEVENT;injection,'},'stirrer');
    const resources=await service.resources();
    const rows=await calendarRows(db,now,at(18,5));
    const text=calendarICS(rows,resources,now),unfolded=text.replace(/\r\n /g,'');
    expect(unfolded).toContain('DTSTART:20300102T010000Z');expect(unfolded).toContain('DTEND:20300102T030000Z');
    expect(unfolded).toContain('\\nBEGIN:VEVENT\\;injection\\,');
    expect(text.split('\r\n').every(line=>new TextEncoder().encode(line).length<=75)).toBe(true);
    await service.change('b','updated','stirrer','U1','',booking(11,13,3),receipt.reservation_id,1);
    const updated=calendarICS(await calendarRows(db,now,at(18,5)),resources,now);
    expect(updated).toContain(`UID:${receipt.reservation_id}@lab-reservation`);expect(updated).toContain('SEQUENCE:2');
    await service.change('c','cancelled','stirrer','U1','',undefined,receipt.reservation_id,2);
    expect(calendarICS(await calendarRows(db,now,at(18,5)),resources,now)).not.toContain('BEGIN:VEVENT');
  });
  it('calendar filter/navigation only changes the modal and leaves reservation data untouched',async()=>{
    await change('a');const before=(await db.prepare('SELECT * FROM reservations').all()).results;
    const slack=vi.fn(async(_method:string,_payload:SlackJSON)=>({ok:true}));
    await action(service,slack,{user:{id:'U1'},trigger_id:'t',actions:[{action_id:'calendar_open'}]});
    const view=slack.mock.calls[0][1].view;expect(view.title.text).toContain('予約カレンダー');
    await action(service,slack,{user:{id:'U1'},view:{...view,id:'V1',hash:'h'},actions:[{action_id:'calendar_next'}]});
    expect(slack.mock.calls.at(-1)?.[0]).toBe('views.update');
    expect(JSON.parse(slack.mock.calls.at(-1)![1].view.private_metadata).date).toBe('2030-01-07');
    expect((await db.prepare('SELECT * FROM reservations').all()).results).toEqual(before);
  });
  it('subscription link is shown privately in a modal and never posted to a channel',async()=>{
    const slack=vi.fn(async(_method:string,_payload:SlackJSON)=>({ok:true}));
    await action(service,slack,{user:{id:'U1'},trigger_id:'t',actions:[{action_id:'calendar_subscribe_all'}]},'https://test');
    expect(slack.mock.calls.map(c=>c[0])).toEqual(['views.open']);
    expect(JSON.stringify(slack.mock.calls[0][1].view)).toContain('https://test/calendar.ics?token=');
    expect(JSON.stringify(slack.mock.calls[0][1].view)).toContain('研究室外へ共有しない');
  });
  it('configured direct Google calendar offers iPhone account guidance and ignores URL button actions',async()=>{
    const slack=vi.fn(async(_method:string,_payload:SlackJSON)=>({ok:true}));
    await action(service,slack,{user:{id:'U1'},trigger_id:'t',actions:[{action_id:'calendar_subscribe_all'}]},'https://test','calendar-1@example.invalid');
    const view=JSON.stringify(slack.mock.calls[0][1].view);
    expect(view).toContain('Googleカレンダーを開く');expect(view).toContain('共有を受けたGoogleアカウント');
    expect(view).toContain('端末の取得間隔');expect(view).toContain('cid=calendar-1%40example.invalid');
    slack.mockClear();
    for(const action_id of ['calendar_ios_help','calendar_google_help'])await action(service,slack,{user:{id:'U1'},actions:[{action_id}]});
    expect(slack).not.toHaveBeenCalled();
  });
});

describe('Google Calendar durable push',()=>{
  let credentials:string;
  beforeAll(async()=>{
    const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
    if(!('privateKey' in keys))throw new Error('expected RSA key pair');
    const exported=await crypto.subtle.exportKey('pkcs8',keys.privateKey);
    if(!(exported instanceof ArrayBuffer))throw new Error('expected PKCS8 bytes');
    const bytes=new Uint8Array(exported);
    credentials=JSON.stringify({client_email:'bot@example.invalid',private_key:'-----BEGIN PRIVATE KEY-----\n'+btoa(Array.from(bytes,b=>String.fromCharCode(b)).join(''))+'\n-----END PRIVATE KEY-----'});
  });
  const config=():Env=>({DB:db,GOOGLE_CALENDAR_ID:'calendar-2@example.invalid',GOOGLE_SERVICE_ACCOUNT_JSON:credentials} as Env);
  const client=()=>vi.fn<typeof fetch>(async()=>Response.json({access_token:'test-access-token'}));
  it('professor create/update/delete mirror only to the separate calendar with stable IDs and no replay writes',async()=>{
    const input={start_date:'2030-01-02',end_date:'2030-01-02',start_at:at(0),end_at:at(0,3),all_day:1,title:'出張',notes:''};
    await changeProfessor(db,'U1','push-prof','created','prof_2030-01-02',0,input,now);
    const env={...config(),SCHEDULE_GOOGLE_CALENDAR_ID:'seminars',PROFESSOR_GOOGLE_CALENDAR_ID:'professor'},request=client();
    request.mockImplementation(async(url,init)=>String(url).includes('oauth2')?Response.json({access_token:'t'}):init?.method==='PUT'?new Response(null,{status:404}):Response.json({ok:true}));
    expect(await syncProfessorEvent(env,'prof_2030-01-02',request,()=>now)).toBe('synced');
    const post=request.mock.calls.find(c=>String(c[0]).includes('/events')&&c[1]?.method==='POST')!;
    expect(String(post[0])).toContain('/calendars/professor/events');expect(JSON.parse(String(post[1]?.body)).end).toEqual({date:'2030-01-03'});
    const count=request.mock.calls.length;await syncProfessorEvent(env,'prof_2030-01-02',request,()=>now);expect(request).toHaveBeenCalledTimes(count);
    await changeProfessor(db,'U2','push-prof-edit','updated','prof_2030-01-02',1,{...input,title:'変更'},now+1);
    await syncProfessorEvent(env,'prof_2030-01-02',request,()=>now+1);
    await changeProfessor(db,'U2','push-prof-cancel','cancelled','prof_2030-01-02',2,undefined,now+2);
    expect(await syncProfessorEvent(env,'prof_2030-01-02',request,()=>now+2)).toBe('synced');
    expect(request.mock.calls.find(c=>c[1]?.method==='DELETE')?.[0]).toContain(professorGoogleId('prof_2030-01-02'));
    expect(request.mock.calls.filter(c=>String(c[0]).includes('/calendars/')).every(c=>String(c[0]).includes('/calendars/professor/'))).toBe(true);
  });
  it('professor sync failure preserves source and retries, and refuses existing lab calendar IDs',async()=>{
    const input={start_date:'2030-01-02',end_date:'2030-01-02',start_at:at(0),end_at:at(0,3),all_day:1,title:'予定あり',notes:''};
    await changeProfessor(db,'U1','push-fail','created','prof-fail',0,input,now);
    const env={...config(),PROFESSOR_GOOGLE_CALENDAR_ID:'professor'},request=client(),log=vi.spyOn(console,'error').mockImplementation(()=>{});
    request.mockImplementation(async(url)=>String(url).includes('oauth2')?Response.json({access_token:'t'}):new Response('private response',{status:503}));
    try{
      expect(await syncProfessorEvent({...env,PROFESSOR_GOOGLE_CALENDAR_ID:env.GOOGLE_CALENDAR_ID},'prof-fail',request,()=>now)).toBe('disabled');expect(request).not.toHaveBeenCalled();
      expect(await syncProfessorEvent(env,'prof-fail',request,()=>now)).toBe('pending');
      expect((await db.prepare("SELECT status FROM professor_days WHERE id='prof-fail'").first())?.status).toBe('active');
      expect((await db.prepare('SELECT last_error FROM professor_google_sync').first())?.last_error).toBe('google_events_http_503');expect(JSON.stringify(log.mock.calls)).not.toContain('private response');
      request.mockImplementation(async()=>Response.json({access_token:'t'}));expect(await syncProfessorEvent(env,'prof-fail',request,()=>now+60001)).toBe('synced');
    }finally{log.mockRestore();}
  });
  it('queues only committed changes atomically and replays do not add duplicate jobs',async()=>{
    const receipt=await change('a');await change('a');
    await expect(change('conflict')).rejects.toThrow();
    const jobs=(await db.prepare('SELECT * FROM google_calendar_sync').all()).results;
    expect(jobs).toHaveLength(1);expect(jobs[0].desired_version).toBe(1);
    await service.change('b','updated','room','U1','',booking(11,13),receipt.reservation_id,1);
    expect((await db.prepare('SELECT desired_version FROM google_calendar_sync').first())?.desired_version).toBe(2);
  });
  it('insert/update use the same deterministic event ID and successful replay sends nothing',async()=>{
    const receipt=await change('a'),request=client();
    request.mockImplementation(async(input,init)=>String(input).includes('oauth2')?Response.json({access_token:'t'}):init?.method==='PUT'?new Response('',{status:404}):Response.json({ok:true}));
    expect(await syncGoogleReservation(config(),receipt.reservation_id,request,()=>now)).toBe('synced');
    const post=request.mock.calls.find(c=>c[1]?.method==='POST'&&String(c[0]).includes('/events'))!;
    expect(JSON.parse(String(post[1]?.body)).id).toBe(googleEventId(receipt.reservation_id));
    const count=request.mock.calls.length;
    expect(await syncGoogleReservation(config(),receipt.reservation_id,request,()=>now)).toBe('synced');expect(request).toHaveBeenCalledTimes(count);
    await service.change('b','updated','room','U1','',booking(11,13),receipt.reservation_id,1);
    await syncGoogleReservation(config(),receipt.reservation_id,request,()=>now);
    expect(request.mock.calls.filter(c=>c[1]?.method==='PUT').every(c=>String(c[0]).includes(googleEventId(receipt.reservation_id)))).toBe(true);
  });
  it('failed Google delivery keeps reservation and a retryable job, without leaking response contents',async()=>{
    const receipt=await change('a'),request=client(),log=vi.spyOn(console,'error').mockImplementation(()=>{});
    request.mockImplementation(async(input)=>String(input).includes('oauth2')?Response.json({access_token:'t'}):new Response('secret provider response',{status:503}));
    try {
      expect(await syncGoogleReservation(config(),receipt.reservation_id,request,()=>now)).toBe('pending');
      expect((await service.owned(receipt.reservation_id,'U1')).status).toBe('active');
      const state=await db.prepare('SELECT * FROM google_calendar_sync').first();
      expect(state?.status).toBe('pending');expect(state?.lease_until).toBe(0);expect(state?.last_error).toBe('google_events_http_503');
      expect(JSON.stringify(log.mock.calls)).not.toContain('secret provider response');
      request.mockImplementation(async()=>Response.json({access_token:'t'}));
      expect(await syncGoogleReservation(config(),receipt.reservation_id,request,()=>now+60001)).toBe('synced');
    } finally {log.mockRestore();}
  });
  it('cancel deletes only its mirrored event, tolerates missing event, and concurrent updates reach latest version',async()=>{
    const receipt=await change('a'),request=client();let edited=false;
    request.mockImplementation(async(input,init)=>{
      if(init?.method==='PUT'&&!edited) {edited=true;await service.change('b','updated','room','U1','',booking(11,13),receipt.reservation_id,1);}
      return init?.method==='DELETE'?new Response('',{status:404}):Response.json({access_token:'t'});
    });
    await syncGoogleReservation(config(),receipt.reservation_id,request,()=>now);
    expect((await db.prepare('SELECT synced_version FROM google_calendar_sync').first())?.synced_version).toBe(2);
    await service.change('c','cancelled','room','U1','',undefined,receipt.reservation_id,2);
    expect(await syncGoogleReservation(config(),receipt.reservation_id,request,()=>now)).toBe('synced');
    expect(request.mock.calls.find(c=>c[1]?.method==='DELETE')).toBeTruthy();
  });
  it('unconfigured integration is disabled and backfill preserves every reservation',async()=>{
    await change('a');const before=(await db.prepare('SELECT * FROM reservations').all()).results;
    await seedGoogleSync(config());await seedGoogleSync(config());
    expect((await db.prepare('SELECT * FROM google_calendar_sync').all()).results).toHaveLength(1);
    expect((await db.prepare('SELECT * FROM reservations').all()).results).toEqual(before);
    expect(await syncGoogleReservation({DB:db} as Env,String(before[0].id))).toBe('disabled');
  });
  it('seminar events and their location only reach the separate schedule calendar; feeds remain separate',async()=>{
    await db.prepare("INSERT INTO resources(id,channel_id,name,type,capacity,schedule_event,icon,created_at,updated_at) VALUES('seminar','CSEMINAR','英論ゼミ','exclusive_room',1,1,'📖',?,?)").bind(now,now).run();
    const event=await change('event',{...booking(),location:'サンプル棟 206室'},'seminar');await change('equipment');
    const request=client(),env={...config(),SCHEDULE_GOOGLE_CALENDAR_ID:'separate-schedule'};
    expect(await syncGoogleReservation(env,event.reservation_id,request,()=>now)).toBe('synced');
    const call=request.mock.calls.find(c=>c[1]?.method==='PUT')!;
    expect(String(call[0])).toContain('/calendars/separate-schedule/events/');expect(JSON.parse(String(call[1]?.body)).location).toBe('サンプル棟 206室');
    const token=await subscriptionToken(db,'U1',now);
    const equipment=await (await calendarResponse(new Request(`https://test/calendar.ics?token=${token}`),db,now)).text();
    const schedule=await (await calendarResponse(new Request(`https://test/calendar.ics?token=${token}&kind=schedule`),db,now)).text();
    expect(equipment).not.toContain(event.reservation_id);expect(schedule).toContain(event.reservation_id);expect(schedule).not.toContain('測定室A');expect(schedule).toContain('LOCATION:サンプル棟 206室');
  });
});


