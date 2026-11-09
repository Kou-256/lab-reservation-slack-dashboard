import {DAY,jstDate,midnight,type BookingView} from '../../shared/dashboard';
import {DashboardError} from './auth';

// 予約の終了日で履歴を検索する。キャンセル・未来の予約は使用履歴に含めない。
export async function bookingHistory(db:D1Database,params:URLSearchParams,now:number) {
  const resource=params.get('resource')??'',from=params.get('from')??'',to=params.get('to')??'';
  const start=midnight(from),finish=midnight(to);
  if(!resource||resource.length>100||![from,to].every(d=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(midnight(d))&&jstDate(midnight(d))===d)||start>finish||finish-start>366*DAY||to>jstDate(now))throw new DashboardError('過去の日付を、開始日から366日以内の範囲で指定してください。');
  const before=params.get('before'),id=params.get('before_id');
  if((before===null)!==(id===null)||before!==null&&(!Number.isSafeInteger(Number(before))||!id||id.length>100))throw new DashboardError('履歴の続きの指定が正しくありません。');
  const exists=await db.prepare('SELECT id FROM resources WHERE id=? AND schedule_event=0').bind(resource).first();
  if(!exists)throw new DashboardError('設備が見つかりません。',404);
  const result=await db.prepare(`SELECT id,resource_id,slack_user_name AS person,start_at,end_at,quantity,purpose,purpose_choice,pool_id,version FROM reservations
    WHERE resource_id=? AND status='active' AND end_at<=? AND end_at>=? AND end_at<?
    ${before===null?'':'AND (end_at<? OR (end_at=? AND id<?))'} ORDER BY end_at DESC,id DESC LIMIT 31`)
    .bind(resource,now,start,finish+DAY,...(before===null?[]:[Number(before),Number(before),id])).all<BookingView&{purpose_choice:string}>();
  const rows=result.results.slice(0,30).map(b=>({id:b.id,resource_id:b.resource_id,person:b.person,start_at:b.start_at,end_at:b.end_at,quantity:b.quantity,purpose:b.purpose||b.purpose_choice,pool_id:b.pool_id,version:b.version}));
  const last=rows.at(-1);
  return {bookings:rows,next:result.results.length>30&&last?{end:last.end_at,id:last.id}:null};
}
