const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const camera = $('#camera'), output = $('#output');
const outCtx = output.getContext('2d', {alpha:true});
const work = document.createElement('canvas'), mask = document.createElement('canvas'), effectLayer = document.createElement('canvas');
const workCtx = work.getContext('2d', {willReadFrequently:true}), maskCtx = mask.getContext('2d'), effectCtx = effectLayer.getContext('2d');
const state = {stream:null,facing:'user',running:false,background:null,hue:220,tolerance:40,feather:2,sampling:false,lastShot:null,fpsFrames:0,fpsLast:0};
const presetHues = {blue:220,green:120,red:0,purple:280};
const presetColors = {blue:'#1e64ff',green:'#30d879',red:'#ff3c5f',purple:'#a85cff'};
let maskA, maskB, maskImage;

function say(message){
  const toast=$('#toast'); toast.textContent=message; toast.classList.add('show');
  clearTimeout(say.timer); say.timer=setTimeout(()=>toast.classList.remove('show'),2700);
}

function setStatus(label,color='#61e696'){
  $('#statusChip b').textContent=label; $('#statusChip span').style.background=color; $('#statusChip').hidden=false;
}

function sizeCanvases(){
  const maxWidth=innerWidth<700?360:480, ratio=camera.videoHeight/camera.videoWidth||9/16;
  const width=Math.min(maxWidth,camera.videoWidth||maxWidth), height=Math.round(width*ratio);
  [output,work,mask,effectLayer].forEach(canvas=>{canvas.width=width;canvas.height=height;});
  maskA=new Uint8Array(width*height);maskB=new Uint8Array(width*height);maskImage=maskCtx.createImageData(width,height);
}

async function startCamera(facing=state.facing){
  if(!navigator.mediaDevices?.getUserMedia){say('Camera is unavailable here. Try a recent browser over HTTPS.');return false;}
  state.stream?.getTracks().forEach(track=>track.stop());
  try{
    state.stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:facing},width:{ideal:1280},height:{ideal:720}},audio:false});
    state.facing=facing; camera.srcObject=state.stream; await camera.play(); sizeCanvases(); state.running=true;
    $('#emptyState').hidden=true;
    ['#backgroundButton','#switchButton','#captureButton','#fullscreenButton','#sampleButton'].forEach(s=>$(s).disabled=false);
    state.fpsFrames=0;state.fpsLast=0;$('#fpsChip').hidden=false;
    setStatus('Live · background needed','#ffd76a'); cancelAnimationFrame(startCamera.raf); render(); return true;
  }catch(error){
    $('#emptyState').hidden=false;
    say(error.name==='NotAllowedError'?'Camera permission was denied. Enable it in site settings.':'The camera could not start. It may be in use elsewhere.'); return false;
  }
}

function drawCameraFrame(){
  workCtx.save(); workCtx.setTransform(1,0,0,1,0,0); workCtx.clearRect(0,0,work.width,work.height);
  if(state.facing==='user'){workCtx.translate(work.width,0);workCtx.scale(-1,1);}
  workCtx.drawImage(camera,0,0,work.width,work.height); workCtx.restore();
}

function rgbToHsv(r,g,b){
  r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=0;
  if(d){if(max===r)h=((g-b)/d)%6;else if(max===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;if(h<0)h+=360;}
  return [h,max?d/max:0,max];
}

function erode3(src,dst,w,h){
  dst.fill(0);
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
    const i=y*w+x;
    if(src[i]&&src[i-1]&&src[i+1]&&src[i-w]&&src[i+w]&&src[i-w-1]&&src[i-w+1]&&src[i+w-1]&&src[i+w+1])dst[i]=255;
  }
}

function dilate3(src,dst,w,h){
  dst.fill(0);
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
    const i=y*w+x;
    if(src[i]||src[i-1]||src[i+1]||src[i-w]||src[i+w]||src[i-w-1]||src[i-w+1]||src[i+w-1]||src[i+w+1])dst[i]=255;
  }
}

function makeMask(frame){
  const src=frame.data,dst=maskImage.data;
  for(let i=0,p=0;i<src.length;i+=4,p++){
    const r=src[i],g=src[i+1],b=src[i+2],max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
    let h=0;
    if(delta){if(max===r)h=((g-b)/delta)%6;else if(max===g)h=(b-r)/delta+2;else h=(r-g)/delta+4;h*=60;if(h<0)h+=360;}
    const s=max?delta/max:0,v=max/255;
    const distance=Math.min(Math.abs(h-state.hue),360-Math.abs(h-state.hue));
    maskA[p]=distance<=state.tolerance&&s>=.314&&v>=.314?255:0;
  }
  erode3(maskA,maskB,work.width,work.height);
  dilate3(maskB,maskA,work.width,work.height);
  dilate3(maskA,maskB,work.width,work.height);
  for(let p=0,i=0;p<maskB.length;p++,i+=4){dst[i]=dst[i+1]=dst[i+2]=255;dst[i+3]=maskB[p];}
  maskCtx.putImageData(maskImage,0,0);
}

