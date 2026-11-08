import { dateLabel, localParts, range } from './datetime';
import { purposeText, purposeMenu } from './purpose';
import { presenterNames, meetingRooms, hasPresenters, sharedSchedule } from './meeting';
import type { Change, Operation, Reservation, Resource, SlackJSON } from './types';
export const plain=(text:string)=>({type:'plain_text',text,emoji:true});
export const section=(text:string)=>({type:'section',text:plain(text)});
export const button=(text:string,action_id:string,value:string,style?:string)=>({type:'button',text:plain(text),action_id,value,...(style?{style}:{})});
export const ownerButton=(text:string,action_id:string,row:Reservation)=>({...button(text,action_id,row.id),visible_to_user_ids:[row.slack_user_id]});
export const editButton=(text:string,action_id:string,row:Reservation,r:Resource)=>sharedSchedule(r)?button(text,action_id,row.id):ownerButton(text,action_id,row);
export const isWashingBooking=(row:Pick<Reservation,'purpose'|'purpose_choice'>)=>/^洗浄(?:[（(][12１２]回目[）)]|[：:]|$)/.test(purposeText(row));
export const option=(text:string,value:string)=>({text:plain(text),value});
export const notice=(title:string,text:string)=>({type:'modal',title:plain(title),close:plain('閉じる'),blocks:[section(text)]});
export const detail=(r:Pick<Reservation,'start_at'|'end_at'|'quantity'|'purpose'|'purpose_choice'|'location'|'online_url'>,quantity:boolean,showEmpty=false)=>[
  quantity?`🧪 使用台数：${r.quantity}台`:'',`開始：${dateLabel(r.start_at)} ${localParts(r.start_at).time}\n終了：${dateLabel(r.end_at)} ${localParts(r.end_at).time}`,
  r.location?`📍 ${r.location}`:'',r.online_url?`🔗 ${r.online_url}`:'',purposeText(r)?`📝 ${purposeText(r)}`:showEmpty?'📝 用途：未入力':''
].filter(Boolean).join('\n');

// Rich-text text elements keep user input literal, including *, <@...> and URLs.
export function changedDetail(c:Change):SlackJSON {
  const before=c.before!,after=c.after,quantity=c.resource.type==='quantity_resource';
  const fields=(row:Reservation)=>[
    ...(quantity?[`🧪 使用台数：${row.quantity}台`]:[]),
    `開始：${dateLabel(row.start_at)} ${localParts(row.start_at).time}`,
    `終了：${dateLabel(row.end_at)} ${localParts(row.end_at).time}`,
    ...((before.location||after.location||before.pool_id||after.pool_id)?[`📍 場所：${row.location||'未設定'}`]:[]),
    ...((before.online_url||after.online_url)?[`🔗 オンラインURL：${row.online_url||'未入力'}`]:[]),
    `📝 用途：${purposeText(row)||'未入力'}`,
    ...(hasPresenters(c.resource)?[`担当者：${presenterNames(row)}`]:[])
  ];
  const previous=fields(before),next=fields(after);
  const elements:SlackJSON[]=[{type:'text',text:'【変更前】\n'}];
  const append=(lines:string[])=>lines.forEach((text,i)=>{
    const changed=previous[i]!==next[i];
    elements.push({type:'text',text:`${changed?'🔸変更 ':''}${text}\n`,...(changed?{style:{bold:true}}:{})});
  });
  append(previous);elements.push({type:'text',text:'\n↓\n\n【変更後】\n'});append(next);
  return {type:'rich_text',elements:[{type:'rich_text_section',elements}]};
}

