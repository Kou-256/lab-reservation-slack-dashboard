import {washAction} from './washing-ui';
import {resourceAction} from './resource-ui';
import { day, localParts, parseDate, periodBounds } from './datetime';
import { calendarRows, subscriptionToken, changeSubscription, weekBounds } from './services/calendar';
import { maintenanceList, isAdmin, requireMaintenanceOwner, saveMaintenance, cancelMaintenance, maintenanceById, repairUpdates, addRepairUpdate } from './services/maintenance';
import { calendarModal } from './ui-calendar';
import { BookingError, peakUsage, Reservations } from './services/reservations';
import { memberName } from './services/member-names';
import { resolvePurpose, purposeOption } from './purpose';
import { meetingRooms } from './meeting';
import { meetingAction } from './services/meetings';
import { professorAction } from './services/professor';
import { professorCalendarAction } from './services/professor-batch';
import {toolsAction} from './booking-tools-ui';
import {extendBooking,maintenanceWarnings} from './services/booking-tools';
import { deliver, logFailure, refreshOperations, refreshPanel } from './services/notifications';
import { availabilityModal, bookingModal, button, cancelModal, finishModal, detail, homeView, listModal, notice, section, maintenanceDetail, maintenanceModal, purposeInput, option } from './ui';
import type { Booking, Change, Operation, Receipt, Reservation, Resource, SlackCall, SlackJSON,Env } from './types';

