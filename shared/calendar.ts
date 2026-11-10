import {DAY,jstDate,midnight} from './dashboard.js';
export interface CalendarResource{id:string;name:string;kind:'event'|'equipment';enabled:number;capacity:number|null;pools:{id:string;name:string;capacity:number}[]}
export interface CalendarItem{id:string;resource_id:string;title:string;description:string;person:string;date:string;start_at:number|null;end_at:number|null;quantity:number;location:string;pool_id:string|null;not_held:boolean}
export interface CalendarData{server_time:number;month:string;range_start:number;range_end:number;resources:CalendarResource[];items:CalendarItem[];upcoming:CalendarItem[]}
export function calendarRange(month:string,weekStart:0|1=1,compact=false){
 const start=midnight(month+'-01');
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||!Number.isFinite(start)||jstDate(start).slice(0,7)!==month||Number(month.slice(0,4))<1900||Number(month.slice(0,4))>2200)throw new Error('年月を確認してください。');
 const weekday=new Date(start+9*3600000).getUTCDay(),from=start-((weekday-weekStart+7)%7)*DAY;
 const next=midnight(new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),1)).toISOString().slice(0,10));
 return {start:from,end:from+(compact?Math.ceil((next-from)/DAY/7)*7:42)*DAY};
}
export function itemsOnDate(items:CalendarItem[],date:string){const start=midnight(date),end=start+DAY;return items.filter(i=>i.start_at===null?i.date===date:i.start_at<end&&i.end_at!==null&&i.end_at>start).sort((a,b)=>(a.start_at??midnight(a.date))-(b.start_at??midnight(b.date))||a.id.localeCompare(b.id));}


export interface CalendarSegment{item:CalendarItem;column:number;span:number;lane:number;continuesBefore:boolean;continuesAfter:boolean}
// 週境界で分割し、同じ日を占める予定は別の段へ置く。終了日の午前0時は前日まで。
export function calendarWeek(items:CalendarItem[],start:number){
 const end=start+7*DAY,segments:CalendarSegment[]=[],occupied:number[]=[];
 const sorted=items.filter(i=>i.start_at===null?midnight(i.date)>=start&&midnight(i.date)<end:i.start_at<end&&i.end_at!>start).map(item=>{
 const first=item.start_at===null?midnight(item.date):midnight(jstDate(item.start_at)),last=item.end_at===null?first+DAY:midnight(jstDate(item.end_at-1))+DAY;
 const column=Math.max(0,Math.round((first-start)/DAY)),stop=Math.min(7,Math.round((last-start)/DAY));return {item,column,span:stop-column,continuesBefore:first<start,continuesAfter:last>end};
 }).sort((a,b)=>b.span-a.span||a.column-b.column||(a.item.start_at??0)-(b.item.start_at??0)||a.item.id.localeCompare(b.item.id));
 for(const s of sorted){const mask=((1<<s.span)-1)<<s.column;let lane=occupied.findIndex(n=>(n&mask)===0);if(lane<0){lane=occupied.length;occupied.push(0);}occupied[lane]|=mask;segments.push({...s,lane});}return {segments,lanes:Math.max(1,occupied.length)};
}
