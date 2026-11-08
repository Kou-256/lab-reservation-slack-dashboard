import type { SlackCall } from '../types';
export function slackClient(token:string):SlackCall {
  return async(method,payload)=>{
    // Never retry a message post: a lost response does not mean Slack failed to accept it.
    // users.info accepts URL-encoded arguments; JSON would silently lose `user`.
    const lookup=method==='users.info';
    const response=await fetch(`https://slack.com/api/${method}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':lookup?'application/x-www-form-urlencoded':'application/json; charset=utf-8'},body:lookup?new URLSearchParams({user:String(payload.user)}):JSON.stringify(payload),signal:AbortSignal.timeout(4500)});
    if(!response.ok) throw new Error(`slack_http_${response.status}`);
    const data=await response.json() as {ok:boolean;error?:string};
    if(!data.ok) throw new Error(`slack_${data.error??'unknown'}`);
    return data;
  };
}
