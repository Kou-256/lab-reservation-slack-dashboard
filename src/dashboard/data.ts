import type {Snapshot,Equipment,BookingView,Downtime} from '../../shared/dashboard';
import {DAY,jstDate,midnight} from '../../shared/dashboard';
import type {Resource,Reservation} from '../types';
import {DashboardError} from './auth';

export async function snapshot(db:D1Database,date:string,now:number):Promise<Snapshot> {
  const start=midnight(date),end=start+DAY;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(start)||jstDate(start)!==date||Math.abs(start-midnight(jstDate(now)))>366*DAY)throw new DashboardError('表示日は本日から前後366日以内で指定してください。');
  // 1回のbatch内で設備・予約・停止期間を読み、途中変更による混在を避ける。
  // 今日の終了済み予約も取得する。現在の予約と各設備の直近の次回予約は表示日外でも含める。
  const result=await db.batch([
    db.prepare(`SELECT * FROM resources r WHERE schedule_event=0 AND (enabled=1 OR EXISTS(
      SELECT 1 FROM reservations b WHERE b.resource_id=r.id AND b.status='active' AND b.end_at>?)) ORDER BY created_at,id`).bind(now),
    db.prepare(`SELECT b.* FROM reservations b JOIN resources r ON r.id=b.resource_id WHERE r.schedule_event=0 AND b.status='active' AND b.end_at>?
      AND ((b.start_at<? AND b.end_at>?) OR (b.start_at<=? AND b.end_at>?) OR b.start_at=(
        SELECT MIN(n.start_at) FROM reservations n WHERE n.resource_id=b.resource_id AND n.status='active' AND n.start_at>?))
      ORDER BY b.start_at,b.id LIMIT 5001`).bind(Math.min(start,now),end,start,now,now,now),
    db.prepare(`SELECT m.* FROM maintenance_periods m JOIN resources r ON r.id=m.resource_id WHERE r.schedule_event=0 AND m.status='active'
      AND ((m.start_at<? AND (m.end_at IS NULL OR m.end_at>?)) OR (m.start_at<=? AND (m.end_at IS NULL OR m.end_at>?))) ORDER BY m.start_at,m.id LIMIT 5001`).bind(end,start,now,now),
    db.prepare(`SELECT m.slack_user_id AS id,m.name FROM member_names m JOIN dashboard_members d USING(slack_user_id) WHERE d.enabled=1 ORDER BY m.name`)
  ]);
  if(result[1].results.length>5000||result[2].results.length>5000)throw new DashboardError('表示件数が上限を超えました。管理者に連絡してください。',503);
  const resources=(result[0].results as unknown as Resource[]).map((r):Equipment=>({id:r.id,name:r.name,room:r.room??'',type:r.type,capacity:r.capacity,enabled:r.enabled,multi_day:r.multi_day,pools:JSON.parse(r.booking_pools??'[]'),purposes:JSON.parse(r.purpose_options)}));
  const reservations=(result[1].results as unknown as Reservation[]).map((b):BookingView=>({id:b.id,resource_id:b.resource_id,person:b.slack_user_name,start_at:b.start_at,end_at:b.end_at,quantity:b.quantity,purpose:b.purpose||b.purpose_choice,pool_id:b.pool_id??null,version:b.version}));
  const maintenance=(result[2].results as unknown as Downtime[]).map(m=>({id:m.id,resource_id:m.resource_id,start_at:m.start_at,end_at:m.end_at,quantity:m.quantity,kind:m.kind,reason:m.reason}));
  return {server_time:now,date,range_end:end,resources,reservations,maintenance,members:result[3].results as unknown as Snapshot['members']};
}
