import {it,expect} from 'vitest';
import {dateFields,selectedDateTime} from '../dashboard/date-fields';
it('uses five dropdowns, leap-month days and JST across year boundaries',()=>{
 const ms=Date.parse('2028-02-29T23:59:00+09:00'),html=dateFields('start',ms,Date.parse('2026-12-31T00:00:00+09:00'));
 expect((html.match(/<select /g)||[]).length).toBe(5);expect(html).toContain('value="29" selected>29日');expect(html).not.toContain('>30日');expect(html).toContain('value="23" selected>23時');expect(html).toContain('value="59" selected>59分');expect(html).not.toContain('type="number"');
});
it('keeps an existing booking year and serializes selected values without changing timezone',()=>{
 const html=dateFields('end',Date.parse('2020-01-01T00:00:00+09:00'),Date.parse('2026-01-01T00:00:00+09:00'));expect(html).toContain('value="2020" selected');
 const values=new FormData();for(const [k,v] of Object.entries({year:'2028',month:'2',day:'29',hour:'0',minute:'5'}))values.set('end_'+k,v);
 expect(selectedDateTime(values,'end')).toBe('2028-02-29T00:05');expect(Date.parse(selectedDateTime(values,'end')+'+09:00')).toBe(Date.parse('2028-02-28T15:05:00Z'));
});
