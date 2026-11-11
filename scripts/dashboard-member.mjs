import {createInterface} from 'node:readline/promises';

// 登録済み利用者のタブレット利用を有効・無効にする。PINは扱わない。
const user=process.argv[2],disable=process.argv.includes('--disable'),enable=process.argv.includes('--enable');
if(!/^U[A-Z0-9]+$/.test(user??'')||!process.env.ADMIN_TOKEN||!process.env.WORKER_URL||disable===enable){
  console.error('Usage: node --env-file=.env scripts/dashboard-member.mjs Uxxxxxxxx --enable | --disable\n.env: WORKER_URL / ADMIN_TOKEN');process.exit(1);
}
const rl=createInterface({input:process.stdin,output:process.stdout});
try {
  const answer=await rl.question(`${user} のタブレット利用を${disable?'無効化':'有効化'}します。yes と入力: `);
  if(answer.trim()!=='yes')process.exit(0);
}finally{rl.close();}
const url=new URL('/admin/dashboard/member',process.env.WORKER_URL);
if(url.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('HTTPSのWORKER_URLを指定してください。');
const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${process.env.ADMIN_TOKEN}`,'Content-Type':'application/json',Origin:url.origin},body:JSON.stringify({user,action:disable?'disable':'enable'})});
const result=await response.json();
if(!response.ok)throw new Error(result.error??'設定失敗');
console.log(disable?'無効化しました。':'有効化しました。氏名選択だけで利用できます。');
