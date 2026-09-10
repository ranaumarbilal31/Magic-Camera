const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const camera = $('#camera');
const output = $('#output');
const outCtx = output.getContext('2d', { alpha: true });

const work = document.createElement('canvas');
const mask = document.createElement('canvas');
const softMask = document.createElement('canvas');
const effectLayer = document.createElement('canvas');

const workCtx = work.getContext('2d', { willReadFrequently: true });
const maskCtx = mask.getContext('2d');
const softMaskCtx = softMask.getContext('2d');
const effectCtx = effectLayer.getContext('2d');

const MASK_FPS = 20;
const MASK_INTERVAL = 1000 / MASK_FPS;

const state = {
  stream: null,
  facing: 'user',
  running: false,
  background: null,
  hue: 220,
  tolerance: 40,
  feather: 2,
  sampling: false,
  lastShot: null,
  fpsFrames: 0,
  fpsLast: 0
};

const presetHues = {
  blue: 220,
  green: 120,
  red: 0,
  purple: 280
};

const presetColors = {
  blue: '#1e64ff',
  green: '#30d879',
  red: '#ff3c5f',
  purple: '#a85cff'
};

let maskA;
let maskB;
let maskImage;
let lastMaskUpdate = 0;

function say(message) {
  const toast = $('#toast');

  toast.textContent = message;
  toast.classList.add('show');

  clearTimeout(say.timer);

  say.timer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2700);
}

function setStatus(label, color = '#61e696') {
  $('#statusChip b').textContent = label;
  $('#statusChip span').style.background = color;
  $('#statusChip').hidden = false;
}

function sizeCanvases() {
  /*
   * Processing the camera at its full 1280×720 resolution is expensive,
   * especially when every pixel must be checked.
   *
   * A smaller internal resolution keeps the effect smooth while the
   * output canvas is enlarged by CSS.
   */
  const maxWidth = innerWidth < 700 ? 320 : 400;
  const ratio = camera.videoHeight / camera.videoWidth || 9 / 16;
  const width = Math.min(maxWidth, camera.videoWidth || maxWidth);
  const height = Math.round(width * ratio);

  [output, work, mask, softMask, effectLayer].forEach(canvas => {
    canvas.width = width;
    canvas.height = height;
  });

  maskA = new Uint8Array(width * height);
  maskB = new Uint8Array(width * height);
  maskImage = maskCtx.createImageData(width, height);

  lastMaskUpdate = 0;
}

async function startCamera(facing = state.facing) {
  if (!navigator.mediaDevices?.getUserMedia) {
    say('Camera is unavailable here. Try a recent browser over HTTPS.');
    return false;
  }

  state.stream?.getTracks().forEach(track => track.stop());

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });

    state.facing = facing;
    camera.srcObject = state.stream;

    await camera.play();

    sizeCanvases();

    state.running = true;
    $('#emptyState').hidden = true;

    [
      '#backgroundButton',
      '#switchButton',
      '#captureButton',
      '#fullscreenButton',
      '#sampleButton'
    ].forEach(selector => {
      $(selector).disabled = false;
    });

    state.fpsFrames = 0;
    state.fpsLast = 0;

    $('#fpsChip').hidden = false;

    setStatus('Live · background needed', '#ffd76a');

    cancelAnimationFrame(startCamera.raf);
    render();

    return true;
  } catch (error) {
    $('#emptyState').hidden = false;

    say(
      error.name === 'NotAllowedError'
        ? 'Camera permission was denied. Enable it in site settings.'
        : 'The camera could not start. It may be in use elsewhere.'
    );

    return false;
  }
}

function drawCameraFrame() {
  workCtx.save();
  workCtx.setTransform(1, 0, 0, 1, 0, 0);
  workCtx.clearRect(0, 0, work.width, work.height);

  if (state.facing === 'user') {
    workCtx.translate(work.width, 0);
    workCtx.scale(-1, 1);
  }

  workCtx.drawImage(camera, 0, 0, work.width, work.height);
  workCtx.restore();
}

