import type {Env} from '../types';
import {DashboardError,sign} from './auth';

export interface DeviceInfo {id:string;name:string;version:number;enabled:number;created_at:number;updated_at:number}
export async function listDevices(env:Env) {
  return (await env.DB.prepare('SELECT id,name,version,enabled,created_at,updated_at FROM dashboard_devices ORDER BY created_at,id').all<DeviceInfo>()).results;
}
export async function manageDevice(env:Env,body:Record<string,unknown>,now:number) {
  const action=body.action,id=body.id,name=body.name;
  if(!['create','rename','disable','enable','rotate'].includes(String(action)))throw new DashboardError('端末操作を選択してください。');
  if((action==='create'||action==='rename')&&(typeof name!=='string'||!name.trim()||name.trim().length>80))throw new DashboardError('端末名を1〜80文字で指定してください。');
  if(!env.DASHBOARD_SECRET||env.DASHBOARD_SECRET.length<32)throw new DashboardError('サーバー認証設定が必要です。',503);
  if(action==='create'){
    // 端末数は制限しない。キーは発行時だけ管理者へ返し、DBにはHMACのみ保存する。
    const deviceId=crypto.randomUUID(),key=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
    await env.DB.prepare('INSERT INTO dashboard_devices(id,name,key_hash,created_at,updated_at) VALUES(?,?,?,?,?)').bind(deviceId,(name as string).trim(),await sign(env.DASHBOARD_SECRET,'device-key:'+key),now,now).run();
    return {id:deviceId,name:(name as string).trim(),key};
  }
  if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw new DashboardError('端末IDを確認してください。');
  let key:string|undefined;
  let result:D1Result;
  if(action==='rename')result=await env.DB.prepare('UPDATE dashboard_devices SET name=?,updated_at=? WHERE id=?').bind((name as string).trim(),now,id).run();
  else if(action==='rotate'){
    key=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
    result=await env.DB.prepare('UPDATE dashboard_devices SET key_hash=?,version=version+1,updated_at=? WHERE id=?').bind(await sign(env.DASHBOARD_SECRET,'device-key:'+key),now,id).run();
  }else result=await env.DB.prepare('UPDATE dashboard_devices SET enabled=?,version=version+1,updated_at=? WHERE id=?').bind(action==='enable'?1:0,now,id).run();
  if(!result.meta.changes)throw new DashboardError('端末が見つかりません。',404);
  return {id,...(key?{key}:{})};
}
