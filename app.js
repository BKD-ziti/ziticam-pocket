// ZitiCam Pocket — the live-face ziti, running entirely on the phone.
// Front camera -> MediaPipe Face Landmarker -> the same 3D ziti as the stream PC (ZitiCam),
// rendered in 9:16 on a key color, recorded with your voice to MP4. Nothing leaves the phone.
//
// URL options: ?debug=1 (stats on), ?autostart=1 (skip the start card), ?mp=<base url> (MediaPipe location)

import * as THREE from 'three';
import { GLTFLoader } from './GLTFLoader.js';
import { RoomEnvironment } from './RoomEnvironment.js';

const VERSION = '0.1.1';
const MP_VER = '0.10.35';   // same MediaPipe build as ZitiCam on the stream PC
const q = new URLSearchParams(location.search);
const MP_BASES = q.get('mp')
  ? [q.get('mp')]
  : [`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}`, `https://unpkg.com/@mediapipe/tasks-vision@${MP_VER}`];

// ---------------------------------------------------------------- settings (stream look = defaults)
const DEFAULTS = {
  sauce: true, brows: false, mirror: false, flip: true,
  eyes: 1.1, mouth: 1.24, mouthLift: 0.16, eyeLift: 0, eyeSpread: 0.94,
  turn: 1.15, sway: 0.45, bounce: 2, smooth: 0.5,
  zoom: 1, lift: 0, bg: 'blue', quality: 1080, countdown: true, micMode: 'clean',
};
const LOOK_KEYS = ['sauce', 'brows', 'mirror', 'flip', 'eyes', 'mouth', 'mouthLift', 'eyeLift', 'eyeSpread', 'turn', 'sway', 'bounce', 'smooth', 'zoom', 'lift'];
const STORE = 'zitipocket.v1';
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: keep going */ } },
};
const CFG = { ...DEFAULTS, ...store.get(STORE, {}), debug: q.get('debug') === '1', fps: 30 };
const saveCfg = () => { const o = {}; for (const k of Object.keys(DEFAULTS)) o[k] = CFG[k]; store.set(STORE, o); };

// Blue is the default key: the sauce has green basil flecks, the ziti has no blue or magenta at all.
const BGS = {
  blue: { hex: '#0000ff', label: 'Blue' },
  green: { hex: '#00ff00', label: 'Green' },
  pink: { hex: '#ff00ff', label: 'Pink' },
};
const BG_ORDER = ['blue', 'green', 'pink'];
if (!BGS[CFG.bg]) CFG.bg = 'blue';

// Geometry constants of ziti v2 (glTF space: +Y up, +Z = front of the noodle).
const SURFACE_R = 0.524;
const FACE_SPAN = 0.92;
const FACE_REF = new THREE.Vector2(0.0, 0.20);
const LM = {
  rEyeOuter: 33, rEyeInner: 133, lEyeInner: 362, lEyeOuter: 263,
  rBrowTop: 105, lBrowTop: 334,
  mouthL: 61, mouthR: 291, lipTop: 0, lipBot: 17,
  bridge: 168, cheekR: 234, cheekL: 454, forehead: 10, chin: 152,
};

// ---------------------------------------------------------------- dom
const $ = (id) => document.getElementById(id);
const videoEl = $('cam');
const canvas = $('stage');
const debugEl = $('debug');
const thumb = $('thumb');
const thumbCtx = thumb.getContext('2d');
const status = { cam: 'off', tracker: 'loading', det: 0, fps: 0, camFps: 0, face: false, err: '', mic: 'off', rec: '' };
let camFrames = 0;

let toastT = 0;
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}
function setStatus(msg) { const s = $('status'); s.textContent = msg || ''; s.classList.toggle('show', !!msg); }

// ---------------------------------------------------------------- renderer + scene
const renderer = new THREE.WebGLRenderer({
  canvas, alpha: false, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance',
});
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(28, 9 / 16, 0.1, 50);
const world = new THREE.Group();   // flip lives here, inside the picture, so the recording is flipped too
scene.add(world);
world.add(new THREE.HemisphereLight(0xfff1dc, 0x3b2a1e, 0.9));
const key = new THREE.DirectionalLight(0xffe7cc, 2.4); key.position.set(-2.2, 3.2, 4.0); world.add(key);
const fill = new THREE.DirectionalLight(0xd8e4ff, 0.7); fill.position.set(3.0, 0.5, 2.5); world.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 1.6); rim.position.set(1.2, 2.5, -3.5); world.add(rim);

const rig = new THREE.Group();
const bob = new THREE.Group();
rig.add(bob);
world.add(rig);
let sauceNode = null;

