import {Reservations,BookingError} from './reservations';
import {button,detail,section} from '../ui';
import type {Reservation,SlackCall} from '../types';

export async function setReminders(db:D1Database,user:string,key:string,enabled:boolean,now=Date.now()){
  if(!/^U[A-Z0-9]+$/.test(user)||!/^[A-Za-z0-9_-]{1,100}$/.test(key))throw new BookingError('設定を確認できません。');
  await db.prepare('INSERT INTO reminder_preference_requests VALUES(?,?,?,?) ON CONFLICT DO NOTHING').bind(key,user,enabled?1:0,now).run();
  const row=await db.prepare('SELECT slack_user_id,enabled FROM reminder_preference_requests WHERE request_key=?').bind(key).first<{slack_user_id:string;enabled:number}>();
  if(row?.slack_user_id!==user||row.enabled!==(enabled?1:0))throw new BookingError('設定を確認できません。');
}
export async function sendDueReminders(service:Reservations,slack:SlackCall,limit=2){
  const now=service.clock();
  const jobs=(await service.db.prepare(`SELECT b.*,CASE WHEN b.end_at>? THEN 'before' ELSE 'end' END AS kind
    FROM reservations b JOIN resources r ON r.id=b.resource_id JOIN reminder_preferences p ON p.slack_user_id=b.slack_user_id
    WHERE p.enabled=1 AND b.status='active' AND r.schedule_event=0 AND b.start_at<? AND b.end_at>=p.enabled_at
      AND b.end_at>? AND b.end_at<=?
      AND NOT EXISTS(SELECT 1 FROM processed_requests q WHERE q.reservation_id=b.id AND json_extract(q.payload,'$.after.version')=b.version AND json_extract(q.payload,'$.finished')=1)
      AND NOT EXISTS(SELECT 1 FROM reminder_deliveries d WHERE d.reservation_id=b.id AND d.version=b.version AND d.kind=CASE WHEN b.end_at>? THEN 'before' ELSE 'end' END)
    ORDER BY b.end_at,b.id LIMIT ?`).bind(now,now,now-5*60000,now+5*60000,now,limit).all<Reservation&{kind:'before'|'end'}>()).results;
  for(const row of jobs){
    const claimed=await service.db.prepare("INSERT INTO reminder_deliveries VALUES(?,?,?,?, 'sending',?,NULL) ON CONFLICT DO NOTHING RETURNING reservation_id").bind(row.id,row.version,row.kind,row.slack_user_id,now).first();
    if(!claimed)continue;
    try{
      const valid=await service.db.prepare("SELECT 1 FROM reservations b JOIN reminder_preferences p ON p.slack_user_id=b.slack_user_id WHERE b.id=? AND b.version=? AND b.status='active' AND p.enabled=1").bind(row.id,row.version).first();
      if(!valid){await service.db.prepare("UPDATE reminder_deliveries SET status='skipped' WHERE reservation_id=? AND version=? AND kind=?").bind(row.id,row.version,row.kind).run();continue;}
      const resource=await service.resource(row.resource_id),text=(row.kind==='before'?'⏰ まもなく設備の利用終了時刻です':'⏰ 設備の利用終了時刻になりました')+'\n'+resource.name;
      const controls=row.kind==='before'?[button('今すぐ終了','finish',row.id),button('あと30分','extend_30',row.id),button('あと1時間','extend_60',row.id)]:[];
      await slack('chat.postMessage',{channel:row.slack_user_id,text,blocks:[section(text),section(detail(row,resource.type==='quantity_resource')),...(controls.length?[{type:'actions',elements:controls}]:[]),{type:'actions',elements:[button('個人の通知設定','tools_reminders','self')]}],unfurl_links:false,unfurl_media:false});
      await service.db.prepare("UPDATE reminder_deliveries SET status='sent' WHERE reservation_id=? AND version=? AND kind=?").bind(row.id,row.version,row.kind).run();
    }catch(error){
      const code=error instanceof Error&&/^slack_[a-z_0-9]+$/.test(error.message)?error.message:'delivery_unconfirmed';
      await service.db.prepare("UPDATE reminder_deliveries SET status='failed',error=? WHERE reservation_id=? AND version=? AND kind=?").bind(code,row.id,row.version,row.kind).run();
      console.error(JSON.stringify({kind:'reservation_reminder',reservation_id:row.id,slack_user_id:row.slack_user_id,error:code,occurred_at:new Date(now).toISOString()}));
      // Do not blindly retry a potentially accepted DM after a timeout.
    }
  }
}
