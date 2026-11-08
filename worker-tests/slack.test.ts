import {afterEach,expect,it,vi} from 'vitest';
import {slackClient} from '../src/services/slack';

afterEach(()=>vi.unstubAllGlobals());
it('sends users.info as a form so Slack receives the authenticated user ID',async()=>{
  const request=vi.fn(async()=>new Response(JSON.stringify({ok:true,user:{profile:{real_name:'利用者F'}}})));
  vi.stubGlobal('fetch',request);
  await slackClient('test-token')('users.info',{user:'U1'});
  const [url,init]=request.mock.calls[0] as unknown as [string,RequestInit];
  expect(url).toBe('https://slack.com/api/users.info');
  expect(new Headers(init.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded');
  expect(String(init.body)).toBe('user=U1');
});
it('keeps Block Kit message posts as JSON and does not retry failures',async()=>{
  const request=vi.fn(async()=>new Response(JSON.stringify({ok:false,error:'ratelimited'})));
  vi.stubGlobal('fetch',request);
  await expect(slackClient('test-token')('chat.postMessage',{channel:'C1',blocks:[]})).rejects.toThrow('slack_ratelimited');
  expect(request).toHaveBeenCalledTimes(1);
  const [,init]=request.mock.calls[0] as unknown as [string,RequestInit];
  expect(JSON.parse(String(init.body))).toEqual({channel:'C1',blocks:[]});
});