function outSize() { const w = CFG.quality === 720 ? 720 : 1080; return { w, h: Math.round(w * 16 / 9) }; }
function applyOutput() {
  const { w, h } = outSize();
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  applyFraming();
}
function applyFraming() {
  camera.fov = 28 / Math.max(0.3, CFG.zoom);
  camera.position.set(0, 0.25 - CFG.lift, 6.0);
  camera.lookAt(0, 0.05 - CFG.lift, 0);
  camera.updateProjectionMatrix();
}
function applyLook() {
  world.scale.x = CFG.flip ? -1 : 1;
  if (sauceNode) sauceNode.visible = CFG.sauce;
  renderer.setClearColor(new THREE.Color(BGS[CFG.bg].hex), 1);
  $('bgSwatch').style.background = BGS[CFG.bg].hex;
  $('bgLabel').textContent = BGS[CFG.bg].label;
  $('sauceBtn').setAttribute('aria-pressed', String(CFG.sauce));
  for (const b of document.querySelectorAll('[data-toggle]')) b.setAttribute('aria-pressed', String(!!CFG[b.dataset.toggle]));
  for (const b of document.querySelectorAll('#qualSeg button')) b.setAttribute('aria-pressed', String(+b.dataset.q === CFG.quality));
  for (const b of document.querySelectorAll('#micSeg button')) b.setAttribute('aria-pressed', String(b.dataset.mic === (CFG.micMode || 'clean')));
  document.body.classList.toggle('debug', CFG.debug);
  $('dbgBtn').setAttribute('aria-pressed', String(CFG.debug));
  applyFraming();
}
applyOutput();

// ---------------------------------------------------------------- face insets (eyes + mouth)
const snap = document.createElement('canvas');
const snapCtx = snap.getContext('2d', { alpha: false });
const videoTex = new THREE.CanvasTexture(snap);
videoTex.colorSpace = THREE.SRGBColorSpace;
videoTex.minFilter = THREE.LinearFilter;
videoTex.magFilter = THREE.LinearFilter;
videoTex.generateMipmaps = false;
function snapshotFrame() {
  const w = videoEl.videoWidth, h = videoEl.videoHeight;
  if (!w) return false;
  if (snap.width !== w || snap.height !== h) { snap.width = w; snap.height = h; videoTex.dispose(); }
  snapCtx.drawImage(videoEl, 0, 0, w, h);
  videoTex.needsUpdate = true;
  return true;
}

const insetVert = /* glsl */`
  uniform vec2 uCenter; uniform vec2 uSize; uniform float uRadius;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    float x = uCenter.x + position.x * uSize.x;
    float y = uCenter.y + position.y * uSize.y;
    float z = sqrt(max(uRadius * uRadius - x * x, 0.0));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(x, y, z, 1.0);
  }`;
const insetFrag = /* glsl */`
  uniform sampler2D uMap; uniform vec2 uVideo; uniform vec2 uCropC; uniform vec2 uCropH;
  uniform float uAngle; uniform float uMirror; uniform float uFeather; uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    vec2 d2 = (vUv - 0.5) * 2.0;
    float d = length(d2);
    float a = 1.0 - smoothstep(1.0 - uFeather, 1.0, d);
    if (a <= 0.002) discard;
    vec2 o = vec2(d2.x * uCropH.x, -d2.y * uCropH.y);
    float c = cos(uAngle), s = sin(uAngle);
    vec2 p = uCropC + vec2(c * o.x - s * o.y, s * o.x + c * o.y);
    vec2 n = p / uVideo;
    if (uMirror > 0.5) n.x = 1.0 - n.x;
    vec4 col = texture2D(uMap, vec2(n.x, 1.0 - n.y));
    float edge = smoothstep(0.5, 1.0, d);
    col.rgb *= 1.0 - 0.12 * edge;
    gl_FragColor = vec4(col.rgb, a * uOpacity);
    #include <colorspace_fragment>
  }`;
function makeInset(name, feather) {
  const mat = new THREE.ShaderMaterial({
    name,
    uniforms: {
      uMap: { value: videoTex }, uVideo: { value: new THREE.Vector2(720, 1280) },
      uCropC: { value: new THREE.Vector2() }, uCropH: { value: new THREE.Vector2(1, 1) },
      uAngle: { value: 0 }, uMirror: { value: 0 }, uFeather: { value: feather }, uOpacity: { value: 0 },
      uCenter: { value: new THREE.Vector2() }, uSize: { value: new THREE.Vector2(0.1, 0.1) }, uRadius: { value: SURFACE_R },
    },
    vertexShader: insetVert, fragmentShader: insetFrag,
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 24, 12), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  bob.add(mesh);
  return mesh;
}
const insets = { eyeR: makeInset('eyeR', 0.28), eyeL: makeInset('eyeL', 0.28), mouth: makeInset('mouth', 0.26) };

// ---------------------------------------------------------------- load the ziti
let zitiReady = false;
new GLTFLoader().load('./ziti.glb', (gltf) => {
  const root = gltf.scene;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    if (o.name.startsWith('Sauce')) { m.roughness = 0.22; if ('clearcoat' in m) { m.clearcoat = 0.6; m.clearcoatRoughness = 0.08; } }
    else m.roughness = 0.55;
    m.envMapIntensity = 0.9;
  });
  sauceNode = root.getObjectByName('Sauce');
  bob.add(root);
  zitiReady = true;
  applyLook();
  updateLoadline();
}, (e) => { if (e.total) setLoad('ziti', Math.round(100 * e.loaded / e.total)); },
(e) => { status.err = 'model: ' + e.message; updateLoadline(); });