function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const difference = max - min;

  let hue = 0;

  if (difference) {
    if (max === r) {
      hue = ((g - b) / difference) % 6;
    } else if (max === g) {
      hue = (b - r) / difference + 2;
    } else {
      hue = (r - g) / difference + 4;
    }

    hue *= 60;

    if (hue < 0) {
      hue += 360;
    }
  }

  return [
    hue,
    max ? difference / max : 0,
    max
  ];
}

function erode3(source, destination, width, height) {
  destination.fill(0);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;

      if (
        source[index] &&
        source[index - 1] &&
        source[index + 1] &&
        source[index - width] &&
        source[index + width] &&
        source[index - width - 1] &&
        source[index - width + 1] &&
        source[index + width - 1] &&
        source[index + width + 1]
      ) {
        destination[index] = 255;
      }
    }
  }
}

function dilate3(source, destination, width, height) {
  destination.fill(0);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;

      if (
        source[index] ||
        source[index - 1] ||
        source[index + 1] ||
        source[index - width] ||
        source[index + width] ||
        source[index - width - 1] ||
        source[index - width + 1] ||
        source[index + width - 1] ||
        source[index + width + 1]
      ) {
        destination[index] = 255;
      }
    }
  }
}

function makeMask(frame) {
  const source = frame.data;
  const destination = maskImage.data;

  for (
    let sourceIndex = 0, pixelIndex = 0;
    sourceIndex < source.length;
    sourceIndex += 4, pixelIndex++
  ) {
    const red = source[sourceIndex];
    const green = source[sourceIndex + 1];
    const blue = source[sourceIndex + 2];

    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const difference = max - min;

    let hue = 0;

    if (difference) {
      if (max === red) {
        hue = ((green - blue) / difference) % 6;
      } else if (max === green) {
        hue = (blue - red) / difference + 2;
      } else {
        hue = (red - green) / difference + 4;
      }

      hue *= 60;

      if (hue < 0) {
        hue += 360;
      }
    }

    const saturation = max ? difference / max : 0;
    const brightness = max / 255;

    const hueDistance = Math.min(
      Math.abs(hue - state.hue),
      360 - Math.abs(hue - state.hue)
    );

    maskA[pixelIndex] =
      hueDistance <= state.tolerance &&
      saturation >= 0.314 &&
      brightness >= 0.314
        ? 255
        : 0;
  }

  /*
   * Remove small isolated areas and fill small gaps.
   * This is equivalent to cleaning the color mask.
   */
  erode3(maskA, maskB, work.width, work.height);
  dilate3(maskB, maskA, work.width, work.height);
  dilate3(maskA, maskB, work.width, work.height);

  for (
    let pixelIndex = 0, destinationIndex = 0;
    pixelIndex < maskB.length;
    pixelIndex++, destinationIndex += 4
  ) {
    destination[destinationIndex] = 255;
    destination[destinationIndex + 1] = 255;
    destination[destinationIndex + 2] = 255;
    destination[destinationIndex + 3] = maskB[pixelIndex];
  }

  maskCtx.putImageData(maskImage, 0, 0);
  refreshSoftMask();
}

function refreshSoftMask() {
  softMaskCtx.save();
  softMaskCtx.setTransform(1, 0, 0, 1, 0, 0);
  softMaskCtx.clearRect(0, 0, softMask.width, softMask.height);

  softMaskCtx.filter = state.feather
    ? `blur(${state.feather}px)`
    : 'none';

  softMaskCtx.drawImage(mask, 0, 0);
  softMaskCtx.restore();
}

function cacheBackground() {
  effectCtx.clearRect(
    0,
    0,
    effectLayer.width,
    effectLayer.height
  );

  if (state.background) {
    effectCtx.putImageData(state.background, 0, 0);
  }
}

