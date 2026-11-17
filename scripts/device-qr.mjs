import QRCode from 'qrcode';
import {mkdir,writeFile} from 'node:fs/promises';

export async function writeDeviceQR(device,base,dir='backups/dashboard-device-qr') {
  await mkdir(dir,{recursive:true});
  const url=new URL('/dashboard/',base);url.hash=new URLSearchParams({access:device.key}).toString();
  const options={errorCorrectionLevel:'M',margin:4,width:640};
  await QRCode.toFile(`${dir}/${device.id}.png`,url.href,options);
  await writeFile(`${dir}/${device.id}.svg`,await QRCode.toString(url.href,{...options,type:'svg'}));
  await writeFile(`${dir}/${device.id}.url`,`[InternetShortcut]\r\nURL=${url.href}\r\n`);
  await writeFile(`${dir}/${device.id}.secrets.json`,JSON.stringify({id:device.id,url:url.href}));
  return {shortcut:`${dir}/${device.id}.url`,secret:`${dir}/${device.id}.secrets.json`,png:`${dir}/${device.id}.png`,svg:`${dir}/${device.id}.svg`};
}