const loadPct = { ziti: 0 };
function setLoad(k, v) { loadPct[k] = v; updateLoadline(); }
function updateLoadline() {
  const el = $('loadline');
  if (status.err) { el.textContent = 'Problem: ' + status.err; return; }
  const parts = [];
  parts.push(zitiReady ? 'Ziti ready' : `Loading the ziti… ${loadPct.ziti || 0}%`);
  parts.push(landmarker ? 'face tracker ready' : (status.tracker === 'failed' ? 'face tracker failed' : 'loading face tracker…'));
  el.textContent = parts.join(' · ');
}

// ---------------------------------------------------------------- smoothing
class OneEuro {
  constructor(minCutoff = 1.5, beta = 0.03, dCutoff = 1.0) { Object.assign(this, { minCutoff, beta, dCutoff, x: null, dx: 0, t: null }); }
  static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(v, t) {
    if (this.x === null) { this.x = v; this.t = t; return v; }
    const dt = Math.max((t - this.t) / 1000, 1e-3); this.t = t;
    const dv = (v - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dv - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}
const filters = new Map();
const baseCut = () => 3.0 - 2.7 * Math.min(1, Math.max(0, CFG.smooth));
const smooth = (k, v, t, scale = 1, b = 0.03) => {
  if (!filters.has(k)) filters.set(k, new OneEuro(1, b));
  const f = filters.get(k);
  f.minCutoff = baseCut() * scale; f.beta = b;
  return f.filter(v, t);
};
const euler = new THREE.Euler(0, 0, 0, 'YXZ');

// ---------------------------------------------------------------- head pose + insets from landmarks
const target = { quat: new THREE.Quaternion(), pos: new THREE.Vector2(), jaw: 0, seen: -1e9 };
const neutralInv = new THREE.Quaternion();
const savedNeutral = store.get('zitipocket.neutral', null);
if (Array.isArray(savedNeutral)) neutralInv.fromArray(savedNeutral);
const lastRawQuat = new THREE.Quaternion();
let lastRawT = -1e9;
const mB = new THREE.Matrix4();
const vx = new THREE.Vector3(), vy = new THREE.Vector3(), vz = new THREE.Vector3();

function onFace(lm, blend, t) {
  const W = videoEl.videoWidth, H = videoEl.videoHeight;
  const mx = CFG.mirror ? (x) => 1 - x : (x) => x;
  const P2 = (i) => new THREE.Vector2(mx(lm[i].x) * W, lm[i].y * H);
  const P3 = (i) => new THREE.Vector3(mx(lm[i].x) * W, -lm[i].y * H, -lm[i].z * W);

  vx.subVectors(P3(LM.cheekL), P3(LM.cheekR)).normalize();
  vy.subVectors(P3(LM.forehead), P3(LM.chin)).normalize();
  vz.crossVectors(vx, vy).normalize();
  vy.crossVectors(vz, vx).normalize();
  mB.makeBasis(vx, vy, vz);
  const raw = new THREE.Quaternion().setFromRotationMatrix(mB);
  lastRawQuat.copy(raw); lastRawT = t;
  const rel = neutralInv.clone().multiply(raw);
  if (CFG.turn !== 1) rel.slerp(new THREE.Quaternion(), 1 - CFG.turn);
  euler.setFromQuaternion(rel, 'YXZ');
  euler.set(smooth('rx', euler.x, t, 1, 0.6), smooth('ry', euler.y, t, 1, 0.6), smooth('rz', euler.z, t, 1, 0.6), 'YXZ');
  target.quat.setFromEuler(euler);

  const faceW = smooth('faceW', P3(LM.cheekL).distanceTo(P3(LM.cheekR)), t, 0.7, 0.004);
  const eR = P2(LM.rEyeOuter).add(P2(LM.rEyeInner)).multiplyScalar(0.5);
  const eL = P2(LM.lEyeOuter).add(P2(LM.lEyeInner)).multiplyScalar(0.5);
  const roll = Math.atan2(eL.y - eR.y, eL.x - eR.x);
  const cr = Math.cos(-roll), sr = Math.sin(-roll);
  const bridge = P2(LM.bridge);
  const toFace = (p) => {
    const dx = p.x - bridge.x, dy = p.y - bridge.y;
    return new THREE.Vector2((cr * dx - sr * dy) / faceW, (sr * dx + cr * dy) / faceW);
  };

  target.pos.set(smooth('px', (bridge.x / W - 0.5) * 2, t, 1, 1.0), smooth('py', -(bridge.y / H - 0.5) * 2, t, 1, 1.0));

  const eye = (outer, inner, browTop, k) => {
    const a = P2(outer), b = P2(inner);
    const w = a.distanceTo(b);
    const c = a.clone().add(b).multiplyScalar(0.5);
    let halfW = w * 0.95, halfH = w * 0.62;
    if (CFG.brows) {
      const brow = P2(browTop);
      const up = Math.max(0, (c.y - brow.y) * Math.cos(roll)) * 1.25;
      halfH = Math.max(halfH, (up + w * 0.55) / 2);
      c.x += Math.sin(roll) * (halfH - w * 0.55);
      c.y -= Math.cos(roll) * (halfH - w * 0.55);
    }
    const f = toFace(c);
    const s = CFG.eyes;
    const cx = smooth(k + 'cx', c.x, t, 1.6, 0.03), cy = smooth(k + 'cy', c.y, t, 1.6, 0.03);
    const hw = smooth(k + 'hw', halfW, t, 0.5, 0.002), hh = smooth(k + 'hh', halfH, t, 0.5, 0.002);
    return {
      crop: [cx, cy, hw, hh],
      center: [FACE_REF.x + smooth(k + 'fx', f.x, t, 0.6, 0.5) * FACE_SPAN * CFG.eyeSpread, FACE_REF.y - smooth(k + 'fy', f.y, t, 0.6, 0.5) * FACE_SPAN + CFG.eyeLift],
      size: [(2 * hw / faceW) * FACE_SPAN * s, (2 * hh / faceW) * FACE_SPAN * s],
    };
  };
  insets.eyeR.userData.v = eye(LM.rEyeOuter, LM.rEyeInner, LM.rBrowTop, 'eR');
  insets.eyeL.userData.v = eye(LM.lEyeOuter, LM.lEyeInner, LM.lBrowTop, 'eL');

  {
    const a = P2(LM.mouthL), b = P2(LM.mouthR);
    const w = a.distanceTo(b);
    const top = P2(LM.lipTop), bot = P2(LM.lipBot);
    const c = new THREE.Vector2((a.x + b.x) / 2, (top.y + bot.y) / 2);
    c.x = (c.x + (top.x + bot.x) / 2) / 2;
    const open = top.distanceTo(bot);
    const halfW = w * 0.72, halfH = Math.max(w * 0.42, open * 0.85);
    const f = toFace(c);
    const s = CFG.mouth;
    const cx = smooth('mcx', c.x, t, 1.6, 0.03), cy = smooth('mcy', c.y, t, 1.6, 0.03);
    const hw = smooth('mhw', halfW, t, 0.6, 0.003), hh = smooth('mhh', halfH, t, 3.0, 0.05);
    insets.mouth.userData.v = {
      crop: [cx, cy, hw, hh],
      center: [FACE_REF.x + smooth('mfx', f.x, t, 0.6, 0.5) * FACE_SPAN, FACE_REF.y - smooth('mfy', f.y, t, 0.6, 0.5) * FACE_SPAN + CFG.mouthLift],
      size: [(2 * hw / faceW) * FACE_SPAN * s, (2 * hh / faceW) * FACE_SPAN * s],
    };
  }
  const sRoll = smooth('roll', roll, t, 1.2, 0.5);
  for (const m of Object.values(insets)) m.userData.roll = sRoll;

  const jaw = blend?.categories?.find((c) => c.categoryName === 'jawOpen')?.score ?? 0;
  target.jaw = smooth('jaw', jaw, t, 4.0, 2.0);
  target.seen = t;
}

function applyInsets(t) {
  const visible = t - target.seen < 350;
  for (const m of Object.values(insets)) {
    const u = m.material.uniforms;
    u.uOpacity.value += ((visible && m.userData.v ? 1 : 0) - u.uOpacity.value) * 0.25;
    u.uMirror.value = CFG.mirror ? 1 : 0;
    u.uVideo.value.set(videoEl.videoWidth || 720, videoEl.videoHeight || 1280);
    const v = m.userData.v;
    if (!v) continue;
    u.uCropC.value.set(v.crop[0], v.crop[1]);
    u.uCropH.value.set(v.crop[2], v.crop[3]);
    u.uAngle.value = m.userData.roll || 0;
    u.uCenter.value.set(v.center[0], v.center[1]);
    u.uSize.value.set(v.size[0], v.size[1]);
  }
}

// ---------------------------------------------------------------- face tracker
let landmarker = null;
async function startTracker() {
  let lastErr;
  for (const base of MP_BASES) {
    try {
      const { FaceLandmarker, FilesetResolver } = await import(`${base}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${base}/wasm`);
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: './face_landmarker.task', delegate },
        runningMode: 'VIDEO', numFaces: 1,
        outputFaceBlendshapes: true, outputFacialTransformationMatrixes: false,
        minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
      try { landmarker = await FaceLandmarker.createFromOptions(fileset, opts('GPU')); status.tracker = 'GPU'; }
      catch (e) { landmarker = await FaceLandmarker.createFromOptions(fileset, opts('CPU')); status.tracker = 'CPU (' + String(e.message || e).slice(0, 40) + ')'; }
      status.trackerSrc = new URL(base, location.href).host;
      updateLoadline();
      return;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no tracker source reachable');
}

// ---------------------------------------------------------------- camera + mic
// Audio (v0.1.1): the mic is opened fresh for every take and closed right after, so
//  - iOS never keeps "call mode" running between takes (that made playback thin and takes inconsistent)
//  - each take gets the same clean, unprocessed mic. "Voice" mode (Look) turns iOS call-style cleanup back on for noisy places.
const VIDEO_C = { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
const MIC = {
  clean: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 } },
  voice: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } },
};
const micConstraints = () => MIC[CFG.micMode] || MIC.clean;
let camStream = null, micStream = null;
let micGranted = false;
let keepMicOpen = false;   // flips on if reopening the mic looks like it asked for permission again
function describeMic(track) {
  if (!track) return '';
  const s = track.getSettings ? track.getSettings() : {};
  const yn = (v) => (v === undefined ? '?' : v ? 'on' : 'off');
  return `${s.sampleRate ? Math.round(s.sampleRate / 100) / 10 + ' kHz' : '? kHz'} · ${s.channelCount || '?'} ch · echo ${yn(s.echoCancellation)} · noise ${yn(s.noiseSuppression)} · auto-gain ${yn(s.autoGainControl)}`;
}
function micLive() { return !!micStream && micStream.getAudioTracks().some((t) => t.readyState === 'live'); }
function releaseMic(force = false) {
  if (!micStream || (keepMicOpen && !force)) return;
  for (const t of micStream.getTracks()) t.stop();
  micStream = null;
  status.mic = micGranted ? 'closed (opens when you record)' : status.mic;
}
async function openMic() {
  if (micLive()) return true;
  const t0 = performance.now();
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(), video: false });
    micStream = s;
    micGranted = true;
    status.mic = 'on';
    status.micInfo = describeMic(s.getAudioTracks()[0]);
    if (performance.now() - t0 > 1500) keepMicOpen = true;   // looked like a permission prompt: stop closing the mic between takes
    // some iOS versions stop the camera when a new capture starts: bring it back
    const vt = camStream?.getVideoTracks()[0];
    if (!vt || vt.readyState === 'ended') await restartCamera();
    return true;
  } catch (e) {
    status.mic = 'blocked (' + e.name + ')';
    return false;
  }
}
async function startCamera() {
  let stream;
  try {
    // one permission prompt for camera + mic, then the mic is closed until the first take
    stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_C, audio: micConstraints() });
    micGranted = true;
  } catch (e) {
    if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
      // maybe only the mic was refused: try camera alone
      stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_C, audio: false });
      status.mic = 'blocked';
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_C, audio: false });
      status.mic = 'unavailable';
    }
  }
  attachCamera(stream.getVideoTracks());
  const at = stream.getAudioTracks()[0];
  if (at) { status.micInfo = describeMic(at); micStream = new MediaStream([at]); releaseMic(); }
}
function attachCamera(tracks) {
  camStream = new MediaStream(tracks);
  videoEl.srcObject = camStream;
  videoEl.play().catch(() => {});
  const tr = camStream.getVideoTracks()[0];
  status.cam = `${tr?.getSettings?.().width || '?'}x${tr?.getSettings?.().height || '?'}`;
  tr?.addEventListener('ended', () => { status.cam = 'ended'; if (document.visibilityState === 'visible' && !restarting) restartCamera(); });
  // if opening the mic freezes the camera (some iOS versions), bring it back
  tr?.addEventListener('mute', () => setTimeout(() => { if (tr.muted && tr.readyState === 'live' && document.visibilityState === 'visible' && !restarting && camStream?.getVideoTracks()[0] === tr) restartCamera(); }, 1500));
}
let restarting = false;
async function restartCamera() {
  if (restarting) return;
  restarting = true;
  try { for (const t of camStream?.getTracks() || []) t.stop(); } catch {}
  try { attachCamera((await navigator.mediaDevices.getUserMedia({ video: VIDEO_C, audio: false })).getVideoTracks()); }
  catch (e) { status.cam = 'error ' + e.name; toast('Camera stopped. Tap Start again if it does not come back.'); }
  restarting = false;
}

