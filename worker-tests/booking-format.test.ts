import {it,expect} from 'vitest';
import {bookingDate,bookingStamp} from '../shared/booking-format';
import {bookingPeriod} from '../dashboard/booking-period';
it('shows JST dates with weekdays across UTC midnight and year boundaries',()=>{
 expect(bookingDate(Date.parse('2026-11-04T15:00:00Z'))).toBe('2026/11/05(木)');
 expect(bookingStamp(Date.parse('2026-12-31T15:05:00Z'))).toBe('2027/01/01(金) 00:05');
 expect(bookingStamp(Date.parse('2026-12-31T15:05:00Z'),false)).toBe('01/01(金) 00:05');
});
it('uses the same two time elements for same-day and multi-day reservations',()=>{
 const start=Date.parse('2026-11-05T10:00:00+09:00');
 for(const end of [start+3600000,Date.parse('2026-11-13T11:00:00+09:00')]){
  const html=bookingPeriod(start,end);expect((html.match(/class="period-time"/g)||[]).length).toBe(2);expect(html).toContain('開始');expect(html).toContain('終了');expect(html).toContain('2026/11/05(木)');expect(html).not.toContain('cross-day');
 }
 expect(bookingPeriod(start,Date.parse('2026-11-13T11:00:00+09:00'))).toContain('2026/11/13(金)');
});
