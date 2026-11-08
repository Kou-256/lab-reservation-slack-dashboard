import { dateLabel, day, localParts } from './datetime';
import { weekBounds } from './services/calendar';
import { button, option, plain, section } from './ui';
import type { Reservation, Resource, SlackJSON } from './types';
import { calendarPerson } from './meeting';

export function calendarModal(rows:Reservation[],resources:Resource[],meta:SlackJSON):SlackJSON {
  const [start,end]=weekBounds(meta.date);
  const options=[option('すべての設備','all'),...resources.filter(r=>r.enabled).map(r=>option(r.name,r.id))];
  const blocks:SlackJSON[]=[section(`${dateLabel(start)} ～ ${dateLabel(end-day)}（日本時間）`),
    {type:'actions',elements:[{type:'static_select',action_id:'calendar_resource',options,initial_option:options.find(x=>x.value===meta.resource)??options[0]},
      {type:'datepicker',action_id:'calendar_date',initial_date:meta.date,placeholder:plain('日付を選択')}]},
    {type:'actions',elements:[button('前の週','calendar_prev','prev'),button('今週','calendar_today','today'),button('次の週','calendar_next','next'),button('最新に更新','calendar_refresh','refresh')]}];
  for(let i=0;i<7;i++) {
    const a=start+i*day,b=a+day;
    const matches=rows.filter(r=>r.status==='active'&&r.start_at<b&&r.end_at>a&&(meta.resource==='all'||r.resource_id===meta.resource));
    const entries=matches.slice(0,10).map(r=>{
      const resource=resources.find(x=>x.id===r.resource_id);
      const start=r.start_at<a?'00:00':localParts(r.start_at).time,end=r.end_at>=b?'24:00':localParts(r.end_at).time;
      const who=resource?calendarPerson(r,resource):r.slack_user_name;
      return `${start} ～ ${end}　${resource?.name??r.resource_id}${resource?.type==='quantity_resource'?` ${r.quantity}台`:''}${who?'\n'+who:''}`;
    });
    blocks.push({type:'divider'},section(`${dateLabel(a)}\n\n${entries.length?entries.join('\n\n'):'予約なし'}${matches.length>10?`\n\nほか${matches.length-10}件。設備を選んで絞り込んでください。`:''}`));
  }
  return {type:'modal',title:plain('📅 予約カレンダー'),close:plain('閉じる'),private_metadata:JSON.stringify(meta),blocks};
}