// ---------------------------------------------------------------- loop
let lastVideoTime = -1, lastFrame = 0, fpsN = 0, fpsT = performance.now(), slowStrikes = 0;
const curQuat = new THREE.Quaternion();
const IDENT = new THREE.Quaternion();
function frame(now) {
  requestAnimationFrame(frame);
  if (now - lastFrame < 1000 / CFG.fps - 3) return;
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  if (landmarker && videoEl.readyState >= 2 && videoEl.currentTime !== lastVideoTime) {
    lastVideoTime = videoEl.currentTime;
    camFrames++;
    const t0 = performance.now();
    try {
      if (snapshotFrame()) {
        const res = landmarker.detectForVideo(snap, now);
        status.det = performance.now() - t0;
        status.face = !!res.faceLandmarks?.length;
        if (status.face) onFace(res.faceLandmarks[0], res.faceBlendshapes?.[0], now);
      }
    } catch (e) { status.err = 'detect: ' + e.message; }
  } else if (!landmarker && videoEl.readyState >= 2) {
    snapshotFrame();
  }

  const tracking = now - target.seen < 500;
  const goal = tracking ? target.quat : IDENT;
  const follow = 1 - Math.exp(-dt * (16 - 10 * Math.min(1, Math.max(0, CFG.smooth))));
  curQuat.slerp(goal, tracking ? follow : 1 - Math.exp(-dt * 2));
  rig.quaternion.copy(curQuat);
  const px = tracking ? target.pos.x * CFG.sway * 0.6 : 0, py = tracking ? target.pos.y * CFG.sway * 0.45 : 0;
  rig.position.x += (px - rig.position.x) * follow;
  rig.position.y += (py - rig.position.y) * follow;
  const jaw = tracking ? target.jaw : 0;
  const sy = 1 + 0.035 * jaw * CFG.bounce, sxz = 1 - 0.015 * jaw * CFG.bounce;
  bob.scale.set(sxz + (bob.scale.x - sxz) * 0.5, sy + (bob.scale.y - sy) * 0.5, sxz + (bob.scale.z - sxz) * 0.5);

  applyInsets(now);
  renderer.render(scene, camera);

  fpsN++;
  if (now - fpsT > 1000) {
    status.fps = fpsN * 1000 / (now - fpsT); status.camFps = camFrames * 1000 / (now - fpsT);
    camFrames = 0; fpsN = 0; fpsT = now;
    // gentle nudge if the phone can't keep up at 1080
    if (started && CFG.quality === 1080 && status.fps < 22 && !recording) { if (++slowStrikes === 6) toast('Running a bit slow. Try 720 × 1280 under Look.', 4000); }
    else slowStrikes = 0;
    drawDebug();
  }
}

