import {bookingDate,bookingTime} from '../shared/booking-format.js';
// 期間の長さや設備の種類で文字を縮めず、開始・終了を同じ構造で表示する。
export function bookingPeriod(start:number,end:number){
 return `<div class="booking-period" aria-label="予約期間"><div class="period-endpoint"><div class="period-date"><span>開始</span> ${bookingDate(start)}</div><time class="period-time" datetime="${new Date(start).toISOString()}">${bookingTime(start)}</time></div><span class="period-separator" aria-hidden="true">〜</span><div class="period-endpoint"><div class="period-date"><span>終了</span> ${bookingDate(end)}</div><time class="period-time" datetime="${new Date(end).toISOString()}">${bookingTime(end)}</time></div></div>`;
}
