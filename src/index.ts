import {submitWash} from './washing-ui';
import {dashboardRoute} from './dashboard/routes';
import {submitResource,refreshResourceHistory} from './resource-ui';
import type { Env, SlackJSON } from './types';
import { verifySlack } from './signature';
import { slackClient } from './services/slack';
import { Reservations } from './services/reservations';
import { action, checkAvailability, publishHome, submit, submitSettings, submitRepair } from './handlers';
import { notice } from './ui';
import { submitMeeting } from './services/meetings';
import { parseProfessor, refreshProfessor, submitProfessor } from './services/professor';
import {parseProfessorDates,professorDateError,submitProfessorDates} from './services/professor-batch';
import {professorCalendarResponse,professorSetup,submitProfessorSubscription,syncProfessorPending} from './services/professor-calendar';
import {submitTools} from './booking-tools-ui';
import {sendDueReminders} from './services/reminders';
import { BookingError } from './services/reservations';
import { refreshHistorical, refreshOperations, refreshPanel } from './services/notifications';
import { calendarResponse, calendarSetupResponse } from './services/calendar';
import { googleConfigured, seedGoogleSync, syncGooglePending, syncGoogleReservation } from './services/google-calendar';

export default {
  async scheduled(_event:ScheduledController,env:Env):Promise<void> {
    if(env.RESTORE_MODE==='1')return;
    // Keep background API work bounded; successful bookings still push immediately.
    const jobs=await Promise.allSettled([refreshResourceHistory(new Reservations(env.DB),slackClient(env.SLACK_BOT_TOKEN)),syncGooglePending(env,1),syncProfessorPending(env,1),sendDueReminders(new Reservations(env.DB),slackClient(env.SLACK_BOT_TOKEN)),refreshProfessor(env.DB,slackClient(env.SLACK_BOT_TOKEN)),env.OPERATIONS_CHANNEL_ID?refreshOperations(new Reservations(env.DB,Date.now,env.OPERATIONS_CHANNEL_ID),slackClient(env.SLACK_BOT_TOKEN)):Promise.resolve(),env.SCHEDULE_CHANNEL_ID?refreshOperations(new Reservations(env.DB,Date.now,env.SCHEDULE_CHANNEL_ID,true),slackClient(env.SLACK_BOT_TOKEN)):Promise.resolve()]);
    jobs.forEach((job,index)=>{if(job.status==='rejected')console.error(JSON.stringify({kind:'background_job_failed',job:index}));});
  },
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response> {
    const path=new URL(request.url).pathname;
    if(env.RESTORE_MODE==='1'&&path!=='/health')return new Response('復元作業中です。しばらくお待ちください。',{status:503,headers:{'Retry-After':'60'}});
    if(path==='/dashboard'||path.startsWith('/dashboard/')||path.startsWith('/admin/dashboard/'))return dashboardRoute(request,env,ctx);
    if(path==='/calendar.ics'&&['GET','HEAD'].includes(request.method)) return calendarResponse(request,env.DB);
    if(path==='/calendar/setup'&&request.method==='GET')return calendarSetupResponse(request,env.DB);
    if(path==='/professor/calendar.ics'&&['GET','HEAD'].includes(request.method))return professorCalendarResponse(request,env.DB);
    if(path==='/professor/calendar/setup'&&request.method==='GET')return professorSetup(request,env.DB);
    if(path==='/health'&&request.method==='GET') return Response.json({ok:true,service:'lab-reservation',restore_mode:env.RESTORE_MODE==='1'});
    if(path==='/admin/professor-panel'&&request.method==='POST') {
      if(!env.ADMIN_TOKEN||request.headers.get('Authorization')!==`Bearer ${env.ADMIN_TOKEN}`)return new Response('Unauthorized',{status:401});
      const args=await request.json() as {channel_id?:string;create?:boolean};
      try{await refreshProfessor(env.DB,slackClient(env.SLACK_BOT_TOKEN),Date.now(),args.channel_id,args.create===true);return Response.json({ok:true});}
      catch{return Response.json({ok:false,error:'professor_panel_update_failed'},{status:502});}
    }
    if(path==='/admin/calendar-sync'&&request.method==='POST') {
      if(!env.ADMIN_TOKEN||request.headers.get('Authorization')!==`Bearer ${env.ADMIN_TOKEN}`)return new Response('Unauthorized',{status:401});
      if(!googleConfigured(env))return Response.json({ok:false,error:'google_calendar_not_configured'},{status:409});
      await seedGoogleSync(env);ctx.waitUntil(syncGooglePending(env));return Response.json({ok:true,queued:true});
    }
    if(['/admin/panels','/admin/operations','/admin/history'].includes(path)&&request.method==='POST') {
      if(!env.ADMIN_TOKEN || request.headers.get('Authorization')!==`Bearer ${env.ADMIN_TOKEN}`) return new Response('Unauthorized',{status:401});
      const args=await request.json() as {resource_id:string;create?:boolean;schedule?:boolean;resource_ids?:string[];offset?:number;limit?:number};
      const service=new Reservations(env.DB,Date.now,args.schedule?env.SCHEDULE_CHANNEL_ID:env.OPERATIONS_CHANNEL_ID,args.schedule===true);
      try {
        if(path==='/admin/history')return Response.json({ok:true,...await refreshHistorical(service,slackClient(env.SLACK_BOT_TOKEN),args.resource_ids??[],args.offset??0,args.limit)});
        else if(path==='/admin/operations') await refreshOperations(service,slackClient(env.SLACK_BOT_TOKEN),args.create===true);
        else await refreshPanel(service,slackClient(env.SLACK_BOT_TOKEN),args.resource_id,args.create===true);
        return Response.json({ok:true}); }
      catch(error) {const message=(error instanceof Error?error.message:'admin_operation_failed').replace(/xox[baprs]-[^\s]+/g,'[redacted]').slice(0,300);console.error(JSON.stringify({kind:'admin_operation',path,error:message}));return Response.json({ok:false,error:message},{status:502}); }
    }
    if(path!=='/slack/events'||request.method!=='POST') return new Response('Not found',{status:404});
    const reader=request.body?.getReader();
    const chunks:Uint8Array[]=[];
    let size=0;
    if(reader) while(true) {
      const part=await reader.read();if(part.done)break;
      size+=part.value.length;
      if(size>200_000) {await reader.cancel();return new Response('Too large',{status:413});}
      chunks.push(part.value);
    }
    const bytes=new Uint8Array(size);let offset=0;
    for(const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.length;}
    const raw=new TextDecoder().decode(bytes);
    if(!await verifySlack(raw,request.headers,env.SLACK_SIGNING_SECRET)) return new Response('Invalid signature',{status:401});
    let body:SlackJSON;
    try { body=request.headers.get('content-type')?.includes('application/json')?JSON.parse(raw):JSON.parse(new URLSearchParams(raw).get('payload')??'{}'); }
    catch { return new Response('Invalid payload',{status:400}); }
    if(body.type==='url_verification') return Response.json({challenge:body.challenge});
    if((body.team?.id??body.team_id)!==env.SLACK_TEAM_ID||body.api_app_id!==env.SLACK_APP_ID) return new Response('Workspace mismatch',{status:403});
    let origin=body.channel?.id;
    try {origin=JSON.parse(body.view?.private_metadata??'{}').origin_channel||origin;}catch{}
    let schedule=Boolean(env.SCHEDULE_CHANNEL_ID&&origin===env.SCHEDULE_CHANNEL_ID);
    let resourceId:string|undefined;
    try {resourceId=JSON.parse(body.view?.private_metadata??'{}').resource;}catch{}
    if(!resourceId&&['book','list','mine','availability'].includes(body.actions?.[0]?.action_id))resourceId=body.actions[0].value;
    if(resourceId) {const r=await env.DB.prepare('SELECT schedule_event FROM resources WHERE id=?').bind(resourceId).first<{schedule_event:number}>();if(r)schedule=Boolean(r.schedule_event);}
    else if(['edit','cancel'].includes(body.actions?.[0]?.action_id)) {
      const r=await env.DB.prepare('SELECT r.schedule_event FROM resources r JOIN reservations b ON r.id=b.resource_id WHERE b.id=?').bind(body.actions[0].value).first<{schedule_event:number}>();if(r)schedule=Boolean(r.schedule_event);
    }
    const service=new Reservations(env.DB,Date.now,schedule?env.SCHEDULE_CHANNEL_ID:env.OPERATIONS_CHANNEL_ID,schedule,env.ADMIN_USER_IDS),slack=slackClient(env.SLACK_BOT_TOKEN);
    const run=(task:Promise<unknown>)=>ctx.waitUntil(task.catch(()=>console.error('Slack操作処理に失敗しました。機密ペイロードは記録しません。')));
    if(body.type==='block_actions') { run(action(service,slack,body,new URL(request.url).origin,googleConfigured(env)?(schedule?env.SCHEDULE_GOOGLE_CALENDAR_ID:env.GOOGLE_CALENDAR_ID):undefined,env.PROFESSOR_GOOGLE_CALENDAR_ID,env));return new Response(''); }
    if(body.type==='event_callback'&&body.event?.type==='app_home_opened'&&body.event.tab==='home') {
      run(publishHome(service,slack,body.event.user));return new Response('');
    }
    if(body.type==='view_submission'&&body.view?.callback_id==='check_availability') {
      return Response.json({response_action:'update',view:await checkAvailability(service,body.view)});
    }
    if(body.type==='view_submission'&&['save_professor','cancel_professor'].includes(body.view?.callback_id)) {
      try {
        const input=body.view.callback_id==='save_professor'?parseProfessor(body.view):undefined;
        run(submitProfessor(env.DB,slack,body,input).then(()=>syncProfessorPending(env)));return Response.json({response_action:'update',view:notice('保存中','予定を保存しています…')});
      }catch(error){return Response.json({response_action:'errors',errors:{[error instanceof BookingError?error.field:'start_date']:error instanceof BookingError?error.message:'入力内容を確認してください。'}});}
    }
    if(body.type==='view_submission'&&body.view?.callback_id==='save_professor_bulk') {
      try{const inputs=parseProfessorDates(body.view);run(submitProfessorDates(env.DB,slack,body,inputs).then(()=>syncProfessorPending(env)));return Response.json({response_action:'update',view:notice('保存中','選んだ日付の予定を保存しています…')});}
      catch(error){return Response.json({response_action:'update',view:professorDateError(body.view,error instanceof BookingError?error.message:'日付と入力内容を確認してください。')});}
    }
    if(body.type==='view_submission'&&body.view?.callback_id==='save_meeting') {
      const result=await submitMeeting(service,body);if(result.response_action==='update')ctx.waitUntil(syncGooglePending(env,3));
      return Response.json(result);
    }
    if(body.type==='view_submission'&&body.view?.callback_id==='prof_subscription') {
      run(submitProfessorSubscription(env.DB,slack,body));return Response.json({response_action:'update',view:notice('変更中','購読URLを変更しています…')});
    }
    if(body.type==='view_submission'&&body.view?.callback_id==='save_wash') {
      const completionId='wash-result-'+crypto.randomUUID();body.completion_external_id=completionId;
      run(submitWash(service,slack,body,env));return Response.json({response_action:'update',view:{...notice('予約中','洗浄の予約を確認しています…'),external_id:completionId}});
    }
    if(body.type==='view_submission'&&body.view?.callback_id==='save_resource') {
      const completionId='resource-result-'+crypto.randomUUID();body.completion_external_id=completionId;
      run(submitResource(service,slack,body,env));
      return Response.json({response_action:'update',view:{...notice('保存中','設備の設定を保存しています…'),external_id:completionId}});
    }
    if(body.type==='view_submission'&&['save_tools_reminders','save_tools_purpose'].includes(body.view?.callback_id)){
      run(submitTools(service,slack,body));return Response.json({response_action:'update',view:notice('保存中','設定を保存しています…')});
    }
    if(body.type==='view_submission'&&body.view?.callback_id==='save_repair') {
      run(submitRepair(service,slack,body));return Response.json({response_action:'update',view:notice('修理状況','修理状況を保存しています…')});
    }
    if(body.type==='view_submission'&&['save_maintenance','cancel_maintenance','change_subscription'].includes(body.view?.callback_id)) {
      run(submitSettings(service,slack,body));return Response.json({response_action:'clear'});
    }
    if(body.type==='view_submission'&&['save_booking','cancel_booking','finish_booking','extend_booking'].includes(body.view?.callback_id)) {
      // Ack before D1/API latency can exceed Slack's 3 seconds. Result is private in-channel.
      const meta=JSON.parse(body.view.private_metadata);
      // response_action may replace the submitted view ID. Address the acknowledged view by a stable external ID.
      const completionId=meta.return_view?'booking-result-'+crypto.randomUUID():undefined;
      if(completionId)body.completion_external_id=completionId;
      run(submit(service,slack,body,receipt=>syncGoogleReservation(env,receipt.reservation_id)));
      return Response.json(completionId?{response_action:'update',view:{...notice('保存中','予定を更新しています…'),external_id:completionId}}:{response_action:'clear'});
    }
    return new Response('');
  }
} satisfies ExportedHandler<Env>;
