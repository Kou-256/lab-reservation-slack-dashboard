import type { Booking } from './types';

export function resolvePurpose(value:string,choices:string[]):string {
  const match=/^@purpose:(\d+)$/.exec(value);
  return match?choices[Number(match[1])]??value:value;
}
export function purposeOption(value:string,choices:string[]) {
  const chars=Array.from(value);
  return {text:{type:'plain_text',text:chars.length>75?chars.slice(0,74).join('')+'…':value,emoji:true},
    value:value.length>150||value.startsWith('@purpose:')?`@purpose:${choices.indexOf(value)}`:value};
}
export function purposeMenu(choices:string[],selected?:string) {
  const options=choices.map(value=>purposeOption(value,choices));
  const groups=Array.from({length:Math.ceil(options.length/100)},(_,i)=>({label:{type:'plain_text',text:`用途 ${i*100+1}～${Math.min((i+1)*100,options.length)}`},options:options.slice(i*100,(i+1)*100)}));
  return {type:'static_select',...(options.length<=100?{options}:{option_groups:groups}),
    ...(selected&&choices.includes(selected)?{initial_option:purposeOption(selected,choices)}:{})};
}

// "自由入力" is a UI action, never a purpose prefix in messages or calendars.
export function purposeText(row:Pick<Booking,'purpose_choice'|'purpose'>) {
  return [row.purpose_choice==='自由入力'?'':row.purpose_choice,row.purpose].filter(Boolean).join('：');
}
