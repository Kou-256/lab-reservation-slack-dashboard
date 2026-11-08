import {localParts} from '../datetime';
import {sharedSchedule} from '../meeting';
import type { Change, Receipt, SlackCall } from '../types';
import { detail, editButton, isWashingBooking, notification, operationPanel, panel, plain, schedulePanel, section } from '../ui';
import { Reservations } from './reservations';

export function logFailure(receipt:Receipt,kind:string,error:unknown) {
  const c=JSON.parse(receipt.payload) as Change;
  // Avoid request bodies, tokens, and user-entered text in logs.
  const message=error instanceof Error?error.message:String(error);
  console.error(JSON.stringify({reservation_id:receipt.reservation_id,channel_id:c.resource.channel_id,slack_user_id:receipt.slack_user_id,
    operation:receipt.operation,error:message.replace(/xox[baprs]-[^\s]+/g,'[redacted]').slice(0,500),kind,occurred_at:new Date().toISOString()}));
}
export async function refreshPanel(service:Reservations,slack:SlackCall,resourceId:string,create=false) {
  const resource=(await service.resources()).find(r=>r.id===resourceId)??await service.resource(resourceId);
  const existing=await service.db.prepare('SELECT * FROM panel_messages WHERE resource_id=?').bind(resourceId).first<{channel_id:string;message_ts:string}>();
  const content=panel(resource,await service.list(resourceId),service.clock(),service.operationsChannel);
  if(existing && existing.channel_id!==resource.channel_id) {
    if(!create)throw new Error('panel_channel_changed');
    const response=await slack('chat.postMessage',{channel:resource.channel_id,...content});
    await service.db.prepare('UPDATE panel_messages SET channel_id=?,message_ts=?,updated_at=? WHERE resource_id=?').bind(resource.channel_id,response.ts,service.clock(),resourceId).run();
    await slack('chat.update',{channel:existing.channel_id,ts:existing.message_ts,text:`${resource.name}の予約案内`,blocks:[section(`${resource.name}の通知先を変更しました。`),{type:'section',text:{type:'mrkdwn',text:`今後の予約通知：<#${resource.channel_id}>\n予約操作：<#${service.operationsChannel}>`,verbatim:true}}]});
    return;
  }
  if(existing) {
    await slack('chat.update',{channel:resource.channel_id,ts:existing.message_ts,...content});
    await service.db.prepare('UPDATE panel_messages SET updated_at=? WHERE resource_id=?').bind(service.clock(),resourceId).run();
  }
  else {
    if(!create) throw new Error('panel_not_installed');
    const response=await slack('chat.postMessage',{channel:resource.channel_id,...content});
    await service.db.prepare('INSERT INTO panel_messages VALUES(?,?,?,?,?)').bind(resourceId,resource.channel_id,response.ts,service.clock(),service.clock()).run();
  }
}
export async function refreshOperations(service:Reservations,slack:SlackCall,create=false) {
  const channel=service.operationsChannel;
  if(!channel) throw new Error('operations_channel_not_configured');
  const now=service.clock();
  const savedPage=await service.db.prepare('SELECT equipment_page FROM operation_panels WHERE channel_id=?').bind(channel).first<{equipment_page:number}>();
  const content=service.scheduleOnly?schedulePanel(await service.resources()):operationPanel(await service.resources(),await service.list(null,null,now),now,savedPage?.equipment_page??0);
  const existing=await service.db.prepare('SELECT message_ts,state FROM operation_panels WHERE channel_id=?').bind(channel).first<{message_ts:string|null;state:string}>();
  if(existing?.message_ts) {
    await slack('chat.update',{channel,ts:existing.message_ts,...content});return;
  }
  if(!create) throw new Error('operations_panel_not_installed');
  const claim=await service.db.prepare("INSERT INTO operation_panels(channel_id,state,updated_at) VALUES(?,'posting',?) ON CONFLICT DO NOTHING RETURNING channel_id").bind(channel,service.clock()).first();
  if(!claim) throw new Error('operations_panel_installation_pending_or_uncertain');
  try {
    const result=await slack('chat.postMessage',{channel,...content});
    await service.db.prepare("UPDATE operation_panels SET message_ts=?,state='ready',updated_at=? WHERE channel_id=?").bind(result.ts,service.clock(),channel).run();
  } catch(error) {
    // No blind retry of a potentially accepted Slack post.
    await service.db.prepare("UPDATE operation_panels SET state='uncertain',updated_at=? WHERE channel_id=?").bind(service.clock(),channel).run();
    throw error;
  }
}
export async function refreshHistorical(service:Reservations,slack:SlackCall,resourceIds:string[],offset=0,limit?:number) {
  if(limit!==undefined&&(!Number.isInteger(limit)||limit<1||limit>5||resourceIds.length!==1||!Number.isSafeInteger(offset)||offset<0))throw new Error('invalid_history_page');
  const resources=await service.resources();let count=0,next_offset:number|null=null;const missing=new Set<string>();
  for(const id of resourceIds) {
    const resource=resources.find(r=>r.id===id);if(!resource)continue;
    const query="SELECT p.*,n.message_ts FROM processed_requests p JOIN notifications n USING(request_key) WHERE p.resource_id=? AND n.status='sent' AND n.message_ts IS NOT NULL ORDER BY p.processed_at,p.request_key";
    const rows=(await service.db.prepare(query+(limit===undefined?'':' LIMIT ? OFFSET ?')).bind(...(limit===undefined?[id]:[id,limit,offset])).all<Receipt&{message_ts:string}>()).results;
    if(limit!==undefined&&rows.length===limit)next_offset=offset+rows.length;
    for(const row of rows) {
      const c=JSON.parse(row.payload) as Change;const originalChannel=c.resource.channel_id;c.resource=resource;
      try {await slack('chat.update',{channel:originalChannel,ts:row.message_ts,...notification(row.operation,c,service.clock(),row.slack_user_id)});count++;}
      catch(error) {if(error instanceof Error&&error.message==='slack_message_not_found')missing.add(row.message_ts);else throw error;}
    }
    const latest=new Map(rows.map(r=>[r.reservation_id,r]));
    for(const row of latest.values())if(row.operation!=='created')try {await refreshOriginal(service,slack,row);}catch(error){if(!(error instanceof Error&&error.message==='slack_message_not_found'))throw error;}
  }
  return {updated:count,missing:missing.size,...(limit===undefined?{}:{next_offset})};
}
async function refreshOriginal(service:Reservations,slack:SlackCall,receipt:Receipt) {
  const original=await service.db.prepare(`SELECT p.payload,n.message_ts FROM processed_requests p JOIN notifications n USING(request_key)
    WHERE p.reservation_id=? AND p.operation='created' AND n.status='sent' AND n.message_ts IS NOT NULL ORDER BY p.processed_at LIMIT 1`).bind(receipt.reservation_id).first<{payload:string;message_ts:string}>();
  // Imported reservations may have no known original Slack message. Do not guess one.
  if(!original) return;
  const c=JSON.parse(original.payload) as Change;
  const originalChannel=c.resource.channel_id;
  c.resource=await service.resource(c.resource.id);
  for(let attempt=0;attempt<3;attempt++) {
    const current=await service.editable(receipt.reservation_id,receipt.slack_user_id);
    const ended=current.status==='active'&&current.end_at<=service.clock();
    const content=notification('created',c,service.clock());
    content.blocks=content.blocks.filter(b=>b.type!=='actions');
    content.blocks.unshift(section(current.status==='cancelled'?'❌ この予約はキャンセル済みです':ended?'✅ この設備の利用は終了しました':'✏️ この予約は変更されています。現在の内容は下記をご確認ください。'));
    content.blocks.push({type:'divider'},section(`【現在の状態】${current.status==='cancelled'?'キャンセル済み':ended?'利用終了':'予約中'}\n${detail(current,c.resource.type==='quantity_resource',true)}`));
    if(sharedSchedule(c.resource)){
      const latest=await service.db.prepare("SELECT slack_user_id,operation,processed_at FROM processed_requests WHERE reservation_id=? AND operation<>'created' ORDER BY processed_at DESC,rowid DESC LIMIT 1").bind(current.id).first<{slack_user_id:string;operation:string;processed_at:number}>();
      if(latest)content.blocks.push({type:'section',text:{type:'mrkdwn',text:`${latest.operation==='cancelled'?'キャンセルした人':'最終変更者'}：<@${latest.slack_user_id}>\n${localParts(latest.processed_at).date} ${localParts(latest.processed_at).time}（日本時間）`,verbatim:true}});
      content.blocks.push({type:'actions',elements:[{type:'button',text:plain('操作履歴'),action_id:'meeting_audit',value:current.id}]});
    }
    if(current.status==='active'&&!ended) content.blocks.push({type:'actions',elements:[editButton('変更','edit',current,c.resource),editButton('キャンセル','cancel',current,c.resource),...(!c.resource.schedule_event?[{type:'button',text:plain('今すぐ終了'),action_id:'finish',value:current.id,visible_to_user_ids:[current.slack_user_id]}]:[])]});
    if(current.status==='active'&&!ended&&!c.resource.schedule_event&&!isWashingBooking(current)&&current.start_at<service.clock())content.blocks.push({type:'actions',elements:[{type:'button',text:plain('あと30分'),action_id:'extend_30',value:current.id,visible_to_user_ids:[current.slack_user_id]},{type:'button',text:plain('あと1時間'),action_id:'extend_60',value:current.id,visible_to_user_ids:[current.slack_user_id]}]});
    content.text=`${current.status==='cancelled'?'キャンセル済み':ended?'利用終了':'変更済み'}：${c.resource.name}（予約ID：${current.id}）`;
    await slack('chat.update',{channel:originalChannel,ts:original.message_ts,...content});
    if((await service.owned(current.id,current.slack_user_id)).version===current.version) return;
  }
  throw new Error('original_notice_changed_concurrently');
}
export async function deliver(service:Reservations,slack:SlackCall,receipt:Receipt,refresh=true) {
  const db=service.db;
  const c=JSON.parse(receipt.payload) as Change;
  const claimed=await db.prepare("UPDATE notifications SET status='sending',attempted_at=? WHERE request_key=? AND status='pending' RETURNING request_key").bind(service.clock(),receipt.request_key).first();
  let notificationFailed=false;
  if(claimed) {
    try {
      const result=await slack('chat.postMessage',{channel:c.resource.channel_id,...notification(receipt.operation,c,service.clock(),receipt.slack_user_id)});
      await db.prepare("UPDATE notifications SET status='sent',message_ts=?,finished_at=? WHERE request_key=?").bind(result.ts,service.clock(),receipt.request_key).run();
    } catch(error) {
      notificationFailed=true;
      logFailure(receipt,'notification',error);
      try { await db.prepare("UPDATE notifications SET status='failed',error=?,finished_at=? WHERE request_key=?").bind(error instanceof Error?error.message.slice(0,500):'unknown',service.clock(),receipt.request_key).run(); }
      catch(dbError) { logFailure(receipt,'notification_status',dbError); }
    }
  } else {
    const state=await db.prepare('SELECT status FROM notifications WHERE request_key=?').bind(receipt.request_key).first<{status:string}>();
    notificationFailed=state?.status!=='sent';
  }
  let panelFailed=false;
  if(!refresh)return {notificationFailed,panelFailed};
  try { await refreshPanel(service,slack,c.resource.id); }
  catch(error) { panelFailed=true;logFailure(receipt,'panel',error); }
  if(service.operationsChannel) try { await refreshOperations(service,slack); }
  catch(error) { panelFailed=true;logFailure(receipt,'operations_panel',error); }
  if(receipt.operation!=='created') try { await refreshOriginal(service,slack,receipt); }
  catch(error) { panelFailed=true;logFailure(receipt,'original_notification',error); }
  return {notificationFailed,panelFailed};
}
