import {jstDate} from '../shared/dashboard.js';
const options=(values:number[],chosen:number,suffix:string)=>values.map(v=>`<option value="${v}" ${v===chosen?'selected':''}>${v}${suffix}</option>`).join('');
// 小さな数値スピナーを使わず、日付・時刻をすべて大きな選択欄から指定する。
export function dateFields(prefix:'start'|'end',ms:number,now:number){
 const [year,month,day]=jstDate(ms).split('-').map(Number),yearNow=Number(jstDate(now).slice(0,4));
 const hours=Number(new Date(ms+9*3600000).toISOString().slice(11,13)),minutes=Number(new Date(ms).getUTCMinutes());
 const years=[...new Set([year,...Array.from({length:5},(_,i)=>yearNow-1+i)])].sort((a,b)=>a-b),days=new Date(Date.UTC(year,month,0)).getUTCDate();
 const heading=prefix==='start'?'開始':'終了';
 return `<fieldset class="date-parts"><legend>${heading}日時（JST）</legend>${[['year','年',years,year],['month','月',Array.from({length:12},(_,i)=>i+1),month],['day','日',Array.from({length:days},(_,i)=>i+1),day],['hour','時',Array.from({length:24},(_,i)=>i),hours],['minute','分',Array.from({length:60},(_,i)=>i),minutes]].map(([key,label,values,value])=>`<label>${label}<select name="${prefix}_${key}" aria-label="${heading}の${label}" required>${options(values as number[],value as number,String(label))}</select></label>`).join('')}</fieldset>`;
}
export function selectedDateTime(values:FormData,prefix:string){
 const part=(key:string)=>String(values.get(prefix+'_'+key)??'').padStart(2,'0');
 return `${values.get(prefix+'_year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}