function paintEffect(){
  effectCtx.clearRect(0,0,effectLayer.width,effectLayer.height);
  if(state.background)effectCtx.putImageData(state.background,0,0);
}

function render(time=0){
  if(!state.running||camera.readyState<2){startCamera.raf=requestAnimationFrame(render);return;}
  state.fpsFrames++;
  if(!state.fpsLast)state.fpsLast=time;
  const fpsElapsed=time-state.fpsLast;
  if(fpsElapsed>=1000){$('#fpsValue').textContent=Math.round(state.fpsFrames*1000/fpsElapsed);state.fpsFrames=0;state.fpsLast=time;}
  drawCameraFrame();outCtx.globalCompositeOperation='source-over';outCtx.filter='none';outCtx.clearRect(0,0,output.width,output.height);outCtx.drawImage(work,0,0);
  if(state.background){
    makeMask(workCtx.getImageData(0,0,work.width,work.height));paintEffect();
    outCtx.globalCompositeOperation='destination-out';outCtx.filter=state.feather?`blur(${state.feather}px)`:'none';outCtx.drawImage(mask,0,0);
    outCtx.filter='none';outCtx.globalCompositeOperation='destination-over';outCtx.drawImage(effectLayer,0,0);outCtx.globalCompositeOperation='source-over';
  }
  startCamera.raf=requestAnimationFrame(render);
}

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function captureBackground(){
  $('#backgroundButton').disabled=true;const countdown=$('#countdown');countdown.classList.add('active');
  for(let n=3;n>0;n--){countdown.textContent=n;setStatus('Step out of frame','#ffd76a');await delay(1000);}
  countdown.textContent='✦';setStatus('Capturing 30 clean frames','#69e7ff');
  for(let i=0;i<30;i++){await new Promise(requestAnimationFrame);drawCameraFrame();}
  state.background=workCtx.getImageData(0,0,work.width,work.height);
  countdown.classList.remove('active');countdown.textContent='';$('#backgroundButton').disabled=false;$('#backgroundButton').textContent='Retake';
  $('[data-step="1"]').classList.add('complete');$('[data-step="1"]').classList.remove('active');$('[data-step="2"]').classList.add('active');
  setStatus('Cloak ready');say('Background captured. Bring in your cloak!');
}

function selectHue(hue,message){state.hue=hue;localStorage.setItem('magic-camera-hue',String(hue));say(message||'Cloak color updated.');}
function showSelectedShade(color){
  const normalized=color.toUpperCase();
  $('#sampleColor').style.background=color;
  $('#sampleColorValue').textContent=normalized;
}
function startSampling(){
  state.sampling=!state.sampling;$('#cameraStage').classList.toggle('sample-mode',state.sampling);
  $('#sampleButton').textContent=state.sampling?'Cancel sampling':'＋ Tap to sample';
}
function sampleAt(event){
  if(!state.sampling)return;
  const rect=output.getBoundingClientRect(),scale=Math.max(rect.width/output.width,rect.height/output.height);
  const ox=(rect.width-output.width*scale)/2,oy=(rect.height-output.height*scale)/2;
  const x=Math.max(0,Math.min(output.width-1,Math.floor((event.clientX-rect.left-ox)/scale)));
  const y=Math.max(0,Math.min(output.height-1,Math.floor((event.clientY-rect.top-oy)/scale)));
  drawCameraFrame();const pixel=workCtx.getImageData(x,y,1,1).data,[h,s,v]=rgbToHsv(pixel[0],pixel[1],pixel[2]);
  if(s<.2||v<.12){say('That spot has too little color. Try a brighter part of the cloth.');return;}
  const sampledColor=`#${[pixel[0],pixel[1],pixel[2]].map(value=>value.toString(16).padStart(2,'0')).join('')}`;
  selectHue(h,'Color sampled from your cloak.');showSelectedShade(sampledColor);$$('.color-swatch').forEach(item=>item.classList.remove('selected'));startSampling();
}

function takePhoto(){
  output.toBlob(blob=>{
    if(!blob){say('Could not create the photo.');return;}
    if(state.lastShot)URL.revokeObjectURL(state.lastShot.url);
    const url=URL.createObjectURL(blob);state.lastShot={blob,url};$('#resultImage').src=url;$('#shareButton').hidden=!navigator.share;$('#resultDialog').showModal();
  },'image/png');
}
function downloadPhoto()function downloadPhoto() {
  if (!state.lastShot?.blob) {
    say('Take a photo first.');
    return;
  }

  const url = URL.createObjectURL(state.lastShot.blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = `magic-camera-${Date.now()}.png`;
  link.style.display = 'none';

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 2000);
  say('Photo downloaded.');
}

