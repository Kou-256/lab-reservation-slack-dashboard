import type { SlackCall } from '../types';

// A configured spelling takes precedence over the account's student-number login.
// Ownership is still checked solely using the authenticated Slack user ID.
export async function memberName(db:D1Database,slack:SlackCall,user:string):Promise<string> {
  const configured=await db.prepare('SELECT name FROM member_names WHERE slack_user_id=?').bind(user).first<{name:string}>();
  if(configured?.name)return configured.name;
  try {
    const info=await slack('users.info',{user});
    const candidates=[info.user?.profile?.real_name,info.user?.real_name,info.user?.profile?.display_name];
    const name=candidates.find(value=>typeof value==='string'&&value.trim()&&!/^s\d+$/i.test(value.trim()));
    if(name)return name.trim().slice(0,100);
  } catch { /* API outages must not prevent booking or change ownership. */ }
  return user;
}
