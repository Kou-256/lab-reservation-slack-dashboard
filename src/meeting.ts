import type {Reservation,Resource} from './types';
export type Presenter={id:string;name:string};
export function presenterNames(row:Pick<Reservation,'presenters'>) {
  const people=JSON.parse(row.presenters??'[]') as Presenter[];
  return people.map(p=>p.name).join('、')||'担当未定';
}
export const meetingRooms=['サンプル棟 204室','サンプル棟 206室','オンライン','その他'];
export const hasPresenters=(r:Pick<Resource,'id'|'schedule_event'>)=>Boolean(r.schedule_event)&&r.id!=='biweekly_report';
export const calendarPerson=(row:Reservation,r:Resource)=>r.id==='biweekly_report'?'':r.schedule_event?presenterNames(row):row.slack_user_name;

export const sharedSchedule=(r:Pick<Resource,'id'|'schedule_event'>)=>Boolean(r.schedule_event)&&['english_seminar','biweekly_report'].includes(r.id);