export function selected(view:SlackJSON,key:string,fallback:any='') {
  const v=view.state?.values?.[key]?.[key]??{};
  return v.selected_date??v.selected_time??v.value??v.selected_option?.value??fallback;
}
export function parseBooking(view:SlackJSON,r:Resource):Booking {
  try {
    const options:string[]=JSON.parse(r.purpose_options);
    const choice=resolvePurpose(selected(view,'purpose_choice'),options);
    const directInput=!view.blocks?.some((b:SlackJSON)=>b.block_id==='purpose_choice');
    const room=selected(view,'location_choice');
    if(r.schedule_event&&!meetingRooms.includes(room))throw new BookingError('使用する部屋を選択してください。');
    const time=(prefix:string)=>view.state?.values?.[`${prefix}_hour`]||view.state?.values?.[`${prefix}_minute`]
      ?`${selected(view,`${prefix}_hour`)}:${selected(view,`${prefix}_minute`)}`:selected(view,`${prefix}_time`);
    return {start_at:parseDate(selected(view,'start_date'),time('start')),
      end_at:parseDate(r.multi_day?selected(view,'end_date'):selected(view,'start_date'),time('end')),
      quantity:r.type==='quantity_resource'?Number(selected(view,'quantity')):1,pool_id:selected(view,'pool_id')||null,
      purpose:!options.length||directInput||choice==='自由入力'||choice==='その他'?selected(view,'purpose'):'',purpose_choice:choice==='自由入力'?'':choice,
      location:r.schedule_event?(room==='その他'?selected(view,'location_custom'):room):'',
      online_url:room==='オンライン'?selected(view,'online_url'):'',
      presenters:r.schedule_event&&view.state?.values?.presenters?(view.state.values.presenters.presenters.selected_options??[]).map((o:SlackJSON)=>o.value).filter((id:string)=>id!=='undecided'):undefined};
  } catch(error) { if(error instanceof BookingError)throw error;throw new BookingError('日付と時刻を正しく選択してください。'); }
}
async function renderList(service:Reservations,meta:SlackJSON,user:string) {
  const [start,end]=periodBounds(meta.period,service.clock());
  const resources=(await service.resources()).filter(r=>Boolean(r.schedule_event)===service.scheduleOnly);
  const rows=(await service.list(meta.resource==='all'?null:meta.resource,meta.mine?user:null,start,end)).filter(row=>resources.some(r=>r.id===row.resource_id));
  return listModal(await maintenanceWarnings(service,rows),resources,{...meta,now:service.clock(),viewer:user});
}
function origin(body:SlackJSON,service:Reservations):SlackJSON {
  if(body.view?.private_metadata) {
    const m=JSON.parse(body.view.private_metadata);
    return {origin_channel:m.origin_channel||service.operationsChannel,home:m.home===true,
      ...(body.view?.callback_id==='reservation_list'?{return_view:body.view.id,return_meta:m}:m.return_view?{return_view:m.return_view,return_meta:m.return_meta}:{})};
  }
  return {origin_channel:body.channel?.id||service.operationsChannel,home:body.view?.type==='home'};
}
async function open(slack:SlackCall,body:SlackJSON,view:SlackJSON) {
  return slack(body.view?.type==='modal'?'views.push':'views.open',{trigger_id:body.trigger_id,view});
}
export async function publishHome(service:Reservations,slack:SlackCall,user:string,result?:string) {
  const now=service.clock();
  await slack('views.publish',{user_id:user,view:homeView(await service.resources(),result,await service.list(null,null,now),now)});
}
export async function action(service:Reservations,slack:SlackCall,body:SlackJSON,baseURL?:string,googleCalendarId?:string,professorGoogleId?:string,env?:Env) {
  const a=body.actions[0],user=body.user.id;
  try {
    if(a.action_id.startsWith('wash_')){await washAction(service,slack,body);return;}
    if(a.action_id.startsWith('res_')){await resourceAction(service,slack,body);return;}
    if(a.action_id.startsWith('tools_')){await toolsAction(service,slack,body,env);return;}
    if(a.action_id.startsWith('prof_')) {
      if(['prof_subscribe','prof_sub_rotate','prof_sub_revoke','prof_ios_help','prof_google_help'].includes(a.action_id)){
        const {professorSubscription}=await import('./services/professor-calendar');
        await professorSubscription(slack,service.db,body,baseURL!,professorGoogleId,service.clock());return;
      }
      const bulk=body.view?.private_metadata&&JSON.parse(body.view.private_metadata).calendar_batch;
      if(a.action_id==='prof_add'||a.action_id.startsWith('prof_cal_')||a.action_id==='prof_mode'&&bulk)await professorCalendarAction(slack,body,service.clock());
      else await professorAction(service.db,slack,body,service.clock());return;
    }
    if(a.action_id.startsWith('meeting_')){await meetingAction(service,slack,body);return;}
    if(a.action_id.startsWith('maintenance_')) {
      if(a.action_id==='maintenance_manage') {
        const resources=(await service.resources()).filter(r=>!r.schedule_event&&r.enabled);
        const periods=await maintenanceList(service);
        const blocks:SlackJSON[]=[section('故障・点検の対象と期間を登録します。スターラーは指定した台数だけ停止します。既存予約は自動キャンセルしません。'),
          {type:'actions',elements:[{type:'static_select',action_id:'maintenance_resource',placeholder:{type:'plain_text',text:'設定する設備を選択'},options:resources.map(r=>({text:{type:'plain_text',text:r.name},value:r.id}))}]}];
        for(const p of periods)blocks.push({...section(`${resources.find(r=>r.id===p.resource_id)?.name||p.resource_id}\n${maintenanceDetail(p)}`),accessory:button(p.kind==='fault'?'修理状況を見る・追記':'状況を見る','maintenance_status',p.id)});
        await open(slack,body,{...notice('設備の故障・点検',''),blocks});
      }else if(a.action_id==='maintenance_status') {
        const p=await maintenanceById(service,a.value),r=await service.resource(p.resource_id),updates=await repairUpdates(service,p.id);
        const blocks:SlackJSON[]=[section(r.name),section(maintenanceDetail(p)),section(p.status==='active'?'現在：利用停止中':'現在：利用再開済み')];
        if(!updates.length&&p.kind==='fault')blocks.push(section('修理状況の追記はまだありません。'));
        for(const note of updates)blocks.push(section(note.content),{type:'context',elements:[{type:'mrkdwn',text:`<@${note.slack_user_id}>｜${localParts(note.created_at).date} ${localParts(note.created_at).time}（日本時間）`,verbatim:true}]});
        const buttons=[];
        if(p.kind==='fault'&&p.status==='active')buttons.push(button('修理状況を追記','maintenance_repair',p.id));
        if(p.status==='active'&&(p.slack_user_id===user||isAdmin(service,user)))buttons.push(button('利用再開','maintenance_cancel',p.id));
        if(buttons.length)blocks.push({type:'actions',elements:buttons});
        await open(slack,body,{...notice('故障・修理状況',''),blocks,private_metadata:JSON.stringify(origin(body,service))});
      }else if(a.action_id==='maintenance_repair') {
        const p=await maintenanceById(service,a.value);
        if(p.kind!=='fault'||p.status!=='active')throw new BookingError('この故障は解除済みです。画面を開き直してください。');
        await open(slack,body,{...notice('修理状況を追記',''),callback_id:'save_repair',submit:{type:'plain_text',text:'保存する'},close:{type:'plain_text',text:'戻る'},private_metadata:JSON.stringify({maintenance:p.id,nonce:crypto.randomUUID(),...origin(body,service)}),blocks:[section((await service.resource(p.resource_id)).name),section('現在の修理状況を追記します。過去の記録は残ります。'),{type:'input',block_id:'repair_status',label:{type:'plain_text',text:'修理状況'},element:{type:'plain_text_input',action_id:'repair_status',multiline:true,max_length:1000,placeholder:{type:'plain_text',text:'例：メーカーへ問い合わせ済み。部品の到着待ちです。'}}}]});
      }else if(a.action_id==='maintenance_resource') {
        const r=await service.resource(a.selected_option.value);
        const view=maintenanceModal(r,service.clock(),undefined,origin(body,service));
        await open(slack,body,view);
      }else if(a.action_id==='maintenance_kind') {
        const kind=a.selected_option.value;
        if(!['fault','inspection'].includes(kind))throw new BookingError('故障または点検を選択してください。');
        const meta=JSON.parse(body.view.private_metadata),r=await service.resource(meta.resource);
        const view=maintenanceModal(r,service.clock(),kind,meta);
        view.blocks=view.blocks.map((b:SlackJSON)=>['start_date','start_hour','start_minute','purpose','maintenance_quantity'].includes(b.block_id)?body.view.blocks.find((old:SlackJSON)=>old.block_id===b.block_id)??b:b);
        await slack('views.update',{view_id:body.view.id,hash:body.view.hash,view});
      }else if(a.action_id==='maintenance_cancel') {
        await requireMaintenanceOwner(service,user,a.value);
        const p=(await maintenanceList(service)).find(p=>p.id===a.value);
        if(!p)throw new BookingError('この期間は解除済みです。一覧を開き直してください。');
        await open(slack,body,{...notice('設備の利用を再開',`${(await service.resource(p.resource_id)).name}\n故障・点検を解除して予約を受け付けますか？\n${maintenanceDetail(p)}`),callback_id:'cancel_maintenance',submit:{type:'plain_text',text:'利用再開'},close:{type:'plain_text',text:'戻る'},private_metadata:JSON.stringify({id:p.id,...origin(body,service)})});
      }
      return;
    }
    if(['calendar_rotate','calendar_revoke'].includes(a.action_id)) {
      const subscription=await service.db.prepare('SELECT version FROM calendar_subscriptions WHERE slack_user_id=?').bind(user).first<{version:number}>();
      if(!subscription)throw new BookingError('購読URLがありません。案内を開き直してください。');
      await open(slack,body,{...notice('購読URLを変更',`${a.action_id==='calendar_rotate'?'新しいURLを発行':'現在のURLを失効'}しますか？\nご自分が発行した全員用・自分用の設備・ゼミ購読URLがすべて使えなくなります。${a.action_id==='calendar_rotate'?'Google・iOSで新しいURLの登録が必要です。':'保存済みの予定が端末から即座に消えるとは限りません。'}`),callback_id:'change_subscription',submit:{type:'plain_text',text:a.action_id==='calendar_rotate'?'再発行する':'失効する'},close:{type:'plain_text',text:'戻る'},private_metadata:JSON.stringify({version:subscription.version,revoke:a.action_id==='calendar_revoke',...origin(body,service)})});
      return;
    }
    if(a.action_id.startsWith('calendar_')) {
      if(a.action_id==='calendar_subscribe') {
        const label=service.scheduleOnly?'日程':'予約';
        await open(slack,body,{...notice('Google・iOSカレンダー',''),private_metadata:JSON.stringify(origin(body,service)),blocks:[section(`カレンダーへ表示する${label}を選択してください。`),{type:'actions',elements:[button(`全員の${label}`,'calendar_subscribe_all','all'),button(`自分の${label}だけ`,'calendar_subscribe_mine','mine','primary')]},section(`「自分の${label}だけ」は、このSlackアカウントで登録した予定のみです。Google・iOSに登録済みの全員用カレンダーから切り替える場合は、新しい購読URLを登録して、古い方の表示をオフにしてください。`),section('購読の更新にはGoogle・iOS側の取得間隔による遅延があります。')]});
      }else if(['calendar_subscribe_all','calendar_subscribe_mine'].includes(a.action_id)) {
        if(!baseURL) throw new BookingError('購読リンクを取得できませんでした。');
        const mine=a.action_id==='calendar_subscribe_mine';
        const token=await subscriptionToken(service.db,user,service.clock(),mine?'mine':'all');
        const link=new URL('/calendar.ics',baseURL);link.searchParams.set('token',token);
        if(service.scheduleOnly)link.searchParams.set('kind','schedule');
        const setup=new URL(link);setup.pathname='/calendar/setup';
        const googleLink=googleCalendarId&&!mine?`https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(googleCalendarId)}`:null;
        const direct:SlackJSON[]=googleLink?[
          section(`✅ 専用の「${service.scheduleOnly?'研究室ゼミ・隔週報':'研究室設備予約'}」Googleカレンダーへ登録・変更・キャンセルを自動反映します。変更操作はSlackから行ってください。`),
          {type:'actions',elements:[{type:'button',action_id:'calendar_google_help',text:{type:'plain_text',text:'管理者用：Googleカレンダーを開く'},url:googleLink}]},
          section(`iPhone：設定 → アプリ → カレンダー → カレンダーアカウント → アカウントを追加 → Google。共有を受けたGoogleアカウントでログインし、カレンダーをオンにしてください。カレンダーアプリの一覧で「${service.scheduleOnly?'研究室ゼミ・隔週報':'研究室設備予約'}」を選びます。`),
          section('予約はGoogleへ直接反映されますが、iPhone標準カレンダーの表示更新は端末の取得間隔に依存します。Googleカレンダーアプリでも確認できます。表示できない場合は管理者にGoogleアカウントへの共有を依頼してください。'),
          ]:[];
        await open(slack,body,{...notice('Google・iOSカレンダー',''),private_metadata:JSON.stringify(origin(body,service)),blocks:[
          section(`🔗 ${service.scheduleOnly?'ゼミ・隔週報':'設備予約'}：${mine?'自分の予約だけ':'全員の予約'}を購読`),
          ...(mine?[section('このURLは、発行したSlackユーザー本人の予約だけを配信します。予約・変更・キャンセルは次回の取得で反映されます。')]:[]),
          section('個人Gmailでも、次の秘密の購読URLから設備名・予約者・用途・場所を表示できます。メールアドレスの個別登録は不要です。一般公開にはしていません。'),
          section('Google（パソコン）：他のカレンダーの＋ → URLで追加 → 下のURLを貼り付けて追加。「予定あり」だけだった既存のカレンダーとは別のURL購読です。重複する場合は古い方の表示をオフにしてください。'),
          section('iPhone：下の「購読案内を開く」をSafariで開いて購読してください。'),
          section('次のURLをコピーして購読先に貼り付けてください。ファイルのインポートでは自動更新されません。'),
          {type:'section',text:{type:'mrkdwn',text:'```'+link.toString()+'```',verbatim:true}},
          {type:'actions',elements:[{type:'button',action_id:'calendar_ios_help',text:{type:'plain_text',text:'iPhone用の購読案内を開く'},url:setup.toString()}]},
          section('このリンクを知っている人は予約者・用途を含む予定を閲覧できます。研究室外へ共有しないでください。更新の間隔はGoogle・iOS側で決まり、即時反映は保証できません。読み取り専用です。変更・キャンセルはSlackから行ってください。'),
          {type:'actions',elements:[button('購読URLを再発行','calendar_rotate','self'),button('購読URLを失効','calendar_revoke','self','danger')]},
          ...(direct.length?[{type:'divider'},section('以下は所有者・個別共有権限があるアカウント用です。個人Gmailでのリンク共有は上のURL購読を使ってください。'),...direct]:[]) ]});
      } else if(!['calendar_ios_help','calendar_google_help'].includes(a.action_id)) {
        const meta=a.action_id==='calendar_open'?{date:localParts(service.clock()).date,resource:'all',...origin(body,service)}:JSON.parse(body.view.private_metadata);
        if(a.action_id==='calendar_date') meta.date=a.selected_date;
        if(a.action_id==='calendar_resource') meta.resource=a.selected_option.value;
        if(a.action_id==='calendar_today') meta.date=localParts(service.clock()).date;
        if(['calendar_prev','calendar_next'].includes(a.action_id)) meta.date=localParts(weekBounds(meta.date)[0]+(a.action_id==='calendar_next'?7:-7)*day).date;
        const [start,end]=weekBounds(meta.date);
        const resources=(await service.resources()).filter(r=>Boolean(r.schedule_event)===service.scheduleOnly);
        const rows=(await calendarRows(service.db,start,end,meta.resource==='all'?null:meta.resource)).filter(row=>resources.some(r=>r.id===row.resource_id));
        const view=calendarModal(rows,resources,meta);
        if(a.action_id==='calendar_open') await open(slack,body,view);
        else await slack('views.update',{view_id:body.view.id,hash:body.view.hash,view});
      }
    } else if(a.action_id==='refresh_status') {
      if(body.view?.type==='home') await publishHome(service,slack,user);
      else await refreshOperations(service,slack);
    } else if(['hub_list','hub_mine'].includes(a.action_id)) {
      await open(slack,body,await renderList(service,{resource:'all',mine:a.action_id==='hub_mine',period:'all',page:0,...origin(body,service)},user));
    } else if(a.action_id==='availability') {
      const resource=await service.resource(a.value);
      await open(slack,body,availabilityModal(resource,service.clock()));
    } else if(['book','list','mine','retry_booking'].includes(a.action_id)) {
      const draft=a.action_id==='retry_booking'?JSON.parse(a.value):null;
      const resource=await service.resource(draft?.resource??a.value);
      const home=body.view?.type==='home';
      if(!home && ![resource.channel_id,service.operationsChannel].filter(Boolean).includes(body.channel?.id)) throw new BookingError('パネルの設定が変わりました。管理者に確認してください。');
      // Old in-flight messages remain usable, but the published equipment panels only link to the hub.
      if(!resource.enabled) throw new BookingError('この設備は現在利用できません。');
      if(a.action_id==='book'||draft) {
        if(resource.type==='quantity_resource'&&resource.capacity===null) throw new BookingError('総台数が未設定です。管理者に設定を依頼してください。');
        let row:Reservation|undefined;
        if(draft?.reservation) row=await service.owned(draft.reservation,user);
        const view=bookingModal(resource,service.clock(),row);
        view.private_metadata=JSON.stringify({...JSON.parse(view.private_metadata),...origin(body,service)});
        if(draft?.booking) {
          const values={...row,...draft.booking} as Reservation;
          const filled=bookingModal(resource,service.clock(),values,JSON.parse(view.private_metadata));
          view.blocks=filled.blocks;
        }
        await slack('views.open',{trigger_id:body.trigger_id,view});
      } else await slack('views.open',{trigger_id:body.trigger_id,view:await renderList(service,{resource:a.action_id==='mine'?'all':resource.id,mine:a.action_id==='mine',period:'all',page:0,...origin(body,service)},user)});
      // No notification for opening a modal. Refresh current usage only.
      try { await refreshPanel(service,slack,resource.id); } catch { /* Next operation/admin refresh can repair it. */ }
    } else if(a.action_id==='finish_resource') {
      const resource=await service.resource(a.value),now=service.clock();
      if(resource.schedule_event)throw new BookingError('この操作は設備の利用予約のみ対象です。');
      const rows=(await service.list(resource.id,user)).filter(r=>r.start_at<now&&now<r.end_at);
      if(!rows.length)throw new BookingError('この設備で、現在利用中のご本人の予約はありません。');
      const view=rows.length===1?finishModal(rows[0],resource,now):{...notice('終了する予約を選択',''),blocks:[section('終了するご本人の予約を選んでください。'),...rows.slice(0,25).flatMap(row=>[section(`${resource.name}\n${detail(row,resource.type==='quantity_resource')}`),{type:'actions',elements:[button('今すぐ終了','finish',row.id)]}])]};
      view.private_metadata=JSON.stringify({...JSON.parse(view.private_metadata??'{}'),...origin(body,service)});await open(slack,body,view);
    } else if(['edit','cancel','finish','extend_30','extend_60'].includes(a.action_id)) {
      const row=await (['edit','cancel'].includes(a.action_id)?service.editable(a.value,user):service.owned(a.value,user)),resource=await service.resource(row.resource_id);
      row.maintenance_warning=(await maintenanceWarnings(service,[row]))[0].maintenance_warning;
      if(row.status!=='active'||row.end_at<=service.clock()) throw new BookingError('この予約は終了またはキャンセル済みです。');
      if(a.action_id==='finish'&&(resource.schedule_event||row.start_at>=service.clock()))throw new BookingError(resource.schedule_event?'この操作は設備の利用予約のみ対象です。':'まだ利用開始前です。開始後に「今すぐ終了」を押してください。');
      const extending=a.action_id.startsWith('extend_');
      if(extending&&(resource.schedule_event||row.start_at>=service.clock()))throw new BookingError('現在利用中の設備の予約だけ延長できます。');
      const minutes=a.action_id==='extend_30'?30:60;
      const view=extending?{...notice('予約を延長',`${resource.name}\n${detail(row,resource.type==='quantity_resource')}\n\n終了時刻を${minutes}分延長しますか？確定時に次の予約・故障・点検・台数を再確認します。`),callback_id:'extend_booking',submit:{type:'plain_text',text:'延長する'},close:{type:'plain_text',text:'戻る'},private_metadata:JSON.stringify({resource:resource.id,reservation:row.id,version:row.version,minutes,nonce:crypto.randomUUID()})}:a.action_id==='edit'?bookingModal(resource,service.clock(),row):a.action_id==='finish'?finishModal(row,resource,service.clock()):cancelModal(row,resource);
      view.private_metadata=JSON.stringify({...JSON.parse(view.private_metadata),...origin(body,service)});
      await open(slack,body,view);
    } else if(a.action_id.startsWith('list_')) {
      const meta=JSON.parse(body.view.private_metadata);
      if(a.action_id==='list_period') { meta.period=a.selected_option.value;meta.page=0; }
      if(a.action_id==='list_resource') { meta.resource=a.selected_option.value;meta.page=0; }
      if(['list_page','list_prev','list_next'].includes(a.action_id)) meta.page=Number(a.value);
      await slack('views.update',{view_id:body.view.id,hash:body.view.hash,view:await renderList(service,meta,user)});
    } else if(a.action_id==='purpose_choice') {
      const old=body.view;
      const meta=JSON.parse(old.private_metadata),resource=await service.resource(meta.resource);
      const choices:string[]=JSON.parse(resource.purpose_options),choice=resolvePurpose(a.selected_option?.value??'',choices);
      if(choice&&!choices.includes(choice))throw new BookingError('用途を選択してください。');
      const draft=old.state?.values?.purpose?.purpose?.value;
      if(typeof draft==='string')meta.purpose_draft=draft;
      const view:SlackJSON=Object.fromEntries(['type','title','submit','close','callback_id','private_metadata','blocks'].map(k=>[k,old[k]]));
      view.private_metadata=JSON.stringify(meta);
      view.blocks=view.blocks.filter((b:SlackJSON)=>b.block_id!=='purpose').map((b:SlackJSON)=>{
        if(b.block_id!=='purpose_choice')return b;
        const element={...b.element};delete element.initial_option;
        if(choice)element.initial_option=purposeOption(choice,choices);
        return {...b,dispatch_action:true,element};
      });
      if(choice==='自由入力'||choice==='その他')view.blocks.push(purposeInput(meta.purpose_draft??old.blocks.find((b:SlackJSON)=>b.block_id==='purpose')?.element.initial_value??''));
      await slack('views.update',{view_id:old.id,hash:old.hash,view});
    }
  } catch(error) {
    const code=error instanceof Error&&/^slack_[a-z0-9_]+$/.test(error.message)?error.message:error instanceof Error&&error.name==='TimeoutError'?'slack_timeout':'action_failed';
    console.error(JSON.stringify({kind:'action_error',code}));
    const message=error instanceof BookingError?error.message:'画面を開けませんでした。もう一度お試しください。';
    if(body.channel?.id) await slack('chat.postEphemeral',{channel:body.channel.id,user,text:message});
    else await open(slack,body,notice('操作できません',message));
  }
}