export function notification(op:Operation,c:Change,now=Date.now(),actor?:string) {
  const quantity=c.resource.type==='quantity_resource';
  const title=c.finished?'✅ 設備の利用が終了しました':op==='created'?(quantity?`🧪 ${c.resource.name}の利用予定が登録されました`:'✅ 新しい予約が入りました'):
    op==='updated'?(quantity?`✏️ ${c.resource.name}の利用予定が変更されました`:'✏️ 予約が変更されました'):
    quantity?`❌ ${c.resource.name}の利用予定がキャンセルされました`:'❌ 予約がキャンセルされました';
  const eventTitle=op==='created'?'✅ 日程が登録されました':op==='updated'?'✏️ 日程が変更されました':'❌ 日程がキャンセルされました';
  const blocks:SlackJSON[]=[section(c.resource.schedule_event?eventTitle:title),section(`${c.resource.icon||(quantity?'🧪':'🏠')} ${c.resource.name}`),
    {type:'section',text:{type:'mrkdwn',text:`${sharedSchedule(c.resource)?'登録者':'予約者'}：<@${c.after.slack_user_id}>`,verbatim:true}}];
  if(sharedSchedule(c.resource)&&op!=='created'&&actor)blocks.push({type:'section',text:{type:'mrkdwn',text:`${op==='cancelled'?'キャンセルした人':'変更者'}：<@${actor}>`,verbatim:true}});
  if(hasPresenters(c.resource)&&op!=='updated')blocks.push(section(`担当者：${presenterNames(c.after)}`));
  if(op==='updated') blocks.push(changedDetail(c));
  else blocks.push(section(detail(c.after,quantity)));
  blocks.push({type:'context',elements:[plain(`予約ID：${c.after.id}`)]});
  if(c.after.status==='active'&&!c.finished&&c.after.end_at>now) blocks.push({type:'actions',elements:[editButton('変更','edit',c.after,c.resource),editButton('キャンセル','cancel',c.after,c.resource),...(!c.resource.schedule_event&&c.after.start_at<now?[ownerButton('今すぐ終了','finish',c.after)]:[])]});
  if(!c.resource.schedule_event&&!isWashingBooking(c.after)&&c.after.status==='active'&&c.after.start_at<now&&now<c.after.end_at&&!c.finished)blocks.push({type:'actions',elements:[ownerButton('あと30分','extend_30',c.after),ownerButton('あと1時間','extend_60',c.after)]});
  if(c.resource.schedule_event)blocks.push({type:'actions',elements:[...(c.after.status==='active'?[button('出欠を選ぶ・確認','meeting_record',c.after.id)]:[]),...(sharedSchedule(c.resource)?[button('操作履歴','meeting_audit',c.after.id)]:[])]});
  // User-entered text stays literal; only the authenticated ID becomes a mention.
  return {text:`${c.resource.schedule_event?eventTitle:title}：${c.resource.name}`,blocks,unfurl_links:false,unfurl_media:false};
}
const input=(id:string,label:string,element:SlackJSON,optional=false)=>({type:'input',block_id:id,label:plain(label),element:{...element,action_id:id},optional});
export const purposeInput=(value='')=>input('purpose','用途の内容',{type:'plain_text_input',max_length:300,...(value?{initial_value:value}:{})},true);
export const timeInputs=(prefix:string,label:string,time:string)=>[
  input(`${prefix}_hour`,`${label}（時）`,{type:'static_select',options:Array.from({length:24},(_,n)=>option(`${String(n).padStart(2,'0')}時`,String(n).padStart(2,'0'))),initial_option:option(`${time.slice(0,2)}時`,time.slice(0,2))}),
  input(`${prefix}_minute`,`${label}（分・1分単位）`,{type:'static_select',options:Array.from({length:60},(_,n)=>option(`${String(n).padStart(2,'0')}分`,String(n).padStart(2,'0'))),initial_option:option(`${time.slice(3,5)}分`,time.slice(3,5))})
];
export function bookingModal(resource:Resource,now:number,row?:Reservation,meta?:SlackJSON):SlackJSON {
  const start=localParts(row?.start_at??(Math.floor(now/3_600_000)+1)*3_600_000);
  const end=localParts(row?.end_at??(Math.floor(now/3_600_000)+2)*3_600_000);
  const choices:string[]=JSON.parse(resource.purpose_options);
  const freePurpose=choices.includes('自由入力');
  // Preserve legacy preset + supplemental text when reopening an existing booking.
  const choice=freePurpose&&(row?.purpose||row?.purpose_choice&&!choices.includes(row.purpose_choice))?'自由入力':row?.purpose_choice||(freePurpose?undefined:choices[0]);
  const blocks:SlackJSON[]=[section(resource.name),input('start_date','開始日',{type:'datepicker',initial_date:start.date}),
    ...timeInputs('start','開始時間',start.time)];
  if(row&&!resource.schedule_event&&row.status==='active'&&row.start_at<now&&now<row.end_at)blocks.splice(1,0,
    section('もう使い終わった場合は、日時を入力せず下のボタンで終了できます。入力中の変更は保存されません。'),
    {type:'actions',elements:[ownerButton('今すぐ終了','finish',row),...(!isWashingBooking(row)?[ownerButton('あと30分','extend_30',row),ownerButton('あと1時間','extend_60',row)]:[])]});
  if(row?.maintenance_warning)blocks.splice(1,0,section(row.maintenance_warning));
  if(resource.multi_day) blocks.push(input('end_date','終了日',{type:'datepicker',initial_date:end.date}));
  blocks.push(...timeInputs('end','終了時間',end.time));
  if(resource.schedule_event) {
    const rooms=meetingRooms;
    const selectedRoom=row?.location?(rooms.includes(row.location)?row.location:'その他'):undefined;
    blocks.push(input('location_choice','使用する部屋',{type:'static_select',options:rooms.map(x=>option(x,x)),...(selectedRoom?{initial_option:option(selectedRoom,selectedRoom)}:{})}));
    blocks.push(input('location_custom','その他の場所（その他を選んだ場合）',{type:'plain_text_input',max_length:150,...(selectedRoom==='その他'?{initial_value:row!.location}:{})},true));
    blocks.push(input('online_url','オンラインURL（オンラインの場合）',{type:'plain_text_input',max_length:1000,...(row?.online_url?{initial_value:row.online_url}:{})},true));
    if(hasPresenters(resource)) {
      const members=resource.members??[],assigned=(JSON.parse(row?.presenters??'[]') as {id:string}[]).map(p=>p.id);
      const options=[...members.map(p=>option(p.name,p.id)),option('未確定','undecided')];
      blocks.push(input('presenters','担当者（複数選択可・未確定でもOK）',{type:'checkboxes',options,initial_options:assigned.length?options.filter(o=>assigned.includes(o.value)):[options.at(-1)!]},true));
    }
  }
  if(resource.pools?.length)blocks.push(input('pool_id','使用場所',{type:'static_select',options:resource.pools.map(p=>option(`${p.name}（${p.capacity}台）`,p.id)),...(row?.pool_id?{initial_option:option(`${resource.pools.find(p=>p.id===row.pool_id)?.name??'使用場所'}（${resource.pools.find(p=>p.id===row.pool_id)?.capacity??0}台）`,row.pool_id)}:{})}));
  if(resource.type==='quantity_resource') {
    const capacity=resource.capacity??1;
    blocks.push(input('quantity','使用台数',capacity<=100?{type:'static_select',options:Array.from({length:capacity},(_,i)=>option(`${i+1}台`,String(i+1))),initial_option:option(`${row?.quantity??1}台`,String(row?.quantity??1))}:
      {type:'number_input',is_decimal_allowed:false,min_value:'1',max_value:String(capacity),initial_value:String(row?.quantity??1)}));
  }
  if(choices.length) blocks.push({...input('purpose_choice','用途',purposeMenu(choices,choice),freePurpose),dispatch_action:true});
  const purpose=row?purposeText(row):'';
  if(choices.length&&(choice==='自由入力'||choice==='その他'))blocks.push(purposeInput(choice==='自由入力'?purpose:row?.purpose??''));
  else if(!choices.length) blocks.push(input('purpose',resource.schedule_event?'発表内容・備考':'用途',{type:'plain_text_input',max_length:300,...(purpose?{initial_value:purpose}:{})},true));
  if(!resource.schedule_event)blocks.push({type:'context',block_id:'shared_purpose_hint',elements:[plain(choices.length>=9999?'選択肢の上限に達しています。自由入力した内容は今回の予約に保存します。':'自由入力した用途は、予約確定後にこの設備の共通の選択肢へ追加されます。')]});
  return {type:'modal',callback_id:'save_booking',title:plain(row?(resource.schedule_event?'日程を変更':'予約を変更'):(resource.schedule_event?'日程を登録':'予約する')),submit:plain(row?'変更する':resource.schedule_event?'登録する':'予約する'),close:plain('戻る'),
    private_metadata:JSON.stringify(meta??{resource:resource.id,reservation:row?.id,version:row?.version,nonce:crypto.randomUUID(),user_name:row?.slack_user_name}),blocks};
}
export function cancelModal(row:Reservation,resource:Resource,origin:SlackJSON={}):SlackJSON {
  return {...notice('予約のキャンセル',`この予約をキャンセルしますか？\n\n${resource.name}\n${detail(row,resource.type==='quantity_resource')}`),
    callback_id:'cancel_booking',submit:plain('予約をキャンセル'),close:plain('戻る'),
    private_metadata:JSON.stringify({resource:row.resource_id,reservation:row.id,version:row.version,nonce:crypto.randomUUID(),...origin})};
}
export function finishModal(row:Reservation,resource:Resource,now:number):SlackJSON {
  return {...notice('利用を終了',`この設備の利用を終了しますか？\n\n${resource.name}${resource.type==='quantity_resource'?`（${row.quantity}台）`:''}\n${detail(row,resource.type==='quantity_resource')}\n\n終了を確定すると、その時点の現在時刻に終了時間を変更します。残りの予約時間が空きになります。`),
    callback_id:'finish_booking',submit:plain('今すぐ終了する'),close:plain('戻る'),
    private_metadata:JSON.stringify({resource:row.resource_id,reservation:row.id,version:row.version,nonce:crypto.randomUUID()})};
}
export function listModal(rows:Reservation[],resources:Resource[],meta:SlackJSON):SlackJSON {
  const schedule=resources.length>0&&resources.every(r=>r.schedule_event);
  const periods=[['all','今後すべて'],['today','今日'],['tomorrow','明日'],['week','今週'],['next_week','来週']];
  const page=Math.max(0,Math.min(Number(meta.page)||0,Math.max(0,Math.ceil(rows.length/8)-1)));
  const blocks:SlackJSON[]=[{type:'actions',elements:[{type:'static_select',action_id:'list_period',options:periods.map(([v,t])=>option(t,v)),initial_option:option(periods.find(x=>x[0]===meta.period)?.[1]??'今後すべて',meta.period??'all')},button('更新','list_refresh','refresh')]}];
  const resourceOptions=[option(schedule?'すべての日程':'すべての設備','all'),...resources.map(r=>option(r.name,r.id))];
  blocks.unshift({type:'actions',elements:[{type:'static_select',action_id:'list_resource',options:resourceOptions,initial_option:resourceOptions.find(o=>o.value===meta.resource)??resourceOptions[0]}]});
  if(!schedule&&!meta.mine && meta.resource && meta.resource!=='all') blocks.push({type:'actions',elements:[button('希望日時の空きを確認','availability',meta.resource)]});
  for(const row of rows.slice(page*8,(page+1)*8)) {
    const resource=resources.find(r=>r.id===row.resource_id);
    blocks.push(section(`${resource?.name??row.resource_id}\n${detail(row,resource?.type==='quantity_resource')}${resource?.id==='biweekly_report'?'':'\n'+(resource?.schedule_event?'担当者：'+presenterNames(row):'予約者：'+row.slack_user_name)}`));
    if(row.maintenance_warning)blocks.push(section(row.maintenance_warning));
    if(meta.viewer===row.slack_user_id||resource&&sharedSchedule(resource)) blocks.push({type:'actions',elements:[editButton('変更','edit',row,resource!),editButton('キャンセル','cancel',row,resource!),...(!resource?.schedule_event&&row.start_at<(meta.now??Date.now())&&row.end_at>(meta.now??Date.now())?[ownerButton('今すぐ終了','finish',row)]:[])]});
    if(meta.viewer===row.slack_user_id&&!resource?.schedule_event)blocks.push({type:'actions',elements:[...(!isWashingBooking(row)&&row.start_at<(meta.now??Date.now())&&row.end_at>(meta.now??Date.now())?[ownerButton('あと30分','extend_30',row),ownerButton('あと1時間','extend_60',row)]:[]),ownerButton('この内容を再利用','tools_reuse_pick',row)]});
  }
  if(!rows.length) blocks.push(section('この期間の予約はありません。'));
  const nav=[];
  if(page>0) nav.push(button('前へ','list_prev',String(page-1)));
  if((page+1)*8<rows.length) nav.push(button('次へ','list_next',String(page+1)));
  if(nav.length) blocks.push({type:'actions',elements:nav});
  return {type:'modal',callback_id:'reservation_list',title:plain(schedule?(meta.mine?'👤 自分の日程':'📅 日程一覧'):(meta.mine?'👤 自分の予約':'📅 予約状況')),close:plain('閉じる'),private_metadata:JSON.stringify({...meta,page}),blocks};
}
export function panel(resource:Resource,rows:Reservation[],now:number,operationsChannel='') {
  const quantity=resource.type==='quantity_resource';
  const current=rows.filter(r=>r.start_at<=now&&now<r.end_at&&r.status==='active');
  const used=current.reduce((sum,r)=>sum+r.quantity,0);
  const blocks:SlackJSON[]=[section(`${resource.icon||(quantity?'🧪':'🏠')} ${resource.name} ${resource.schedule_event?'日程登録':quantity?'利用状況':'利用予約'}`)];
  if(quantity) {
    const offline=resource.maintenance_quantity??0;
    blocks.push(section(resource.capacity===null?'総台数が未設定です。管理者に設定を依頼してください。':`使用中：${used} / ${resource.capacity}台\n${offline?`故障・点検：${offline}台\n`:''}空き：${Math.max(0,resource.capacity-used-offline)}台`));
    if(resource.pools?.length)blocks.push(section(currentStatus(resource,rows,now)));
    for(const r of current.slice(0,15)) blocks.push(section(`${r.slack_user_name}　${r.quantity}台\n～ ${range(r.start_at,r.end_at).split('\n～ ')[1]}`));
    if(current.length>15) blocks.push(section('その他の利用者は「予約状況」で確認できます。'));
  } else blocks.push(section(operationsChannel?'このチャンネルには予約の登録・変更・キャンセルをお知らせします。':'下のボタンから予約できます。'));
  if(operationsChannel) blocks.push({type:'section',text:{type:'mrkdwn',text:`予約はこちら → <#${operationsChannel}>`,verbatim:true}});
  blocks.push({type:'actions',elements:operationsChannel?[
    button('📅 予約状況を見る','list',resource.id)
  ]:[button(quantity?'＋ 利用登録':'＋ 予約する','book',resource.id,'primary'),button('📅 予約状況を見る','list',resource.id),button('👤 自分の予約','mine',resource.id)]});
  blocks.push({type:'context',elements:[plain(`最終更新：${localParts(now).date} ${localParts(now).time}（日本時間）｜このメッセージをピン留めしてご利用ください。`)]});
  return {text:`${resource.name} 利用予約`,blocks};
}

