import {BookingError,Reservations} from './reservations';
import {day,parseDate,localParts} from '../datetime';
import {purposeText} from '../purpose';
import type {Booking,Env,Reservation} from '../types';

export async function extendBooking(service:Reservations,key:string,user:string,id:string,version:number,minutes:number){
  if(![30,60].includes(minutes))throw new BookingError('30分または1時間を選んでください。');
  const replay=await service.receipt(key,user,'updated');
  if(replay){const c=JSON.parse(replay.payload);if(replay.reservation_id!==id||c.after.end_at-c.before?.end_at!==minutes*60000)throw new BookingError('操作を確認できません。');return replay;}
  const row=await service.owned(id,user),r=await service.resource(row.resource_id);
  if(r.schedule_event)throw new BookingError('設備の利用予約を選んでください。');
  if(row.status!=='active'||row.start_at>=service.clock()||row.end_at<=service.clock())throw new BookingError('現在利用中のご本人の予約だけ延長できます。');
  let purpose=row.purpose,purpose_choice=row.purpose_choice;
  if(purpose_choice&&!JSON.parse(r.purpose_options).includes(purpose_choice)){purpose=purposeText(row);purpose_choice='';}
  return service.change(key,'updated',r.id,user,'',{start_at:row.start_at,end_at:row.end_at+minutes*60000,quantity:row.quantity,purpose,purpose_choice,location:row.location,pool_id:row.pool_id},id,version);
}
export async function maintenanceWarnings(service:Reservations,rows:Reservation[]){
  if(!rows.length)return rows;
  const periods=(await service.db.prepare("SELECT resource_id,kind,reason,quantity,start_at,end_at FROM maintenance_periods WHERE status='active' AND start_at<? AND (end_at IS NULL OR end_at>?)").bind(Math.max(...rows.map(r=>r.end_at)),Math.min(...rows.map(r=>r.start_at))).all<{resource_id:string;kind:string;reason:string;quantity:number|null;start_at:number;end_at:number|null}>()).results;
  return rows.map(row=>{const p=periods.filter(p=>p.resource_id===row.resource_id&&p.start_at<row.end_at&&(p.end_at===null||p.end_at>row.start_at));
    return {...row,maintenance_warning:p.length?'⚠️ 故障・点検と重なる予約です。利用前に状況を確認してください。\n'+p.slice(0,2).map(p=>`${p.kind==='fault'?'故障':'点検'}${p.quantity?'（'+p.quantity+'台）':''}：${p.reason.slice(0,160)}`).join('\n'):''};});
}
export async function reusableBookings(service:Reservations,user:string,page=0){
  const rows=(await service.db.prepare(`SELECT b.*,count(*) AS uses FROM reservations b JOIN resources r ON r.id=b.resource_id
    WHERE b.slack_user_id=? AND b.status='active' AND r.enabled=1 AND r.schedule_event=0
    GROUP BY b.resource_id,b.quantity,b.purpose,b.purpose_choice ORDER BY uses DESC,max(b.updated_at) DESC,b.id LIMIT 6 OFFSET ?`).bind(user,Math.max(0,page)*5).all<Reservation&{uses:number}>()).results;
  return rows;
}
export function reuseBooking(row:Reservation,now:number):Reservation{
  const start=parseDate(localParts(now+day).date,'09:00');
  return {...row,start_at:start,end_at:start+Math.max(60000,row.end_at-row.start_at)};
}
export async function editPurpose(service:Reservations,user:string,key:string,resourceId:string,revision:number,source:string,target:string,restore=false){
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(key))throw new BookingError('操作を確認できません。');
  const replay=await service.db.prepare('SELECT resource_id,slack_user_id FROM purpose_edits WHERE request_key=?').bind(key).first<{resource_id:string;slack_user_id:string}>();
  if(replay){if(replay.resource_id!==resourceId||replay.slack_user_id!==user)throw new BookingError('操作を確認できません。');return;}
  const r=await service.resource(resourceId);if(r.schedule_event||r.revision!==revision)throw new BookingError('用途が更新されました。画面を開き直してください。');
  const options:string[]=JSON.parse(r.purpose_options);target=target.trim();
  if(!source||source==='自由入力'||source==='その他'||target==='自由入力'||target==='その他'||target.length>300)throw new BookingError('用途の名前を確認してください。');
  let operation=restore?'restore':target?'rename':'hide';
  if(restore){if(!await service.db.prepare('SELECT 1 FROM purpose_hidden WHERE resource_id=? AND value=?').bind(r.id,source).first())throw new BookingError('非表示の用途を選んでください。');target=source;}
  else if(!options.includes(source))throw new BookingError('用途を選び直してください。');
  if(!restore&&target===source)return;
  const next=[...new Set([...options.filter(v=>v!==source&&v!=='自由入力'),...(target?[target]:[]),'自由入力'])];
  if(next.length>9999)throw new BookingError('用途の選択肢が上限に達しています。');
  try{await service.db.prepare('INSERT INTO purpose_edits VALUES(?,?,?,?,?,?,?,?,?)').bind(key,r.id,user,revision,operation,source,target,JSON.stringify(next),service.clock()).run();}
  catch(error){const saved=await service.db.prepare('SELECT resource_id,slack_user_id FROM purpose_edits WHERE request_key=?').bind(key).first<{resource_id:string;slack_user_id:string}>();if(saved?.resource_id===r.id&&saved.slack_user_id===user)return;if(String(error).includes('stale_purpose_edit'))throw new BookingError('用途が更新されました。画面を開き直してください。');throw error;}
}
export async function calendarStatus(service:Reservations,user:string,env?:Env){
  const groups=(await service.db.prepare(`SELECT CASE WHEN r.schedule_event=1 THEN 'ゼミ・隔週報' ELSE '設備予約' END AS name,s.status,count(*) AS count,sum(CASE WHEN s.last_error IS NOT NULL THEN 1 ELSE 0 END) AS errors FROM google_calendar_sync s JOIN reservations b ON b.id=s.reservation_id JOIN resources r ON r.id=b.resource_id GROUP BY CASE WHEN r.schedule_event=1 THEN 'ゼミ・隔週報' ELSE '設備予約' END,s.status
    UNION ALL SELECT '担当教員先生の予定',status,count(*),sum(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) FROM professor_google_sync GROUP BY status`).all<{name:string;status:string;count:number;errors:number}>()).results;
  const own=(await service.db.prepare(`SELECT b.*,r.name,s.status AS sync_status,s.desired_version,s.synced_version,s.last_error FROM reservations b JOIN resources r ON r.id=b.resource_id LEFT JOIN google_calendar_sync s ON s.reservation_id=b.id WHERE b.slack_user_id=? ORDER BY b.updated_at DESC LIMIT 8`).bind(user).all<Reservation&{name:string;sync_status:string;desired_version:number;synced_version:number;last_error:string}>()).results;
  return {groups,own,configured:env?Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON&&env.GOOGLE_CALENDAR_ID):undefined};
}
