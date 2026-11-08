import { localParts, range } from '../datetime';
import type { Booking, Change, Operation, Receipt, Reservation, Resource } from '../types';

export class BookingError extends Error {
  constructor(message: string, public field = 'start_date') { super(message); }
}
export function peakUsage(rows: Pick<Reservation,'start_at'|'end_at'|'quantity'>[], start: number, end: number) {
  const events = new Map<number, number>();
  for (const r of rows) {
    if (r.start_at >= end || r.end_at <= start) continue;
    const a = Math.max(start,r.start_at), b = Math.min(end,r.end_at);
    events.set(a,(events.get(a) ?? 0)+r.quantity);
    events.set(b,(events.get(b) ?? 0)-r.quantity);
  }
  let count=0, peak=0;
  for (const [,delta] of [...events].sort((a,b)=>a[0]-b[0])) { count+=delta; peak=Math.max(peak,count); }
  return peak;
}
export class Reservations {
  constructor(public db: D1Database, public clock=Date.now, public operationsChannel='',public scheduleOnly=false,public adminUserIds='') {}
  async resources() {
    const resources=(await this.db.prepare(`SELECT r.*,m.id AS maintenance_id,m.kind AS maintenance_kind,
      COALESCE((SELECT SUM(COALESCE(p.quantity,r.capacity,1)) FROM maintenance_periods p
        WHERE p.resource_id=r.id AND p.status='active' AND p.start_at<=? AND (p.end_at IS NULL OR p.end_at>?)),0) AS maintenance_quantity,
      (CASE WHEN m.kind='fault' THEN '故障（復旧まで）：' ELSE '点検中：' END)||m.reason AS maintenance_reason
      FROM resources r LEFT JOIN maintenance_periods m ON m.id=(SELECT id FROM maintenance_periods p
        WHERE p.resource_id=r.id AND p.status='active' AND p.start_at<=? AND (p.end_at IS NULL OR p.end_at>?)
        ORDER BY CASE WHEN p.kind='fault' THEN 0 ELSE 1 END,p.start_at,p.id LIMIT 1)
      ORDER BY r.created_at,r.id`).bind(this.clock(),this.clock(),this.clock(),this.clock()).all<Resource>()).results;
    return resources.map(r=>({...r,pools:JSON.parse(r.booking_pools??'[]')}));
  }
  async unavailable(resource:Resource,start:number,end:number) {
    const rows=(await this.db.prepare("SELECT start_at,end_at,quantity FROM maintenance_periods WHERE resource_id=? AND status='active' AND start_at<? AND (end_at IS NULL OR end_at>?)").bind(resource.id,end,start).all<{start_at:number;end_at:number|null;quantity:number|null}>()).results;
    return rows.map(row=>({start_at:row.start_at,end_at:row.end_at??end,quantity:row.quantity??resource.capacity??1}));
  }
  async resource(id: string) {
    const r=await this.db.prepare('SELECT * FROM resources WHERE id=?').bind(id).first<Resource>();
    if (!r) throw new BookingError('設備が見つかりません。');
    r.pools=JSON.parse(r.booking_pools??'[]');
    if(r.schedule_event)r.members=(await this.db.prepare('SELECT slack_user_id AS id,name FROM member_names ORDER BY name').all<{id:string;name:string}>()).results;
    return r;
  }
  async owned(id: string,user: string) {
    const r=await this.db.prepare('SELECT * FROM reservations WHERE id=? AND slack_user_id=?').bind(id,user).first<Reservation>();
    if (!r) throw new BookingError('ご本人の予約のみ操作できます。');
    return r;
  }
  async editable(id:string,user:string) {
    const row=await this.db.prepare(`SELECT b.* FROM reservations b JOIN resources r ON r.id=b.resource_id
      WHERE b.id=? AND (b.slack_user_id=? OR (r.schedule_event=1 AND r.id IN ('english_seminar','biweekly_report')))`)
      .bind(id,user).first<Reservation>();
    if(!row)throw new BookingError('ご本人の予約のみ操作できます。');
    return row;
  }
  async receipt(key: string,user: string,op: Operation) {
    const r=await this.db.prepare('SELECT * FROM processed_requests WHERE request_key=?').bind(key).first<Receipt>();
    if(r && (r.slack_user_id!==user || r.operation!==op)) throw new BookingError('操作を確認できません。');
    return r;
  }
  async list(resource: string|null=null,user: string|null=null,start=0,end=8_640_000_000_000_000) {
    return (await this.db.prepare(`SELECT * FROM reservations WHERE status='active' AND end_at>?
      AND (? IS NULL OR resource_id=?) AND (? IS NULL OR slack_user_id=?)
      AND start_at<? AND end_at>? ORDER BY start_at,id`).bind(this.clock(),resource,resource,user,user,end,start).all<Reservation>()).results;
  }
  async finish(key:string,user:string,id:string,version:number):Promise<Receipt> {
    if(!/^[A-Za-z0-9:_-]{1,150}$/.test(key))throw new BookingError('操作を確認できません。');
    for(let attempt=0;attempt<4;attempt++) {
      const replay=await this.receipt(key,user,'updated');
      if(replay){if(replay.reservation_id!==id||!JSON.parse(replay.payload).finished)throw new BookingError('操作を確認できません。');return replay;}
      const owned=await this.owned(id,user),resource=await this.resource(owned.resource_id);
      // Read the reservation again after the resource revision to serialize with other writers.
      const before=await this.owned(id,user),now=this.clock();
      if(resource.schedule_event)throw new BookingError('この操作は設備の利用予約のみ対象です。');
      if(before.status!=='active'||before.version!==version)throw new BookingError('この予約は変更または終了済みです。一覧を開き直してください。');
      if(now<=before.start_at)throw new BookingError('まだ利用開始前です。開始後に「今すぐ終了」を押してください。');
      if(now>=before.end_at)throw new BookingError('この予約はすでに終了しています。');
      const after={...before,end_at:now,version:before.version+1,updated_at:now};
      const payload=JSON.stringify({resource,before,after,finished:true} satisfies Change);
      try{
        await this.db.prepare('INSERT INTO processed_requests(request_key,reservation_id,resource_id,slack_user_id,operation,expected_revision,payload,processed_at) VALUES(?,?,?,?,?,?,?,?)')
          .bind(key,id,resource.id,user,'updated',resource.revision,payload,now).run();
        return (await this.receipt(key,user,'updated'))!;
      }catch(error){
        const replay=await this.receipt(key,user,'updated');if(replay&&replay.reservation_id===id&&JSON.parse(replay.payload).finished)return replay;
        if(String(error).includes('stale_resource'))continue;
        if(String(error).includes('stale_reservation'))throw new BookingError('この予約は変更済みです。一覧を開き直してください。');throw error;
      }
    }
    throw new BookingError('他の方の操作を処理中です。少し待ってもう一度押してください。');
  }
  async validateBooking(resource:Resource,b:Booking,before:Reservation|null=null,pending:Reservation[]=[]) {
    const now=this.clock();
    if(!b || !Number.isSafeInteger(b.start_at) || !Number.isSafeInteger(b.end_at) || Math.abs(b.start_at)>8e15 || Math.abs(b.end_at)>8e15) throw new BookingError('日時を正しく選択してください。');
    if(b.end_at<=b.start_at) throw new BookingError('終了は開始より後にしてください。','end_time');
    if(b.start_at<now && !(before && before.start_at===b.start_at && before.end_at>now)) throw new BookingError('過去の日時は予約できません。');
    if(b.end_at<=now) throw new BookingError('終了は現在より後にしてください。','end_time');
    if(!resource.multi_day && localParts(b.start_at).date!==localParts(b.end_at).date) throw new BookingError('同じ日付内で予約してください。','end_time');
    if(!Number.isInteger(b.quantity) || b.quantity<1 || (resource.type==='exclusive_room' && b.quantity!==1)) throw new BookingError('使用台数を正しく選択してください。','quantity');
    if(typeof b.purpose!=='string' || b.purpose.length>300) throw new BookingError('用途は300文字以内で入力してください。','purpose');
    if(b.location!==undefined&&(typeof b.location!=='string'||b.location.length>150))throw new BookingError('場所は150文字以内で入力してください。');
    if(resource.schedule_event&&!b.location?.trim())throw new BookingError('使用する部屋を選択し、その他の場合は場所を入力してください。');
    if(resource.schedule_event&&b.presenters?.some(id=>!resource.members?.some(m=>m.id===id)))throw new BookingError('担当者を選択し直してください。');
    if(b.online_url) {
      let valid=false;try{const url=new URL(b.online_url);valid=url.protocol==='https:'&&Boolean(url.hostname)&&!url.username&&!url.password&&!/\s/.test(b.online_url)&&b.online_url.length<=1000;}catch{}
      if(!valid)throw new BookingError('オンラインURLはhttps://から始まるURLを入力してください。');
    }
    const blocked=await this.db.prepare("SELECT * FROM maintenance_periods WHERE resource_id=? AND status='active' AND start_at<? AND (end_at IS NULL OR end_at>?) ORDER BY start_at LIMIT 1").bind(resource.id,b.end_at,b.start_at).first<{start_at:number;end_at:number|null;reason:string}>();
    if(blocked&&resource.type!=='quantity_resource')throw new BookingError(`⚠️ 故障・点検のため、この時間帯は利用できません。\n${blocked.end_at===null?'復旧まで利用停止（終了未定）':range(blocked.start_at,blocked.end_at)}\n${blocked.reason}`);
    const options: string[]=JSON.parse(resource.purpose_options);
    if(options.length && !options.includes(b.purpose_choice) && !(options.includes('自由入力')&&b.purpose_choice==='')) throw new BookingError('用途を選択してください。','purpose_choice');
    const rows=[...(await this.list(resource.id,null,b.start_at,b.end_at)).filter(r=>r.id!==before?.id),...pending.filter(r=>r.resource_id===resource.id&&r.start_at<b.end_at&&r.end_at>b.start_at)];
    if(resource.type==='exclusive_room' && !resource.schedule_event && rows.length) throw new BookingError(`⚠️ この時間帯はすでに予約されています。\n${range(rows[0].start_at,rows[0].end_at)} ${rows[0].slack_user_name}\n別の時間を選択してください。`);
    if(resource.type==='quantity_resource') {
      if(resource.capacity===null) throw new BookingError('総台数が未設定です。管理者に設定を依頼してください。');
      const offline=await this.unavailable(resource,b.start_at,b.end_at);
      const peak=peakUsage([...rows,...offline],b.start_at,b.end_at);
      const pools=resource.pools??[];
      if(pools.length){
        const selected=pools.find(p=>p.id===b.pool_id);
        if(!selected&&!(before&&!before.pool_id&&!b.pool_id))throw new BookingError('ドラフト内・ドラフト外の使用場所を選択してください。','pool_id');
        for(const pool of selected?[selected]:pools){
          const used=peakUsage([...rows.filter(r=>!r.pool_id||r.pool_id===pool.id),...offline],b.start_at,b.end_at);
          if(used+b.quantity>pool.capacity)throw new BookingError(`⚠️ ${pool.name}のスターラーが不足します。\n総数：${pool.capacity}台\n予約可能：${Math.max(0,pool.capacity-used)}台\n場所未設定の予約・故障点検も安全のため含めています。`,'quantity');
        }
      }else if(b.pool_id)throw new BookingError('使用場所を選択し直してください。','pool_id');
      if(peak+b.quantity>resource.capacity) throw new BookingError(`⚠️ 指定時間帯では${resource.name}が不足します。\n総数：${resource.capacity}台\n${offline.length?'予約・故障・点検の最大合計':'最大使用予定'}：${peak}台\n予約可能：${Math.max(0,resource.capacity-peak)}台`,'quantity');
    }
  }
  async change(key: string, op: Operation, resourceId: string, user: string, name: string,
    booking?: Booking, reservationId?: string, version?: number): Promise<Receipt> {
    if(!/^[A-Za-z0-9:_-]{1,150}$/.test(key)) throw new BookingError('操作を確認できません。');
    if(booking?.purpose_choice==='自由入力')booking={...booking,purpose_choice:''};
    for(let attempt=0;attempt<4;attempt++) {
      const replay=await this.receipt(key,user,op);
      if(replay) return replay;
      // Read revision BEFORE reservations. Any later writer invalidates the whole decision.
      const resource=await this.resource(resourceId);
      const before=op==='created'?null:await this.editable(reservationId!,user);
      if(before && (before.resource_id!==resource.id || before.status!=='active' || before.version!==version)) throw new BookingError('この予約は変更済みです。一覧を開き直してください。');
      if(op!=='cancelled' && (!resource.enabled || !resource.channel_id)) throw new BookingError('この設備は現在利用できません。');
      const now=this.clock();
      if(op!=='cancelled')await this.validateBooking(resource,booking!,before);
      const after: Reservation=op==='cancelled'?{...before!,status:'cancelled',version:before!.version+1,updated_at:now}:{
        id:before?.id??crypto.randomUUID(),resource_id:resource.id,slack_user_id:before?.slack_user_id??user,
        slack_user_name:before?.slack_user_name??(name||user).slice(0,100),
        start_at:booking!.start_at,end_at:booking!.end_at,quantity:booking!.quantity,
        purpose:booking!.purpose,purpose_choice:booking!.purpose_choice,pool_id:booking!.pool_id??null,
        location:resource.pools?.find(p=>p.id===booking!.pool_id)?`${resource.room||resource.name}・${resource.pools.find(p=>p.id===booking!.pool_id)!.name}`:booking!.location?.trim()??'',
        presenters:resource.schedule_event&&resource.id!=='biweekly_report'?JSON.stringify(booking!.presenters===undefined?JSON.parse(before?.presenters??'[]'):(resource.members??[]).filter(m=>booking!.presenters!.includes(m.id))):'[]',
        online_url:resource.schedule_event&&booking!.location==='オンライン'?(booking!.online_url??'').trim():'',
        status:'active',version:(before?.version??0)+1,created_at:before?.created_at??now,updated_at:now};
      const payload=JSON.stringify({resource,before,after} satisfies Change);
      try {
        await this.db.prepare(`INSERT INTO processed_requests(request_key,reservation_id,resource_id,slack_user_id,operation,expected_revision,payload,processed_at) VALUES(?,?,?,?,?,?,?,?)`)
          .bind(key,after.id,resource.id,user,op,resource.revision,payload,now).run();
        return (await this.receipt(key,user,op))!;
      } catch(error) {
        const replay=await this.receipt(key,user,op);
        if(replay) return replay;
        if(String(error).includes('stale_resource')) continue;
        if(String(error).includes('stale_reservation')) throw new BookingError('この予約は変更済みです。一覧を開き直してください。');
        throw error;
      }
    }
    throw new BookingError('他の方の操作を処理中です。少し待ってもう一度押してください。');
  }
}
