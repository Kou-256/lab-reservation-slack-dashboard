import type {Booking,Receipt,Reservation,Change} from '../types';
import {BookingError,Reservations} from './reservations';

export async function reserveWash(service:Reservations,user:string,name:string,key:string,resourceId:string,bookings:Booking[]):Promise<Receipt[]> {
  if(!/^[UW][A-Z0-9]+$/.test(user)||!/^[a-zA-Z0-9_-]{1,100}$/.test(key)||![1,2].includes(bookings.length))throw new BookingError('洗浄は1回または2回を選択してください。');
  const replay=async()=>{
    const saved=await service.db.prepare('SELECT * FROM wash_batches WHERE request_key=?').bind(key).first<{slack_user_id:string;resource_id:string;rounds:number}>();
    if(!saved)return null;
    if(saved.slack_user_id!==user||saved.resource_id!==resourceId)throw new BookingError('操作を確認できません。');
    const receipts:Receipt[]=[];
    for(let i=0;i<saved.rounds;i++){const row=await service.receipt(`${key}_${i+1}`,user,'created');if(!row)throw new BookingError('予約結果を確認できません。一覧を確認してください。');receipts.push(row);}
    return receipts;
  };
  for(let attempt=0;attempt<4;attempt++) {
    const saved=await replay();if(saved)return saved;
    const r=await service.resource(resourceId);
    if(!r.enabled||r.schedule_event||r.type!=='quantity_resource'||!r.pools?.length)throw new BookingError('場所別に管理するスターラーを選択してください。');
    if(bookings.length===2&&bookings[1].start_at<bookings[0].end_at)throw new BookingError('2回目は1回目が終了した後の日時を選んでください。');
    const rows:Reservation[]=[],receipts:Receipt[]=[];
    for(let i=0;i<bookings.length;i++){
      const b=bookings[i];await service.validateBooking(r,b,null,rows);
      const pool=r.pools.find(p=>p.id===b.pool_id)!;
      const after:Reservation={id:crypto.randomUUID(),resource_id:r.id,slack_user_id:user,slack_user_name:(name||user).slice(0,100),
        start_at:b.start_at,end_at:b.end_at,quantity:b.quantity,pool_id:pool.id,location:`${r.room||r.name}・${pool.name}`,
        purpose:b.purpose,purpose_choice:b.purpose_choice,status:'active',version:1,created_at:service.clock(),updated_at:service.clock(),presenters:'[]',online_url:''};
      rows.push(after);receipts.push({request_key:`${key}_${i+1}`,resource_id:r.id,reservation_id:after.id,slack_user_id:user,operation:'created',processed_at:service.clock(),payload:JSON.stringify({resource:r,before:null,after} satisfies Change)});
    }
    const statements=[service.db.prepare('INSERT INTO wash_batches VALUES(?,?,?,?,?)').bind(key,r.id,user,bookings.length,service.clock())];
    for(let i=0;i<receipts.length;i++){
      const row=receipts[i];
      statements.push(service.db.prepare(`INSERT INTO processed_requests(request_key,reservation_id,resource_id,slack_user_id,operation,expected_revision,payload,processed_at)
        VALUES(?,?,?,?,'created',${i===0?'?':'(SELECT revision FROM resources WHERE id=?)'},?,?)`)
        .bind(row.request_key,row.reservation_id,r.id,user,i===0?r.revision:r.id,row.payload,row.processed_at));
    }
    // D1 batch is one transaction: a failure in round two also rolls back round one and its notification job.
    try{await service.db.batch(statements);return receipts;}
    catch(error){const saved=await replay();if(saved)return saved;if(String(error).includes('stale_resource'))continue;throw error;}
  }
  throw new BookingError('他の方の予約を処理中です。少し待ってもう一度お試しください。');
}