async function sharePhoto() {
  if (!state.lastShot?.blob) {
    say('Take a photo first.');
    return;
  }

  const file = new File(
    [state.lastShot.blob],
    `magic-camera-${Date.now()}.png`,
    { type: 'image/png' }
  );

  const fileSharingSupported =
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [file] });

  if (!fileSharingSupported) {
    say('Sharing is unavailable here. Downloading instead.');
    downloadPhoto();
    return;
  }

  try {
    await navigator.share({
      title: 'My Magic Camera photo',
      text: 'Created with Magic Camera',
      files: [file]
    });
  } catch (error) {
    if (error.name !== 'AbortError') {
      say('Sharing failed. Downloading instead.');
      downloadPhoto();
    }
  }
}
async function sharePhoto(){
  if(!state.lastShot||!navigator.share)return;const file=new File([state.lastShot.blob],'magic-camera.png',{type:'image/png'});
  try{await navigator.share({files:[file],title:'My Magic Camera shot'});}catch(error){if(error.name!=='AbortError')downloadPhoto();}
}
async function switchCamera(){
  const next=state.facing==='user'?'environment':'user';state.background=null;$('#backgroundButton').textContent='Capture';
  await startCamera(next);say(next==='user'?'Front camera selected.':'Rear camera selected.');
}
function resetApp(){
  state.background=null;state.hue=220;state.tolerance=40;state.feather=2;
  $('#tolerance').value=40;$('#toleranceValue').value=40;$('#feather').value=2;$('#featherValue').value=2;$('#backgroundButton').textContent='Capture';
  $$('.step-card').forEach(x=>x.classList.remove('active','complete'));$('[data-step="1"]').classList.add('active');
  $$('.color-swatch').forEach(x=>x.classList.toggle('selected',x.dataset.color==='blue'));
  showSelectedShade(presetColors.blue);
  setStatus('Live · background needed','#ffd76a');say('Cloak settings reset.');
}

$('#startButton').addEventListener('click',()=>startCamera());
$('#backgroundButton').addEventListener('click',captureBackground);
$('#sampleButton').addEventListener('click',startSampling);
$('#cameraStage').addEventListener('click',sampleAt);
$('#switchButton').addEventListener('click',switchCamera);
$('#captureButton').addEventListener('click',takePhoto);
$('#fullscreenButton').addEventListener('click',()=>$('#cameraStage').requestFullscreen?.());
$('#resetButton').addEventListener('click',resetApp);
$('#helpButton')?.addEventListener('click',()=>$('#helpDialog').showModal());
$('#closeHelp').addEventListener('click',()=>$('#helpDialog').close());
$('#closeResult').addEventListener('click',()=>$('#resultDialog').close());
$('#downloadButton').addEventListener('click',downloadPhoto);
$('#shareButton').addEventListener('click',sharePhoto);
$('#tolerance').addEventListener('input',e=>{state.tolerance=+e.target.value;$('#toleranceValue').value=e.target.value;});
$('#feather').addEventListener('input',e=>{state.feather=+e.target.value;$('#featherValue').value=e.target.value;});
$$('.color-swatch').forEach(button=>button.addEventListener('click',()=>{
  button.parentElement.querySelectorAll('button').forEach(item=>item.classList.remove('selected'));button.classList.add('selected');
  showSelectedShade(presetColors[button.dataset.color]);selectHue(presetHues[button.dataset.color],`${button.dataset.color[0].toUpperCase()+button.dataset.color.slice(1)} cloak selected.`);
}));

document.addEventListener('visibilitychange',()=>{if(document.hidden)cancelAnimationFrame(startCamera.raf);else if(state.running)render();});
addEventListener('beforeunload',()=>state.stream?.getTracks().forEach(track=>track.stop()));
if('serviceWorker'in navigator)addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));

function registerWebMCP(){
  const context=document.modelContext;if(!context?.registerTool)return;const colors=['blue','green','red','purple'];
  try{void Promise.resolve(context.registerTool({
    name:'configure_cloak_color',title:'Configure cloak color',description:'Set the visible Magic Camera color preset and color tolerance using the same controls as the camera studio.',
    inputSchema:{type:'object',properties:{color:{type:'string',enum:colors},tolerance:{type:'number',minimum:20,maximum:60}},required:['color'],additionalProperties:false},
    annotations:{readOnlyHint:false,untrustedContentHint:false},
    execute(input){
      if(!colors.includes(input?.color))throw new Error('Unsupported color');state.hue=presetHues[input.color];showSelectedShade(presetColors[input.color]);$$('.color-swatch').forEach(x=>x.classList.toggle('selected',x.dataset.color===input.color));
      if(input.tolerance!==undefined){if(input.tolerance<20||input.tolerance>60)throw new Error('Tolerance out of range');state.tolerance=input.tolerance;$('#tolerance').value=input.tolerance;$('#toleranceValue').value=input.tolerance;}
      return {color:input.color,tolerance:state.tolerance};
    }
  })).catch(()=>{});}catch{}
}
registerWebMCP();
