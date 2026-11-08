import type { Env, Reservation, Resource } from '../types';
import { purposeText } from '../purpose';
import { presenterNames, calendarPerson } from '../meeting';

export function googleConfigured(env:Env) {
  return Boolean(env.GOOGLE_CALENDAR_ID&&env.GOOGLE_SERVICE_ACCOUNT_JSON);
}
const base64url=(bytes:Uint8Array)=>btoa(Array.from(bytes,b=>String.fromCharCode(b)).join('')).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
export async function googleAccessToken(env:Env,request:typeof fetch=fetch,now=Date.now()) {
  const service=JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON!) as {client_email:string;private_key:string};
  if(!service.client_email||!service.private_key)throw new Error('google_credentials_invalid');
  const encode=(value:unknown)=>base64url(new TextEncoder().encode(JSON.stringify(value)));
  const seconds=Math.floor(now/1000);
  const unsigned=encode({alg:'RS256',typ:'JWT'})+'.'+encode({iss:service.client_email,scope:'https://www.googleapis.com/auth/calendar.events',aud:'https://oauth2.googleapis.com/token',iat:seconds,exp:seconds+3600});
  const pem=service.private_key.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
  const key=await crypto.subtle.importKey('pkcs8',Uint8Array.from(atob(pem),c=>c.charCodeAt(0)),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(unsigned));
  const response=await request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:unsigned+'.'+base64url(new Uint8Array(signature))}),signal:AbortSignal.timeout(5000)});
  if(!response.ok) throw new Error(`google_auth_http_${response.status}`);
  const data=await response.json() as {access_token?:string};
  if(!data.access_token)throw new Error('google_auth_missing_token');
  return data.access_token;
}
export const googleEventId=(id:string)=>'lab'+id.replace(/-/g,'').toLowerCase();
export function googleEvent(row:Reservation,r:Resource) {
  const who=calendarPerson(row,r);
  return {id:googleEventId(row.id),summary:`${r.icon?r.icon+' ':''}${r.name}${r.type==='quantity_resource'?` ${row.quantity}台`:''}${who?'｜'+who:''}`,
    description:`${r.id==='biweekly_report'?'':(r.schedule_event?'担当者：'+presenterNames(row):'予約者：'+row.slack_user_name)+'\n'}用途：${purposeText(row)||'未入力'}\n${row.online_url?'オンラインURL：'+row.online_url+'\n':''}予約ID：${row.id}\n変更・キャンセルはSlackから行ってください。`,
    start:{dateTime:new Date(row.start_at).toISOString(),timeZone:'Asia/Tokyo'},end:{dateTime:new Date(row.end_at).toISOString(),timeZone:'Asia/Tokyo'},
    location:row.location||(r.schedule_event?'':r.room??''),extendedProperties:{private:{labReservationId:row.id,labReservationVersion:String(row.version)}},visibility:'default',transparency:'opaque'};
}
export async function writeGoogleEvent(request:typeof fetch,calendarId:string,token:string,row:Reservation,r:Resource) {
  const base=`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const url=`${base}/${googleEventId(row.id)}?sendUpdates=none`;
  const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  const options=(method:string,body?:unknown)=>({method,headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});
  if(row.status==='cancelled') {
    const response=await request(url,options('DELETE'));
    if(!response.ok&&![404,410].includes(response.status))throw new Error(`google_events_http_${response.status}`);
    return;
  }
  const event=googleEvent(row,r);
  let response=await request(url,options('PUT',event));
  if(response.status===404) {
    response=await request(base+'?sendUpdates=none',options('POST',event));
    if(response.status===409) response=await request(url,options('PUT',event));
  }
  if(!response.ok)throw new Error(`google_events_http_${response.status}`);
}
export async function syncGoogleReservation(env:Env,id:string,request:typeof fetch=fetch,clock=Date.now):Promise<'disabled'|'synced'|'pending'> {
  if(!googleConfigured(env))return 'disabled';
  const target=await env.DB.prepare('SELECT r.schedule_event FROM reservations b JOIN resources r ON r.id=b.resource_id WHERE b.id=?').bind(id).first<{schedule_event:number}>();
  const calendarId=target?.schedule_event?env.SCHEDULE_GOOGLE_CALENDAR_ID:env.GOOGLE_CALENDAR_ID;
  if(!calendarId)return 'disabled';
  const owner=crypto.randomUUID(),now=clock(),db=env.DB;
  const claimed=await db.prepare(`UPDATE google_calendar_sync SET lease_owner=?,lease_until=?,attempts=attempts+1
    WHERE reservation_id=? AND status='pending' AND lease_until<=? AND next_attempt_at<=? RETURNING reservation_id`)
    .bind(owner,now+120000,id,now,now).first();
  if(!claimed) {
    const state=await db.prepare('SELECT status,synced_calendar_id FROM google_calendar_sync WHERE reservation_id=?').bind(id).first<{status:string;synced_calendar_id:string|null}>();
    return state?.status==='synced'&&state.synced_calendar_id===calendarId?'synced':'pending';
  }
  try {
    const token=await googleAccessToken(env,request,now);
    for(let attempt=0;attempt<3;attempt++) {
      const row=await db.prepare('SELECT * FROM reservations WHERE id=?').bind(id).first<Reservation>();
      if(!row)throw new Error('google_reservation_missing');
      const resource=await db.prepare('SELECT * FROM resources WHERE id=?').bind(row.resource_id).first<Resource>();
      if(!resource)throw new Error('google_resource_missing');
      await writeGoogleEvent(request,calendarId,token,row,resource);
      const saved=await db.prepare(`UPDATE google_calendar_sync SET synced_version=?,synced_calendar_id=?,status='synced',last_error=NULL,next_attempt_at=0
        WHERE reservation_id=? AND desired_version=? AND lease_owner=? RETURNING reservation_id`).bind(row.version,calendarId,id,row.version,owner).first();
      if(saved)return 'synced';
    }
    return 'pending';
  } catch(error) {
    // Only fixed error codes are persisted. Never store API bodies, credentials or user data.
    const code=error instanceof Error&&/^google_[a-z_]+(?:_\d+)?$/.test(error.message)?error.message:'google_sync_network_or_credentials';
    await db.prepare(`UPDATE google_calendar_sync SET last_error=?,next_attempt_at=?,status='pending' WHERE reservation_id=? AND lease_owner=?`).bind(code,clock()+60000,id,owner).run();
    console.error(JSON.stringify({kind:'google_calendar_sync',reservation_id:id,error:code,occurred_at:new Date(clock()).toISOString()}));
    return 'pending';
  } finally {await db.prepare('UPDATE google_calendar_sync SET lease_owner=NULL,lease_until=0 WHERE reservation_id=? AND lease_owner=?').bind(id,owner).run();}
}
export async function syncGooglePending(env:Env,limit=10) {
  if(!googleConfigured(env))return;
  const jobs=(await env.DB.prepare("SELECT reservation_id FROM google_calendar_sync WHERE status='pending' AND lease_until<=? AND next_attempt_at<=? LIMIT ?").bind(Date.now(),Date.now(),limit).all<{reservation_id:string}>()).results;
  for(const job of jobs)await syncGoogleReservation(env,job.reservation_id);
}
export async function seedGoogleSync(env:Env) {
  await env.DB.prepare(`INSERT INTO google_calendar_sync(reservation_id,desired_version) SELECT id,version FROM reservations WHERE true
    ON CONFLICT(reservation_id) DO UPDATE SET desired_version=excluded.desired_version,status='pending',next_attempt_at=0`).run();
}