export async function submit(service:Reservations,slack:SlackCall,body:SlackJSON,afterCommit?:(receipt:Receipt)=>Promise<string>) {
  const view=body.view,meta=JSON.parse(view.private_metadata),user=body.user.id;
  const resultTarget=body.completion_external_id?{external_id:body.completion_external_id}:{view_id:view.id};
  const complete=async(message:string,title='操作が完了しました')=>{
    const content={...notice(title,message),close:{type:'plain_text',text:'一覧に戻る'},private_metadata:JSON.stringify(meta.return_meta??{resource:'all',period:'all'}),blocks:[section(message),{type:'actions',elements:[button('最新の一覧を見る','list_refresh','refresh')]}],...(body.completion_external_id?{external_id:body.completion_external_id}:{})};
    // Acknowledgement must reach Slack before the asynchronous update. Retry only this idempotent view update.
    for(let attempt=0;attempt<3;attempt++)try{await slack('views.update',{...resultTarget,view:content});return;}catch(error){
      if(attempt===2)throw error;
      await new Promise(resolve=>setTimeout(resolve,300*(attempt+1)));
    }
  };
  const finishing=view.callback_id==='finish_booking';
  const extending=view.callback_id==='extend_booking';
  const op:Operation=view.callback_id==='cancel_booking'?'cancelled':meta.reservation?'updated':'created';
  let resource:Resource;
  try { resource=await service.resource(meta.resource); }
  catch { if(meta.return_view)await complete('対象の日程が見つかりません。一覧を開き直してください。','保存できません');return; }
  const feedbackChannel=[service.operationsChannel,resource.channel_id].filter(Boolean).includes(meta.origin_channel)?meta.origin_channel:resource.channel_id;
  let booking:Booking|undefined,receipt;
  try {
    if(op!=='cancelled'&&!finishing&&!extending) booking=parseBooking(view,resource);
    const name=op==='created'?await memberName(service.db,slack,user):user;
    receipt=extending?await extendBooking(service,meta.nonce,user,meta.reservation,meta.version,meta.minutes):finishing?await service.finish(meta.nonce,user,meta.reservation,meta.version):await service.change(meta.nonce,op,resource.id,user,name,booking,meta.reservation,meta.version);
  } catch(error) {
    const message=error instanceof BookingError?error.message:'予約を保存できませんでした。少し待ってもう一度お試しください。';
    const blocks:SlackJSON[]=[section(message)];
    if(meta.return_view){await complete(message,'保存できません');return;}
    if(op!=='cancelled'&&!finishing&&!extending) blocks.push({type:'actions',elements:[button('入力を修正して再予約','retry_booking',JSON.stringify({resource:resource.id,reservation:meta.reservation,booking}))]});
    await slack('chat.postEphemeral',{channel:feedbackChannel,user,text:message,blocks});
    if(meta.home) await publishHome(service,slack,user,message);
    return;
  }
  // Only this branch (committed receipt) can post the channel history.
  // Stop the saving screen immediately after the DB commit, before slower external services.
  if(meta.return_view)try{await complete('✅ 保存しました。一覧・チャンネル・カレンダーを更新しています。');}catch(error){logFailure(receipt,'completion_view',error);}
  let calendarPending=false;
  if(afterCommit) try {calendarPending=await afterCommit(receipt)==='pending';} catch {calendarPending=true;}
  let notificationFailed=true,panelFailed=true;
  try { ({notificationFailed,panelFailed}=await deliver(service,slack,receipt)); }
  catch(error) { logFailure(receipt,'delivery',error); }
  const c=JSON.parse(receipt.payload) as Change;
  const message=extending?'✅ 予約を延長しました。':c.finished?'✅ 利用を終了しました。':c.resource.schedule_event?(op==='created'?'✅ 日程を登録しました。':op==='updated'?'✅ 日程を変更しました。':'✅ 日程をキャンセルしました。'):(op==='created'?'✅ 予約しました。':op==='updated'?'✅ 予約を変更しました。':'✅ 予約をキャンセルしました。');
  const warnings=[notificationFailed?'⚠️ 予約の保存は完了しましたが、チャンネル通知を確認できませんでした。予約をやり直す必要はありません。':'',panelFailed?'⚠️ 予約パネルの更新に失敗しました。予約一覧で最新情報を確認できます。':''].filter(Boolean);
  if(calendarPending)warnings.push('⚠️ 予約は保存済みです。Googleカレンダーへの反映は再試行中です。');
  const result=[message,c.resource.name,detail(c.after,c.resource.type==='quantity_resource'),...warnings].join('\n\n');
  if(meta.return_view){
    try{await slack('views.update',{view_id:meta.return_view,view:await renderList(service,meta.return_meta??{resource:'all',period:'all'},user)});}
    catch(error){logFailure(receipt,'list_refresh',error);warnings.push('一覧を自動更新できませんでした。一覧の「更新」を押してください。');}
    try{await complete([message,...warnings].join('\n\n'));}catch(error){logFailure(receipt,'completion_view',error);}return;
  }
  // The normal channel notice already confirms success; private channel messages are warnings only.
  const feedback=warnings.join('\n\n');
  try { if(feedback) await slack('chat.postEphemeral',{channel:feedbackChannel,user,text:feedback,blocks:[section(feedback)]}); }
  catch(error) { logFailure(receipt,'actor_feedback',error); }
  if(meta.home) try { await publishHome(service,slack,user,result); } catch(error) {logFailure(receipt,'home_feedback',error);}
}

