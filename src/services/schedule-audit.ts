import {localParts} from '../datetime';
import {presenterNames} from '../meeting';
import {button,detail,notice,section} from '../ui';
import type {Change,SlackCall,SlackJSON} from '../types';
import {BookingError,Reservations} from './reservations';

interface AuditRow {id:string;resource_id:string;name:string;actor:string;actor_name:string|null;operation:string;payload:string;at:number;source:string}
export async function scheduleAudit(service:Reservations,reservation='all',page=0) {
  if(!Number.isSafeInteger(page)||page<0||page>100000)page=0;
  if(reservation!=='all') {
    const allowed=await service.db.prepare("SELECT b.id FROM reservations b JOIN resources r ON r.id=b.resource_id WHERE b.id=? AND r.schedule_event=1 AND r.id IN ('english_seminar','biweekly_report')").bind(reservation).first();
    if(!allowed)throw new BookingError('日程が見つかりません。');
  }
  const rows=(await service.db.prepare(`SELECT a.*,r.name,m.name AS actor_name FROM (
    SELECT request_key AS id,resource_id,slack_user_id AS actor,operation,payload,processed_at AS at,'booking' AS source,reservation_id AS target FROM processed_requests
    UNION ALL SELECT e.request_key,s.resource_id,e.slack_user_id,'history_updated',e.payload,e.created_at,'history',s.reservation_id
      FROM schedule_edits e JOIN schedule_sessions s ON s.id=e.session_id
    UNION ALL SELECT e.request_key,s.resource_id,e.slack_user_id,'history_created',e.payload,e.created_at,'history',s.reservation_id
      FROM meeting_creations e JOIN schedule_sessions s ON s.id=e.session_id
    ) a JOIN resources r ON r.id=a.resource_id LEFT JOIN member_names m ON m.slack_user_id=a.actor
    WHERE r.schedule_event=1 AND r.id IN ('english_seminar','biweekly_report') AND (?='all' OR a.target=?)
    ORDER BY a.at DESC,a.id DESC LIMIT 6 OFFSET ?`).bind(reservation,reservation,page*5).all<AuditRow>()).results;
  const blocks:SlackJSON[]=[section('登録・変更・キャンセルと担当履歴の操作記録です。日時は日本時間です。登録者と操作者は別に記録しています。')];
  for(const row of rows.slice(0,5)) {
    const labels:Record<string,string>={created:'登録',updated:'変更',cancelled:'キャンセル',history_updated:'担当履歴を変更',history_created:'担当履歴を追加'};
    const when=localParts(row.at);
    blocks.push({type:'divider'},section(`${when.date} ${when.time}｜${row.name}｜${labels[row.operation]??row.operation}\n操作者：${row.actor_name??row.actor}`));
    if(row.source==='booking') {
      const c=JSON.parse(row.payload) as Change;
      blocks.push(section(`登録者：${c.after.slack_user_name}\n${row.operation==='updated'&&c.before?'【変更前】\n'+detail(c.before,false,true)+'\n\n【変更後】\n':''}${detail(c.after,false,true)}${row.resource_id==='english_seminar'?'\n担当者：'+presenterNames(c.after):''}\n予約ID：${c.after.id}`));
    }else {
      const p=JSON.parse(row.payload);
      blocks.push(section(`${p.date}\n${p.state==='not_held'?'開催なし':'担当者：'+presenterNames({presenters:p.presenters})}${p.notes?'\n備考：'+p.notes:''}`));
    }
  }
  if(!rows.length)blocks.push(section('このページに操作履歴はありません。'));
  const controls=[button('更新','meeting_audit_refresh',String(page))];
  if(page>0)controls.push(button('前へ','meeting_audit_prev',String(page-1)));
  if(rows.length>5)controls.push(button('次へ','meeting_audit_next',String(page+1)));
  blocks.push({type:'actions',elements:controls});
  return {...notice('日程の操作履歴',''),callback_id:'schedule_audit',private_metadata:JSON.stringify({reservation,page}),blocks};
}
export async function scheduleAuditAction(service:Reservations,slack:SlackCall,body:SlackJSON) {
  const a=body.actions[0],existing=body.view?.callback_id==='schedule_audit';
  const meta=existing?JSON.parse(body.view.private_metadata):{};
  const view=await scheduleAudit(service,existing?meta.reservation:a.value||'all',existing?Number(a.value):0);
  if(existing)await slack('views.update',{view_id:body.view.id,hash:body.view.hash,view});
  else await slack(body.view?.type==='modal'?'views.push':'views.open',{trigger_id:body.trigger_id,view});
}