const catalog:Record<string,[string,string]>={
  dark_room:['🔬 暗室・測定室A','暗室の利用予約'],
  cryostat:['❄️ クライオスタット-暗室測定室A','1台の利用予約'],
  sem_edx:['🔬 SEM/EDX-測定室D','1台の利用予約'],
  stirrer:['🧪 スターラー（秤量室・実験室B）','スターラーの台数・時間を予約'],
  furnace_blue:['🔥 電気炉(青) - 実験室C','1台の利用予約'],
  furnace_silver:['🔥 電気炉(銀) - 実験室B','1台の利用予約'],
  furnace_light_blue:['🔥 電気炉(水色) - 実験室B','1台の利用予約'],
  printer_3d:['🖨️ 3Dプリンタ','実験室C｜1台の利用予約'],
  centrifuge:['🌀 遠心分離機(実験室B)','1台の利用予約'],
    job_room:['📦 物置部屋・280室','部屋の利用予約'],
  storage_room:['🌫️ ミストCVD部屋・実験室C','部屋の利用予約']
};
export function currentStatus(resource:Resource,rows:Reservation[],now:number) {
  if(resource.maintenance_reason&&resource.type!=='quantity_resource')return `🔧 ${resource.maintenance_reason}`;
  const current=rows.filter(r=>r.resource_id===resource.id&&r.status==='active'&&r.start_at<=now&&now<r.end_at);
  if(resource.type==='quantity_resource') {
    const used=current.reduce((sum,r)=>sum+r.quantity,0);
    const offline=resource.maintenance_quantity??0;
    const pools=resource.pools??[],unknown=current.filter(r=>!r.pool_id).reduce((n,r)=>n+r.quantity,0);
    const places=pools.map(p=>{const assigned=current.filter(r=>r.pool_id===p.id).reduce((n,r)=>n+r.quantity,0);return `${p.name}：${assigned} / ${p.capacity}台使用・空き${Math.max(0,p.capacity-assigned-unknown-offline)}台`;});
    return resource.capacity===null?'総台数が未設定です':`使用中：${used} / ${resource.capacity}台\n${offline?`故障・点検：${offline}台\n`:''}空き：${Math.max(0,resource.capacity-used-offline)}台${places.length?'\n'+places.join('\n')+(unknown?'\n場所未設定：'+unknown+'台（両方の空き計算に含む）':''):''}`;
  }
  if(!current.length) return '空き';
  const r=current[0],start=localParts(r.start_at),end=localParts(r.end_at);
  const stamp=(p:ReturnType<typeof localParts>)=>`${p.date.slice(5).replace('-','/')} ${p.time}`;
  return `使用中：${start.date===end.date?`${start.time} ～ ${end.time}`:`${stamp(start)} ～ ${stamp(end)}`}`;
}
export function operationPanel(resources:Resource[],rows:Reservation[]=[],now=Date.now(),page=0) {
  const order=Object.keys(catalog);
  const blocks:SlackJSON[]=[{type:'header',text:plain('📅 研究室 設備予約システム')},section('使用する設備を選択してください。'),{type:'divider'}];
  const equipment=[...resources].filter(r=>r.enabled&&!r.schedule_event).sort((a,b)=>(order.indexOf(a.id)+1||99)-(order.indexOf(b.id)+1||99));
  page=Math.max(0,Math.min(page,Math.max(0,Math.ceil(equipment.length/12)-1)));
  for(const r of equipment.slice(page*12,page*12+12)) {
    const title=`${r.icon||catalog[r.id]?.[0]?.split(' ')[0]||'🏠'} ${r.name}`;
    const stopped=r.maintenance_id&&r.type!=='quantity_resource';
    const next=rows.filter(row=>row.resource_id===r.id&&row.status==='active'&&row.start_at>now).sort((a,b)=>a.start_at-b.start_at||a.id.localeCompare(b.id))[0];
    const stamp=(ms:number)=>{const p=localParts(ms);return `${p.date.slice(5).replace('-','/')} ${p.time}`;};
    const upcoming=next?`${stamp(next.start_at)} ～ ${localParts(next.start_at).date===localParts(next.end_at).date?localParts(next.end_at).time:stamp(next.end_at)}${r.type==='quantity_resource'?`・${next.quantity}台`:''}（${next.slack_user_name}）`:'なし';
    blocks.push(section(`${title}\n${currentStatus(r,rows,now)}\n次の予約：${upcoming}`));
    const controls:SlackJSON[]=[stopped?button(r.maintenance_kind==='fault'?'故障中・修理状況':'点検中・状況','maintenance_status',r.maintenance_id!):button('予約する','book',r.id),button('予約一覧・空き状況','list',r.id)];
    if(r.pools?.length&&!stopped)controls.push(button('🧼 洗浄を予約','wash_open',r.id));
    const users=[...new Set(rows.filter(row=>row.resource_id===r.id&&row.status==='active'&&row.start_at<now&&now<row.end_at).map(row=>row.slack_user_id))];
    if(users.length)controls.push({...button('今すぐ終了','finish_resource',r.id),visible_to_user_ids:users});
    if(r.maintenance_id&&r.type==='quantity_resource')controls.push(button('故障・点検の状況','maintenance_status',r.maintenance_id));
    blocks.push({type:'actions',elements:controls});
    blocks.push({type:'divider'});
  }
  if(equipment.length>12)blocks.push({type:'actions',elements:[...(page>0?[button('前の設備','res_panel',String(page-1))]:[]),...(page*12+12<equipment.length?[button('次の設備','res_panel',String(page+1))]:[])]});
  blocks.push({type:'actions',elements:[button('📅 予約一覧・空き状況','hub_list','all'),button('👤 予約変更・キャンセル','hub_mine','all'),button('最新に更新','refresh_status','all')]},
    {type:'actions',elements:[button('🗓️ 予約カレンダー','calendar_open','all'),button('Google・iOSカレンダー','calendar_subscribe','all'),button('🔧 設備の故障・点検','maintenance_manage','all')]},
    {type:'actions',elements:[button('予約を再利用','tools_reuse','all'),button('個人の通知設定','tools_reminders','self')]},
    {type:'actions',elements:[button('用途の選択肢を整理','tools_purposes','all'),button('カレンダーの同期状況','tools_sync','all'),button('設備を追加・編集','res_manage','0')]},
    {type:'context',elements:[plain(`最終更新：${localParts(now).date} ${localParts(now).time}（日本時間）｜約1分ごとに自動更新。予約結果は設備別チャンネルへお知らせします。`)]});
  return {text:'研究室 設備予約システム：設備を選んで予約できます。',blocks};
}
export function schedulePanel(resources:Resource[]) {
  const blocks:SlackJSON[]=[{type:'header',text:plain('📅 ゼミ・隔週報 日程登録')},section('登録する日程を選択してください。登録・変更・キャンセルはGoogleカレンダーにも反映します。'),{type:'divider'}];
  for(const r of resources.filter(r=>r.enabled&&r.schedule_event))blocks.push({...section(`${r.icon||'📖'} ${r.name}`),accessory:button('日程を登録','book',r.id)},{type:'divider'});
  blocks.push({type:'actions',elements:[button('📅 日程一覧','hub_list','all'),button('👤 自分の日程・変更','hub_mine','all'),button('最新に更新','refresh_status','all')]},{type:'actions',elements:[button('🗓️ カレンダー','calendar_open','all'),button('Google・iOSカレンダー','calendar_subscribe','all'),button('カレンダーの同期状況','tools_sync','all')]});
  blocks.push({type:'actions',elements:[button('英論ゼミ 担当履歴・回数','meeting_history','english_seminar'),button('出欠を選ぶ・確認','meeting_attendance','all'),button('操作履歴','meeting_audit','all')]});
  return {text:'ゼミ・隔週報 日程登録',blocks};
}
export function homeView(resources:Resource[],result?:string,rows:Reservation[]=[],now=Date.now()) {
  return {type:'home',blocks:[...(result?[section(result),{type:'divider'}]:[]),...operationPanel(resources,rows,now).blocks]};
}
export function availabilityModal(resource:Resource,now:number):SlackJSON {
  const view=bookingModal(resource,now);
  view.callback_id='check_availability';view.title=plain('空き状況を確認');view.submit=plain('確認する');
  view.blocks=view.blocks.filter((b:SlackJSON)=>!['purpose','purpose_choice','shared_purpose_hint'].includes(b.block_id));
  return view;
}
export function maintenanceDetail(p:{start_at:number;end_at:number|null;kind?:string;reason:string;quantity?:number|null}) {
  return `${p.kind==='fault'?'🔴 故障':'🔧 点検'}\n${p.quantity===null?'対象：全台\n':p.quantity?`対象：${p.quantity}台\n`:''}開始：${dateLabel(p.start_at)} ${localParts(p.start_at).time}\n${p.end_at===null?'終了：復旧まで（未定）':`終了：${dateLabel(p.end_at)} ${localParts(p.end_at).time}`}\n理由：${p.reason}`;
}
export function maintenanceModal(resource:Resource,now:number,kind?:'fault'|'inspection',meta?:SlackJSON) {
  const view=bookingModal({...resource,multi_day:1,schedule_event:0,type:'exclusive_room',purpose_options:'[]'},now);
  view.blocks=view.blocks.filter((b:SlackJSON)=>b.block_id!=='shared_purpose_hint');
  view.private_metadata=JSON.stringify({...JSON.parse(view.private_metadata),...meta,kind});
  view.title=plain('故障・点検を登録');view.submit=plain('登録する');view.callback_id='save_maintenance';
  const start=localParts(now);
  for(const b of view.blocks) {
    if(b.block_id==='start_date')b.element.initial_date=start.date;
    if(b.block_id==='start_hour')b.element.initial_option=option(`${start.time.slice(0,2)}時`,start.time.slice(0,2));
    if(b.block_id==='start_minute')b.element.initial_option=option(`${start.time.slice(3,5)}分`,start.time.slice(3,5));
  }
  const options=[option('故障（終了未定・復旧まで）','fault'),option('点検（期間を指定）','inspection')];
  view.blocks.splice(1,0,{...input('maintenance_kind','故障・点検の種類',{type:'static_select',options,...(kind?{initial_option:options.find(o=>o.value===kind)}:{}),placeholder:plain('故障または点検を選択')}),dispatch_action:true});
  if(resource.type==='quantity_resource'&&resource.capacity!==null)view.blocks.splice(2,0,input('maintenance_quantity','故障・点検の対象台数',{type:'static_select',options:Array.from({length:Math.min(resource.capacity,100)},(_,n)=>option(`${n+1}台`,String(n+1))),initial_option:option('1台','1')}));
  if(kind==='fault')view.blocks=view.blocks.filter((b:SlackJSON)=>!['end_date','end_hour','end_minute'].includes(b.block_id));
  const reason=view.blocks.find((b:SlackJSON)=>b.block_id==='purpose');reason.label=plain('状況・理由');reason.optional=false;
  if(kind==='fault')view.blocks.push(section(`終了日は不要です。復旧後に「利用再開」を押すまで、${resource.type==='quantity_resource'?'選んだ台数を利用可能数から差し引きます。':'この設備の予約を停止します。'}`));
  return view;
}
