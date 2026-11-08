import { day, localParts, parseDate } from '../datetime';
import { purposeText } from '../purpose';
import { presenterNames, calendarPerson } from '../meeting';
import type { Reservation, Resource } from '../types';

export function weekBounds(date:string):[number,number] {
  const selected=parseDate(date,'00:00');
  const weekday=new Date(selected+9*3_600_000).getUTCDay();
  const start=selected-((weekday+6)%7)*day;
  return [start,start+7*day];
}
export async function calendarRows(db:D1Database,start:number,end:number,resource:string|null=null,user:string|null=null) {
  return (await db.prepare(`SELECT r.* FROM reservations r JOIN resources x ON x.id=r.resource_id
    WHERE r.status='active' AND r.start_at<? AND r.end_at>?
    AND (? IS NULL OR r.resource_id=?) AND (? IS NULL OR r.slack_user_id=?) ORDER BY r.start_at,r.id`).bind(end,start,resource,resource,user,user).all<Reservation>()).results;
}
export async function subscriptionToken(db:D1Database,user:string,now:number,scope:'all'|'mine'='all') {
  const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
  await db.prepare('INSERT INTO calendar_subscriptions(slack_user_id,token,created_at) VALUES(?,?,?) ON CONFLICT(slack_user_id) DO UPDATE SET token=excluded.token,personal_token=NULL,created_at=excluded.created_at,version=calendar_subscriptions.version+1,revoked=0 WHERE calendar_subscriptions.revoked=1').bind(user,token,now).run();
  if(scope==='mine') {
    const personal=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
    await db.prepare('UPDATE calendar_subscriptions SET personal_token=? WHERE slack_user_id=? AND personal_token IS NULL').bind(personal,user).run();
    return (await db.prepare('SELECT personal_token FROM calendar_subscriptions WHERE slack_user_id=?').bind(user).first<{personal_token:string}>())!.personal_token;
  }
  return (await db.prepare('SELECT token FROM calendar_subscriptions WHERE slack_user_id=?').bind(user).first<{token:string}>())!.token;
}
export async function changeSubscription(db:D1Database,user:string,version:number,revoke:boolean,now:number) {
  const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
  const personal=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
  return db.prepare('UPDATE calendar_subscriptions SET token=?,personal_token=?,created_at=?,version=version+1,revoked=? WHERE slack_user_id=? AND version=?').bind(token,personal,now,revoke?1:0,user,version).run();
}
export const escapeICS=(s:string)=>s.replace(/\\/g,'\\\\').replace(/\r\n|\r|\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
export const utc=(ms:number)=>new Date(ms).toISOString().replace(/[-:]/g,'').slice(0,15)+'Z';
export function foldICS(line:string) {
  const lines:string[]=[];let part='',bytes=0;
  for(const char of line) {
    const size=new TextEncoder().encode(char).length;
    if(bytes+size>75) {lines.push(part);part=' ';bytes=1;}
    part+=char;bytes+=size;
  }
  lines.push(part);return lines.join('\r\n');
}
export function calendarICS(rows:Reservation[],resources:Resource[],now:number,name='研究室 設備予約') {
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Lab Reservation//JA','CALSCALE:GEXAMPLE0001','METHOD:PUBLISH',`X-WR-CALNAME:${escapeICS(name)}`,'X-WR-TIMEZONE:Asia/Tokyo'];
  for(const row of rows) {
    const r=resources.find(r=>r.id===row.resource_id);
    if(row.status!=='active'||!r) continue;
    const who=calendarPerson(row,r),summary=`${r.icon?r.icon+' ':''}${r.name}${r.type==='quantity_resource'?` ${row.quantity}台`:''}${who?'｜'+who:''}`;
    const purpose=purposeText(row);
    lines.push('BEGIN:VEVENT',`UID:${row.id}@lab-reservation`,`DTSTAMP:${utc(now)}`,`DTSTART:${utc(row.start_at)}`,`DTEND:${utc(row.end_at)}`,
      ...((row.location||(!r.schedule_event&&r.room))?[`LOCATION:${escapeICS(row.location||r.room!)}`]:[]),
      ...(row.online_url?[`URL:${escapeICS(row.online_url)}`]:[]),
      `CREATED:${utc(row.created_at)}`,`LAST-MODIFIED:${utc(row.updated_at)}`,`SEQUENCE:${row.version}`,
      `SUMMARY:${escapeICS(summary)}`,`DESCRIPTION:${escapeICS(`${r.id==='biweekly_report'?'':(r.schedule_event?'担当者：'+presenterNames(row):'予約者：'+row.slack_user_name)+'\n'}${purpose?`用途：${purpose}\n`:''}${row.online_url?'オンラインURL：'+row.online_url+'\n':''}予約ID：${row.id}\n変更・キャンセルはSlackから行ってください。`)}`,
      'STATUS:CEXAMPLE0002','TRANSP:OPAQUE','END:VEVENT');
  }
  lines.push('END:VCALENDAR');return lines.map(foldICS).join('\r\n')+'\r\n';
}
export async function calendarResponse(request:Request,db:D1Database,now=Date.now()) {
  const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
  const url=new URL(request.url),token=url.searchParams.get('token')??'';
  const owner=/^[a-f0-9]{64}$/.test(token)?await db.prepare('SELECT slack_user_id,CASE WHEN personal_token=? THEN 1 ELSE 0 END AS mine FROM calendar_subscriptions WHERE (token=? OR personal_token=?) AND revoked=0').bind(token,token,token).first<{slack_user_id:string;mine:number}>():null;
  if(!owner)return new Response('Unauthorized',{status:401,headers});
  const resource=url.searchParams.get('resource');
  const schedule=url.searchParams.get('kind')==='schedule';
  const resources=(await db.prepare('SELECT * FROM resources').all<Resource>()).results.filter(r=>Boolean(r.schedule_event)===schedule);
  if(resource&&!resources.some(r=>r.id===resource)) return new Response('Not found',{status:404,headers});
  const start=parseDate(localParts(now).date,'00:00')-30*day,end=start+396*day;
  const rows=(await calendarRows(db,start,end,resource,owner.mine?owner.slack_user_id:null)).filter(row=>resources.some(r=>r.id===row.resource_id));
  const name=(schedule?'研究室ゼミ・隔週報':'研究室 設備予約')+(owner.mine?'（自分の予約）':'');
  return new Response(request.method==='HEAD'?null:calendarICS(rows,resources,now,name),{headers:{...headers,'X-Lab-Calendar-Scope':owner.mine?'mine':'all','Content-Type':'text/calendar; charset=utf-8','Content-Disposition':`inline; filename="${owner.mine?'my-':''}${schedule?'lab-schedules':'lab-reservations'}.ics"`}});
}

export async function calendarSetupResponse(request:Request,db:D1Database,respond=calendarResponse,icsPath='/calendar.ics') {
  const url=new URL(request.url);url.pathname=icsPath;
  const checked=await respond(new Request(url,{method:'HEAD'}),db);
  if(checked.status!==200)return checked;
  const escape=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const https=escape(url.toString()),webcal=escape(url.toString().replace(/^https:/,'webcal:'));
  return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>研究室カレンダーの購読</title><style>body{font:17px system-ui;max-width:680px;margin:40px auto;padding:24px;line-height:1.7}a{display:block;padding:14px;border:1px solid #888;border-radius:8px;margin:16px 0}code{overflow-wrap:anywhere;user-select:all}h1{font-size:24px}</style><h1>研究室カレンダーの購読</h1><p>iPhoneではこのページをSafariで開き、下のボタンを押してください。</p><a href="${webcal}">iPhoneのカレンダーで購読を開く</a><p>うまく開かない場合：設定 → アプリ → カレンダー → カレンダーアカウント → アカウントを追加 → その他 → 照会するカレンダーを追加。次のURLをサーバ欄にそのまま貼り付け、SSLを有効にしてください。ユーザ名・パスワードは不要です。</p><code>${https}</code><p>ファイルのダウンロードやインポートではなく、購読として追加します。リンクを知る人は予約情報を閲覧できます。研究室外へ共有しないでください。</p><p>購読方式の更新間隔は端末側で決まります。</p></html>`,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"}});
}
