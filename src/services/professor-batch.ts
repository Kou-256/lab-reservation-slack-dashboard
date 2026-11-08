import {localParts,parseDate} from '../datetime';
import {button,notice,option,plain,section,timeInputs} from '../ui';
import type {SlackCall,SlackJSON} from '../types';
import {BookingError} from './reservations';
import {parseProfessor,refreshProfessor,type ProfessorInput} from './professor';

interface CalendarDraft {calendar_batch:true;id:string;nonce:string;month:string;dates:string[];mode:'all_day'|'timed';title:string;notes:string;times:Record<string,string>}
const field=(id:string,label:string,element:SlackJSON,optional=false)=>({type:'input',block_id:id,label:plain(label),element:{...element,action_id:id},optional});
const values=(v:SlackJSON,id:string)=>v.state?.values?.[id]?.[id]??{};
function draft(view?:SlackJSON,now=Date.now()):CalendarDraft {
  const saved=view?.private_metadata?JSON.parse(view.private_metadata):{};
  const m:CalendarDraft={calendar_batch:true,id:crypto.randomUUID(),nonce:crypto.randomUUID(),month:localParts(now).date.slice(0,7),dates:[],mode:'all_day',title:'',notes:'',times:{},...saved};
  if(view) {
    const selection=Object.values(view.state?.values??{}).map((b:any)=>b.prof_cal_selection).find(v=>v?.selected_options!==undefined);
    if(selection)m.dates=(selection.selected_options??[]).map((o:SlackJSON)=>o.value);
    for(const name of ['title','notes'] as const)if(values(view,name).value!==undefined)m[name]=values(view,name).value??'';
    const mode=values(view,'prof_mode').selected_option?.value;if(mode)m.mode=mode;
    for(const name of ['start_hour','start_minute','end_hour','end_minute']){const v=values(view,name).selected_option?.value;if(v)m.times[name]=v;}
  }
  return m;
}
export function professorCalendar(now=Date.now(),data?:CalendarDraft,error=''):SlackJSON {
  const m=data??draft(undefined,now);
  const blocks:SlackJSON[]=[section('カレンダーから日付を選ぶたびに追加します。飛び飛びの日や別の月の日も選べます。最後にまとめて登録すると、1日ずつの単発予定になります。')];
  if(error)blocks.push(section('⚠️ '+error));
  blocks.push({...section('📅 日付を追加（何度でも選べます）'),accessory:{type:'datepicker',action_id:'prof_cal_date',placeholder:plain('カレンダーを開く')}});
  if(m.dates.length){const options=[...m.dates].sort().map(d=>option(d,d));
    blocks.push({...field('prof_cal_selection','選択した日（×で解除）',{type:'multi_static_select',options,initial_options:options,placeholder:plain('選択した日付')},true),block_id:'prof_selected_'+crypto.randomUUID(),dispatch_action:true});
  }
  blocks.push(section(m.dates.length?`選択中：${m.dates.length}日`:'まだ日付を選んでいません。'),
    {type:'actions',elements:[button('選択をすべて解除','prof_cal_clear','clear')]},
    {...field('prof_mode','各日の時刻',{type:'static_select',options:[option('終日・時間未定','all_day'),option('同じ時間帯を指定','timed')],initial_option:option(m.mode==='timed'?'同じ時間帯を指定':'終日・時間未定',m.mode)}),dispatch_action:true});
  if(m.mode==='timed')blocks.push(...timeInputs('start','開始時間',`${m.times.start_hour??'09'}:${m.times.start_minute??'00'}`),...timeInputs('end','終了時間',`${m.times.end_hour??'18'}:${m.times.end_minute??'00'}`));
  blocks.push(field('title','共通の予定名',{type:'plain_text_input',max_length:100,...(m.title?{initial_value:m.title}:{placeholder:plain('会議・出張など（未入力なら「予定あり」）')})},true),
    field('notes','共通の備考',{type:'plain_text_input',multiline:true,max_length:500,...(m.notes?{initial_value:m.notes}:{})},true));
  return {type:'modal',title:plain('予定日をまとめて追加'),callback_id:'save_professor_bulk',submit:plain('選んだ日を登録'),close:plain('戻る'),private_metadata:JSON.stringify(m),blocks};
}
export async function professorCalendarAction(slack:SlackCall,body:SlackJSON,now=Date.now()) {
  const a=body.actions[0];if(a.action_id.startsWith('prof_cal_blank_'))return;
  if(a.action_id==='prof_add'){await slack('views.open',{trigger_id:body.trigger_id,view:professorCalendar(now)});return;}
  const m=draft(body.view,now);let error='';
  if(a.action_id==='prof_cal_date') {
    parseDate(a.selected_date,'00:00');
    if(!m.dates.includes(a.selected_date)){
      if(m.dates.length>=90)error='1回の登録は90日までです。先に登録してから追加してください。';
      else m.dates.push(a.selected_date);
    }
  }else if(a.action_id==='prof_cal_selection')m.dates=(a.selected_options??[]).map((o:SlackJSON)=>o.value);
  else if(a.action_id.startsWith('prof_cal_pick_')) {
    parseDate(a.value,'00:00');
    if(m.dates.includes(a.value))m.dates=m.dates.filter(d=>d!==a.value);
    else if(m.dates.length>=90)error='1回の登録は90日までです。先に登録してから追加してください。';
    else m.dates.push(a.value);
  }else if(a.action_id==='prof_cal_clear')m.dates=[];
  else if(a.action_id==='prof_mode')m.mode=a.selected_option?.value;
  else if(a.action_id==='prof_cal_today')m.month=localParts(now).date.slice(0,7);
  else if(['prof_cal_prev','prof_cal_next'].includes(a.action_id)) {
    const d=new Date(m.month+'-01T12:00:00Z');d.setUTCMonth(d.getUTCMonth()+(a.action_id==='prof_cal_prev'?-1:1));m.month=d.toISOString().slice(0,7);
  }
  await slack('views.update',{view_id:body.view.id,hash:body.view.hash,view:professorCalendar(now,m,error)});
}
export function parseProfessorDates(view:SlackJSON):ProfessorInput[] {
  const m=draft(view),dates=[...new Set(m.dates)].sort();
  if(!dates.length)throw new BookingError('カレンダーの日付を1日以上選んでください。','calendar_dates');
  if(dates.length>90)throw new BookingError('1回の登録は90日までです。','calendar_dates');
  return dates.map(date=>{
    const state:SlackJSON={...view.state?.values,start_date:{start_date:{selected_date:date}},end_date:{end_date:{selected_date:date}},
      prof_mode:{prof_mode:{selected_option:{value:m.mode}}},title:{title:{value:m.title}},notes:{notes:{value:m.notes}}};
    for(const key of ['start_hour','start_minute','end_hour','end_minute'])state[key]={[key]:{selected_option:{value:m.times[key]??(key==='start_hour'?'09':key==='end_hour'?'18':'00')}}};
    return parseProfessor({state:{values:state}});
  });
}
export function professorDateError(view:SlackJSON,message:string,now=Date.now()){return professorCalendar(now,draft(view,now),message);}
export async function saveProfessorDates(db:D1Database,user:string,key:string,baseId:string,inputs:ProfessorInput[],now=Date.now()) {
  if(!/^[A-Za-z0-9:_-]{1,130}$/.test(key)||!/^[A-Za-z0-9_-]{1,100}$/.test(baseId)||!inputs.length||inputs.length>90)throw new BookingError('選択内容を確認してください。');
  const unique=new Set<string>();
  for(const input of inputs) {
    parseDate(input.start_date,'00:00');
    if(input.start_date!==input.end_date||unique.has(input.start_date)||!Number.isSafeInteger(input.start_at)||!Number.isSafeInteger(input.end_at)||input.end_at<=input.start_at||input.title.length>100||input.notes.length>500)throw new BookingError('日付ごとの予定を確認してください。');
    unique.add(input.start_date);
  }
  const items=inputs.map(input=>({...input,id:baseId+'_'+input.start_date,status:'active',version:1,created_by:user,created_at:now}));
  try{await db.prepare('INSERT INTO professor_day_batches VALUES(?,?,?,?,?)').bind(key,baseId,user,JSON.stringify(items),now).run();return inputs.length;}
  catch(error){const saved=await db.prepare('SELECT base_id,slack_user_id,json_array_length(payload) AS count FROM professor_day_batches WHERE request_key=?').bind(key).first<{base_id:string;slack_user_id:string;count:number}>();
    if(saved?.base_id===baseId&&saved.slack_user_id===user)return saved.count;throw error;}
}
export async function submitProfessorDates(db:D1Database,slack:SlackCall,body:SlackJSON,inputs:ProfessorInput[],now=Date.now()) {
  let view:SlackJSON;
  try{const m=JSON.parse(body.view.private_metadata),count=await saveProfessorDates(db,body.user.id,m.nonce,m.id,inputs,now);
    let warning='';try{await refreshProfessor(db,slack,now);}catch{warning='\n\n⚠️ 保存は完了しましたが、一覧を更新できませんでした。「最新に更新」を押してください。';}
    view=notice('登録しました',`${count}日分を、それぞれ単発の予定として登録しました。変更・削除は予定一覧から行えます。${warning}`);
  }catch(error){view=notice('保存できません','予定を保存できませんでした。予定一覧を確認してから、もう一度選択してください。');}
  await slack('views.update',{view_id:body.view.id,view});
}