function drawDebug() {
  if (!CFG.debug) return;
  const { w, h } = outSize();
  debugEl.textContent =
    `ZitiCam Pocket ${VERSION}\n` +
    `render ${status.fps.toFixed(1)} fps · camera ${status.camFps.toFixed(1)} fps\n` +
    `detect ${status.det.toFixed(1)} ms · tracker ${status.tracker}${status.trackerSrc ? ' (' + status.trackerSrc + ')' : ''}\n` +
    `camera ${status.cam} · mic ${status.mic}\n` +
    (status.micInfo ? `mic ${CFG.micMode}: ${status.micInfo}\n` : '') +
    `output ${w}x${h} · ${BGS[CFG.bg].label} key\n` +
    `recorder ${pickMime()?.mime || 'none'}\n` +
    `face ${status.face ? 'yes' : 'no'}` + (status.rec ? `\n${status.rec}` : '') +
    (status.err ? `\nerror ${status.err}` : '');
  if (videoEl.videoWidth) {
    thumb.width = 240; thumb.height = Math.round(240 * videoEl.videoHeight / videoEl.videoWidth);
    thumbCtx.drawImage(videoEl, 0, 0, thumb.width, thumb.height);
    const k = thumb.width / videoEl.videoWidth;
    thumbCtx.strokeStyle = '#e8b45a'; thumbCtx.lineWidth = 1.5;
    for (const m of Object.values(insets)) {
      const v = m.userData.v; if (!v) continue;
      let [cx, cy, hw, hh] = v.crop;
      if (CFG.mirror) cx = videoEl.videoWidth - cx;
      thumbCtx.save(); thumbCtx.translate(cx * k, cy * k); thumbCtx.rotate((CFG.mirror ? -1 : 1) * (m.userData.roll || 0));
      thumbCtx.strokeRect(-hw * k, -hh * k, 2 * hw * k, 2 * hh * k); thumbCtx.restore();
    }
  }
}