export async function checkAvailability(service:Reservations,view:SlackJSON) {
  try {
    const resource=await service.resource(JSON.parse(view.private_metadata).resource);
    const b=parseBooking(view,resource);
    if(b.end_at<=b.start_at || b.start_at<service.clock()) throw new BookingError('現在以降の日時を選び、終了を開始より後にしてください。');
    if(!Number.isInteger(b.quantity)||b.quantity<1) throw new BookingError('使用台数を選択してください。');
    const blocked=await service.db.prepare("SELECT reason FROM maintenance_periods WHERE resource_id=? AND status='active' AND start_at<? AND (end_at IS NULL OR end_at>?) LIMIT 1").bind(resource.id,b.end_at,b.start_at).first<{reason:string}>();
    if(blocked&&resource.type!=='quantity_resource')throw new BookingError(`⚠️ 指定した時間帯は故障・点検のため利用できません。\n${blocked.reason}`);
    const rows=await service.list(resource.id,null,b.start_at,b.end_at);
    const offline=resource.type==='quantity_resource'?await service.unavailable(resource,b.start_at,b.end_at):[];
    let remaining=resource.type==='quantity_resource'?Math.max(0,(resource.capacity??0)-peakUsage([...rows,...offline],b.start_at,b.end_at)):rows.length?0:1;
    if(resource.pools?.length){const pool=resource.pools.find(p=>p.id===b.pool_id);if(!pool)throw new BookingError('使用場所を選択してください。');remaining=Math.min(remaining,Math.max(0,pool.capacity-peakUsage([...rows.filter(r=>!r.pool_id||r.pool_id===pool.id),...offline],b.start_at,b.end_at)));}

    return notice('空き状況',`${resource.name}\n${remaining>=b.quantity?'✅ 指定した日時・台数で予約できます。':'⚠️ 指定した日時・台数では予約できません。'}\n${resource.type==='quantity_resource'?`指定時間帯で予約可能：${remaining}台\n`:''}\n確認時点の情報です。予約の確定時にも空きを確認します。`);
  } catch(error) { return notice('空き状況',error instanceof BookingError?error.message:'空き状況を取得できませんでした。もう一度お試しください。'); }
}

