import {bookingModal,button,detail,notice,option,plain,section} from './ui';
import {BookingError,Reservations} from './services/reservations';
import {calendarStatus,editPurpose,reusableBookings,reuseBooking} from './services/booking-tools';
import {setReminders} from './services/reminders';
import {purposeMenu,resolvePurpose} from './purpose';
import {parseDate,localParts} from './datetime';
import type {Env,SlackCall,SlackJSON} from './types';
const field=(id:string,label:string,element:SlackJSON,optional=false)=>({type:'input',block_id:id,label:plain(label),optional,element:{...element,action_id:id}});
export async function toolsAction(service:Reservations,slack:SlackCall,body:SlackJSON,env?:Env){
  const a=body.actions[0],user=body.user.id,meta=body.view?.private_metadata?JSON.parse(body.view.private_metadata):{};
  let view:SlackJSON,replace=false;
  if(a.action_id==='tools_reminders'){
    const row=await service.db.prepare('SELECT enabled FROM reminder_preferences WHERE slack_user_id=?').bind(user).first<{enabled:number}>(),enabled=row?.enabled===1;
    view={...notice('個人の通知設定',''),callback_id:'save_tools_reminders',submit:plain('保存'),private_metadata:JSON.stringify({nonce:crypto.randomUUID()}),blocks:[section('初期設定はOFFです。ONにすると、設備予約の終了5分前と終了時刻に、Botからご本人だけへ通知します。ゼミ・隔週報は対象外です。'),
      field('enabled','終了時刻の通知',{type:'static_select',options:[option('OFF（通知しない）','off'),option('ON（本人へ通知）','on')],initial_option:option(enabled?'ON（本人へ通知）':'OFF（通知しない）',enabled?'on':'off')})]};
  }else if(a.action_id==='tools_reuse_pick'){
    const row=await service.owned(a.value,user),r=await service.resource(row.resource_id);if(r.schedule_event||!r.enabled)throw new BookingError('利用できる設備の予約を選んでください。');
    const seed=reuseBooking(row,service.clock());if(!r.multi_day)seed.end_at=Math.min(seed.end_at,parseDate(localParts(seed.start_at).date,'23:59'));
    view=bookingModal(r,service.clock(),{...seed,status:'active'},{resource:r.id,nonce:crypto.randomUUID(),origin_channel:meta.origin_channel??service.operationsChannel,
      ...(body.view?.callback_id==='reservation_list'?{return_view:body.view.id,return_meta:meta}:meta.return_view?{return_view:meta.return_view,return_meta:meta.return_meta}:{})});view.title=plain('予約を再利用');view.submit=plain('予約する');view.blocks.unshift(section('設備・用途・台数を引き継ぎました。開始日と終了日を確認してから予約してください。'));
  }else if(['tools_reuse','tools_reuse_next','tools_reuse_prev'].includes(a.action_id)){
    const page=a.action_id==='tools_reuse'?0:Math.max(0,Number(a.value)||0),rows=await reusableBookings(service,user,page),resources=await service.resources();
    const blocks:SlackJSON[]=[section('ご本人がよく使う予約内容です。再利用しても、確定するまでは新しい予約を保存しません。')];
    for(const row of rows.slice(0,5))blocks.push(section(`${resources.find(r=>r.id===row.resource_id)?.name??row.resource_id}（${row.uses}回）\n${detail(row,resources.find(r=>r.id===row.resource_id)?.type==='quantity_resource')}`),{type:'actions',elements:[button('この内容で予約','tools_reuse_pick',row.id)]});
    if(!rows.length)blocks.push(section('再利用できる予約はまだありません。'));
    const nav=[];if(page)nav.push(button('前へ','tools_reuse_prev',String(page-1)));if(rows.length>5)nav.push(button('次へ','tools_reuse_next',String(page+1)));if(nav.length)blocks.push({type:'actions',elements:nav});
    view={...notice('予約を再利用',''),blocks};replace=a.action_id!=='tools_reuse';
  }else if(a.action_id==='tools_purposes'){
    const resources=(await service.resources()).filter(r=>r.enabled&&!r.schedule_event);
    view={...notice('用途の選択肢を整理',''),blocks:[section('設備を選んで、用途の名前の統一・統合・非表示・再表示ができます。過去の予約の用途は変更しません。'),{type:'actions',elements:[{type:'static_select',action_id:'tools_purpose_resource',placeholder:plain('設備を選ぶ'),options:resources.map(r=>option(r.name,r.id))}]}]};
  }else if(['tools_purpose_resource','tools_purpose_restore'].includes(a.action_id)){
    const r=await service.resource(a.selected_option?.value??a.value),restore=a.action_id==='tools_purpose_restore';if(r.schedule_event)throw new BookingError('設備を選んでください。');
    const choices:string[]=restore?(await service.db.prepare('SELECT value FROM purpose_hidden WHERE resource_id=? ORDER BY hidden_at DESC,value').bind(r.id).all<{value:string}>()).results.map(x=>x.value):JSON.parse(r.purpose_options).filter((v:string)=>!['自由入力','その他'].includes(v));
    if(!choices.length)view={...notice('用途の選択肢を整理',''),blocks:[section(restore?'非表示の用途はありません。':'現在表示中の用途はありません。非表示の用途は下のボタンから再表示できます。'),{type:'actions',elements:[button(restore?'表示中の用途を整理':'非表示の用途を再表示',restore?'tools_purpose_resource':'tools_purpose_restore',r.id)]}]};
    else view={...notice(restore?'用途を再表示':'用途の選択肢を整理',''),callback_id:'save_tools_purpose',submit:plain('保存'),private_metadata:JSON.stringify({resource:r.id,revision:r.revision,restore,nonce:crypto.randomUUID()}),blocks:[section(r.name+'\n'+(restore?'選んだ用途を再びプルダウンに表示します。':'新しい名前を入力すると名前を統一します。既存の名前と同じにすると統合します。空欄なら非表示にします。予約履歴は変更しません。')),
      field('source','対象の用途',purposeMenu(choices)),...(!restore?[field('target','新しい名前（空欄なら非表示）',{type:'plain_text_input',max_length:300},true)]:[]),{type:'actions',elements:[button(restore?'表示中の用途を整理':'非表示の用途を再表示',restore?'tools_purpose_resource':'tools_purpose_restore',r.id)]}]};
    replace=true;
  }else if(a.action_id==='tools_sync'){
    const status=await calendarStatus(service,user,env),blocks:SlackJSON[]=[section('登録・変更・取消のGoogle同期状況です（過去分を含みます）。秘密URLの購読は端末側の取得間隔によって遅れます。Google・iOSからいつ取得されたかは、この画面では確認できません。')];
    if(status.configured===false)blocks.push(section('⚠️ Googleカレンダーの接続設定が未完了です。'));
    for(const name of ['設備予約','ゼミ・隔週報','担当教員先生の予定']){const rows=status.groups.filter(g=>g.name===name);blocks.push(section(name+'\n'+(rows.length?rows.map(g=>`${g.status==='synced'?'反映済み':'反映待ち'}：${g.count}件${g.errors?'（再試行中 '+g.errors+'件）':''}`).join('\n'):'同期対象はまだありません。')));}
    blocks.push(section('自分の最近の予約'));
    for(const r of status.own)blocks.push(section(`${r.name}\n${r.last_error?'⚠️ 反映エラー・自動再試行中':r.sync_status==='synced'&&r.synced_version>=r.version?'✅ 反映済み':'⏳ 反映待ち'}\n${detail(r,false)}`));
    view={...notice('カレンダーの同期状況',''),blocks:[...blocks,{type:'actions',elements:[button('最新に更新','tools_sync','refresh')]}]};replace=body.view?.title?.text==='カレンダーの同期状況';
  }else return;
  if(replace&&body.view?.id)await slack('views.update',{view_id:body.view.id,hash:body.view.hash,view});
  else await slack(body.view?.type==='modal'?'views.push':'views.open',{trigger_id:body.trigger_id,view});
}
export async function submitTools(service:Reservations,slack:SlackCall,body:SlackJSON){
  const v=body.view,m=JSON.parse(v.private_metadata),get=(key:string)=>v.state?.values?.[key]?.[key]??{};let message='設定を保存しました。';
  try{
    if(v.callback_id==='save_tools_reminders'){
      const value=get('enabled').selected_option?.value;if(!['on','off'].includes(value))throw new BookingError('ONまたはOFFを選んでください。');
      await setReminders(service.db,body.user.id,m.nonce,value==='on',service.clock());message=value==='on'?'終了時刻の通知をONにしました。ご本人だけに通知します。':'終了時刻の通知をOFFにしました。';
    }else {
      const previous=await service.db.prepare('SELECT resource_id,slack_user_id FROM purpose_edits WHERE request_key=?').bind(m.nonce).first<{resource_id:string;slack_user_id:string}>();
      if(previous){if(previous.resource_id!==m.resource||previous.slack_user_id!==body.user.id)throw new BookingError('操作を確認できません。');}
      else {
        const r=await service.resource(m.resource);if(r.revision!==m.revision)throw new BookingError('用途が更新されました。画面を開き直してください。');
        const choices:string[]=m.restore?(await service.db.prepare('SELECT value FROM purpose_hidden WHERE resource_id=? ORDER BY hidden_at DESC,value').bind(r.id).all<{value:string}>()).results.map(x=>x.value):JSON.parse(r.purpose_options).filter((v:string)=>!['自由入力','その他'].includes(v));
        await editPurpose(service,body.user.id,m.nonce,r.id,m.revision,resolvePurpose(get('source').selected_option?.value??'',choices),get('target').value??'',m.restore);
      }message='用途の選択肢を更新しました。予約履歴は変更していません。';
    }
  }catch(error){message=error instanceof BookingError?error.message:'設定を保存できませんでした。画面を開き直してください。';}
  await slack('views.update',{view_id:v.id,view:notice('設定',message)});
}
