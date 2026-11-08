import type {Env} from '../types';
import {DashboardError,pinHash,requireMember} from './auth';

export async function changePIN(env:Env,body:Record<string,unknown>,now:number) {
  if(typeof body.new_pin!=='string'||!/^\d{4}$/.test(body.new_pin))throw new DashboardError('新しいPINは半角数字4桁で入力してください。');
  if(body.new_pin!==body.confirm_pin)throw new DashboardError('新しいPINと確認用PINが一致しません。');
  const member=await requireMember(env,body.user,body.pin,now),salt=crypto.randomUUID();
  const hash=await pinHash(env,member.id,body.new_pin,salt);
  // 確認後に別の端末から変更・リセットされた場合は上書きしない。
  const result=await env.DB.batch([
    env.DB.prepare('UPDATE dashboard_members SET pin_salt=?,pin_hash=?,updated_at=? WHERE slack_user_id=? AND enabled=1 AND pin_hash=?').bind(salt,hash,now,member.id,member.credentialHash),
    env.DB.prepare(`INSERT INTO dashboard_pin_events SELECT ?,slack_user_id,'changed','self',? FROM dashboard_members WHERE slack_user_id=? AND pin_hash=?`).bind(crypto.randomUUID(),now,member.id,hash)
  ]);
  if(!result[0].meta.changes)throw new DashboardError('PINが別の操作で変更されました。現在のPINを確認してやり直してください。',409);
}

export async function resetPIN(env:Env,user:unknown,enabled:unknown,now:number) {
  if(typeof user!=='string'||!/^U[A-Z0-9]+$/.test(user)||(enabled!==undefined&&typeof enabled!=='boolean'))throw new DashboardError('Slack IDと有効状態を確認してください。');
  if(!await env.DB.prepare('SELECT 1 FROM member_names WHERE slack_user_id=?').bind(user).first())throw new DashboardError('既存のmember_namesに登録されているメンバーを指定してください。');
  const current=await env.DB.prepare('SELECT enabled FROM dashboard_members WHERE slack_user_id=?').bind(user).first<{enabled:number}>();
  const active=enabled===undefined?current?.enabled??1:enabled?1:0;
  const salt=crypto.randomUUID(),hash=await pinHash(env,user,'0000',salt);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO dashboard_members(slack_user_id,pin_salt,pin_hash,enabled,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(slack_user_id) DO UPDATE SET pin_salt=excluded.pin_salt,pin_hash=excluded.pin_hash,enabled=excluded.enabled,updated_at=excluded.updated_at`).bind(user,salt,hash,active,now),
    env.DB.prepare("INSERT INTO dashboard_pin_events VALUES(?,?,?,'admin',?)").bind(crypto.randomUUID(),user,active?'reset':'disabled',now),
    env.DB.prepare('DELETE FROM dashboard_auth_attempts WHERE expires_at<=? OR bucket=?').bind(now,'member:'+user)
  ]);
}
