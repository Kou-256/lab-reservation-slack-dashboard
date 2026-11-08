import type {Env,Resource,SlackCall,SlackJSON} from './types';
import {button,notice,option,plain,section,operationPanel} from './ui';
import {BookingError,Reservations} from './services/reservations';
import {changeResource,type ResourceInput} from './services/resources';
import {refreshHistorical,refreshOperations,refreshPanel} from './services/notifications';
import {syncGooglePending} from './services/google-calendar';

const field=(id:string,label:string,element:SlackJSON,optional=false)=>({type:'input',block_id:id,label:plain(label),element:{...element,action_id:id},optional});
const picked=(v:SlackJSON,id:string,fallback:any='')=>{const s=v.state?.values?.[id]?.[id];return s?s.value??s.selected_option?.value??s.selected_conversation??'':fallback;};
export async function resourceManagement(service:Reservations,page=0) {
  const rows=(await service.resources()).filter(r=>!r.schedule_event).sort((a,b)=>b.enabled-a.enabled||a.name.localeCompare(b.name,'ja'));
  page=Math.max(0,Math.min(Number.isSafeInteger(page)?page:0,Math.max(0,Math.ceil(rows.length/6)-1)));
  const blocks:SlackJSON[]=[section('全メンバーが設備を追加・編集できます。削除しても過去の予約と既存予定は残ります。'),{type:'actions',elements:[button('＋ 設備を追加','res_add','new')]}];
  for(const r of rows.slice(page*6,page*6+6))blocks.push(section(`${r.icon||'🏠'} ${r.name}${r.enabled?'':'（削除済み）'}${r.type==='quantity_resource'?`\n総台数：${r.capacity??'未設定'}台`:''}`),
    {type:'actions',elements:r.enabled?[button('編集・移動','res_edit',r.id),button('削除','res_delete',r.id)]:[button('再登録する','res_restore',r.id)]});
  const controls=[button('更新','res_page',String(page))];if(page>0)controls.push(button('前へ','res_page_prev',String(page-1)));if(page*6+6<rows.length)controls.push(button('次へ','res_page_next',String(page+1)));
  blocks.push({type:'actions',elements:controls});
  return {...notice('設備を追加・編集',''),callback_id:'resource_management',private_metadata:JSON.stringify({page}),blocks};
}
export function resourceForm(r?:Resource,old?:SlackJSON) {
  const create=!r,meta=old?JSON.parse(old.private_metadata):{id:r?.id??'equipment_'+crypto.randomUUID(),revision:r?.revision??-1,create,nonce:crypto.randomUUID()};
  const parts=r?.name.match(/^(.*)\(([^()]*)\)$/),get=(id:string,fallback:any)=>old?picked(old,id,fallback):fallback;
  const type=create?get('res_type','exclusive_room'):r.type;
  const text=(id:string,label:string,initial:string,max=70)=>field(id,label,{type:'plain_text_input',max_length:max,...(get(id,initial)?{initial_value:get(id,initial)}:{})});
  const channel=get('res_channel',r?.channel_id??'');
  const blocks:SlackJSON[]=[section('設備名と部屋を入力すると「設備名(部屋)」で表示します。通知先のチャンネルにはlab-reservationを追加してください。'),
    text('res_label','設備名',r?.equipment_label||parts?.[1]||r?.name||''),text('res_room','設置場所・部屋',r?.room||parts?.[2]||'',60),
    field('res_channel','通知先チャンネル',{type:'conversations_select',filter:{include:['public','private'],exclude_external_shared_channels:true},...(channel?{initial_conversation:channel}:{})}),
    ...(create?[{...field('res_type','予約方式',{type:'static_select',options:[option('1台・1部屋を占有','exclusive_room'),option('複数台を数えて予約','quantity_resource')],initial_option:option(type==='quantity_resource'?'複数台を数えて予約':'1台・1部屋を占有',type)}),dispatch_action:true}]:[section(`予約方式：${type==='quantity_resource'?'複数台を数えて予約':'1台・1部屋を占有'}`)]),
    ...(type==='quantity_resource'?(r?.pools?.length?r.pools.map(p=>text('res_pool_'+p.id,p.name+'の台数',String(p.capacity),4)):[text('res_capacity','総台数（1〜1000）',String(r?.capacity??1),4)]):[]),
    field('res_days','予約できる期間',{type:'static_select',options:[option('日をまたぐ予約も可能','1'),option('同じ日だけ','0')],initial_option:option(get('res_days',String(r?.multi_day??1))==='1'?'日をまたぐ予約も可能':'同じ日だけ',get('res_days',String(r?.multi_day??1)))}),
    field('res_icon','アイコン（絵文字・任意）',{type:'plain_text_input',max_length:20,...(get('res_icon',r?.icon??'')?{initial_value:get('res_icon',r?.icon??'')}:{})},true)];
  return {type:'modal',title:plain(create?'設備を追加':'設備を編集・移動'),callback_id:'save_resource',submit:plain(create?'追加する':'保存する'),close:plain('戻る'),private_metadata:JSON.stringify(meta),blocks};
}
export async function resourceAction(service:Reservations,slack:SlackCall,body:SlackJSON) {
  const a=body.actions[0];let view:SlackJSON;
  if(a.action_id==='res_panel') {
    const page=Number(a.value);if(!Number.isSafeInteger(page)||page<0)return;
    if(body.view?.type==='home'){await slack('views.publish',{user_id:body.user.id,view:{type:'home',blocks:operationPanel(await service.resources(),await service.list(),service.clock(),page).blocks}});return;}
    await service.db.prepare('UPDATE operation_panels SET equipment_page=? WHERE channel_id=?').bind(page,service.operationsChannel).run();
    await refreshOperations(service,slack);return;
  }
  if(a.action_id==='res_type'){await slack('views.update',{view_id:body.view.id,hash:body.view.hash,view:resourceForm(undefined,body.view)});return;}
  if(a.action_id==='res_manage'||a.action_id.startsWith('res_page'))view=await resourceManagement(service,Number(a.value)||0);
  else if(a.action_id==='res_add')view=resourceForm();
  else {
    const r=await service.resource(a.value);if(r.schedule_event)throw new BookingError('設備を選択してください。');
    if(a.action_id==='res_edit')view=resourceForm(r);
    else {const remove=a.action_id==='res_delete';const count=(await service.list(r.id)).length;
      view={...notice(remove?'設備を削除しますか？':'設備を再登録しますか？',`${r.name}\n${remove?`新しい予約を停止し、設備パネルから外します。\n既存の予約：${count}件（自動キャンセルしません）。\n予約履歴は残り、あとで再登録できます。`:'新しい予約を受け付けます。'}`),callback_id:'save_resource',submit:plain(remove?'削除する':'再登録する'),close:plain('戻る'),private_metadata:JSON.stringify({id:r.id,revision:r.revision,operation:remove?'disabled':'restored',nonce:crypto.randomUUID()})};}
  }
  if(body.view?.type==='modal'&&(a.action_id==='res_manage'||a.action_id.startsWith('res_page')))await slack('views.update',{view_id:body.view.id,hash:body.view.hash,view});
  else await slack(body.view?.type==='modal'?'views.push':'views.open',{trigger_id:body.trigger_id,view});
}
export async function submitResource(service:Reservations,slack:SlackCall,body:SlackJSON,env?:Env) {
  const v=body.view,m=JSON.parse(v.private_metadata),target=body.completion_external_id?{external_id:body.completion_external_id}:{view_id:v.id};
  const complete=async(text:string)=>{for(let i=0;i<3;i++)try{await slack('views.update',{...target,view:{...notice('設備の設定',text),...(body.completion_external_id?{external_id:body.completion_external_id}:{}),blocks:[section(text),{type:'actions',elements:[button('設備の管理へ','res_manage','0')]}]}});return;}catch(e){if(i===2)throw e;await new Promise(r=>setTimeout(r,300*(i+1)));}};
  let change;
  try{
    const old=m.create?undefined:await service.resource(m.id),type=m.create?picked(v,'res_type'):old!.type;
    const input:ResourceInput={equipment_label:picked(v,'res_label'),room:picked(v,'res_room'),channel_id:picked(v,'res_channel'),type,
      capacity:type==='quantity_resource'?(old?.pools?.length?old.pools.reduce((n,p)=>n+Number(picked(v,'res_pool_'+p.id)),0):Number(picked(v,'res_capacity'))):1,pool_capacities:old?.pools?.map(p=>({id:p.id,capacity:Number(picked(v,'res_pool_'+p.id))})),multi_day:Number(picked(v,'res_days')),icon:picked(v,'res_icon')};
    change=await changeResource(service,body.user.id,m.nonce,m.id,m.operation??(m.create?'created':'updated'),m.revision,m.operation?undefined:input);
  }catch(error){await complete(error instanceof BookingError?error.message:'保存できませんでした。管理画面から再度お試しください。');return;}
  await complete('✅ 設備の設定を保存しました。パネルとカレンダーを更新しています。');
  const warnings:string[]=[];
  try{await refreshOperations(service,slack);}catch{warnings.push('設備パネルの更新は次の自動更新までお待ちください。');}
  try{const r=await service.resource(m.id);if(r.enabled)await refreshPanel(service,slack,r.id,true);
    else {const panel=await service.db.prepare('SELECT channel_id,message_ts FROM panel_messages WHERE resource_id=?').bind(r.id).first<{channel_id:string;message_ts:string}>();if(panel)await slack('chat.update',{channel:panel.channel_id,ts:panel.message_ts,text:`${r.name}は予約受付を終了しました。`,blocks:[section(`${r.name}は削除済みです。過去の予約は残っています。`)]});}
  }catch{warnings.push('通知先にlab-reservationが参加しているか確認してください。設備の設定は保存済みです。');}
  if(env)try{await syncGooglePending(env,2);}catch{warnings.push('Googleカレンダーは自動で再試行します。');}
  await complete('✅ 設備の設定を保存しました。'+(warnings.length?'\n'+warnings.join('\n'):''));
}
export async function refreshResourceHistory(service:Reservations,slack:SlackCall) {
  const job=await service.db.prepare('SELECT * FROM resource_display_sync ORDER BY updated_at LIMIT 1').first<{resource_id:string;desired_revision:number;offset:number}>();if(!job)return;
  const result=await refreshHistorical(service,slack,[job.resource_id],job.offset,1);
  if(result.next_offset===null)await service.db.prepare('DELETE FROM resource_display_sync WHERE resource_id=? AND desired_revision=?').bind(job.resource_id,job.desired_revision).run();
  else await service.db.prepare('UPDATE resource_display_sync SET offset=? WHERE resource_id=? AND desired_revision=?').bind(result.next_offset,job.resource_id,job.desired_revision).run();
}
