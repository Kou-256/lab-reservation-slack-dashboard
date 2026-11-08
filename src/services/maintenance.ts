import { BookingError, Reservations, peakUsage } from './reservations';
import type { Booking } from '../types';

export interface Maintenance {id:string;resource_id:string;start_at:number;end_at:number|null;kind:'fault'|'inspection';reason:string;status:string;slack_user_id:string;quantity:number|null;}
export type MaintenanceBooking=Omit<Booking,'end_at'>&{end_at:number|null};
export interface RepairUpdate {id:string;maintenance_id:string;slack_user_id:string;content:string;created_at:number;}
export async function maintenanceById(service:Reservations,id:string) {
  const p=await service.db.prepare('SELECT * FROM maintenance_periods WHERE id=?').bind(id).first<Maintenance>();
  if(!p)throw new BookingError('故障・点検の情報が見つかりません。');return p;
}
export async function repairUpdates(service:Reservations,id:string) {
  return (await service.db.prepare('SELECT * FROM maintenance_updates WHERE maintenance_id=? ORDER BY created_at DESC,id DESC LIMIT 20').bind(id).all<RepairUpdate>()).results;
}
export async function addRepairUpdate(service:Reservations,user:string,id:string,requestId:string,content:string) {
  if(!/^[UW][A-Z0-9]+$/.test(user)||!/^[a-zA-Z0-9_-]{1,100}$/.test(requestId))throw new BookingError('操作を確認できません。');
  if(typeof content!=='string'||!content.trim()||content.length>1000)throw new BookingError('修理状況を1〜1000文字で入力してください。');
  await service.db.prepare(`INSERT INTO maintenance_updates(id,maintenance_id,slack_user_id,content,created_at)
    SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM maintenance_periods WHERE id=? AND kind='fault' AND status='active')
    ON CONFLICT(id) DO NOTHING`).bind(requestId,id,user,content.trim(),service.clock(),id).run();
  const result=await service.db.prepare('SELECT * FROM maintenance_updates WHERE id=?').bind(requestId).first<RepairUpdate>();
  if(!result)throw new BookingError('この故障は解除済みです。画面を開き直してください。');
  if(result.maintenance_id!==id||result.slack_user_id!==user)throw new BookingError('操作を確認できません。');
  return result;
}
export const isAdmin=(service:Reservations,user:string)=>service.adminUserIds.split(',').map(x=>x.trim()).filter(Boolean).includes(user);
export async function requireMaintenanceOwner(service:Reservations,user:string,id:string) {
  const row=await service.db.prepare('SELECT slack_user_id FROM maintenance_periods WHERE id=?').bind(id).first<{slack_user_id:string}>();
  if(!row||!(row.slack_user_id===user||isAdmin(service,user)))throw new BookingError('故障・点検期間の解除は登録した本人または管理者が行ってください。');
}
export async function maintenanceList(service:Reservations) {
  return (await service.db.prepare("SELECT * FROM maintenance_periods WHERE status='active' AND (end_at IS NULL OR end_at>?) ORDER BY start_at LIMIT 15").bind(service.clock()).all<Maintenance>()).results;
}
export async function saveMaintenance(service:Reservations,user:string,id:string,resource:string,b:MaintenanceBooking,kind:Maintenance['kind']='inspection') {
  if(!/^U[A-Z0-9]+$/.test(user))throw new BookingError('Slackの利用者を確認できません。');
  const r=await service.resource(resource);
  if(r.schedule_event)throw new BookingError('設備を選択してください。');
  if(!Number.isInteger(b.quantity)||b.quantity<1||(r.type==='quantity_resource'?(r.capacity===null||b.quantity>r.capacity):b.quantity!==1))throw new BookingError('故障・点検の対象台数を正しく選択してください。');
  if(!['fault','inspection'].includes(kind))throw new BookingError('故障または点検を選択してください。');
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id)||!Number.isSafeInteger(b.start_at)||Math.abs(b.start_at)>8e15||
    (b.end_at===null?kind!=='fault':!Number.isSafeInteger(b.end_at)||b.end_at<=b.start_at||b.end_at<=service.clock()||Math.abs(b.end_at)>8e15))throw new BookingError('点検の終了は開始・現在時刻より後にしてください。');
  if(typeof b.purpose!=='string'||!b.purpose.trim()||b.purpose.length>300)throw new BookingError('故障・点検の理由を300文字以内で入力してください。');
  await service.db.prepare('INSERT INTO maintenance_periods(id,resource_id,start_at,end_at,reason,slack_user_id,created_at,updated_at,kind,quantity) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(id,r.id,b.start_at,b.end_at,b.purpose.trim(),user,service.clock(),service.clock(),kind,b.quantity).run();
  const end=b.end_at??8_640_000_000_000_000,rows=await service.list(r.id,null,b.start_at,end);
  if(r.type==='quantity_resource'&&r.capacity!==null&&peakUsage([...rows,...await service.unavailable(r,b.start_at,end)],b.start_at,end)<=r.capacity)return [];
  return rows;
}
export async function cancelMaintenance(service:Reservations,user:string,id:string) {
  await requireMaintenanceOwner(service,user,id);
  await service.db.prepare("UPDATE maintenance_periods SET status='cancelled',updated_at=? WHERE id=? AND status='active'").bind(service.clock(),id).run();
}
