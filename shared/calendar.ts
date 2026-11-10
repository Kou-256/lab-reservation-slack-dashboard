import {DAY,jstDate,midnight} from './dashboard.js';
export interface CalendarResource{id:string;name:string;kind:'event'|'equipment';enabled:number;capacity:number|null;pools:{id:string;name:string;capacity:number}[]}
export interface CalendarItem{id:string;resource_id:string;title:string;description:string;person:string;date:string;start_at:number|null;end_at:number|null;quantity:number;location:string;pool_id:string|null;not_held:boolean}
export interface CalendarData{server_time:number;month:string;range_start:number;range_end:number;resources:CalendarResource[];items:CalendarItem[];upcoming:CalendarItem[]}
export function calendarRange(month:string){
 const start=midnight(month+'-01');
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||!Number.isFinite(start)||jstDate(start).slice(0,7)!==month||Number(month.slice(0,4))<1900||Number(month.slice(0,4))>2200)throw new Error('年月を確認してください。');
 const weekday=new Date(start+9*3600000).getUTCDay(),from=start-((weekday+6)%7)*DAY;
 return {start:from,end:from+42*DAY};
}
export function itemsOnDate(items:CalendarItem[],date:string){const start=midnight(date),end=start+DAY;return items.filter(i=>i.start_at===null?i.date===date:i.start_at<end&&i.end_at!==null&&i.end_at>start).sort((a,b)=>(a.start_at??midnight(a.date))-(b.start_at??midnight(b.date))||a.id.localeCompare(b.id));}

