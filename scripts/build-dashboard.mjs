import {mkdir,copyFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
// QR読み取りモジュールだけをバンドルし、カメラ利用時に遅延ロードする。
const result=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p','dashboard/tsconfig.json'],{stdio:'inherit'});
if(result.status!==0)process.exit(result.status??1);
await mkdir('dist/web/dashboard/assets',{recursive:true});
await copyFile('dashboard/index.html','dist/web/dashboard/index.html');
await copyFile('dashboard/style.css','dist/web/dashboard/assets/style.css');
await copyFile('dashboard/terminal.css','dist/web/dashboard/assets/terminal.css');
await mkdir('dist/web/dashboard/assets/fonts',{recursive:true});
for(const name of ['noto-sans-jp-variable.woff2','OFL.txt','SOURCE.md'])await copyFile('dashboard/fonts/'+name,'dist/web/dashboard/assets/fonts/'+name);
await build({entryPoints:['dashboard/qr-scan.ts'],bundle:true,format:'esm',minify:true,target:'es2022',outfile:'dist/web/dashboard/assets/dashboard/qr-scan.js'});
console.log('Dashboard built: dist/web/dashboard');
