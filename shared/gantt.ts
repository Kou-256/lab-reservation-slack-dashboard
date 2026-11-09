import type {BookingView} from './dashboard';
// 同時予約は別レーンに分け、日跨ぎは表示範囲に切り詰める。終了時刻は含まない。
export function ganttLanes(rows:BookingView[],resource:string,start:number,end:number):BookingView[][] {
  const lanes:BookingView[][]=[];
  const visible=rows.filter(b=>b.resource_id===resource&&b.start_at<end&&b.end_at>start).sort((a,b)=>a.start_at-b.start_at||a.end_at-b.end_at||a.id.localeCompare(b.id));
  for(const booking of visible){const lane=lanes.find(l=>l.at(-1)!.end_at<=booking.start_at);if(lane)lane.push(booking);else lanes.push([booking]);}
  return lanes;
}