// ---------------------------------------------------------------- recording
const MIMES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1.4d0028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];
let mimeCache = null;
function pickMime() {
  if (mimeCache !== null) return mimeCache;
  if (typeof MediaRecorder === 'undefined') return (mimeCache = undefined);
  const forced = q.get('mime');
  if (forced && MediaRecorder.isTypeSupported(forced)) return (mimeCache = { mime: forced, ext: forced.startsWith('video/mp4') ? 'mp4' : 'webm' });
  const m = MIMES.find((x) => { try { return MediaRecorder.isTypeSupported(x); } catch { return false; } });
  return (mimeCache = m ? { mime: m, ext: m.startsWith('video/mp4') ? 'mp4' : 'webm' } : undefined);
}

let recorder = null, recording = false, chunks = [], recStart = 0, timerT = 0, take = null, counting = false;
function fmt(s) { s = Math.floor(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

async function startRecording() {
  const pm = pickMime();
  if (!pm) { toast('This browser can\'t record video.'); return; }
  const { w } = outSize();
  const vStream = canvas.captureStream(CFG.fps);
  const tracks = [...vStream.getVideoTracks()];
  if (micStream) for (const t of micStream.getAudioTracks()) if (t.readyState === 'live') tracks.push(t);
  const micNote = tracks.length > 1 ? (CFG.micMode === 'voice' ? 'voice mic' : 'clean mic') : 'no sound';
  const stream = new MediaStream(tracks);
  try {
    recorder = new MediaRecorder(stream, { mimeType: pm.mime, videoBitsPerSecond: w === 1080 ? 10_000_000 : 6_000_000, audioBitsPerSecond: 160_000 });
  } catch {
    recorder = new MediaRecorder(stream);
  }
  chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    for (const t of vStream.getVideoTracks()) t.stop();
    const type = (recorder.mimeType || pm.mime).split(';')[0] || 'video/mp4';
    const blob = new Blob(chunks, { type });
    chunks = [];
    releaseMic();   // back to normal audio before the playback starts
    if (blob.size < 2000) { toast('That take came out empty. Try again, and give it a second before stopping.', 4500); return; }
    finishTake(blob, (performance.now() - recStart) / 1000, type.includes('mp4') ? 'mp4' : 'webm', micNote);
  };
  recorder.onerror = (e) => { status.err = 'recorder: ' + (e.error?.message || e.name || 'error'); };
  recorder.start(1000);
  recording = true; recStart = performance.now();
  document.body.classList.add('recording');
  $('rec').setAttribute('aria-label', 'Stop recording');
  const tick = () => { $('timer').textContent = fmt((performance.now() - recStart) / 1000); status.rec = 'recording ' + $('timer').textContent; };
  tick(); timerT = setInterval(tick, 250);
  keepAwake();
}
function stopRecording() {
  if (!recording) return;
  recording = false;
  clearInterval(timerT);
  document.body.classList.remove('recording');
  $('rec').setAttribute('aria-label', 'Record');
  status.rec = '';
  try { recorder.requestData?.(); } catch {}
  try { recorder.stop(); } catch {}
}
async function countdownThenRecord() {
  counting = true;
  const micReady = status.mic === 'unavailable' ? Promise.resolve(false) : openMic();   // the mic warms up during the 3-2-1
  const el = $('count');
  if (CFG.countdown) {
    el.classList.add('show');
    for (const n of [3, 2, 1]) { el.textContent = n; await new Promise((r) => setTimeout(r, 800)); if (!counting) { el.classList.remove('show'); releaseMic(); return; } }
    el.classList.remove('show');
  }
  const ok = await micReady;
  if (!counting) { releaseMic(); return; }
  counting = false;
  if (!ok) toast('No mic, so this take is silent. Allow the microphone for this site to add sound.', 4500);
  startRecording();
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function finishTake(blob, secs, ext, micNote = '') {
  if (take?.url) URL.revokeObjectURL(take.url);
  const name = `ziticam-${stamp()}-${BGS[CFG.bg].label.toLowerCase()}.${ext}`;
  take = { blob, url: URL.createObjectURL(blob), name, ext };
  const v = $('reviewVideo');
  v.src = take.url;
  v.play().catch(() => {});
  const { w, h } = outSize();
  $('reviewMeta').textContent = `${fmt(secs)} · ${(blob.size / 1e6).toFixed(1)} MB · ${w}×${h} · ${ext.toUpperCase()} on ${BGS[CFG.bg].label.toLowerCase()} · ${micNote}`;
  openSheet('review');
}
async function shareTake() {
  if (!take) return;
  const file = new File([take.blob], take.name, { type: take.blob.type || 'video/mp4' });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  downloadTake();
}
function downloadTake() {
  if (!take) return;
  const a = document.createElement('a');
  a.href = take.url; a.download = take.name; document.body.appendChild(a); a.click(); a.remove();
}
function closeTake(del) {
  closeSheets();
  // fully unload the player: a paused video still holding the last take can starve the next recording
  const v = $('reviewVideo'); v.pause(); v.removeAttribute('src'); v.load();
  if (take) { URL.revokeObjectURL(take.url); take = null; }
  if (del) toast('Deleted.');
}

// ---------------------------------------------------------------- wake lock + app switching
let wakeLock = null;
async function keepAwake() {
  try { if (!wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch { /* not allowed: fine */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (recording) stopRecording();          // finalize the take instead of losing it (the mic closes when it's written)
    else releaseMic(true);
    counting = false;
  } else if (started) {
    keepAwake();
    const tr = camStream?.getVideoTracks()[0];
    if (!tr || tr.readyState === 'ended') restartCamera();
  }
});

// ---------------------------------------------------------------- UI
function openSheet(id) { $('scrim').classList.add('show'); $(id).classList.add('show'); }
function closeSheets() { $('scrim').classList.remove('show'); for (const s of document.querySelectorAll('.sheet')) s.classList.remove('show'); }

const SLIDERS = [
  ['Face', [
    ['eyes', 'Eye size', 0.6, 1.8, 0.01],
    ['eyeSpread', 'Eye spacing', 0.7, 1.3, 0.01],
    ['eyeLift', 'Eye height', -0.2, 0.2, 0.01],
    ['mouth', 'Mouth size', 0.6, 1.9, 0.01],
    ['mouthLift', 'Mouth height', -0.1, 0.35, 0.01],
  ]],
  ['Motion', [
    ['turn', 'Head follow', 0, 1.6, 0.01],
    ['sway', 'Drift', 0, 1.2, 0.01],
    ['bounce', 'Talk bounce', 0, 3, 0.05],
    ['smooth', 'Calm', 0, 1, 0.01],
  ]],
  ['Frame', [
    ['zoom', 'Size', 0.6, 1.6, 0.01],
    ['lift', 'Up / down', -0.6, 0.6, 0.01],
  ]],
];
function buildSliders() {
  const host = $('sliders');
  host.textContent = '';
  for (const [group, rows] of SLIDERS) {
    const g = document.createElement('div'); g.className = 'group'; g.textContent = group; host.appendChild(g);
    for (const [k, label, min, max, step] of rows) {
      const row = document.createElement('div'); row.className = 'row';
      const id = 'sl-' + k;
      const lab = document.createElement('label'); lab.htmlFor = id; lab.textContent = label;
      const inp = document.createElement('input'); inp.type = 'range'; inp.id = id; inp.min = min; inp.max = max; inp.step = step; inp.value = CFG[k];
      const out = document.createElement('output'); out.textContent = (+CFG[k]).toFixed(2);
      inp.addEventListener('input', () => {
        CFG[k] = +inp.value; out.textContent = (+inp.value).toFixed(2);
        if (k === 'zoom' || k === 'lift') applyFraming();
        saveCfg();
      });
      inp.addEventListener('dblclick', () => { CFG[k] = DEFAULTS[k]; inp.value = CFG[k]; out.textContent = (+CFG[k]).toFixed(2); applyFraming(); saveCfg(); });
      row.append(lab, inp, out); host.appendChild(row);
    }
  }
}

let started = false;
async function start() {
  const btn = $('startBtn');
  btn.disabled = true; btn.textContent = 'Starting…';
  $('startErr').style.display = 'none';
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('This page needs HTTPS and a browser with camera access.'), { name: 'NoCamera' });
    await startCamera();
    started = true;
    $('start').classList.add('gone');
    document.body.classList.remove('prestart');
    $('rec').disabled = false;
    keepAwake();
    if (!landmarker) setStatus('Loading face tracker…');
    if (!micGranted) toast('No mic access, so takes will be silent. Allow the microphone for this site to fix it.', 5000);
    else if (!store.get('zitipocket.seenTip', false)) { toast('Hold the phone how you\'ll record, look at it, then tap Set straight.', 5200); store.set('zitipocket.seenTip', true); }
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Try again';
    const err = $('startErr');
    err.style.display = 'block';
    err.textContent = e.name === 'NotAllowedError'
      ? 'Camera access is blocked. In Safari, open this site\'s settings (the page menu in the address bar), allow Camera and Microphone, then reload.'
      : (e.message || String(e));
  }
}

function wire() {
  buildSliders();
  $('startBtn').addEventListener('click', start);
  $('rec').addEventListener('click', () => {
    if (counting) { counting = false; return; }
    if (recording) stopRecording(); else countdownThenRecord();
  });
  $('bgBtn').addEventListener('click', () => {
    CFG.bg = BG_ORDER[(BG_ORDER.indexOf(CFG.bg) + 1) % BG_ORDER.length];
    applyLook(); saveCfg();
    if (CFG.bg === 'green') toast('Heads up: the basil flecks are green, so a green key can nibble them. Blue keys cleanest.', 4200);
  });
  $('sauceBtn').addEventListener('click', () => { CFG.sauce = !CFG.sauce; applyLook(); saveCfg(); });
  $('straightBtn').addEventListener('click', () => {
    if (performance.now() - lastRawT > 1000) { toast('I can\'t see your face yet. Look at the phone, then tap again.'); return; }
    neutralInv.copy(lastRawQuat).invert(); store.set('zitipocket.neutral', neutralInv.toArray());
    toast('Straightened. This pose is now "looking ahead".');
  });
  $('dbgBtn').addEventListener('click', () => { CFG.debug = !CFG.debug; applyLook(); drawDebug(); });
  $('lookBtn').addEventListener('click', () => openSheet('look'));
  $('closeLook').addEventListener('click', closeSheets);
  $('scrim').addEventListener('click', () => { if ($('review').classList.contains('show')) closeTake(false); else closeSheets(); });
  $('resetLook').addEventListener('click', () => {
    for (const k of LOOK_KEYS) CFG[k] = DEFAULTS[k];
    filters.clear(); saveCfg(); buildSliders(); applyLook(); toast('Back to the stream look.');
  });
  for (const b of document.querySelectorAll('[data-toggle]')) {
    b.addEventListener('click', () => {
      const k = b.dataset.toggle; CFG[k] = !CFG[k];
      if (k === 'mirror') filters.clear();
      applyLook(); saveCfg();
    });
  }
  for (const b of document.querySelectorAll('#micSeg button')) {
    b.addEventListener('click', async () => {
      if (recording || counting) return;
      CFG.micMode = b.dataset.mic; applyLook(); saveCfg();
      if (micLive()) { releaseMic(true); if (keepMicOpen) await openMic(); }   // reopen with the new setting if it's being kept open
      toast(CFG.micMode === 'voice' ? 'Voice mic: iPhone cleanup on. Good for loud places, can sound processed.' : 'Clean mic: your real voice, no processing.');
    });
  }
  for (const b of document.querySelectorAll('#qualSeg button')) {
    b.addEventListener('click', () => {
      if (recording) return;
      CFG.quality = +b.dataset.q; applyOutput(); applyLook(); saveCfg();
    });
  }
  $('shareBtn').addEventListener('click', shareTake);
  $('downloadBtn').addEventListener('click', downloadTake);
  $('discardBtn').addEventListener('click', () => closeTake(true));
  $('keepBtn').addEventListener('click', () => closeTake(false));
}

wire();
applyLook();
updateLoadline();
requestAnimationFrame(frame);
(q.get('notrack') === '1' ? new Promise(() => {}) : startTracker())
  .then(() => { setStatus(''); updateLoadline(); })
  .catch((e) => { status.tracker = 'failed'; status.err = 'tracker: ' + (e.message || e); setStatus('Face tracker didn\'t load. Check your connection and reload.'); updateLoadline(); });
if (q.get('autostart') === '1') start();

// tiny hook for automated checks
window.__zp = { status, CFG, insets, rig, renderer, scene, camera, onFace, applyLook, startRecording, stopRecording, get take() { return take; }, get landmarker() { return landmarker; }, pickMime, get micLive() { return micLive(); }, get camLive() { return camStream?.getVideoTracks()[0]?.readyState === 'live'; }, get keepMicOpen() { return keepMicOpen; } };
