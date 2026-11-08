import {day,localParts,parseDate} from '../datetime';
import {button,notice,option,plain,section,timeInputs} from '../ui';
import type {SlackCall,SlackJSON} from '../types';
import {BookingError} from './reservations';

export interface ProfessorDay {id:string;start_date:string;end_date:string;start_at:number;end_at:number;all_day:number;title:string;notes:string;status:string;version:number;created_by:string;updated_by:string;created_at:number;updated_at:number}
export interface ProfessorInput {start_date:string;end_date:string;start_at:number;end_at:number;all_day:number;title:string;notes:string}
const field=(id:string,label:string,element:SlackJSON,optional=false)=>({type:'input',block_id:id,label:plain(label),element:{...element,action_id:id},optional});
const get=(v:SlackJSON,id:string)=>v.state?.values?.[id]?.[id]??{};
export function parseProfessor(view:SlackJSON):ProfessorInput {
  const start_date=get(view,'start_date').selected_date,end_date=get(view,'end_date').selected_date??start_date;
  const mode=get(view,'prof_mode').selected_option?.value;
  if(!['all_day','timed'].includes(mode))throw new BookingError('終日か時間指定を選択してください。','prof_mode');
  const all_day=mode==='all_day'?1:0;
  const time=(prefix:string)=>`${get(view,prefix+'_hour').selected_option?.value}:${get(view,prefix+'_minute').selected_option?.value}`;
  let start_at:number,end_at:number;
  try {start_at=parseDate(start_date,all_day?'00:00':time('start'));end_at=parseDate(end_date,all_day?'00:00':time('end'))+(all_day?day:0);}
  catch{throw new BookingError('日付と時刻を正しく選択してください。','start_date');}
  if(end_at<=start_at)throw new BookingError('終了は開始より後にしてください。','end_date');
  const title=(get(view,'title').value??'').trim()||'予定あり',notes=(get(view,'notes').value??'').trim();
  if(title.length>100)throw new BookingError('予定名は100文字以内で入力してください。','title');
  if(notes.length>500)throw new BookingError('備考は500文字以内で入力してください。','notes');
  return {start_date,end_date,start_at,end_at,all_day,title,notes};
}
async function existing(db:D1Database,id:string) {
  const row=await db.prepare('SELECT * FROM professor_days WHERE id=?').bind(id).first<ProfessorDay>();
  if(!row)throw new BookingError('予定が見つかりません。一覧を更新してください。');return row;
}
export async function changeProfessor(db:D1Database,user:string,key:string,op:'created'|'updated'|'cancelled',id:string,version:number,input?:ProfessorInput,now=Date.now()) {
  if(!/^[A-Za-z0-9:_-]{1,150}$/.test(key)||!/^[A-Za-z0-9_-]{1,150}$/.test(id))throw new BookingError('操作を確認できません。');
  const replay=await db.prepare('SELECT event_id,slack_user_id,operation FROM professor_day_requests WHERE request_key=?').bind(key).first<{event_id:string;slack_user_id:string;operation:string}>();
  if(replay){if(replay.event_id!==id||replay.slack_user_id!==user||replay.operation!==op)throw new BookingError('操作を確認できません。');return;}
  const before=op==='created'?null:await existing(db,id);
  if(before&&(before.status!=='active'||before.version!==version))throw new BookingError('別の方が更新しました。一覧から開き直してください。');
  const data=op==='cancelled'?before!:input!;
  if(!data||!Number.isSafeInteger(data.start_at)||!Number.isSafeInteger(data.end_at)||data.end_at<=data.start_at||!data.title||data.title.length>100||data.notes.length>500)throw new BookingError('予定の内容を確認してください。');
  const after={...data,id,status:op==='cancelled'?'cancelled':'active',version:(before?.version??0)+1,created_by:before?.created_by??user,created_at:before?.created_at??now};
  try{await db.prepare('INSERT INTO professor_day_requests VALUES(?,?,?,?,?,?,?)').bind(key,id,op,user,version,JSON.stringify(after),now).run();}
  catch(error){
    const saved=await db.prepare('SELECT event_id,slack_user_id,operation FROM professor_day_requests WHERE request_key=?').bind(key).first<{event_id:string;slack_user_id:string;operation:string}>();
    if(saved?.event_id===id&&saved.slack_user_id===user&&saved.operation===op)return;
    if(String(error).includes('stale_professor_event'))throw new BookingError('別の方が更新しました。一覧から開き直してください。');throw error;
  }
}
export function professorForm(now:number,row?:ProfessorDay):SlackJSON {
  const date=localParts(now).date,mode=row?.all_day===0?'timed':'all_day';
  const choices=[option('終日・時間未定','all_day'),option('時間を指定する','timed')];
  const blocks:SlackJSON[]=[section('研究室メンバー全員が追加・変更・削除できます。'),
    field('start_date','開始日',{type:'datepicker',initial_date:row?.start_date??date}),
    field('end_date','終了日（複数日の場合・この日を含む）',{type:'datepicker',...(row?{initial_date:row.end_date}:{})},true),
    {...field('prof_mode','時刻',{type:'static_select',options:choices,initial_option:choices.find(o=>o.value===mode)}),dispatch_action:true}];
  if(mode==='timed')blocks.push(...timeInputs('start','開始時間',row?localParts(row.start_at).time:'09:00'),...timeInputs('end','終了時間',row?localParts(row.end_at).time:'18:00'));
  blocks.push(field('title','予定名',{type:'plain_text_input',max_length:100,...(row?{initial_value:row.title}:{placeholder:plain('会議・出張など（未入力なら「予定あり」）')})},true),field('notes','備考',{type:'plain_text_input',multiline:true,max_length:500,...(row?.notes?{initial_value:row.notes}:{})},true));
  return {type:'modal',title:plain(row?'予定を変更':'予定ある日を追加'),callback_id:'save_professor',submit:plain(row?'変更する':'追加する'),close:plain('戻る'),private_metadata:JSON.stringify({id:row?.id??crypto.randomUUID(),version:row?.version??0,op:row?'updated':'created',nonce:crypto.randomUUID()}),blocks};
}
const dateText=(r:ProfessorDay)=>r.all_day?`${r.start_date}${r.start_date===r.end_date?'':' ～ '+r.end_date}（終日・時間未定）`:`${r.start_date} ${localParts(r.start_at).time} ～ ${r.start_date===r.end_date?'':r.end_date+' '}${localParts(r.end_at).time}`;
const rowBlocks=(r:ProfessorDay):SlackJSON[]=>[section(`📅 ${dateText(r)}\n${r.title}${r.notes?'\n'+r.notes:''}`),{type:'actions',elements:[button('変更','prof_edit',r.id),button('削除','prof_cancel',r.id)]}];
async function rows(db:D1Database,now:number,all=false){return (await db.prepare("SELECT * FROM professor_days WHERE status='active' AND (?=1 OR end_at>?) ORDER BY start_at,id").bind(all?1:0,now).all<ProfessorDay>()).results;}
export async function professorPanel(db:D1Database,now=Date.now()) {
  const list=await rows(db,now);
  const blocks:SlackJSON[]=[{type:'header',text:plain('📅 担当教員先生が予定ある日')},section('予定ある日を共有します。誰でも予定の追加・変更・削除ができます。'),
    {type:'actions',elements:[button('📅 日付を選んで追加','prof_add','add','primary'),button('予定一覧・変更','prof_list','future'),button('最新に更新','prof_refresh','refresh')]},
    {type:'actions',elements:[button('Google・iOSカレンダー','prof_subscribe','subscribe'),button('カレンダーの同期状況','tools_sync','all')]}];
  for(const row of list.slice(0,6))blocks.push(...rowBlocks(row));
  if(!list.length)blocks.push(section('これからの予定はまだ登録されていません。'));
  if(list.length>6)blocks.push(section(`ほか${list.length-6}件は「予定一覧・変更」で確認できます。`));
  blocks.push({type:'context',elements:[plain(`最終更新：${localParts(now).date} ${localParts(now).time}（日本時間）`)]});
  return {text:'担当教員先生が予定ある日：予定の追加・変更',blocks};
}
export async function refreshProfessor(db:D1Database,slack:SlackCall,now=Date.now(),channel?:string,create=false) {
  let panel=await db.prepare("SELECT * FROM professor_panels WHERE id='kato'").first<{channel_id:string;message_ts:string|null;state:string}>();
  if(!panel&&!create)return;
  if(panel&&channel&&panel.channel_id!==channel)throw new Error('professor_panel_channel_mismatch');
  const content=await professorPanel(db,now);
  if(panel?.message_ts){await slack('chat.update',{channel:panel.channel_id,ts:panel.message_ts,...content});return;}
  if(!create||!channel||!/^C[A-Z0-9]+$/.test(channel))throw new Error('professor_panel_not_ready');
  const claim=await db.prepare("INSERT INTO professor_panels VALUES('kato',?,NULL,'posting',?) ON CONFLICT DO NOTHING RETURNING id").bind(channel,now).first();
  if(!claim)throw new Error('professor_panel_installation_pending_or_uncertain');
  try{const result=await slack('chat.postMessage',{channel,...content});await db.prepare("UPDATE professor_panels SET message_ts=?,state='ready',updated_at=? WHERE id='kato'").bind(result.ts,now).run();}
  catch(error){await db.prepare("UPDATE professor_panels SET state='uncertain',updated_at=? WHERE id='kato'").bind(now).run();throw error;}
}
async function listView(db:D1Database,now:number,all:boolean,page=0) {
  const list=await rows(db,now,all);page=Math.max(0,Math.min(page,Math.max(0,Math.ceil(list.length/7)-1)));
  const blocks:SlackJSON[]=[section(all?'過去を含む予定一覧です。全員が変更できます。':'これからの予定です。全員が変更できます。')];
  for(const row of list.slice(page*7,(page+1)*7))blocks.push(...rowBlocks(row));
  if(!list.length)blocks.push(section('該当する予定はありません。'));
  const controls=[button(all?'これからの予定':'過去も表示',all?'prof_future':'prof_all','list')];
  if(page>0)controls.push(button('前へ','prof_prev',String(page-1)));
  if((page+1)*7<list.length)controls.push(button('次へ','prof_next',String(page+1)));
  blocks.push({type:'actions',elements:controls});
  return {...notice('担当教員先生の予定',''),private_metadata:JSON.stringify({all,page}),blocks};
}
export async function professorAction(db:D1Database,slack:SlackCall,body:SlackJSON,now=Date.now()) {
  const a=body.actions[0];let view:SlackJSON;
  if(a.action_id==='prof_refresh'){await refreshProfessor(db,slack,now);return;}
  if(a.action_id==='prof_mode') {
    const old=body.view,mode=a.selected_option?.value;if(!['all_day','timed'].includes(mode))throw new BookingError('時刻の種類を選んでください。');
    view=Object.fromEntries(['type','title','submit','close','callback_id','private_metadata','blocks'].map(k=>[k,old[k]]));
    const meta=JSON.parse(old.private_metadata);meta.prof_times??={};
    for(const key of ['start_hour','start_minute','end_hour','end_minute']) {const value=get(old,key).selected_option?.value;if(value)meta.prof_times[key]=value;}
    view.private_metadata=JSON.stringify(meta);
    view.blocks=old.blocks.filter((b:SlackJSON)=>!['start_hour','start_minute','end_hour','end_minute'].includes(b.block_id)).map((b:SlackJSON)=>b.block_id==='prof_mode'?{...b,element:{...b.element,initial_option:option(mode==='timed'?'時間を指定する':'終日・時間未定',mode)}}:b);
    if(mode==='timed')view.blocks.splice(4,0,...timeInputs('start','開始時間',`${meta.prof_times.start_hour??'09'}:${meta.prof_times.start_minute??'00'}`),...timeInputs('end','終了時間',`${meta.prof_times.end_hour??'18'}:${meta.prof_times.end_minute??'00'}`));
    await slack('views.update',{view_id:old.id,hash:old.hash,view});return;
  }
  if(a.action_id==='prof_add')view=professorForm(now);
  else if(a.action_id==='prof_edit')view=professorForm(now,await existing(db,a.value));
  else if(a.action_id==='prof_cancel') {
    const row=await existing(db,a.value);view={...notice('予定の削除',`この予定を削除しますか？\n\n${dateText(row)}\n${row.title}`),callback_id:'cancel_professor',submit:plain('予定を削除'),close:plain('戻る'),private_metadata:JSON.stringify({id:row.id,version:row.version,op:'cancelled',nonce:crypto.randomUUID()})};
  }else {
    const meta=body.view?.private_metadata?JSON.parse(body.view.private_metadata):{};
    const all=a.action_id==='prof_all'||['prof_prev','prof_next'].includes(a.action_id)&&meta.all;
    view=await listView(db,now,Boolean(all),['prof_prev','prof_next'].includes(a.action_id)?Number(a.value):0);
    if(body.view?.type==='modal'){await slack('views.update',{view_id:body.view.id,hash:body.view.hash,view});return;}
  }
  await slack(body.view?.type==='modal'?'views.push':'views.open',{trigger_id:body.trigger_id,view});
}
export async function submitProfessor(db:D1Database,slack:SlackCall,body:SlackJSON,input?:ProfessorInput,now=Date.now()) {
  let view:SlackJSON;
  try{
    const meta=JSON.parse(body.view.private_metadata);
    await changeProfessor(db,body.user.id,meta.nonce,meta.op,meta.id,meta.version,input,now);
    let warning='';try{await refreshProfessor(db,slack,now);}catch{warning='\n\n⚠️ 保存は完了しましたが、チャンネルの一覧を更新できませんでした。「最新に更新」を押してください。';}
    view=notice('保存しました',(meta.op==='cancelled'?'予定を削除しました。':'予定を保存しました。')+warning);
  }catch(error){view=notice('保存できません',error instanceof BookingError?error.message:'保存状態を確認できませんでした。予定一覧を開き直して確認してください。');}
  await slack('views.update',{view_id:body.view.id,view});
}