export async function submitSettings(service:Reservations,slack:SlackCall,body:SlackJSON) {
  const view=body.view,meta=JSON.parse(view.private_metadata),user=body.user.id;
  let message:string;
  try {
    if(view.callback_id==='change_subscription') {
      if(!Number.isInteger(meta.version))throw new BookingError('画面を開き直してください。');
      const result=await changeSubscription(service.db,user,meta.version,meta.revoke===true,service.clock());
      message=result.meta.changes?meta.revoke?'✅ 購読URLを失効しました。':'✅ 購読URLを再発行しました。「Google・iOSカレンダー」を開いて新しいURLを登録してください。':'この操作は完了済みです。新しいURLは再び変更していません。';
    }else {
      if(view.callback_id==='cancel_maintenance') {await cancelMaintenance(service,user,meta.id);message='✅ 故障・点検期間を解除しました。';}
      else {
        const resource=await service.resource(meta.resource);
        const kind=selected(view,'maintenance_kind');
        if(!['fault','inspection'].includes(kind))throw new BookingError('故障または点検を選択してください。');
        const time=(prefix:string)=>`${selected(view,`${prefix}_hour`)}:${selected(view,`${prefix}_minute`)}`;
        let start:number,end:number|null;
        try {start=parseDate(selected(view,'start_date'),time('start'));end=kind==='fault'?null:parseDate(selected(view,'end_date'),time('end'));}catch{throw new BookingError('日付と時刻を正しく選択してください。');}
        const quantity=resource.type==='quantity_resource'?Number(selected(view,'maintenance_quantity',view.blocks?.some((b:SlackJSON)=>b.block_id==='maintenance_quantity')?'':resource.capacity)):1;
        const overlaps=await saveMaintenance(service,user,meta.nonce,resource.id,{start_at:start,end_at:end,quantity,purpose:selected(view,'purpose'),purpose_choice:''},kind);
        message=`✅ 故障・点検期間を登録しました。${overlaps.length?'\n⚠️ この期間に既存予約が'+overlaps.length+'件あります。予約一覧で確認し、利用者へ連絡してください。自動キャンセルはしていません。':''}`;
      }
      try {await refreshOperations(service,slack);const id=meta.resource||(await maintenanceById(service,meta.id)).resource_id;await refreshPanel(service,slack,id);}catch {message+='\n⚠️ パネルの更新に失敗しました。設定は保存済みです。';}
    }
  }catch(error) {message=error instanceof BookingError?error.message:'設定を保存できませんでした。画面を開き直してください。';}
  const channel=[service.operationsChannel].includes(meta.origin_channel)?meta.origin_channel:service.operationsChannel;
  if(channel)await slack('chat.postEphemeral',{channel,user,text:message});
}
export async function submitRepair(service:Reservations,slack:SlackCall,body:SlackJSON) {
  const meta=JSON.parse(body.view.private_metadata);
  let result:string;
  try {await addRepairUpdate(service,body.user.id,meta.maintenance,meta.nonce,selected(body.view,'repair_status'));result='✅ 修理状況を追記しました。故障中の設備の「修理状況」から確認できます。';}
  catch(error){result=error instanceof BookingError?error.message:'修理状況を保存できませんでした。画面を開き直してください。';}
  await slack('views.update',{view_id:body.view.id,view:notice('修理状況',result)});
}

