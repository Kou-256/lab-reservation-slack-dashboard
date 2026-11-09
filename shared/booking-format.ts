// 表示日時は端末のタイムゾーンに依存させず、年・日付・曜日を常に明示する。
export function bookingDate(ms:number,withYear=true):string {
 return new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:withYear?'numeric':undefined,month:'2-digit',day:'2-digit',weekday:'short'}).format(ms);
}
export function bookingTime(ms:number):string {
 return new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',hour12:false}).format(ms);
}
export function bookingStamp(ms:number,withYear=true):string {return `${bookingDate(ms,withYear)} ${bookingTime(ms)}`;}
