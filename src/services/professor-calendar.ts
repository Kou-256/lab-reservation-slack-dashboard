import {day,localParts,parseDate} from '../datetime';
import {button,notice,plain,section} from '../ui';
import type {Env,SlackCall,SlackJSON} from '../types';
import type {ProfessorDay} from './professor';
import {calendarSetupResponse,escapeICS,foldICS,utc} from './calendar';
import {googleAccessToken} from './google-calendar';

const secret=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
export async function professorToken(db:D1Database,user:string,now=Date.now()) {
  await db.prepare(`INSERT INTO professor_calendar_subscriptions(slack_user_id,token,created_at) VALUES(?,?,?)
    ON CONFLICT(slack_user_id) DO UPDATE SET token=excluded.token,created_at=excluded.created_at,revoked=0,version=professor_calendar_subscriptions.version+1
    WHERE professor_calendar_subscriptions.revoked=1`).bind(user,secret(),now).run();
  return (await db.prepare('SELECT token FROM professor_calendar_subscriptions WHERE slack_user_id=?').bind(user).first<{token:string}>())!.token;
}
export async function changeProfessorToken(db:D1Database,user:string,version:number,revoke:boolean,now=Date.now()) {
  return db.prepare('UPDATE professor_calendar_subscriptions SET token=?,version=version+1,revoked=?,created_at=? WHERE slack_user_id=? AND version=?').bind(secret(),revoke?1:0,now,user,version).run();
}
export function professorICS(rows:ProfessorDay[],now=Date.now()) {
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Lab Professor Days//JA','CALSCALE:GEXAMPLE0001','METHOD:PUBLISH','X-WR-CALNAME:担当教員先生が予定ある日','X-WR-TIMEZONE:Asia/Tokyo'];
  for(const r of rows.filter(r=>r.status==='active'))lines.push('BEGIN:VEVENT',`UID:${r.id}@professor.lab-reservation`,`DTSTAMP:${utc(now)}`,
    ...(r.all_day?[`DTSTART;VALUE=DATE:${r.start_date.replace(/-/g,'')}`,`DTEND;VALUE=DATE:${localParts(r.end_at).date.replace(/-/g,'')}`]:[`DTSTART:${utc(r.start_at)}`,`DTEND:${utc(r.end_at)}`]),
    `CREATED:${utc(r.created_at)}`,`LAST-MODIFIED:${utc(r.updated_at)}`,`SEQUENCE:${r.version}`,`SUMMARY:${escapeICS('担当教員先生｜'+r.title)}`,
    `DESCRIPTION:${escapeICS((r.notes?r.notes+'\n':'')+'変更・削除はSlackの「担当教員先生が予定ある日」から行ってください。')}`,'STATUS:CEXAMPLE0002','TRANSP:OPAQUE','END:VEVENT');
  return [...lines,'END:VCALENDAR'].map(foldICS).join('\r\n')+'\r\n';
}
export async function professorCalendarResponse(request:Request,db:D1Database,now=Date.now()) {
  const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
  const token=new URL(request.url).searchParams.get('token')??'';
  const owner=/^[a-f0-9]{64}$/.test(token)?await db.prepare('SELECT slack_user_id FROM professor_calendar_subscriptions WHERE token=? AND revoked=0').bind(token).first():null;
  if(!owner)return new Response('Unauthorized',{status:401,headers});
  const start=parseDate(localParts(now).date,'00:00')-30*day;
  const rows=(await db.prepare("SELECT * FROM professor_days WHERE status='active' AND end_at>? AND start_at<? ORDER BY start_at,id").bind(start,start+396*day).all<ProfessorDay>()).results;
  return new Response(request.method==='HEAD'?null:professorICS(rows,now),{headers:{...headers,'Content-Type':'text/calendar; charset=utf-8','Content-Disposition':'inline; filename="kato-professor-days.ics"'}});
}
export const professorSetup=(request:Request,db:D1Database)=>calendarSetupResponse(request,db,professorCalendarResponse,'/professor/calendar.ics');
export async function professorSubscription(slack:SlackCall,db:D1Database,body:SlackJSON,baseURL:string,googleId?:string,now=Date.now()) {
  const a=body.actions[0];if(a.action_id==='prof_ios_help'||a.action_id==='prof_google_help')return;
  let view:SlackJSON;
  if(['prof_sub_rotate','prof_sub_revoke'].includes(a.action_id)){
    const row=await db.prepare('SELECT version FROM professor_calendar_subscriptions WHERE slack_user_id=?').bind(body.user.id).first<{version:number}>();
    if(!row)throw Error('professor_subscription_missing');
    const revoke=a.action_id==='prof_sub_revoke';
    view={...notice('購読URLを変更','ご自分が発行した「担当教員先生が予定ある日」の古いURLを無効にします。設備予約・ゼミのURLには影響しません。再発行後はGoogle・iOSで新しいURLの登録が必要です。'),callback_id:'prof_subscription',submit:plain(revoke?'失効する':'再発行する'),close:plain('戻る'),private_metadata:JSON.stringify({version:row.version,revoke})};
  }else {
    const url=new URL('/professor/calendar.ics',baseURL);url.searchParams.set('token',await professorToken(db,body.user.id,now));
    const setup=new URL(url);setup.pathname='/professor/calendar/setup';
    view={...notice('担当教員先生のカレンダー',''),blocks:[section('📅 「担当教員先生が予定ある日」専用カレンダーです。設備予約・英論ゼミ・隔週報の予定は含みません。'),
      section('Google（パソコン）：他のカレンダーの＋ → URLで追加 → 下の秘密のURLを貼り付けて追加。個人Gmailでも購読できます。'),
      section('iPhone：下の購読案内をSafariで開いて追加してください。ファイルの取り込みではなく「購読」で追加します。'),
      {type:'section',text:{type:'mrkdwn',text:'```'+url.toString()+'```',verbatim:true}},
      {type:'actions',elements:[{type:'button',action_id:'prof_ios_help',text:plain('iPhone用の購読案内を開く'),url:setup.toString()}]},
      section('追加・変更・削除は購読先の次回取得時に反映されます。更新間隔はGoogle・iOS側で決まり、即時反映は保証できません。このURLを知る人は予定名・備考を閲覧できます。研究室外には共有しないでください。'),
      {type:'actions',elements:[button('購読URLを再発行','prof_sub_rotate','self'),button('購読URLを失効','prof_sub_revoke','self','danger')]},
      ...(googleId?[section('所有者・共有権限のある方：専用Googleカレンダーにも自動反映します。iOSにそのGoogleアカウントを追加すると同じカレンダーを表示できます。'),{type:'actions',elements:[{type:'button',action_id:'prof_google_help',text:plain('専用Googleカレンダーを開く'),url:'https://calendar.google.com/calendar/u/0/r?cid='+encodeURIComponent(googleId)}]}]:[])]};
  }
  await slack(body.view?.type==='modal'?'views.push':'views.open',{trigger_id:body.trigger_id,view});
}
export async function submitProfessorSubscription(db:D1Database,slack:SlackCall,body:SlackJSON) {
  const m=JSON.parse(body.view.private_metadata),r=await changeProfessorToken(db,body.user.id,m.version,m.revoke);
  await slack('views.update',{view_id:body.view.id,view:notice('購読URL',r.meta.changes?(m.revoke?'購読URLを失効しました。':'購読URLを再発行しました。「Google・iOSカレンダー」を開き直して新しいURLを登録してください。'):'この操作は完了済みです。再度URLを変更していません。')});
}
export const professorGoogleId=(id:string)=>'prof'+Array.from(new TextEncoder().encode(id),b=>b.toString(16).padStart(2,'0')).join('');
export function professorGoogleEvent(r:ProfessorDay) {
  return {id:professorGoogleId(r.id),summary:'担当教員先生｜'+r.title,description:r.notes+'\n変更・削除はSlackの「担当教員先生が予定ある日」から行ってください。',
    start:r.all_day?{date:r.start_date}:{dateTime:new Date(r.start_at).toISOString(),timeZone:'Asia/Tokyo'},
    end:r.all_day?{date:localParts(r.end_at).date}:{dateTime:new Date(r.end_at).toISOString(),timeZone:'Asia/Tokyo'},
    extendedProperties:{private:{labProfessorId:r.id,labProfessorVersion:String(r.version)}},visibility:'default',transparency:'opaque',reminders:{useDefault:false}};
}
export async function syncProfessorEvent(env:Env,id:string,request:typeof fetch=fetch,clock=Date.now):Promise<'disabled'|'synced'|'pending'> {
  const calendarId=env.PROFESSOR_GOOGLE_CALENDAR_ID;if(!calendarId||!env.GOOGLE_SERVICE_ACCOUNT_JSON)return 'disabled';
  // Never allow a misconfiguration to mix teacher days into an existing lab calendar.
  if([env.GOOGLE_CALENDAR_ID,env.SCHEDULE_GOOGLE_CALENDAR_ID].includes(calendarId))return 'disabled';
  const owner=crypto.randomUUID(),now=clock(),db=env.DB;
  const claim=await db.prepare("UPDATE professor_google_sync SET lease_owner=?,lease_until=?,attempts=attempts+1 WHERE event_id=? AND status='pending' AND lease_until<=? AND next_attempt_at<=? RETURNING event_id").bind(owner,now+120000,id,now,now).first();
  if(!claim){const s=await db.prepare('SELECT status,synced_calendar_id FROM professor_google_sync WHERE event_id=?').bind(id).first<{status:string;synced_calendar_id:string}>();return s?.status==='synced'&&s.synced_calendar_id===calendarId?'synced':'pending';}
  try {
    const token=await googleAccessToken(env,request,now);
    for(let attempt=0;attempt<3;attempt++){
      const r=await db.prepare('SELECT * FROM professor_days WHERE id=?').bind(id).first<ProfessorDay>();if(!r)throw Error('google_professor_missing');
      const base='https://www.googleapis.com/calendar/v3/calendars/'+encodeURIComponent(calendarId)+'/events',url=base+'/'+professorGoogleId(id)+'?sendUpdates=none';
      const options=(method:string)=>({method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(method==='DELETE'?{}:{body:JSON.stringify(professorGoogleEvent(r))}),signal:AbortSignal.timeout(5000)});
      let response=await request(url,options(r.status==='cancelled'?'DELETE':'PUT'));
      if(r.status!=='cancelled'&&response.status===404){response=await request(base+'?sendUpdates=none',options('POST'));if(response.status===409)response=await request(url,options('PUT'));}
      if(!response.ok&&!(r.status==='cancelled'&&[404,410].includes(response.status)))throw Error('google_events_http_'+response.status);
      const saved=await db.prepare("UPDATE professor_google_sync SET synced_version=?,synced_calendar_id=?,status='synced',last_error=NULL,next_attempt_at=0 WHERE event_id=? AND desired_version=? AND lease_owner=? RETURNING event_id").bind(r.version,calendarId,id,r.version,owner).first();
      if(saved)return 'synced';
    }return 'pending';
  }catch(error){const code=error instanceof Error&&/^google_[a-z_]+(?:_\d+)?$/.test(error.message)?error.message:'google_sync_network_or_credentials';
    await db.prepare("UPDATE professor_google_sync SET status='pending',last_error=?,next_attempt_at=? WHERE event_id=? AND lease_owner=?").bind(code,clock()+60000,id,owner).run();
    console.error(JSON.stringify({kind:'professor_google_sync',event_id:id,error:code,occurred_at:new Date(clock()).toISOString()}));return 'pending';
  }finally{await db.prepare('UPDATE professor_google_sync SET lease_owner=NULL,lease_until=0 WHERE event_id=? AND lease_owner=?').bind(id,owner).run();}
}
export async function syncProfessorPending(env:Env,limit=2) {
  if(!env.PROFESSOR_GOOGLE_CALENDAR_ID||!env.GOOGLE_SERVICE_ACCOUNT_JSON)return;
  const list=(await env.DB.prepare("SELECT event_id FROM professor_google_sync WHERE status='pending' AND lease_until<=? AND next_attempt_at<=? ORDER BY next_attempt_at,event_id LIMIT ?").bind(Date.now(),Date.now(),limit).all<{event_id:string}>()).results;
  for(const row of list)await syncProfessorEvent(env,row.event_id);
}
