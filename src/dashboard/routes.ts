import type {Booking,Env,Receipt} from '../types';
import {Reservations,BookingError} from '../services/reservations';
import {deliver} from '../services/notifications';
import {slackClient} from '../services/slack';
import {syncGoogleReservation} from '../services/google-calendar';
import {extendBooking} from '../services/booking-tools';
import {jstDate} from '../../shared/dashboard';
import {snapshot} from './data';
import {bookingHistory} from './history';
import {calendarData} from './calendar';
import {listDevices,manageDevice} from './devices';
import {DashboardError,securityHeaders,requireOrigin,readJSON,requireDevice,requireMember,deviceCookie,equalSecret,sign} from './auth';

const json=(value:unknown,status=200,extra:Record<string,string>={})=>Response.json(value,{status,headers:{...securityHeaders,...extra}});
type Dependencies={clock?:()=>number;notify?:(receipt:Receipt)=>Promise<{warnings:string[]}>};
export async function dashboardRoute(request:Request,env:Env,ctx:Pick<ExecutionContext,'waitUntil'>,deps:Dependencies={}):Promise<Response> {
  const url=new URL(request.url),path=url.pathname,now=(deps.clock??Date.now)();
  try {
    // 公開シェルに個人データは含めない。取得・書き込みAPIは必ず端末認証を通す。
    if((path==='/dashboard'||path==='/dashboard/')&&request.method==='GET') {
      if(!env.ASSETS)return new Response('画面のビルドが必要です。',{status:503,headers:securityHeaders});
      url.pathname='/dashboard/index.html';
      const response=await env.ASSETS.fetch(new Request(url,request));
      return new Response(response.body,{status:response.status,headers:{...Object.fromEntries(response.headers),...securityHeaders}});
    }
    if(path.startsWith('/dashboard/assets/')&&['GET','HEAD'].includes(request.method)) {
      if(!env.ASSETS)return new Response('Not found',{status:404});
      return env.ASSETS.fetch(request);
    }
    if(request.method==='POST')requireOrigin(request);
    if(['/admin/dashboard/devices','/admin/dashboard/device'].includes(path)){
      if(!env.ADMIN_TOKEN||!await equalSecret(request.headers.get('Authorization')??'',`Bearer ${env.ADMIN_TOKEN}`))throw new DashboardError('Unauthorized',401);
      if(path==='/admin/dashboard/devices'&&request.method==='GET')return json({devices:await listDevices(env)});
      if(path==='/admin/dashboard/device'&&request.method==='POST')return json({ok:true,...await manageDevice(env,await readJSON(request),now)});
      return json({error:'Not found'},404);
    }
    if(path==='/admin/dashboard/member'&&request.method==='POST') {
      if(!env.ADMIN_TOKEN||!await equalSecret(request.headers.get('Authorization')??'',`Bearer ${env.ADMIN_TOKEN}`))throw new DashboardError('Unauthorized',401);
      const body=await readJSON(request);
      if(!['enable','disable'].includes(String(body.action))||typeof body.user!=='string'||!/^U[A-Z0-9]+$/.test(body.user))throw new DashboardError('利用者とenableまたはdisableを指定してください。');
      if(!await env.DB.prepare('SELECT 1 FROM member_names WHERE slack_user_id=?').bind(body.user).first())throw new DashboardError('登録済みの利用者を指定してください。');
      // 旧スキーマの必須列には空文字を使い、PINは生成・照合しない。既存ハッシュは上書きしない。
      await env.DB.prepare(`INSERT INTO dashboard_members(slack_user_id,pin_salt,pin_hash,enabled,updated_at) VALUES(?,'','',?,?) ON CONFLICT(slack_user_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at`).bind(body.user,body.action==='enable'?1:0,now).run();
      return json({ok:true});
    }
    if(path==='/dashboard/api/unlock'&&request.method==='POST') {
      const body=await readJSON(request);
      if(typeof body.key!=='string'||body.key.length>200)throw new DashboardError('端末キーを入力してください。');
      return json({ok:true},200,{'Set-Cookie':await deviceCookie(env,request,body.key,now)});
    }
    if(path==='/dashboard/api/lock'&&request.method==='POST')return json({ok:true},200,{'Set-Cookie':`lab_dashboard=; Path=/dashboard; HttpOnly; SameSite=Strict; Max-Age=0${url.protocol==='https:'?'; Secure':''}`});
    await requireDevice(env,request,now);
    if(path==='/dashboard/api/snapshot'&&request.method==='GET')return json(await snapshot(env.DB,url.searchParams.get('date')??jstDate(now),now));
    if(path==='/dashboard/api/history'&&request.method==='GET')return json(await bookingHistory(env.DB,url.searchParams,now));
    if(path==='/dashboard/api/calendar'&&request.method==='GET')return json(await calendarData(env.DB,url.searchParams.get('month')??jstDate(now).slice(0,7),now));
    if(path==='/dashboard/api/bookings'&&request.method==='POST') {
      const body=await readJSON(request),member=await requireMember(env,body.user);
      const action=body.action,resourceId=body.resource_id,id=body.reservation_id,version=body.version;
      if(typeof body.request_id!=='string'||!/^[a-f0-9-]{36}$/.test(body.request_id)||typeof resourceId!=='string'||!['create','update','cancel','finish','extend'].includes(String(action)))throw new DashboardError('予約操作を確認できません。');
      const service=new Reservations(env.DB,()=>now,env.OPERATIONS_CHANNEL_ID,false,env.ADMIN_USER_IDS),resource=await service.resource(resourceId);
      if(resource.schedule_event)throw new DashboardError('設備予約だけが対象です。');
      if(action!=='create'&&(typeof id!=='string'||!Number.isSafeInteger(version)))throw new DashboardError('予約を選び直してください。');
      // 同じリクエストIDの再送では内容を変更できない。
      const canonical=JSON.stringify([member.id,action,resourceId,id??null,version??null,body.start_now===true,body.start_at??null,body.end_at??null,body.quantity??null,body.purpose??null,body.purpose_choice??null,body.pool_id??null,body.minutes??null]);
      const fingerprint=await sign(env.DASHBOARD_SECRET!,canonical),key='dashboard:'+body.request_id;
      await env.DB.prepare('INSERT INTO dashboard_operations(request_key,fingerprint) VALUES(?,?) ON CONFLICT DO NOTHING').bind(key,fingerprint).run();
      if((await env.DB.prepare('SELECT fingerprint FROM dashboard_operations WHERE request_key=?').bind(key).first<{fingerprint:string}>())?.fingerprint!==fingerprint)throw new DashboardError('送信内容が変わっています。予約画面を開き直してください。',409);
      const op=action==='create'?'created':action==='cancel'?'cancelled':'updated';
      let receipt=await service.receipt(key,member.id,op);
      const replay=Boolean(receipt);
      if(!receipt) {
        if(action==='finish')receipt=await service.finish(key,member.id,id as string,version as number);
        else if(action==='extend')receipt=await extendBooking(service,key,member.id,id as string,version as number,Number(body.minutes));
        else {
          let booking:Booking|undefined;
          if(action!=='cancel') {
            if(typeof body.purpose!=='string'||typeof body.purpose_choice!=='string'||(body.pool_id!=null&&typeof body.pool_id!=='string'))throw new DashboardError('用途と使用場所を確認してください。');
            if(typeof body.start_at!=='number'||typeof body.end_at!=='number'||typeof body.quantity!=='number')throw new DashboardError('日時と台数を確認してください。');
            booking={start_at:action==='create'&&body.start_now===true?now:body.start_at,end_at:body.end_at,quantity:body.quantity,purpose:body.purpose,purpose_choice:body.purpose_choice,pool_id:body.pool_id as string|null};
          }
          receipt=await service.change(key,op,resourceId,member.id,member.name,booking,id as string|undefined,version as number|undefined);
        }
      }
      // 保存後の外部連携失敗を予約失敗として返さない。既存の再送防止と同期キューを利用する。
      const saved=receipt;
      if(!replay)ctx.waitUntil((deps.notify?deps.notify(saved):notify(env,saved)).catch(()=>{console.error(JSON.stringify({kind:'dashboard_delivery_failed',reservation_id:saved.reservation_id}));}));
      return json({ok:true,reservation_id:saved.reservation_id,replayed:replay,message:'保存しました。Slack通知・カレンダーへの反映は順次行います。'});
    }
    return json({error:'Not found'},404);
  } catch(error) {
    if(error instanceof DashboardError)return json({error:error.message},error.status,error.status===429?{'Retry-After':'900'}:{});
    if(error instanceof BookingError)return json({error:error.message},409);
    console.error(JSON.stringify({kind:'dashboard_request_failed',path}));
    return json({error:'処理結果を確認できません。同じ内容で再試行してください。'},503);
  }
}
async function notify(env:Env,receipt:Receipt) {
  const warnings:string[]=[];
  try{if(await syncGoogleReservation(env,receipt.reservation_id)==='pending')warnings.push('calendar');}catch{warnings.push('calendar');}
  const result=await deliver(new Reservations(env.DB,Date.now,env.OPERATIONS_CHANNEL_ID),slackClient(env.SLACK_BOT_TOKEN),receipt);
  if(result.notificationFailed)warnings.push('notification');if(result.panelFailed)warnings.push('panel');
  if(warnings.length)console.error(JSON.stringify({kind:'dashboard_delivery_pending',reservation_id:receipt.reservation_id,warnings}));
  return {warnings};
}
