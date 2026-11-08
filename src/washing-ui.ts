import {day,localParts,parseDate} from './datetime';
import {button,detail,notice,option,plain,section,timeInputs} from './ui';
import type {Booking,Env,Resource,SlackCall,SlackJSON} from './types';
import {BookingError,Reservations} from './services/reservations';
import {reserveWash} from './services/washing';
import {memberName} from './services/member-names';
import {deliver,refreshPanel,refreshOperations} from './services/notifications';
import {syncGooglePending} from './services/google-calendar';

const input=(id:string,label:string,element:SlackJSON,optional=false)=>({type:'input',block_id:id,label:plain(label),element:{...element,action_id:id},optional});
const get=(v:SlackJSON,key:string,fallback='')=>{const s=v.state?.values?.[key]?.[key];return s?s.value??s.selected_option?.value??s.selected_date??'':fallback;};
const keys=['wash_count','wash_pool','wash_quantity','wash_sample',...['wash1','wash2'].flatMap(p=>[`${p}_start_date`,`${p}_end_date`,`${p}_start_hour`,`${p}_start_minute`,`${p}_end_hour`,`${p}_end_minute`])];
export function washForm(r:Resource,now:number,old?:SlackJSON,action?:SlackJSON) {
  const prior=old?JSON.parse(old.private_metadata):{resource:r.id,nonce:crypto.randomUUID(),draft:{}};
  const draft:Record<string,string>={...prior.draft};
  if(old)for(const k of keys)if(old.state?.values?.[k])draft[k]=get(old,k);
  if(action?.action_id==='wash_count')draft.wash_count=action.selected_option.value;
  const tomorrow=localParts(now+day).date,date1=draft.wash1_start_date||tomorrow;
  if(action?.action_id==='wash_gap'){
    const days=Number(action.selected_option.value);if(!Number.isInteger(days)||days<1||days>30)throw new BookingError('日数を選択してください。');
    const oldStart=parseDate(draft.wash2_start_date||date1,'00:00'),oldEnd=parseDate(draft.wash2_end_date||draft.wash2_start_date||date1,'00:00');
    const duration=Math.max(0,oldEnd-oldStart),start=parseDate(date1,'00:00')+days*day;
    draft.wash2_start_date=localParts(start).date;draft.wash2_end_date=localParts(start+duration).date;
  }
  const count=draft.wash_count==='2'?2:1,pools=r.pools??[];
  const blocks:SlackJSON[]=[section(`${r.name}\n洗浄する時間帯だけ予約します。間の日数は確保しません。1回だけで終わる場合は「1回だけ」で登録できます。`),
    {...input('wash_count','洗浄の回数',{type:'static_select',options:[option('1回だけ','1'),option('2回セット','2')],initial_option:option(count===1?'1回だけ':'2回セット',String(count))}),dispatch_action:true},
    input('wash_pool','使用場所',{type:'static_select',options:pools.map(p=>option(`${p.name}（${p.capacity}台）`,p.id)),...(draft.wash_pool&&pools.some(p=>p.id===draft.wash_pool)?{initial_option:option(`${pools.find(p=>p.id===draft.wash_pool)!.name}（${pools.find(p=>p.id===draft.wash_pool)!.capacity}台）`,draft.wash_pool)}:{})}),
    input('wash_quantity','使用台数',{type:'static_select',options:Array.from({length:Math.min(100,r.capacity??1)},(_,i)=>option(`${i+1}台`,String(i+1))),initial_option:option(`${draft.wash_quantity||'1'}台`,draft.wash_quantity||'1')})];
  for(let i=1;i<=count;i++){
    const prefix=`wash${i}`,start=draft[`${prefix}_start_date`]||(i===1?date1:localParts(parseDate(date1,'00:00')+3*day).date),end=draft[`${prefix}_end_date`]||start;
    blocks.push({type:'divider'},section(`${i}回目の洗浄`));
    if(i===2)blocks.push({type:'actions',elements:[{type:'static_select',action_id:'wash_gap',placeholder:plain('1回目から何日後にするか選択'),options:Array.from({length:30},(_,n)=>option(`${n+1}日後`,String(n+1)))}]},section('初期値は1回目の3日後です。日付・時刻は自由に変更できます。'));
    blocks.push(input(`${prefix}_start_date`,'開始日',{type:'datepicker',initial_date:start}),...timeInputs(`${prefix}_start`,'開始時間',`${draft[`${prefix}_start_hour`]||'09'}:${draft[`${prefix}_start_minute`]||'00'}`),
      input(`${prefix}_end_date`,'終了日',{type:'datepicker',initial_date:end}),...timeInputs(`${prefix}_end`,'終了時間',`${draft[`${prefix}_end_hour`]||'11'}:${draft[`${prefix}_end_minute`]||'00'}`));
    // Remember generated defaults when fields are temporarily hidden by the count switch.
    for(const [k,value] of Object.entries({[`${prefix}_start_date`]:start,[`${prefix}_end_date`]:end,[`${prefix}_start_hour`]:'09',[`${prefix}_start_minute`]:'00',[`${prefix}_end_hour`]:'11',[`${prefix}_end_minute`]:'00'}))if(!draft[k])draft[k]=value;
  }
  blocks.push(input('wash_sample','試料名・備考',{type:'plain_text_input',max_length:120,...(draft.wash_sample?{initial_value:draft.wash_sample}:{})},true),section('2回セットで予約した後でも、2回目が不要になれば「予約変更・キャンセル」から2回目だけを取り消せます。'));
  return {type:'modal',title:plain('スターラーの洗浄を予約'),callback_id:'save_wash',submit:plain(count===1?'1回分を予約':'2回分を予約'),close:plain('戻る'),private_metadata:JSON.stringify({...prior,draft}),blocks};
}
export function washBookings(v:SlackJSON):Booking[]{
  const m=JSON.parse(v.private_metadata),value=(k:string)=>get(v,k,m.draft?.[k]??''),count=Number(value('wash_count')||'1');
  if(![1,2].includes(count))throw new BookingError('洗浄は1回または2回を選択してください。');
  const pool_id=value('wash_pool'),quantity=Number(value('wash_quantity')||'1'),sample=value('wash_sample');
  if(!pool_id)throw new BookingError('使用場所を選択してください。');if(sample.length>120)throw new BookingError('試料名・備考は120文字以内で入力してください。');
  return Array.from({length:count},(_,index)=>{
    const p=`wash${index+1}`;let start_at:number,end_at:number;
    try{start_at=parseDate(value(`${p}_start_date`),`${value(`${p}_start_hour`)}:${value(`${p}_start_minute`)}`);end_at=parseDate(value(`${p}_end_date`),`${value(`${p}_end_hour`)}:${value(`${p}_end_minute`)}`);}catch{throw new BookingError(`${index+1}回目の日付と時刻を選択してください。`);}
    return {start_at,end_at,quantity,pool_id,purpose:`洗浄（${index+1}回目）${sample?'：'+sample:''}`,purpose_choice:''};
  });
}
export async function washAction(service:Reservations,slack:SlackCall,body:SlackJSON){
  const a=body.actions[0],meta=body.view?.callback_id==='save_wash'?JSON.parse(body.view.private_metadata):null;
  const r=await service.resource(meta?.resource??a.value);
  if(!r.enabled||!r.pools?.length)throw new BookingError('場所別スターラーを選択してください。');
  const view=washForm(r,service.clock(),meta?body.view:undefined,a);
  if(meta)await slack('views.update',{view_id:body.view.id,hash:body.view.hash,view});
  else await slack(body.view?.type==='modal'?'views.push':'views.open',{trigger_id:body.trigger_id,view});
}
export async function submitWash(service:Reservations,slack:SlackCall,body:SlackJSON,env?:Env){
  const v=body.view,m=JSON.parse(v.private_metadata),target=body.completion_external_id?{external_id:body.completion_external_id}:{view_id:v.id};
  const complete=async(text:string)=>{for(let i=0;i<3;i++)try{const view:SlackJSON=notice('洗浄の予約',text);if(text.startsWith('✅'))view.blocks.push(section('利用中の洗浄は、自分の予約・設備パネル・チャンネル通知の「今すぐ終了」から、1回ごとに終了できます。'),{type:'actions',elements:[button('自分の予約を見る','hub_mine','all')]});await slack('views.update',{...target,view:{...view,...(body.completion_external_id?{external_id:body.completion_external_id}:{}),private_metadata:JSON.stringify({origin_channel:service.operationsChannel})}});return;}catch(e){if(i===2)throw e;await new Promise(r=>setTimeout(r,300*(i+1)));}};
  let receipts;
  try{const bookings=washBookings(v),name=await memberName(service.db,slack,body.user.id);receipts=await reserveWash(service,body.user.id,name,m.nonce,m.resource,bookings);}
  catch(error){await complete(error instanceof BookingError?error.message:'予約できませんでした。一覧を確認してから再度お試しください。');return;}
  const message=`✅ 洗浄を${receipts.length}回分予約しました。${receipts.length===2?'\n2回目が不要になった場合は、2回目だけをキャンセルできます。':''}`;
  await complete(message);
  let failed=false;for(const receipt of receipts)try{const sent=await deliver(service,slack,receipt,false);failed ||= sent.notificationFailed;}catch{failed=true;}
  try{await refreshPanel(service,slack,m.resource);await refreshOperations(service,slack);}catch{failed=true;}
  if(env)try{await syncGooglePending(env,2);}catch{}
  if(failed)await complete(message+'\n⚠️ 予約は保存済みです。チャンネル通知・パネルの更新を確認できませんでした。一覧で予約内容を確認してください。');
}
