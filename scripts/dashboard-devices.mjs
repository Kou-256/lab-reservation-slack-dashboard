import {writeDeviceQR} from './device-qr.mjs';
// 管理Tokenをタブレットへ渡さず、端末を台数制限なしで追加・停止・再発行する。
const [action='list',value,name]=process.argv.slice(2);
if(!process.env.ADMIN_TOKEN||!process.env.WORKER_URL)throw new Error('.envにADMIN_TOKENとWORKER_URLを設定してください。');
const url=new URL(action==='list'?'/admin/dashboard/devices':'/admin/dashboard/device',process.env.WORKER_URL);
if(url.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('HTTPSで接続してください。');
const body=action==='list'?undefined:action==='create'?{action,name:value}:{action,id:value,name};
if(!['list','create','rename','disable','enable','rotate'].includes(action))throw new Error('list / create 名前 / rename ID 名前 / disable ID / enable ID / rotate ID');
const response=await fetch(url,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${process.env.ADMIN_TOKEN}`,Origin:url.origin,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
const result=await response.json();if(!response.ok)throw new Error(result.error??'端末管理に失敗しました。');
if(result.devices)console.table(result.devices.map(d=>({ID:d.id,端末名:d.name,状態:d.enabled?'有効':'無効'})));
else {console.log(`完了: ${result.id}`);if(result.key){const files=await writeDeviceQR(result,process.env.WORKER_URL);console.log(`接続用QR: ${files.png}`);}}
