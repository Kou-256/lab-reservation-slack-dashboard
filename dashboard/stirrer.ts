import {poolOccupancy} from '../shared/occupancy.js';
import type {Equipment,BookingView,Downtime} from '../shared/dashboard.js';
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function stirrerIllustration(r:Equipment,rows:BookingView[],maintenance:Downtime[],now:number,fresh:boolean) {
  const pools=poolOccupancy(r,rows,maintenance,now);
  return `<aside class="stirrer-map" aria-label="スターラーの場所別予約台数"><div class="stirrer-pools">${pools.map(p=>{
    const count=Math.min(p.capacity,60);
    const icons=Array.from({length:count},(_,i)=>{
      const state=!fresh?'unknown':!r.enabled?'offline':i<p.booked?'reserved':i<p.booked+p.unknown?'uncertain':i<p.booked+p.unknown+p.offline?'offline':'available';
      return `<svg class="stirrer-unit ${state}" data-state="${state}" viewBox="0 0 48 40" aria-hidden="true"><rect class="plate-edge" x="2" y="5" width="44" height="33" rx="4"/><rect class="hotplate" x="2" y="1" width="44" height="32" rx="4"/><rect class="plate-status" x="5" y="4" width="38" height="26" rx="3"/><ellipse class="stir-bar" cx="24" cy="17" rx="9" ry="2.5"/><circle class="status-light" cx="39" cy="27" r="2"/></svg>`;
    });
    // 写真の4連装置を2×2のプレートと共通操作盤で表す。左列から上下順に埋める。
    const sets=Array.from({length:Math.ceil(count/4)},(_,i)=>`<div class="stirrer-set" aria-label="${i+1}組目・液晶式4連スターラー"><svg class="stirrer-case" viewBox="0 0 160 150" aria-hidden="true"><path d="M145 24q8-8 15-9" fill="none" stroke="#4c5056" stroke-width="3"/><path d="M39 13 151 36q7 2 4 12l-27 87q-2 8-13 6L13 118q-12-3-8-15L32 21q2-9 7-8Z" fill="#292f37" stroke="#737983" stroke-width="2"/><path d="m14 108 102 23q7 2 10-5l26-81" fill="none" stroke="#d97c46" stroke-width="2"/><path d="m35 27 101 21-20 58L16 85Z" fill="#151a20" stroke="#9299a0"/></svg><div class="stirrer-plates">${icons.slice(i*4,i*4+4).join('')}</div><div class="stirrer-controls" aria-hidden="true"><span class="stirrer-screen"><i></i><i></i><i></i></span><span class="stirrer-keys"><i></i><i></i><i></i><i></i></span></div></div>`).join('');
    return `<section class="stirrer-pool" aria-label="${esc(p.name)}、予約中${p.booked}台、場所未設定${p.unknown}台、予約可能${p.free}台"><h3>${esc(p.name)}</h3><p class="pool-summary"><span><b>${fresh?p.booked:'—'}</b>台予約中</span><span>空き${fresh?p.free:'—'}台</span></p><div class="stirrer-units">${sets}</div>${p.unknown?`<small>場所未設定 ${p.unknown}台も空きから差引</small>`:''}${p.offline?`<small>故障点検 ${p.offline}台を差引</small>`:''}${p.capacity>60?`<small>図は60台分まで・総数${p.capacity}台</small>`:''}</section>`;
  }).join('')}</div><p class="stirrer-note">回転＝予約中／青＝空き／灰＝停止・不明。実稼働・個体の割当は示しません。</p></aside>`;
}
