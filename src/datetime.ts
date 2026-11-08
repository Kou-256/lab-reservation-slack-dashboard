export const day = 86_400_000;
export function localParts(ms: number) {
  const iso = new Date(ms + 9 * 3_600_000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}
export function parseDate(date: string, time: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new Error('日時を正しく選択してください。');
  const ms = Date.parse(`${date}T${time}:00+09:00`);
  if (!Number.isFinite(ms) || localParts(ms).date !== date || localParts(ms).time !== time) throw new Error('日時を正しく選択してください。');
  return ms;
}
export function dateLabel(ms: number) {
  return new Intl.DateTimeFormat('ja-JP', {timeZone:'Asia/Tokyo', year:'numeric',month:'long',day:'numeric',weekday:'short'}).format(ms);
}
export function range(start: number, end: number) {
  return `${dateLabel(start)} ${localParts(start).time}\n～ ${dateLabel(end)} ${localParts(end).time}`;
}
export function periodBounds(period: string, now: number): [number, number] {
  const today = parseDate(localParts(now).date, '00:00');
  const week = today - ((new Date(today + 9 * 3_600_000).getUTCDay() + 6) % 7) * day;
  switch (period) {
    case 'today': return [today, today + day];
    case 'tomorrow': return [today + day, today + 2 * day];
    case 'week': return [week, week + 7 * day];
    case 'next_week': return [week + 7 * day, week + 14 * day];
    default: return [0, 8_640_000_000_000_000];
  }
}
