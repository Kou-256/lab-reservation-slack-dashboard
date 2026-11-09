import {poolOccupancy} from '../shared/occupancy.js';
import type {Equipment,BookingView,Downtime} from '../shared/dashboard.js';
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function stirrerIllustration(r:Equipment,rows:BookingView[],maintenance:Downtime[],now:number,fresh:boolean) {
  const pools=poolOccupancy(r,rows,maintenance,now);
  return `<aside class="stirrer-map" aria-label="スターラーの場所別予約台数"><div class="stirrer-pools">${pools.map(p=>{
    const count=Math.min(p.capacity,60);
    const icons=Array.from({length:count},(_,i)=>{
      const state=!fresh?'unknown':!r.enabled?'offline':i<p.booked?'reserved':i<p.booked+p.unknown?'uncertain':i<p.booked+p.unknown+p.offline?'offline':'available';
      return `<svg class="stirrer-unit ${state}" data-state="${state}" viewBox="0 0 48 54" aria-hidden="true"><path class="vessel" d="M13 4v25q0 8 11 8t11-8V4M10 4h28"/><path class="liquid" d="M15 21q9-4 18 0v9q-9 9-18 0z"/><ellipse class="stir-bar" cx="24" cy="27" rx="7" ry="2"/><rect class="plate" x="8" y="36" width="32" height="4" rx="2"/><rect class="motor" x="5" y="40" width="38" height="11" rx="3"/><circle class="dial" cx="34" cy="45.5" r="2.5"/><path class="indicator" d="M11 45h10"/></svg>`;
    }).join('');
    return `<section class="stirrer-pool" aria-label="${esc(p.name)}、予約中${p.booked}台、場所未設定${p.unknown}台、予約可能${p.free}台"><h3>${esc(p.name)}</h3><p><b>${fresh?p.booked:'—'}</b>台予約中 <span>／ 空き${fresh?p.free:'—'}台</span></p><div class="stirrer-units">${icons}</div>${p.unknown?`<small>場所未設定 ${p.unknown}台も空きから差引</small>`:''}${p.offline?`<small>故障点検 ${p.offline}台を差引</small>`:''}${p.capacity>60?`<small>図は60台分まで・総数${p.capacity}台</small>`:''}</section>`;
  }).join('')}</div><p class="stirrer-legend"><span class="legend-reserved">回転＝予約中</span><span class="legend-available">静止＝空き</span><span>灰＝停止・不明</span></p><p class="stirrer-note">予約台数の概念図です。実稼働・個体の割当は示しません。</p></aside>`;
}
