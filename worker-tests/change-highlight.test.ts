import {expect,it} from 'vitest';
import {notification,changedDetail,bookingModal,listModal} from '../src/ui';
import type {Change,Reservation,Resource,SlackJSON} from '../src/types';
const resource:Resource={id:'stirrer',name:'スターラー',channel_id:'C1',type:'quantity_resource',capacity:20,enabled:1,multi_day:1,purpose_options:'[]',revision:1};
const row:Reservation={id:'r',resource_id:'stirrer',slack_user_id:'U1',slack_user_name:'利用者A',start_at:Date.parse('2030-01-01T10:00:00+09:00'),end_at:Date.parse('2030-01-01T12:00:00+09:00'),quantity:4,purpose:'洗浄（1回目）',purpose_choice:'',location:'実験室B・ドラフト内',status:'active',version:1,created_at:0,updated_at:0};
const diff=(after:Partial<Reservation>,r=resource):Change=>({resource:r,before:row,after:{...row,...after}});
const bold=(block:SlackJSON)=>block.elements[0].elements.filter((e:SlackJSON)=>e.style?.bold).map((e:SlackJSON)=>e.text);
it('highlights only the changed end line for finish/extend; both snapshots remain visible',()=>{
  const c={...diff({end_at:row.end_at+1800000}),finished:true};
  const block=notification('updated',c).blocks.find(b=>b.type==='rich_text')!;
  expect(bold(block)).toHaveLength(2);expect(bold(block).every((x:string)=>x.startsWith('🔸変更 終了：'))).toBe(true);
  expect(JSON.stringify(block)).toContain('12:30');expect(JSON.stringify(block)).toContain('12:00');
});
it.each([
  [{start_at:row.start_at+60000},'開始：'],[{quantity:5},'使用台数'],
  [{purpose:''},'用途：'],[{location:'実験室B・ドラフト外',pool_id:'outside'},'場所：'],
  [{online_url:'https://example.com/meeting'},'オンラインURL：']
])('highlights changed field and keeps all unchanged fields plain: %j',(after,label)=>{
  const lines=bold(changedDetail(diff(after)));expect(lines).toHaveLength(2);expect(lines.every((x:string)=>x.includes(label))).toBe(true);
});
it('shows removed/added URLs, locations and purpose, with user input kept literal',()=>{
  const c=diff({purpose:'*text* <@U2> & <https://example.com|link>'});
  const b=changedDetail(c);expect(bold(b)[1]).toContain(c.after.purpose);
  expect(b.elements[0].elements.every((e:SlackJSON)=>e.type==='text')).toBe(true);
});
it('compares seminar presenters and preserves editor attribution; reports have no presenter field',()=>{
  const r={...resource,id:'english_seminar',type:'exclusive_room' as const,schedule_event:1};
  const c=diff({presenters:JSON.stringify([{id:'U2',name:'利用者X'}])},r);
  const message=notification('updated',c,0,'U2');expect(bold(message.blocks.find(b=>b.type==='rich_text')!)).toEqual(['🔸変更 担当者：担当未定\n','🔸変更 担当者：利用者X\n']);
  expect(JSON.stringify(message)).toContain('変更者：<@U2>');
  expect(JSON.stringify(changedDetail({...c,resource:{...r,id:'biweekly_report'}}))).not.toContain('担当者');
});
it('does not mark unchanged details as changed',()=>expect(bold(changedDetail(diff({})))).toEqual([]));
it.each(['洗浄（1回目）','洗浄（2回目）：試料A','洗浄'])('hides quick extensions for %s across notices, edit and list while retaining finish',(purpose)=>{
  const current={...row,purpose},now=row.start_at+60000;
  const views=[notification('created',{resource,before:null,after:current},now),bookingModal(resource,now,current),listModal([current],[resource],{viewer:'U1',now,resource:'stirrer'})];
  for(const view of views){const buttons=view.blocks.flatMap((b:SlackJSON)=>b.elements??[]);expect(buttons.some((b:SlackJSON)=>b.action_id==='finish')).toBe(true);expect(buttons.some((b:SlackJSON)=>b.action_id==='extend_30'||b.action_id==='extend_60')).toBe(false);}
});
it('keeps quick extensions for ordinary equipment reservations',()=>{
  const current={...row,purpose:'YVO4試料作製'},now=row.start_at+60000;
  for(const view of [notification('created',{resource,before:null,after:current},now),bookingModal(resource,now,current),listModal([current],[resource],{viewer:'U1',now,resource:'stirrer'})]){
    const buttons=view.blocks.flatMap((b:SlackJSON)=>b.elements??[]);for(const id of ['finish','extend_30','extend_60'])expect(buttons.some((b:SlackJSON)=>b.action_id===id)).toBe(true);
  }
});