function clearBackground() {
  state.background = null;
  lastMaskUpdate = 0;

  effectCtx.clearRect(
    0,
    0,
    effectLayer.width,
    effectLayer.height
  );

  maskCtx.clearRect(
    0,
    0,
    mask.width,
    mask.height
  );

  softMaskCtx.clearRect(
    0,
    0,
    softMask.width,
    softMask.height
  );
}

function updateFps(time) {
  state.fpsFrames++;

  if (!state.fpsLast) {
    state.fpsLast = time;
  }

  const elapsed = time - state.fpsLast;

  if (elapsed >= 1000) {
    $('#fpsValue').textContent = Math.round(
      state.fpsFrames * 1000 / elapsed
    );

    state.fpsFrames = 0;
    state.fpsLast = time;
  }
}

function render(time = 0) {
  if (!state.running || camera.readyState < 2) {
    startCamera.raf = requestAnimationFrame(render);
    return;
  }

  updateFps(time);
  drawCameraFrame();

  outCtx.globalCompositeOperation = 'source-over';
  outCtx.filter = 'none';
  outCtx.clearRect(0, 0, output.width, output.height);
  outCtx.drawImage(work, 0, 0);

  if (state.background) {
    /*
     * Color detection and mask cleanup are the expensive operations.
     * The mask is limited to 20 updates per second, while the video
     * continues to render through requestAnimationFrame.
     */
    if (time - lastMaskUpdate >= MASK_INTERVAL) {
      const currentFrame = workCtx.getImageData(
        0,
        0,
        work.width,
        work.height
      );

      makeMask(currentFrame);
      lastMaskUpdate = time;
    }

    /*
     * Remove the detected cloak area from the current camera frame.
     */
    outCtx.globalCompositeOperation = 'destination-out';
    outCtx.drawImage(softMask, 0, 0);

    /*
     * Place the previously captured background behind the removed area.
     */
    outCtx.globalCompositeOperation = 'destination-over';
    outCtx.drawImage(effectLayer, 0, 0);

    outCtx.globalCompositeOperation = 'source-over';
  }

  startCamera.raf = requestAnimationFrame(render);
}

const delay = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

async function captureBackground() {
  $('#backgroundButton').disabled = true;

  const countdown = $('#countdown');
  countdown.classList.add('active');

  for (let number = 3; number > 0; number--) {
    countdown.textContent = number;
    setStatus('Step out of frame', '#ffd76a');

    await delay(1000);
  }

  countdown.textContent = '✦';
  setStatus('Capturing 30 clean frames', '#69e7ff');

  for (let frame = 0; frame < 30; frame++) {
    await new Promise(requestAnimationFrame);
    drawCameraFrame();
  }

  state.background = workCtx.getImageData(
    0,
    0,
    work.width,
    work.height
  );

  cacheBackground();
  lastMaskUpdate = 0;

  countdown.classList.remove('active');
  countdown.textContent = '';

  $('#backgroundButton').disabled = false;
  $('#backgroundButton').textContent = 'Retake';

  $('[data-step="1"]').classList.add('complete');
  $('[data-step="1"]').classList.remove('active');
  $('[data-step="2"]').classList.add('active');

  setStatus('Cloak ready');
  say('Background captured. Bring in your cloak!');
}

function selectHue(hue, message) {
  state.hue = hue;
  lastMaskUpdate = 0;

  localStorage.setItem(
    'magic-camera-hue',
    String(hue)
  );

  say(message || 'Cloak color updated.');
}

function showSelectedShade(color) {
  $('#sampleColor').style.background = color;
  $('#sampleColorValue').textContent = color.toUpperCase();
}

function startSampling() {
  state.sampling = !state.sampling;

  $('#cameraStage').classList.toggle(
    'sample-mode',
    state.sampling
  );

  $('#sampleButton').textContent = state.sampling
    ? 'Cancel sampling'
    : '＋ Tap to sample';
}

