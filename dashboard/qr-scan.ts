import jsQR from 'jsqr';

function decode(canvas:HTMLCanvasElement):string|null {
  const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)return null;
  const image=context.getImageData(0,0,canvas.width,canvas.height);
  return jsQR(image.data,image.width,image.height,{inversionAttempts:'attemptBoth'})?.data??null;
}
export async function readQRImage(file:File) {
  const image=await createImageBitmap(file);
  try{const canvas=document.createElement('canvas'),scale=Math.min(1,1600/Math.max(image.width,image.height));canvas.width=Math.round(image.width*scale);canvas.height=Math.round(image.height*scale);canvas.getContext('2d')!.drawImage(image,0,0,canvas.width,canvas.height);return decode(canvas);}
  finally{image.close();}
}
export async function scanCamera(video:HTMLVideoElement,signal:AbortSignal,onRead:(text:string)=>void) {
  if(!navigator.mediaDevices?.getUserMedia)throw new Error('カメラを利用できません。QR画像か端末キーで接続してください。');
  const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280}},audio:false});
  // 許可待ちの間に画面を閉じた場合もカメラを停止する。
  const stop=()=>{stream.getTracks().forEach(track=>track.stop());video.srcObject=null;};
  if(signal.aborted){stop();return;}
  signal.addEventListener('abort',stop,{once:true});video.srcObject=stream;
  try{await video.play();}catch(error){stop();throw error;}
  const canvas=document.createElement('canvas');let last=0;
  function frame(t:number){
    if(signal.aborted)return;
    if(t-last>180&&video.readyState>=2){last=t;const scale=Math.min(1,960/video.videoWidth);canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);canvas.getContext('2d')!.drawImage(video,0,0,canvas.width,canvas.height);const text=decode(canvas);if(text){stop();onRead(text);return;}}
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
