// 秒の端数は切り上げ、日・時間・分をそろえて残り時間を読みやすくする。
export function durationLabel(milliseconds:number):string {
  const total=Math.max(0,Math.ceil(milliseconds/60000));
  return `${Math.floor(total/1440)}日${Math.floor(total%1440/60)}時間${total%60}分`;
}