function sampleAt(event) {
  if (!state.sampling) {
    return;
  }

  const rect = output.getBoundingClientRect();
  const scale = Math.max(
    rect.width / output.width,
    rect.height / output.height
  );

  const offsetX = (
    rect.width - output.width * scale
  ) / 2;

  const offsetY = (
    rect.height - output.height * scale
  ) / 2;

  const x = Math.max(
    0,
    Math.min(
      output.width - 1,
      Math.floor(
        (event.clientX - rect.left - offsetX) / scale
      )
    )
  );

  const y = Math.max(
    0,
    Math.min(
      output.height - 1,
      Math.floor(
        (event.clientY - rect.top - offsetY) / scale
      )
    )
  );

  drawCameraFrame();

  const pixel = workCtx.getImageData(x, y, 1, 1).data;

  const [hue, saturation, brightness] = rgbToHsv(
    pixel[0],
    pixel[1],
    pixel[2]
  );

  if (saturation < 0.2 || brightness < 0.12) {
    say(
      'That spot has too little color. Try a brighter part of the cloth.'
    );
    return;
  }

  const sampledColor = `#${[
    pixel[0],
    pixel[1],
    pixel[2]
  ]
    .map(value =>
      value.toString(16).padStart(2, '0')
    )
    .join('')}`;

  selectHue(
    hue,
    'Color sampled from your cloak.'
  );

  showSelectedShade(sampledColor);

  $$('.color-swatch').forEach(item => {
    item.classList.remove('selected');
  });

  startSampling();
}

function canSharePhoto(blob) {
  if (
    !blob ||
    typeof navigator.share !== 'function' ||
    typeof navigator.canShare !== 'function'
  ) {
    return false;
  }

  try {
    const file = new File(
      [blob],
      'magic-camera.png',
      { type: 'image/png' }
    );

    return navigator.canShare({
      files: [file]
    });
  } catch {
    return false;
  }
}

function takePhoto() {
  output.toBlob(blob => {
    if (!blob) {
      say('Could not create the photo.');
      return;
    }

    if (state.lastShot?.url) {
      URL.revokeObjectURL(state.lastShot.url);
    }

    const url = URL.createObjectURL(blob);

    state.lastShot = {
      blob,
      url
    };

    $('#resultImage').src = url;
    $('#shareButton').hidden = !canSharePhoto(blob);
    $('#resultDialog').showModal();
  }, 'image/png');
}

