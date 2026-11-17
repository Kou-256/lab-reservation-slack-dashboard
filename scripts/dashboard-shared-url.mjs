import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {writeDeviceQR} from './device-qr.mjs';
// 全員が同じURLを使う。登録するのは接続権限1件であり、スマホ・PCの登録や台数制限はない。
const dir='backups/dashboard-shared-link',base=process.env.WORKER_URL;
if(!base||!process.env.ADMIN_TOKEN)throw new Error('WORKER_URLとADMIN_TOKENを設定してください。');
const origin=new URL(base);if(origin.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(origin.hostname))throw new Error('HTTPSを使用してください。');
await mkdir(dir,{recursive:true});let saved;
try{saved=JSON.parse(await readFile(dir+'/shared.secrets.json','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
if(!saved||process.argv.includes('--rotate')){
 const response=await fetch(new URL('/admin/dashboard/device',base),{method:'POST',headers:{Origin:origin.origin,Authorization:'Bearer '+process.env.ADMIN_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(saved?{action:'rotate',id:saved.id}:{action:'create',name:'研究室共通URL'})});
 const result=await response.json();if(!response.ok)throw new Error(result.error??'URLの発行に失敗しました。');
 const link=new URL('/dashboard/',base);link.hash=new URLSearchParams({access:result.key}).toString();saved={id:result.id,url:link.href};await writeFile(dir+'/shared.secrets.json',JSON.stringify(saved));
}
const link=new URL(saved.url);if(link.origin!==origin.origin)throw new Error('保存済みURLの接続先を確認してください。');
const key=new URLSearchParams(link.hash.slice(1)).get('access');if(!key)throw new Error('秘密URLを確認してください。');
const files=await writeDeviceQR({id:saved.id,key},base,dir);await copyFile(files.png,dir+'/研究室共通URL.png');await copyFile(files.shortcut,dir+'/研究室設備予約.url');
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
await writeFile(dir+'/研究室共通URL.html',`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>研究室 設備予約 共通URL</title><style>body{font-family:Meiryo,sans-serif;max-width:680px;margin:32px auto;padding:16px}a{display:inline-block;padding:16px;background:#24649a;color:white}img{display:block;max-width:100%;width:320px}textarea{box-sizing:border-box;width:100%;font-size:16px}</style><h1>研究室 設備予約</h1><p>スマートフォン・タブレット・PCから、全員が同じURLで利用できます。端末登録やキー・PIN入力は不要です。</p><p><a href="${esc(saved.url)}" rel="noreferrer">設備予約を開く</a></p><label>共通の秘密URL<textarea readonly rows="4">${esc(saved.url)}</textarea></label><p>スマートフォンのカメラで読み取れます。</p><img src="研究室共通URL.png" alt="共通URLのQRコード"></html>`);
console.log('共通URLを backups/dashboard-shared-link/研究室共通URL.html に保存しました。');
