import type {Env} from '../types';

const encoder=new TextEncoder();
export class DashboardError extends Error {constructor(message:string,public status=400){super(message);}}
export const securityHeaders={
  'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};
function configured(env:Env) {
  if(!env.DASHBOARD_SECRET||env.DASHBOARD_SECRET.length<32)throw new DashboardError('ダッシュボードの認証設定が必要です。管理者に連絡してください。',503);
}
async function key(secret:string) {return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
const hex=(value:ArrayBuffer)=>Array.from(new Uint8Array(value),b=>b.toString(16).padStart(2,'0')).join('');
const bytes=(value:string)=>Uint8Array.from(value.match(/../g)??[],b=>parseInt(b,16));
export async function sign(secret:string,value:string) {return hex(await crypto.subtle.sign('HMAC',await key(secret),encoder.encode(value)));}
async function verify(secret:string,value:string,signature:string) {
  return /^[a-f0-9]{64}$/.test(signature)&&crypto.subtle.verify('HMAC',await key(secret),bytes(signature),encoder.encode(value));
}
export async function equalSecret(a:string,b:string) {
  const salt=crypto.randomUUID();return verify(salt,b,await sign(salt,a));
}
export function requireOrigin(request:Request) {
  if(request.headers.get('Origin')!==new URL(request.url).origin)throw new DashboardError('この画面から操作をやり直してください。',403);
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw new DashboardError('JSON形式で送信してください。',415);
}
export async function readJSON(request:Request):Promise<Record<string,unknown>> {
  const reader=request.body?.getReader();if(!reader)throw new DashboardError('入力がありません。');
  let size=0,text='';const decoder=new TextDecoder();
  while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>16000){await reader.cancel();throw new DashboardError('入力が長すぎます。',413);}text+=decoder.decode(part.value,{stream:true});}
  text+=decoder.decode();
  try{const result=JSON.parse(text);if(!result||typeof result!=='object'||Array.isArray(result))throw 0;return result;}catch{throw new DashboardError('入力を確認してください。');}
}
export async function attempt(db:D1Database,bucket:string,limit:number,now:number) {
  const expires=now+15*60000;
  const row=await db.prepare(`INSERT INTO dashboard_auth_attempts(bucket,attempts,expires_at) VALUES(?,1,?)
    ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN expires_at<=? THEN 1 ELSE attempts+1 END,
    expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING attempts`)
    .bind(bucket,expires,now,now).first<{attempts:number}>();
  if(!row||row.attempts>limit)throw new DashboardError('試行回数の上限です。15分ほど待ってからお試しください。',429);
}
export async function deviceCookie(env:Env,request:Request,provided:string,now:number) {
  configured(env);
  const ip=await sign(env.DASHBOARD_SECRET!,'ip:'+ (request.headers.get('CF-Connecting-IP')??'local'));
  await attempt(env.DB,'device:'+ip,10,now);
  const device=await env.DB.prepare('SELECT id,version FROM dashboard_devices WHERE key_hash=? AND enabled=1').bind(await sign(env.DASHBOARD_SECRET!,'device-key:'+provided)).first<{id:string;version:number}>();
  if(!device)throw new DashboardError('端末キーが正しくないか、この端末は無効化されています。',401);
  const expiry=now+30*DAY;
  const payload=`${device.id}.${device.version}.${expiry}`;
  const value=payload+'.'+await sign(env.DASHBOARD_SECRET!,'device:'+payload);
  return `lab_dashboard=${value}; Path=/dashboard; HttpOnly; SameSite=Strict; Max-Age=${30*86400}${new URL(request.url).protocol==='https:'?'; Secure':''}`;
}
const DAY=86400000;
export async function requireDevice(env:Env,request:Request,now:number) {
  configured(env);
  const cookie=request.headers.get('Cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith('lab_dashboard='))?.slice(14)??'';
  const [id,version,expiry,signature,...extra]=cookie.split('.'),ms=Number(expiry);
  if(extra.length||!id||!Number.isSafeInteger(Number(version))||!Number.isSafeInteger(ms)||ms<=now||ms>now+31*DAY||!await verify(env.DASHBOARD_SECRET!,'device:'+`${id}.${version}.${expiry}`,signature??''))throw new DashboardError('端末の認証が必要です。',401);
  // 端末を無効化・キー再発行した場合は、有効期限前のCookieも直ちに拒否する。
  const device=await env.DB.prepare('SELECT id,name FROM dashboard_devices WHERE id=? AND version=? AND enabled=1').bind(id,Number(version)).first<{id:string;name:string}>();
  if(!device)throw new DashboardError('この端末は無効化またはキー再発行されています。管理者に連絡してください。',401);
  return device;
}
// 共用端末では氏名選択を記録に用いる。本人確認ではなく、登録済み有効メンバーだけを許可する。
export async function requireMember(env:Env,user:unknown) {
  if(typeof user!=='string'||!/^U[A-Z0-9]+$/.test(user))throw new DashboardError('利用者を選択してください。',403);
  const member=await env.DB.prepare(`SELECT m.name FROM dashboard_members d JOIN member_names m USING(slack_user_id) WHERE d.slack_user_id=? AND d.enabled=1`).bind(user).first<{name:string}>();
  if(!member)throw new DashboardError('利用者が未登録または無効です。',403);
  return {id:user,name:member.name};
}
