import {expect,it} from 'vitest';
import {durationLabel} from '../shared/duration';
it.each([
 [0,'0日0時間0分'],[1,'0日0時間1分'],[60000,'0日0時間1分'],
 [944*60000,'0日15時間44分'],[1590*60000,'1日2時間30分'],
 [1440*60000-1,'1日0時間0分'],[-1,'0日0時間0分']
])('formats remaining duration %s as %s',(ms,label)=>expect(durationLabel(ms)).toBe(label));
