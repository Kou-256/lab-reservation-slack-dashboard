import {scheduleAuditAction} from './schedule-audit';
import {localParts,parseDate} from '../datetime';
import {presenterNames,type Presenter} from '../meeting';
import {button,notice,option,plain,section} from '../ui';
import type {SlackCall,SlackJSON} from '../types';
import {BookingError,Reservations} from './reservations';

export interface Meeting {id:string;resource_id:string;reservation_id:string|null;session_date:string;state:string;presenters:string;notes:string;version:number}
const field=(id:string,label:string,element:SlackJSON,optional=false)=>({type:'input',block_id:id,label:plain(label),element:{...element,action_id:id},optional});
const value=(view:SlackJSON,id:string)=>view.state?.values?.[id]?.[id]??{};
export async function meetingById(service:Reservations,id:string) {
  const row=await service.db.prepare(`SELECT s.* FROM schedule_sessions s JOIN resources r ON r.id=s.resource_id WHERE (s.id=? OR s.reservation_id=?) AND r.schedule_event=1 AND (s.reservation_id IS NULL OR EXISTS(SELECT 1 FROM reservations b WHERE b.id=s.reservation_id AND b.status='active'))`).bind(id,id).first<Meeting>();
  if(!row)throw new BookingError('日程が見つかりません。一覧を更新してください。');return row;
}
async function members(service:Reservations) {return (await service.db.prepare('SELECT slack_user_id AS id,name FROM member_names ORDER BY name').all<Presenter>()).results;}
export async function presenterCounts(service:Reservations,date=localParts(service.clock()).date) {
  return (await service.db.prepare(`SELECT m.slack_user_id AS id,m.name,
    count(DISTINCT CASE WHEN s.session_date<=? THEN s.session_date END) AS count,
    count(DISTINCT s.session_date) AS total FROM member_names m
    LEFT JOIN schedule_sessions s ON s.resource_id='english_seminar' AND s.state='held'
      AND (s.reservation_id IS NULL OR EXISTS(SELECT 1 FROM reservations b WHERE b.id=s.reservation_id AND b.status='active'))
      AND EXISTS(SELECT 1 FROM json_each(s.presenters) p WHERE json_extract(p.value,'$.id')=m.slack_user_id)
    GROUP BY m.slack_user_id,m.name ORDER BY m.name`).bind(date).all<{id:string;name:string;count:number;total:number}>()).results;
}
export async function meetingList(service:Reservations,history:boolean,page=0) {
  const rows=(await service.db.prepare(`SELECT s.* FROM schedule_sessions s WHERE (?=0 OR resource_id='english_seminar')
    AND (s.reservation_id IS NULL OR EXISTS(SELECT 1 FROM reservations b WHERE b.id=s.reservation_id AND b.status='active'))
    ORDER BY session_date DESC,id`).bind(history?1:0).all<Meeting>()).results;
  page=Math.max(0,Math.min(page,Math.max(0,Math.ceil(rows.length/6)-1)));
  const meta={meeting_history:history,page,origin_channel:service.operationsChannel};
  const blocks:SlackJSON[]=[];
  if(history) {
    const counts=await presenterCounts(service);
    blocks.push(section('担当回数：予定を含む合計（今日まで）\n開催あり・同日の同じ人は1回\n'+counts.map(c=>`${c.name}：${c.total}回（${c.count}回）`).join('\n')));
    const rotation=await service.db.prepare("SELECT value FROM schedule_settings WHERE key='english_rotation'").first<{value:string}>();
    if(rotation)blocks.push(section('担当の順番\n'+rotation.value));
    blocks.push(section('過去・今後の担当履歴です。全員が担当者・開催状態・備考を編集できます。'));
  } else blocks.push(section('日程を選び、出席・欠席・未定を押してください。出欠変更の通知は送りません。'));
  for(const s of rows.slice(page*6,(page+1)*6)) {
    const label=s.state==='not_held'?'開催なし':presenterNames(s);
    blocks.push(section(`${s.session_date}　${s.resource_id==='english_seminar'?'英論ゼミ\n担当者：'+label:'隔週報'}${s.notes?'\n'+s.notes:''}`),
      {type:'actions',elements:[button(history?'担当・履歴を編集':'出欠を選ぶ・確認',history?'meeting_edit':'meeting_record',s.id)]});
  }
  if(!rows.length)blocks.push(section('登録された日程はありません。'));
  const controls=[button('更新',history?'meeting_history':'meeting_attendance','all')];
  if(history)controls.push(button('＋ 担当回を追加','meeting_add','new'));
  if(page>0)controls.push(button('前へ','meeting_prev',String(page-1)));
  if((page+1)*6<rows.length)controls.push(button('次へ','meeting_next',String(page+1)));
  blocks.push({type:'actions',elements:controls});
  return {...notice(history?'担当履歴・回数':'出欠を選ぶ',''),private_metadata:JSON.stringify(meta),blocks};
}
async function recordView(service:Reservations,id:string,user:string) {
  const s=await meetingById(service,id),people=s.resource_id==='biweekly_report'?[]:JSON.parse(s.presenters) as Presenter[],assigned=new Set(people.map(p=>p.id));
  const responses=(await service.db.prepare('SELECT a.slack_user_id AS id,a.status,m.name FROM schedule_attendance a LEFT JOIN member_names m ON m.slack_user_id=a.slack_user_id WHERE a.session_id=?').bind(s.id).all<{id:string;status:string;name:string|null}>()).results.filter(r=>!assigned.has(r.id));
  const all=await members(service),show=(status:string)=>responses.filter(r=>r.status===status).map(r=>r.name??r.id).join('、')||'なし';
  const unanswered=all.filter(m=>!assigned.has(m.id)&&!responses.some(r=>r.id===m.id)).map(m=>m.name).join('、')||'なし';
  const mine=responses.find(r=>r.id===user)?.status;
  const blocks:SlackJSON[]=[section(`${s.session_date}　${s.resource_id==='english_seminar'?'英論ゼミ\n担当者：'+(s.state==='not_held'?'開催なし':presenterNames(s)):'隔週報'}`),
    section(`出席：${show('attending')}\n欠席：${show('absent')}\n未定：${show('undecided')}\n未回答：${unanswered}`)];
  if(s.state!=='not_held'&&!assigned.has(user))blocks.push(section(`あなたの回答：${mine==='attending'?'出席':mine==='absent'?'欠席':mine==='undecided'?'未定':'未回答'}（通知なし）`),
    {type:'actions',elements:[button('出席','meeting_rsvp_attending',`${s.id}|attending`),button('欠席','meeting_rsvp_absent',`${s.id}|absent`),button('未定','meeting_rsvp_undecided',`${s.id}|undecided`)]});
  else if(assigned.has(user))blocks.push(section('あなたは担当者です。担当者は上の出欠一覧とは分けて表示します。'));
  if(s.resource_id==='english_seminar')blocks.push({type:'actions',elements:[button('担当・履歴を編集','meeting_edit',s.id)]});
  return {...notice('出欠状況',''),private_metadata:JSON.stringify({origin_channel:service.operationsChannel}),blocks};
}
async function editView(service:Reservations,id:string) {
  const create=id==='new';
  const s=create?{id:crypto.randomUUID(),resource_id:'english_seminar',session_date:localParts(service.clock()).date,state:'undecided',presenters:'[]',notes:'',version:0}:await meetingById(service,id);
  if(s.resource_id!=='english_seminar')throw new BookingError('隔週報には担当者の登録はありません。');
  const options=[...(await members(service)).map(m=>option(m.name,m.id)),option('未確定','undecided')];
  const assigned=(JSON.parse(s.presenters) as Presenter[]).map(p=>p.id);
  return {type:'modal',title:plain(create?'担当回を追加':'担当・履歴を編集'),callback_id:'save_meeting',submit:plain(create?'追加する':'保存する'),close:plain('戻る'),
    private_metadata:JSON.stringify({id:s.id,create,version:s.version,nonce:crypto.randomUUID(),origin_channel:service.operationsChannel}),
    blocks:[section(create?'日付と担当者の履歴を追加します。全員が追加できます。時刻のない担当履歴なのでカレンダー予定は作成しません。':'全員が編集できます。出欠変更・履歴編集によるチャンネル通知は送りません。'),
      field('session_date','日付',{type:'datepicker',initial_date:s.session_date}),
      field('state','開催状態',{type:'static_select',options:[option('開催（担当未確定でもOK）','held'),option('開催なし','not_held')],initial_option:option(s.state==='not_held'?'開催なし':'開催（担当未確定でもOK）',s.state==='not_held'?'not_held':'held')}),
      field('presenters','担当者（複数選択可）',{type:'checkboxes',options,initial_options:assigned.length?options.filter(o=>assigned.includes(o.value)):[options.at(-1)!]},true),
      field('notes','備考',{type:'plain_text_input',max_length:1000,...(s.notes?{initial_value:s.notes}:{})},true)]};
}
export async function editMeeting(service:Reservations,user:string,key:string,id:string,version:number,date:string,state:string,ids:string[],notes:string) {
  if(!/^[A-Za-z0-9:_-]{1,150}$/.test(key))throw new BookingError('操作を確認できません。');
  const replay=await service.db.prepare('SELECT session_id,slack_user_id FROM schedule_edits WHERE request_key=?').bind(key).first<{session_id:string;slack_user_id:string}>();
  if(replay){if(replay.session_id!==id||replay.slack_user_id!==user)throw new BookingError('操作を確認できません。');return;}
  const s=await meetingById(service,id),all=await members(service);
  if(s.resource_id!=='english_seminar')throw new BookingError('隔週報には担当者の登録はありません。');
  if(!['held','not_held'].includes(state)||ids.some(id=>!all.some(m=>m.id===id)))throw new BookingError('開催状態と担当者を選択してください。');
  try{parseDate(date,'00:00');}catch{throw new BookingError('日付を正しく選択してください。');}
  if(s.reservation_id&&date!==s.session_date)throw new BookingError('登録済み日程の日付は、日程の変更から操作してください。');
  if(typeof notes!=='string'||notes.length>1000)throw new BookingError('備考は1000文字以内で入力してください。');
  const presenters=state==='not_held'?[]:all.filter(m=>ids.includes(m.id));
  try{await service.db.prepare('INSERT INTO schedule_edits VALUES(?,?,?,?,?,?)').bind(key,s.id,user,version,JSON.stringify({date,state:state==='not_held'?'not_held':presenters.length?'held':'undecided',presenters:JSON.stringify(presenters),notes:notes.trim()}),service.clock()).run();}
  catch(error){
    const saved=await service.db.prepare('SELECT session_id,slack_user_id FROM schedule_edits WHERE request_key=?').bind(key).first<{session_id:string;slack_user_id:string}>();
    if(saved?.session_id===s.id&&saved.slack_user_id===user)return;
    if(String(error).includes('stale_session'))throw new BookingError('別の方が更新しました。一覧を開き直してください。');throw error;}
}
export async function createMeeting(service:Reservations,user:string,key:string,id:string,date:string,state:string,ids:string[],notes:string) {
  if(!/^[A-Za-z0-9:_-]{1,150}$/.test(key)||!/^[A-Za-z0-9_-]{1,150}$/.test(id))throw new BookingError('操作を確認できません。');
  const all=await members(service);
  try{parseDate(date,'00:00');}catch{throw new BookingError('日付を正しく選択してください。');}
  if(!['held','not_held'].includes(state)||ids.some(id=>!all.some(m=>m.id===id)))throw new BookingError('開催状態と担当者を選択してください。');
  if(typeof notes!=='string'||notes.length>1000)throw new BookingError('備考は1000文字以内で入力してください。');
  const presenters=state==='not_held'?[]:all.filter(m=>ids.includes(m.id));
  try{await service.db.prepare('INSERT INTO meeting_creations VALUES(?,?,?,?,?)').bind(key,id,user,JSON.stringify({date,state:state==='not_held'?'not_held':presenters.length?'held':'undecided',presenters:JSON.stringify(presenters),notes:notes.trim()}),service.clock()).run();}
  catch(error){
    const replay=await service.db.prepare('SELECT session_id,slack_user_id FROM meeting_creations WHERE request_key=?').bind(key).first<{session_id:string;slack_user_id:string}>();
    if(replay?.session_id===id&&replay.slack_user_id===user)return;
    if(String(error).includes('duplicate_meeting_date'))throw new BookingError('この日付は登録済みです。担当履歴の編集から変更してください。');
    throw error;
  }
}
export async function saveAttendance(service:Reservations,user:string,id:string,status:string) {
  const s=await meetingById(service,id);
  if(s.state==='not_held')throw new BookingError('開催なしの日程には出欠を登録できません。');
  if(s.resource_id!=='biweekly_report'&&(JSON.parse(s.presenters) as Presenter[]).some(p=>p.id===user))throw new BookingError('担当者は出欠一覧とは別に表示しています。');
  if(!['attending','absent','undecided'].includes(status))throw new BookingError('出席・欠席・未定を選択してください。');
  const changed=await service.db.prepare(`INSERT INTO schedule_attendance SELECT id,?,?,? FROM schedule_sessions s
    WHERE id=? AND state<>'not_held' AND (resource_id='biweekly_report' OR NOT EXISTS(SELECT 1 FROM json_each(s.presenters) p WHERE json_extract(p.value,'$.id')=?))
    ON CONFLICT(session_id,slack_user_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at RETURNING session_id`).bind(user,status,service.clock(),s.id,user).first();
  if(!changed)throw new BookingError('担当や開催状態が更新されました。画面を開き直してください。');
}
export async function meetingAction(service:Reservations,slack:SlackCall,body:SlackJSON) {
  const a=body.actions[0],user=body.user.id;
  if(a.action_id.startsWith('meeting_audit')){await scheduleAuditAction(service,slack,body);return;}
  let view:SlackJSON;
  if(['meeting_history','meeting_attendance','meeting_page','meeting_prev','meeting_next'].includes(a.action_id)) {
    const meta=body.view?.private_metadata?JSON.parse(body.view.private_metadata):{};
    const paged=['meeting_page','meeting_prev','meeting_next'].includes(a.action_id);
    const history=a.action_id==='meeting_history'||paged&&meta.meeting_history;
    view=await meetingList(service,Boolean(history),paged?Number(a.value):0);
    if(body.view?.type==='modal'&&a.action_id!=='meeting_record'){await slack('views.update',{view_id:body.view.id,hash:body.view.hash,view});return;}
  }else if(a.action_id==='meeting_edit'||a.action_id==='meeting_add')view=await editView(service,a.action_id==='meeting_add'?'new':a.value);
  else if(a.action_id==='meeting_rsvp'||a.action_id.startsWith('meeting_rsvp_')) {
    const [id,status]=a.value.split('|');await saveAttendance(service,user,id,status);
    await slack('views.update',{view_id:body.view.id,hash:body.view.hash,view:await recordView(service,id,user)});return;
  }else view=await recordView(service,a.value,user);
  await slack(body.view?.type==='modal'?'views.push':'views.open',{trigger_id:body.trigger_id,view});
}
export async function submitMeeting(service:Reservations,body:SlackJSON) {
  try{
    const v=body.view,m=JSON.parse(v.private_metadata),ids=(value(v,'presenters').selected_options??[]).map((o:SlackJSON)=>o.value).filter((id:string)=>id!=='undecided');
    if(m.create)await createMeeting(service,body.user.id,m.nonce,m.id,value(v,'session_date').selected_date,value(v,'state').selected_option?.value,ids,value(v,'notes').value??'');
    else await editMeeting(service,body.user.id,m.nonce,m.id,m.version,value(v,'session_date').selected_date,value(v,'state').selected_option?.value,ids,value(v,'notes').value??'');
    return {response_action:'update',view:notice('保存しました','担当履歴と回数を更新しました。戻った一覧は「更新」を押すと最新になります。カレンダーにも順次反映します。')};
  }catch(error){return {response_action:'errors',errors:{presenters:error instanceof BookingError?error.message:'保存できませんでした。もう一度お試しください。'}};}
}
