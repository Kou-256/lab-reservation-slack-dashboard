import type {Resource} from '../types';
import {BookingError,peakUsage,Reservations} from './reservations';

export interface ResourceInput {equipment_label:string;room:string;channel_id:string;type:Resource['type'];capacity:number;icon:string;multi_day:number;pool_capacities?:{id:string;capacity:number}[]}
export interface ResourceChange {request_key:string;resource_id:string;slack_user_id:string;operation:string;payload:string;created_at:number}
export async function changeResource(service:Reservations,user:string,key:string,id:string,operation:'created'|'updated'|'disabled'|'restored',revision:number,input?:ResourceInput):Promise<ResourceChange> {
  if(!/^[UW][A-Z0-9]+$/.test(user)||!/^[A-Za-z0-9_-]{1,150}$/.test(key)||!/^[A-Za-z0-9_-]{1,100}$/.test(id))throw new BookingError('操作を確認できません。');
  const replay=await service.db.prepare('SELECT * FROM resource_changes WHERE request_key=?').bind(key).first<ResourceChange>();
  if(replay){if(replay.slack_user_id!==user||replay.resource_id!==id||replay.operation!==operation)throw new BookingError('操作を確認できません。');return replay;}
  const before=operation==='created'?null:await service.resource(id);
  if(before&&(before.schedule_event||before.revision!==revision))throw new BookingError('設備の設定が更新されました。管理画面を開き直してください。');
  if(operation!=='created'&&operation!=='restored'&&!before!.enabled)throw new BookingError('削除済みです。必要な場合は再登録してください。');
  if(operation==='restored'&&before!.enabled)throw new BookingError('この設備は登録済みです。');
  let after:Resource=before?{...before}:{} as Resource;
  if(operation==='created'||operation==='updated') {
    if(!input||!['exclusive_room','quantity_resource'].includes(input.type))throw new BookingError('予約方式を選択してください。');
    const label=input.equipment_label?.trim(),room=input.room?.trim();
    if(!label||label.length>70||/[()（）\r\n]/.test(label)||!room||room.length>60||/[()（）\r\n]/.test(room))throw new BookingError('設備名と部屋名を、括弧・改行を使わずに入力してください。');
    if(!/^[CG][A-Z0-9]+$/.test(input.channel_id)||typeof input.icon!=='string'||input.icon.length>20)throw new BookingError('通知先チャンネルとアイコンを確認してください。');
    if(!Number.isInteger(input.capacity)||input.capacity<1||input.capacity>1000||![0,1].includes(input.multi_day))throw new BookingError('総台数は1〜1000台で入力してください。');
    if(before&&before.type!==input.type)throw new BookingError('既存設備の予約方式は変更できません。別の設備として追加してください。');
    after={...after,id,name:`${label}(${room})`,equipment_label:label,room,channel_id:input.channel_id,type:input.type,
      capacity:input.type==='quantity_resource'?input.capacity:1,icon:input.icon,multi_day:input.multi_day,
      enabled:before?.enabled??1,schedule_event:0,purpose_options:before?.purpose_options??'["自由入力"]',revision:before?.revision??0};
  }else after={...after,enabled:operation==='restored'?1:0};
  const pools=before?.pools??[];
  if(pools.length){
    const next=pools.map(p=>({...p,capacity:input?.pool_capacities?.find(x=>x.id===p.id)?.capacity??p.capacity}));
    if(next.some(p=>!Number.isInteger(p.capacity)||p.capacity<1||p.capacity>1000)||next.reduce((n,p)=>n+p.capacity,0)!==after.capacity)throw new BookingError('場所別の台数の合計と総台数を合わせてください。');
    after={...after,booking_pools:JSON.stringify(next),pools:next};
    if(after.enabled){const end=8_000_000_000_000_000,rows=await service.list(id),offline=await service.unavailable(after,service.clock(),end);
      for(const p of next)if(peakUsage([...rows.filter(r=>!r.pool_id||r.pool_id===p.id),...offline],service.clock(),end)>p.capacity)throw new BookingError(`${p.name}の既存予約・故障点検に必要な台数を下回ります。`);}
  }
  if(after.enabled&&after.type==='quantity_resource') {
    const end=8_000_000_000_000_000,rows=await service.list(id,null,service.clock(),end),offline=await service.unavailable(after,service.clock(),end);
    if(peakUsage([...rows,...offline],service.clock(),end)>(after.capacity??0))throw new BookingError('既存予約・故障・点検に必要な台数を下回ります。総台数を増やすか予定を確認してください。');
  }
  if(after.enabled&&!after.multi_day&&before?.multi_day) {
    const rows=await service.list(id);if(rows.some(r=>new Date(r.start_at+9*3600000).toISOString().slice(0,10)!==new Date(r.end_at+9*3600000).toISOString().slice(0,10)))throw new BookingError('日をまたぐ予約が残っているため、同日内の予約方式には変更できません。');
  }
  try{await service.db.prepare('INSERT INTO resource_changes VALUES(?,?,?,?,?,?,?)').bind(key,id,user,operation,revision,JSON.stringify({before,after}),service.clock()).run();}
  catch(error){
    const saved=await service.db.prepare('SELECT * FROM resource_changes WHERE request_key=?').bind(key).first<ResourceChange>();
    if(saved?.slack_user_id===user&&saved.resource_id===id&&saved.operation===operation)return saved;
    if(String(error).includes('duplicate_resource_name'))throw new BookingError('同じ名前・部屋の設備が登録済みです。');
    if(/stale_resource|resource_exists/.test(String(error)))throw new BookingError('別の方が設備を更新しました。管理画面を開き直してください。');throw error;
  }
  return (await service.db.prepare('SELECT * FROM resource_changes WHERE request_key=?').bind(key).first<ResourceChange>())!;
}