function downloadPhoto() {
  if (!state.lastShot?.blob) {
    say('Take a photo first.');
    return;
  }

  const url = URL.createObjectURL(
    state.lastShot.blob
  );

  const link = document.createElement('a');

  link.href = url;
  link.download = `magic-camera-${Date.now()}.png`;
  link.style.display = 'none';

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 2000);

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

  if (!canSharePhoto(state.lastShot.blob)) {
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

async function switchCamera() {
  const nextFacing =
    state.facing === 'user'
      ? 'environment'
      : 'user';

  clearBackground();

  $('#backgroundButton').textContent = 'Capture';

  await startCamera(nextFacing);

  say(
    nextFacing === 'user'
      ? 'Front camera selected.'
      : 'Rear camera selected.'
  );
}

function resetApp() {
  clearBackground();

  state.hue = 220;
  state.tolerance = 40;
  state.feather = 2;

  $('#tolerance').value = 40;
  $('#toleranceValue').value = 40;
  $('#feather').value = 2;
  $('#featherValue').value = 2;
  $('#backgroundButton').textContent = 'Capture';

  $$('.step-card').forEach(card => {
    card.classList.remove('active', 'complete');
  });

  $('[data-step="1"]').classList.add('active');

  $$('.color-swatch').forEach(swatch => {
    swatch.classList.toggle(
      'selected',
      swatch.dataset.color === 'blue'
    );
  });

  showSelectedShade(presetColors.blue);
  setStatus('Live · background needed', '#ffd76a');
  say('Cloak settings reset.');
}

$('#startButton').addEventListener(
  'click',
  () => startCamera()
);

$('#backgroundButton').addEventListener(
  'click',
  captureBackground
);

$('#sampleButton').addEventListener(
  'click',
  startSampling
);

$('#cameraStage').addEventListener(
  'click',
  sampleAt
);

$('#switchButton').addEventListener(
  'click',
  switchCamera
);

$('#captureButton').addEventListener(
  'click',
  takePhoto
);

$('#fullscreenButton').addEventListener(
  'click',
  () => $('#cameraStage').requestFullscreen?.()
);

$('#resetButton').addEventListener(
  'click',
  resetApp
);

$('#helpButton')?.addEventListener(
  'click',
  () => $('#helpDialog').showModal()
);

$('#closeHelp').addEventListener(
  'click',
  () => $('#helpDialog').close()
);

$('#closeResult').addEventListener(
  'click',
  () => $('#resultDialog').close()
);

$('#downloadButton').addEventListener(
  'click',
  downloadPhoto
);

$('#shareButton').addEventListener(
  'click',
  sharePhoto
);

$('#tolerance').addEventListener('input', event => {
  state.tolerance = Number(event.target.value);
  $('#toleranceValue').value = event.target.value;

  lastMaskUpdate = 0;
});

$('#feather').addEventListener('input', event => {
  state.feather = Number(event.target.value);
  $('#featherValue').value = event.target.value;

  refreshSoftMask();
});

$$('.color-swatch').forEach(button => {
  button.addEventListener('click', () => {
    button.parentElement
      .querySelectorAll('button')
      .forEach(item => {
        item.classList.remove('selected');
      });

    button.classList.add('selected');

    showSelectedShade(
      presetColors[button.dataset.color]
    );

    const colorName =
      button.dataset.color[0].toUpperCase() +
      button.dataset.color.slice(1);

    selectHue(
      presetHues[button.dataset.color],
      `${colorName} cloak selected.`
    );
  });
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(startCamera.raf);
  } else if (state.running) {
    state.fpsFrames = 0;
    state.fpsLast = 0;

    render();
  }
});

addEventListener('beforeunload', () => {
  state.stream?.getTracks().forEach(track => {
    track.stop();
  });

  if (state.lastShot?.url) {
    URL.revokeObjectURL(state.lastShot.url);
  }
});

if ('serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .catch(() => {});
  });
}

function registerWebMCP() {
  const context = document.modelContext;

  if (!context?.registerTool) {
    return;
  }

  const colors = [
    'blue',
    'green',
    'red',
    'purple'
  ];

  try {
    void Promise.resolve(
      context.registerTool({
        name: 'configure_cloak_color',
        title: 'Configure cloak color',
        description:
          'Set the visible Magic Camera color preset and color tolerance using the same controls as the camera studio.',

        inputSchema: {
          type: 'object',

          properties: {
            color: {
              type: 'string',
              enum: colors
            },

            tolerance: {
              type: 'number',
              minimum: 20,
              maximum: 60
            }
          },

          required: ['color'],
          additionalProperties: false
        },

        annotations: {
          readOnlyHint: false,
          untrustedContentHint: false
        },

        execute(input) {
          if (!colors.includes(input?.color)) {
            throw new Error('Unsupported color');
          }

          state.hue = presetHues[input.color];
          lastMaskUpdate = 0;

          showSelectedShade(
            presetColors[input.color]
          );

          $$('.color-swatch').forEach(swatch => {
            swatch.classList.toggle(
              'selected',
              swatch.dataset.color === input.color
            );
          });

          if (input.tolerance !== undefined) {
            if (
              input.tolerance < 20 ||
              input.tolerance > 60
            ) {
              throw new Error(
                'Tolerance out of range'
              );
            }

            state.tolerance = input.tolerance;
            $('#tolerance').value = input.tolerance;
            $('#toleranceValue').value =
              input.tolerance;
          }

          return {
            color: input.color,
            tolerance: state.tolerance
          };
        }
      })
    ).catch(() => {});
  } catch {
    // WebMCP is optional and does not affect camera usage.
  }
}

registerWebMCP();
