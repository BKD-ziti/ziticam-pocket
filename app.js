// ZitiCam Pocket — the live-face ziti, running entirely on the phone.
// Front camera -> MediaPipe Face Landmarker -> the same 3D ziti as the stream PC (ZitiCam),
// rendered in 9:16 on a key color, recorded with your voice to MP4. Nothing leaves the phone.
//
// URL options: ?debug=1 (stats on), ?autostart=1 (skip the start card), ?mp=<base url> (MediaPipe location),
//   ?notrack=1, ?track=page (tracker on the page, not a worker), ?rec=mr (built-in recorder), ?memrec=1 (takes in memory),
//   ?mime=<type> (built-in recorder format), ?rawmic=1 (mic straight to the recorder, no audio line)

import * as THREE from 'three';
import { GLTFLoader } from './GLTFLoader.js';
import { RoomEnvironment } from './RoomEnvironment.js';
import { wcSupport, WcRecorder } from './recorder-wc.js';

const VERSION = '0.2.0';
const MP_VER = '0.10.35';   // same MediaPipe build as ZitiCam on the stream PC
const q = new URLSearchParams(location.search);
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------------------------------------------------------------- settings (stream look = defaults)
const DEFAULTS = {
  sauce: true, brows: false, mirror: false, flip: true,
  eyes: 1.1, mouth: 1.24, mouthLift: 0.16, eyeLift: 0, eyeSpread: 0.94,
  turn: 1.15, sway: 0.45, bounce: 2, smooth: 0.5,
  zoom: 1, lift: 0, bg: 'blue', quality: 1080, fps: 30, countdown: true, micMode: 'clean',
};
const LOOK_KEYS = ['sauce', 'brows', 'mirror', 'flip', 'eyes', 'mouth', 'mouthLift', 'eyeLift', 'eyeSpread', 'turn', 'sway', 'bounce', 'smooth', 'zoom', 'lift'];
const STORE = 'zitipocket.v1';
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: keep going */ } },
};
const CFG = { ...DEFAULTS, ...store.get(STORE, {}), debug: q.get('debug') === '1' };
if (![720, 1080, 2160].includes(CFG.quality)) CFG.quality = 1080;
if (![30, 60].includes(CFG.fps)) CFG.fps = 30;
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
// v0.2: the full frame is no longer anti-aliased. Most of it is one flat key color, and smoothing every pixel
// of a 1080p or 4K frame is most of the graphics cost. The noodle is drawn into its own 4x anti-aliased image,
// sized to just the box it fills on screen, then placed on the key color (see drawStage).
const renderer = new THREE.WebGLRenderer({
  canvas, alpha: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
});
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;   // render targets skip tone mapping, so the noodle applies its own
renderer.autoClear = false;

// three's Neutral tone curve (verbatim, exposure 1), baked into the noodle's materials. The eyes and mouth never had it.
const NEUTRAL = /* glsl */`
vec3 zitiNeutral( vec3 color ) {
  const float StartCompression = 0.8 - 0.04;
  const float Desaturation = 0.15;
  float x = min( color.r, min( color.g, color.b ) );
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max( color.r, max( color.g, color.b ) );
  if ( peak < StartCompression ) return color;
  float d = 1. - StartCompression;
  float newPeak = 1. - d * d / ( peak + d - StartCompression );
  color *= newPeak / peak;
  float g = 1. - 1. / ( Desaturation * ( peak - newPeak ) + 1. );
  return mix( color, vec3( newPeak ), g );
}
`;
function bakeToneMapping(m) {
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = NEUTRAL + sh.fragmentShader.replace('#include <tonemapping_fragment>', 'gl_FragColor.rgb = zitiNeutral( gl_FragColor.rgb );');
  };
  m.customProgramCacheKey = () => 'ziti-neutral';
  m.needsUpdate = true;
}

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(28, 9 / 16, 0.1, 50);
const fullProj = new THREE.Matrix4();   // the camera's projection without the noodle-box crop
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
const keyColor = new THREE.Color(BGS[CFG.bg].hex);

let OW = 1080, OH = 1920;
function outSize() { const w = CFG.quality; return { w, h: Math.round(w * 16 / 9) }; }
function applyOutput() {
  ({ w: OW, h: OH } = outSize());
  renderer.setSize(OW, OH, false);
  camera.aspect = OW / OH;
  compCam.right = OW; compCam.bottom = OH; compCam.updateProjectionMatrix();
  applyFraming();
  mimeCache = null;
  resetSmooth();
  updateVidHint();
}
function applyFraming() {
  camera.fov = 28 / Math.max(0.3, CFG.zoom);
  camera.position.set(0, 0.25 - CFG.lift, 6.0);
  camera.lookAt(0, 0.05 - CFG.lift, 0);
  camera.updateMatrixWorld();
  camera.clearViewOffset();   // also updates the projection
  fullProj.copy(camera.projectionMatrix);
  zitiDirty = true;
}
function applyLook() {
  world.scale.x = CFG.flip ? -1 : 1;
  if (sauceNode) sauceNode.visible = CFG.sauce;
  keyColor.set(BGS[CFG.bg].hex);
  $('bgSwatch').style.background = BGS[CFG.bg].hex;
  $('bgLabel').textContent = BGS[CFG.bg].label;
  $('sauceBtn').setAttribute('aria-pressed', String(CFG.sauce));
  for (const b of document.querySelectorAll('[data-toggle]')) b.setAttribute('aria-pressed', String(!!CFG[b.dataset.toggle]));
  for (const b of document.querySelectorAll('#qualSeg button')) b.setAttribute('aria-pressed', String(+b.dataset.q === CFG.quality));
  for (const b of document.querySelectorAll('#fpsSeg button')) b.setAttribute('aria-pressed', String(+b.dataset.fps === CFG.fps));
  for (const b of document.querySelectorAll('#micSeg button')) b.setAttribute('aria-pressed', String(b.dataset.mic === (CFG.micMode || 'clean')));
  document.body.classList.toggle('debug', CFG.debug);
  $('dbgBtn').setAttribute('aria-pressed', String(CFG.debug));
  applyFraming();
}

// ---------------------------------------------------------------- the stage: noodle image on the key color
// The noodle is drawn into a 4x anti-aliased sRGB image covering only the box it fills on screen (found by projecting
// its bounds every frame), then that image is laid onto the flat key color in one cheap pass. The image is kept between
// frames, so at 60 fps a busy phone can redraw the noodle every other frame and still show every frame.
const compScene = new THREE.Scene();
const compCam = new THREE.OrthographicCamera(0, OW, 0, OH, -10, 10);   // y runs down, in output pixels
const quad = new THREE.PlaneGeometry(1, 1);
const zQuad = new THREE.Mesh(quad, new THREE.MeshBasicMaterial({ toneMapped: false, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
zQuad.frustumCulled = false; zQuad.visible = false;
compScene.add(zQuad);

let zRT = null, zitiDirty = true, zTick = 0;
// The noodle's bounds in bob space, as an upright cylinder around its axis (a box's corners would stick out
// past a round noodle whenever it turns). Talk bounce lives in bob's scale, so it's already included.
const zHull = [];
let zBoxReady = false;
const zCorner = new THREE.Vector3();
function measureZiti(root) {
  // root isn't attached yet, so its world matrices are in bob space
  root.updateMatrixWorld(true);
  let r = SURFACE_R * 1.08, y0 = Infinity, y1 = -Infinity;   // the eyes and mouth sit on the surface
  const v = new THREE.Vector3();
  root.traverse((o) => {
    const pos = o.isMesh && o.geometry.attributes.position;
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      r = Math.max(r, Math.hypot(v.x, v.z)); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
  });
  const N = 16, R = r * 1.02 / Math.cos(Math.PI / N), pad = (y1 - y0) * 0.02;   // a 16-sided ring that fully contains the circle
  zHull.length = 0;
  for (const y of [y0 - pad, y1 + pad]) for (let i = 0; i < N; i++) zHull.push(new THREE.Vector3(R * Math.cos(2 * Math.PI * i / N), y, R * Math.sin(2 * Math.PI * i / N)));
  zBoxReady = true;
}
const zRect = { x: 0, y: 0, w: 0, h: 0, on: false };
function zitiTarget(w, h) {
  // grow in 64 px steps and only shrink when much too big, so the noodle turning rarely reallocates
  const fits = zRT && zRT.width >= w && zRT.height >= h && zRT.width * zRT.height <= 2.2 * w * h;
  if (fits) return zRT;
  zRT?.dispose();
  zRT = new THREE.WebGLRenderTarget(Math.ceil(w / 64) * 64, Math.ceil(h / 64) * 64, { samples: 4, depthBuffer: true, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  zRT.texture.colorSpace = THREE.SRGBColorSpace;
  zQuad.material.map = zRT.texture;
  zQuad.material.needsUpdate = true;
  return zRT;
}
// where the noodle is on screen right now, in output pixels (top-left origin), padded for anti-aliasing
function zitiScreenRect() {
  if (!zBoxReady) return null;
  scene.updateMatrixWorld();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of zHull) {
    zCorner.copy(p).applyMatrix4(bob.matrixWorld).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(fullProj);
    const px = (zCorner.x * 0.5 + 0.5) * OW, py = (0.5 - zCorner.y * 0.5) * OH;
    x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
  }
  const pad = 4 + 0.01 * Math.max(x1 - x0, y1 - y0);
  x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
  x1 = Math.min(OW, Math.ceil(x1 + pad)); y1 = Math.min(OH, Math.ceil(y1 + pad));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
function drawStage() {
  const redraw = zitiDirty || (zTick++ % rung().every) === 0 || !zRect.on;
  if (redraw) {
    zitiDirty = false;
    const r = zitiScreenRect();
    zRect.on = !!r;
    if (r) {
      Object.assign(zRect, r);
      const s = rung().scale;
      const rw = Math.max(16, Math.round(r.w * s)), rh = Math.max(16, Math.round(r.h * s));
      const rt = zitiTarget(rw, rh);
      camera.setViewOffset(OW, OH, r.x, r.y, r.w, r.h);   // render just the noodle's box, at full (or ladder) sharpness
      rt.viewport.set(0, 0, rw, rh);
      rt.scissor.set(0, 0, rw, rh);
      rt.scissorTest = true;   // clear only the part in use
      renderer.setRenderTarget(rt);
      renderer.setClearColor(keyColor, 1);   // the noodle's edges blend into the real key color, exactly as before
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
      camera.clearViewOffset();
      rt.texture.repeat.set(rw / rt.width, rh / rt.height);
      zQuad.position.set(r.x + r.w / 2, r.y + r.h / 2, 0);
      zQuad.scale.set(r.w, -r.h, 1);   // negative: image rows run bottom-up, this stage runs top-down
    }
  }
  zQuad.visible = zRect.on;
  renderer.setRenderTarget(null);
  renderer.setClearColor(keyColor, 1);
  renderer.clear(true, true, false);
  if (zRect.on) renderer.render(compScene, compCam);
}

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
    bakeToneMapping(m);
  });
  sauceNode = root.getObjectByName('Sauce');
  measureZiti(root);
  bob.add(root);
  zitiReady = true;
  applyLook();
  updateLoadline();
  renderer.compile(scene, camera);   // build the shaders now, not on the first visible frame
}, (e) => { if (e.total) setLoad('ziti', Math.round(100 * e.loaded / e.total)); },
(e) => { status.err = 'model: ' + e.message; updateLoadline(); });

const loadPct = { ziti: 0 };
function setLoad(k, v) { loadPct[k] = v; updateLoadline(); }
function updateLoadline() {
  const el = $('loadline');
  if (status.err && !zitiReady) { el.textContent = 'Problem: ' + status.err; return; }
  const parts = [];
  parts.push(zitiReady ? 'Ziti ready' : `Loading the ziti… ${loadPct.ziti || 0}%`);
  parts.push(trackerReady() ? 'face tracker ready' : (status.tracker === 'failed' ? 'face tracker failed' : 'loading face tracker…'));
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

function onFace(lm, blend, t, W = videoEl.videoWidth, H = videoEl.videoHeight) {
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
  const visible = t - target.seen < Math.max(350, 3 * resultGap);
  for (const m of Object.values(insets)) {
    const u = m.material.uniforms;
    u.uOpacity.value += ((visible && m.userData.v ? 1 : 0) - u.uOpacity.value) * 0.25;
    u.uMirror.value = CFG.mirror ? 1 : 0;
    u.uVideo.value.set(snap.width || videoEl.videoWidth || 720, snap.height || videoEl.videoHeight || 1280);
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
// v0.2: it runs in a background worker, so a slow face check (15-30 ms on a phone) never delays a video frame.
// One camera frame is in flight at a time; each answer comes back with the frame it measured, so the eyes and
// mouth stay aligned. Loads from this site first (works offline), then the CDNs. Falls back to the page if needed.
let landmarker = null, worker = null, workerReady = false, inFlight = false;
let resultGap = 33, lastArrival = 0;   // how often face answers arrive; the 'face is here' window stretches to match
const trackerReady = () => !!landmarker || workerReady;
const trackerBases = () => (q.get('mp') ? [q.get('mp')] : [
  new URL('./vendor/mediapipe', location.href).href,
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}`,
  `https://unpkg.com/@mediapipe/tasks-vision@${MP_VER}`,
]);
const hostOf = (base) => { const h = new URL(base, location.href).host; return h === location.host ? 'local' : h; };
const MODEL_URL = new URL('./face_landmarker.task', location.href).href;

function startWorker() {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(new URL('./tracker-worker.js', import.meta.url)); }
    catch (e) { reject(e); return; }
    const fail = (why) => { try { w.terminate(); } catch {} reject(new Error(why)); };
    const timer = setTimeout(() => fail('worker took too long to start'), 30000);
    w.onerror = (e) => { clearTimeout(timer); fail(e.message || 'worker error'); };
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') {
        clearTimeout(timer);
        worker = w; workerReady = true;
        w.onmessage = (ev) => onWorkerResult(ev.data);
        w.onerror = () => { workerReady = false; status.err = 'tracker worker stopped'; };
        status.tracker = m.tracker + ' · background';
        status.trackerSrc = hostOf(m.src);
        resolve();
      } else if (m.type === 'failed') { clearTimeout(timer); fail(m.err); }
    };
    w.postMessage({ type: 'init', bases: trackerBases(), model: MODEL_URL });
  });
}
function onWorkerResult(m) {
  if (m.type !== 'result') return;
  inFlight = false;
  camFrames++;
  status.det = m.det;
  if (m.err && m.err !== 'not ready') status.err = 'detect: ' + m.err;
  // the frame the tracker measured becomes the eyes-and-mouth texture, so they line up exactly
  const bm = m.bitmap;
  if (bm) {
    if (snap.width !== bm.width || snap.height !== bm.height) { snap.width = bm.width; snap.height = bm.height; videoTex.dispose(); }
    snapCtx.drawImage(bm, 0, 0);
    videoTex.needsUpdate = true;
    bm.close?.();
  }
  status.face = !!m.lm;
  if (m.lm) {
    onFace(m.lm, { categories: [{ categoryName: 'jawOpen', score: m.jaw }] }, m.ts, snap.width, snap.height);
    // smoothing runs on capture time, but "is a face here right now" goes by when the answer arrived
    const arrived = performance.now();
    if (lastArrival) resultGap = resultGap * 0.8 + Math.min(1000, arrived - lastArrival) * 0.2;
    lastArrival = target.seen = lastRawT = arrived;
  }
}

async function startTracker() {
  if (q.get('track') !== 'page' && typeof Worker !== 'undefined' && typeof createImageBitmap === 'function') {
    try { await startWorker(); updateLoadline(); return; }
    catch (e) { status.workerErr = String(e.message || e); }
  }
  let lastErr;
  for (const base of trackerBases()) {
    try {
      const { FaceLandmarker, FilesetResolver } = await import(`${base}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${base}/wasm`);
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO', numFaces: 1,
        outputFaceBlendshapes: true, outputFacialTransformationMatrixes: false,
        minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
      try { landmarker = await FaceLandmarker.createFromOptions(fileset, opts('GPU')); status.tracker = 'GPU'; }
      catch (e) { landmarker = await FaceLandmarker.createFromOptions(fileset, opts('CPU')); status.tracker = 'CPU (' + String(e.message || e).slice(0, 40) + ')'; }
      status.trackerSrc = hostOf(base);
      updateLoadline();
      return;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no tracker source reachable');
}

let lastVideoTime = -1;
function track(now) {
  if (workerReady) {
    // one frame at a time: if the tracker is slower than the camera it just skips frames, the video never waits
    if (!inFlight && videoEl.readyState >= 2 && videoEl.currentTime !== lastVideoTime) {
      lastVideoTime = videoEl.currentTime;
      inFlight = true;
      createImageBitmap(videoEl)
        .then((bitmap) => worker.postMessage({ type: 'frame', bitmap, ts: now }, [bitmap]))
        .catch(() => { inFlight = false; });
    }
  } else if (landmarker && videoEl.readyState >= 2 && videoEl.currentTime !== lastVideoTime) {
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
  } else if (!trackerReady() && videoEl.readyState >= 2 && videoEl.currentTime !== lastVideoTime) {
    lastVideoTime = videoEl.currentTime;
    snapshotFrame();
  }
}

// ---------------------------------------------------------------- camera + mic
// The mic is opened fresh for every take and closed right after, so iOS never keeps "call mode" running between
// takes (that made playback thin). "Voice" mode (Look) turns iOS call-style cleanup back on for noisy places.
const VIDEO_C = { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
const MIC = {
  clean: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 } },
  voice: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } },
};
const micConstraints = () => MIC[CFG.micMode] || MIC.clean;
let camStream = null, micStream = null;
let micGranted = false;
let keepMicOpen = false;   // on if this site has to ask for the mic every time
function describeMic(track) {
  if (!track) return '';
  const s = track.getSettings ? track.getSettings() : {};
  const yn = (v) => (v === undefined ? '?' : v ? 'on' : 'off');
  return `${s.sampleRate ? Math.round(s.sampleRate / 100) / 10 + ' kHz' : '? kHz'} · ${s.channelCount || '?'} ch · echo ${yn(s.echoCancellation)} · noise ${yn(s.noiseSuppression)} · auto-gain ${yn(s.autoGainControl)}`;
}
function micLive() { return !!micStream && micStream.getAudioTracks().some((t) => t.readyState === 'live'); }
function releaseMic(force = false) {
  if (!micStream || (keepMicOpen && !force)) return;
  unplugMic();
  for (const t of micStream.getTracks()) t.stop();
  micStream = null;
  status.mic = micGranted ? 'closed (opens when you record)' : status.mic;
}
async function micPermission() {
  try { return (await navigator.permissions.query({ name: 'microphone' })).state; } catch { return 'unknown'; }
}
async function getMic() {
  const s = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(), video: false });
  micStream = s; micGranted = true; status.mic = 'on';
  status.micInfo = describeMic(s.getAudioTracks()[0]);
  watchMic();
}
async function openMic() {
  if (micLive()) return true;
  const t0 = performance.now();
  try {
    await getMic();
    // only keep the mic open between takes if this site asks for permission every time
    const perm = await micPermission();
    keepMicOpen = perm === 'unknown' ? performance.now() - t0 > 3000 : perm !== 'granted';
    // some iOS versions stop the camera when a new capture starts: bring it back
    const vt = camStream?.getVideoTracks()[0];
    if (camStream && (!vt || vt.readyState === 'ended')) {
      await restartCamera();
      if (!micLive()) await getMic();   // some iPhones drop the mic when the camera comes back
    }
    return true;
  } catch (e) {
    status.mic = 'blocked (' + e.name + ')';
    return false;
  }
}

// ---- the audio line (v0.2): the recorder always records one steady Web Audio track, and the mic plugs into it.
// If the mic hiccups or gets reconnected mid-take, the video gets a moment of silence instead of a broken audio track.
const AC = window.AudioContext || window.webkitAudioContext;
let actx = null, bus = null, meter = null, meterBuf = null, micNode = null;
let tapNode = null, tapReady = null, audioSink = null;   // audio-thread tap for the WebCodecs recorder (audio-tap.js)
function audioLine() {
  if (!AC || q.get('rawmic') === '1') return null;
  try {
    if (!actx) {
      actx = new AC();
      bus = actx.createMediaStreamDestination();
      // mic -> meter -> recorder: the meter sits in the path, so it shows exactly what's being recorded
      meter = actx.createAnalyser(); meter.fftSize = 1024;
      meter.connect(bus);
      meterBuf = new Float32Array(meter.fftSize);
      // mic -> meter -> tap: hands raw audio blocks to the recorder from the audio thread, so drawing can't cause gaps
      if (actx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        tapReady = actx.audioWorklet.addModule('./audio-tap.js').then(() => {
          tapNode = new AudioWorkletNode(actx, 'ziti-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
          meter.connect(tapNode);
          tapNode.connect(bus);   // its output is silent; this just keeps it running
          tapNode.port.onmessage = (e) => audioSink?.(e.data);
          return true;
        }).catch(() => false);
      }
    }
    if (actx.state !== 'running') actx.resume().catch(() => {});
    return actx;
  } catch { return null; }
}
function plugMic() {
  if (!actx || !micLive()) return false;
  unplugMic();
  try {
    micNode = actx.createMediaStreamSource(micStream);
    micNode.connect(meter);
    return true;
  } catch { micNode = null; return false; }
}
function unplugMic() { try { micNode?.disconnect(); } catch {} micNode = null; }
function micLevel() {
  if (!meter || !micNode) return 0;
  meter.getFloatTimeDomainData(meterBuf);
  let s = 0;
  for (let i = 0; i < meterBuf.length; i++) s += meterBuf[i] * meterBuf[i];
  return Math.sqrt(s / meterBuf.length);
}
function sleepAudio() { if (actx && actx.state === 'running') actx.suspend().catch(() => {}); }
function watchMic() {
  const t = micStream?.getAudioTracks()[0];
  if (!t) return;
  t.onmute = () => { status.mic = 'muted by the device'; };
  t.onunmute = () => { status.mic = 'on'; };
  t.onended = async () => {
    if (!recording || micStream?.getAudioTracks()[0] !== t) return;
    micStream = null;
    if (status.audioPath !== 'line') { toast('The mic was cut off by the device. The rest of this take may be silent.', 5000); return; }
    toast('The mic was interrupted. Reconnecting…', 2500);
    try { await getMic(); plugMic(); toast('Mic back.', 1800); }
    catch { toast('Couldn\'t get the mic back. Stop and start a new take.', 5000); }
  };
}

async function startCamera() {
  let stream;
  try {
    // one permission prompt for camera + mic, then the mic is closed until the first take
    stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_C, audio: micConstraints() });
    micGranted = true;
  } catch (e) {
    // maybe only the mic was refused: try camera alone
    stream = await navigator.mediaDevices.getUserMedia({ video: VIDEO_C, audio: false });
    status.mic = (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'blocked' : 'unavailable';
  }
  attachCamera(stream.getVideoTracks());
  const at = stream.getAudioTracks()[0];
  if (at) { status.micInfo = describeMic(at); micStream = new MediaStream([at]); releaseMic(true); }
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
let restarting = false, camRestartPending = false;
async function restartCamera() {
  // reopening the camera mid-take can cut the mic on iPhone, so wait for the take to finish
  if (recording) { camRestartPending = true; return; }
  if (restarting) return;
  restarting = true;
  try { for (const t of camStream?.getTracks() || []) t.stop(); } catch {}
  try { attachCamera((await navigator.mediaDevices.getUserMedia({ video: VIDEO_C, audio: false })).getVideoTracks()); }
  catch (e) { status.cam = 'error ' + e.name; toast('Camera stopped. Tap Start again if it does not come back.'); }
  restarting = false;
}

// ---------------------------------------------------------------- loop
let lastFrame = 0, fpsN = 0, fpsT = performance.now();
const curQuat = new THREE.Quaternion();
const IDENT = new THREE.Quaternion();
function frame(now) {
  requestAnimationFrame(frame);
  if (now - lastFrame < 1000 / CFG.fps - 3) return;
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  const w0 = performance.now();

  track(now);

  const tracking = now - target.seen < Math.max(500, 3 * resultGap);
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
  drawStage();
  recordFrame();

  // main-thread cost of this frame: what has to fit inside 33 ms (or 16 ms at 60 fps)
  const work = performance.now() - w0;
  status.work = status.work ? status.work * 0.9 + work * 0.1 : work;
  status.workMax = Math.max(status.workMax || 0, work);
  fpsN++;
  if (now - fpsT > 1000) {
    status.fps = fpsN * 1000 / (now - fpsT); status.camFps = camFrames * 1000 / (now - fpsT);
    camFrames = 0; fpsN = 0; fpsT = now;
    checkPace();
    drawDebug();
    status.workMax = 0;
  }
}

// ---- staying smooth: if the phone can't keep up, give up a little noodle sharpness before the video stutters.
// Each step is checked: if it didn't actually help, it's undone (the limit is elsewhere) and the noodle stays at full quality.
const LADDER = {
  60: [{ every: 1, scale: 1 }, { every: 2, scale: 1 }, { every: 2, scale: 0.75 }, { every: 2, scale: 0.55 }],
  30: [{ every: 1, scale: 1 }, { every: 1, scale: 0.75 }, { every: 1, scale: 0.55 }],
};
const pace = { lvl: 0, bad: 0, good: 0, check: null, holdUntil: 0 };
const rung = () => (LADDER[CFG.fps] || LADDER[30])[pace.lvl] || LADDER[30][0];
function setRung(l) { pace.lvl = l; zitiDirty = true; }
function resetSmooth() { Object.assign(pace, { bad: 0, good: 0, check: null, holdUntil: 0 }); setRung(0); slowStrikes = 0; slowWarned = false; }
let slowStrikes = 0, slowWarned = false;
function checkPace() {
  if (!started || document.visibilityState !== 'visible' || sheetOpen()) { pace.bad = pace.good = 0; return; }
  const now = performance.now(), ratio = status.fps / CFG.fps, top = (LADDER[CFG.fps] || LADDER[30]).length - 1;
  if (ratio < 0.9) { pace.bad++; pace.good = 0; } else if (ratio > 0.97) { pace.good++; pace.bad = 0; } else { pace.bad = pace.good = 0; }

  if (pace.check && now - pace.check.at > 3000) {
    const c = pace.check; pace.check = null;
    if (c.dir === 'down' && status.fps < c.fps * 1.08) { setRung(c.from); pace.holdUntil = now + 60000; }   // didn't help: undo
    if (c.dir === 'up' && ratio < 0.9) { setRung(c.from); pace.holdUntil = now + 60000; }                    // too much: go back
  }
  if (!pace.check && now > pace.holdUntil) {
    if (pace.bad >= 2 && pace.lvl < top) {
      pace.check = { dir: 'down', from: pace.lvl, fps: status.fps, at: now };
      setRung(pace.lvl + 1); pace.bad = 0;
    } else if (pace.good >= 8 && pace.lvl > 0) {
      pace.check = { dir: 'up', from: pace.lvl, fps: status.fps, at: now };
      setRung(pace.lvl - 1); pace.good = 0;
    }
  }

  // still short with nothing left to give (or nothing that helps): say so once
  if (slowWarned) return;
  if (ratio < 0.8 && (pace.lvl === top || now < pace.holdUntil)) slowStrikes++; else slowStrikes = Math.max(0, slowStrikes - 1);
  if (slowStrikes >= 4) {
    slowWarned = true;
    const lower = CFG.fps === 60 ? '30 fps' : CFG.quality === 2160 ? '1080 × 1920' : '720 × 1280';
    toast(`Holding ${Math.round(status.fps)} of ${CFG.fps} frames a second. If Low Power Mode is on, turn it off (it caps the screen at 30). Otherwise try ${lower} under Look.`, 7500);
  }
}

function drawDebug() {
  if (!CFG.debug) return;
  const st = wcRec?.stats || status.lastStats;
  debugEl.textContent =
    `ZitiCam Pocket ${VERSION}\n` +
    `render ${status.fps.toFixed(1)} / ${CFG.fps} fps · tracked ${status.camFps.toFixed(1)} fps\n` +
    `frame work ${(status.work || 0).toFixed(1)} ms avg, ${(status.workMax || 0).toFixed(1)} max · budget ${(1000 / CFG.fps).toFixed(0)} ms\n` +
    `detect ${status.det.toFixed(1)} ms · tracker ${status.tracker}${status.trackerSrc ? ' (' + status.trackerSrc + ')' : ''}${status.workerErr ? ' · worker: ' + status.workerErr.slice(0, 50) : ''}\n` +
    `camera ${status.cam} · mic ${status.mic}\n` +
    (status.micInfo ? `mic ${CFG.micMode}: ${status.micInfo}\n` : '') +
    `output ${OW}x${OH} · ${BGS[CFG.bg].label} key · noodle box ${zRect.on ? zRect.w + 'x' + zRect.h : 'off'}\n` +
    `smoothness step ${pace.lvl} · noodle redrawn every ${rung().every === 1 ? 'frame' : rung().every + ' frames'} at ${Math.round(rung().scale * 100)}%${pace.holdUntil > performance.now() ? ' · holding' : ''}\n` +
    (status.level !== undefined ? `mic level ${(status.level * 100).toFixed(1)} · audio ${status.audioPath || '–'}\n` : '') +
    `recorder ${status.engine || (pickMime()?.mime || 'none')}${status.engineWhy ? ' (' + status.engineWhy + ')' : ''} · ${disk.ok ? 'saves to storage' : 'in memory'}\n` +
    (st ? `frames ${st.frames} · repeated ${st.repeats} · encoder waits ${st.waits}\n` : '') +
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
// H.264 levels cap size x frame rate: 4.0 = 1080p30, 4.2 = 1080p60, 5.1 = 4K30, 5.2 = 4K60
function h264Levels() {
  const mbs = Math.ceil(OW / 16) * Math.ceil(OH / 16), rate = mbs * CFG.fps;
  const all = [['28', 8192, 245760], ['2a', 8704, 522240], ['33', 36864, 983040], ['34', 36864, 2073600]];
  return all.filter(([, f, r]) => mbs <= f && rate <= r).map(([l]) => l);
}
function mimeList() {
  return [
    ...h264Levels().flatMap((l) => [`video/mp4;codecs=avc1.6400${l},mp4a.40.2`, `video/mp4;codecs=avc1.4d00${l},mp4a.40.2`]),
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
}
let mimeCache = null;
function pickMime() {
  if (mimeCache !== null) return mimeCache;
  if (typeof MediaRecorder === 'undefined') return (mimeCache = undefined);
  const forced = q.get('mime');
  if (forced && MediaRecorder.isTypeSupported(forced)) return (mimeCache = { mime: forced, ext: forced.startsWith('video/mp4') ? 'mp4' : 'webm' });
  const m = mimeList().find((x) => { try { return MediaRecorder.isTypeSupported(x); } catch { return false; } });
  return (mimeCache = m ? { mime: m, ext: m.startsWith('video/mp4') ? 'mp4' : 'webm' } : undefined);
}
// a moving noodle on one flat color compresses well; these keep the key edges clean for CapCut
function videoBitrate() {
  const hi = CFG.fps === 60;
  if (CFG.quality === 2160) return hi ? 36_000_000 : 24_000_000;
  if (CFG.quality === 1080) return hi ? 15_000_000 : 10_000_000;
  return hi ? 9_000_000 : 6_000_000;
}
function updateVidHint() {
  const el = $('vidHint');
  if (!el) return;
  const mbMin = Math.round((videoBitrate() + 160_000) / 8 / 1e6 * 60);
  let note = `${OW} × ${OH} at ${CFG.fps} fps · about ${mbMin} MB per minute.`;
  if (disk.ok) note += ' Takes save to this phone\'s storage as you record, so long takes are fine.';
  else if (CFG.quality === 2160) note += ' This browser holds takes in memory: keep 4K takes to a few minutes.';
  if (CFG.fps === 60 || CFG.quality === 2160) note += ' If your phone dips, the noodle gets a touch softer first so the video stays smooth.';
  el.textContent = note;
}

// ---- takes go straight to this phone's storage where the browser allows it: no memory limit on long 4K takes,
// and the last take survives the app being closed or crashing. Otherwise they're held in memory as before.
const disk = { w: null, ok: false, seq: 0, wait: new Map() };
function diskCall(msg) {
  return new Promise((res, rej) => { const id = ++disk.seq; disk.wait.set(id, { res, rej }); disk.w.postMessage({ ...msg, id }); });
}
const takesDir = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('takes', { create: true });
const diskFile = async (name) => (await (await takesDir()).getFileHandle(name)).getFile();
async function initDisk() {
  if (q.get('memrec') === '1' || !navigator.storage?.getDirectory || typeof Worker === 'undefined') return;
  try {
    disk.w = new Worker('./take-writer.js');
    disk.w.onmessage = (e) => { const m = e.data, p = disk.wait.get(m.id); if (!p) return; disk.wait.delete(m.id); if (m.ok) p.res(m); else p.rej(new Error(m.err)); };
    await Promise.race([diskCall({ type: 'probe' }), new Promise((_, rej) => setTimeout(() => rej(new Error('storage check timed out')), 5000))]);
    disk.ok = true;
    navigator.storage.persist?.().catch(() => {});
  } catch (e) { disk.ok = false; status.diskErr = String(e.message || e); }
  updateVidHint();
  if (disk.ok) recoverTake().catch(() => {});
}
async function recoverTake() {
  const d = await takesDir(), names = [];
  for await (const name of d.keys()) if (!name.startsWith('.')) names.push(name);
  names.sort();
  const latest = names.pop();
  if (names.length) diskCall({ type: 'remove', names }).catch(() => {});
  if (!latest || take || recording) return;
  const f = await diskFile(latest);
  if (f.size < 2000) { diskCall({ type: 'remove', names: [latest] }).catch(() => {}); return; }
  const ext = latest.endsWith('.webm') ? 'webm' : 'mp4';
  const blob = new Blob([f], { type: ext === 'mp4' ? 'video/mp4' : 'video/webm' });
  take = { blob, url: URL.createObjectURL(blob), name: latest, ext, disk: latest, meta: `${(f.size / 1e6).toFixed(1)} MB · ${ext.toUpperCase()} · kept from your last session` };
  $('takeBtn').hidden = false;
}

let recorder = null, recording = false, counting = false, startingRec = false, chunks = [], bytes = 0;
let recStart = 0, timerT = 0, take = null;
const fmt = (s) => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return `${h ? h + ':' + String(m).padStart(2, '0') : m}:${String(s % 60).padStart(2, '0')}`; };
const elapsed = () => (performance.now() - recStart) / 1000;

// Two recording engines:
//  'webcodecs': every frame drawn goes to the hardware H.264 encoder with an exact timestamp (frame n at n / fps),
//    so the file is a true constant frame rate. Used whenever the device supports it at this size.
//  'mediarecorder': the browser's built-in recorder, as a fallback (older Safari has no WebCodecs audio encoder).
//    It's handed one frame per drawn frame, rather than sampling the canvas on its own timer and missing some.
let wcRec = null, mrTrack = null, finishFn = null, takeMeta = null;
const engineCache = new Map();
function checkEngine(audioRate) {
  if (q.get('rec') === 'mr') return Promise.resolve({ ok: false, why: 'forced built-in recorder' });
  const k = `${OW}x${OH}@${CFG.fps}:${audioRate}:${videoBitrate()}`;
  if (!engineCache.has(k)) engineCache.set(k, wcSupport({ W: OW, H: OH, fps: CFG.fps, bitrate: videoBitrate(), audioRate }));
  return engineCache.get(k);
}

async function startRecording() {
  status.audioPath = '';
  let audioTrack = null;
  if (actx?.state === 'running' && plugMic()) { audioTrack = bus.stream.getAudioTracks()[0]; status.audioPath = 'line'; }
  else if (micLive()) { audioTrack = micStream.getAudioTracks()[0]; status.audioPath = 'direct'; }
  const micNote = audioTrack ? (CFG.micMode === 'voice' ? 'voice mic' : 'clean mic') : 'no sound';
  const shape = `${OW}×${OH} · ${CFG.fps} fps`;
  const bgName = BGS[CFG.bg].label.toLowerCase();
  const toDisk = disk.ok;
  const nameFor = (ext) => `ziticam-${stamp()}-${bgName}.${ext}`;
  chunks = []; bytes = 0; wcRec = null; mrTrack = null; finishFn = null;
  let diskFailed = false;
  const diskFail = () => {
    if (diskFailed) return;
    diskFailed = true;
    toast('Couldn\'t write to this phone\'s storage (it may be full). Stopping here so the take so far is kept.', 6500);
    stopRecording();
  };
  const readDisk = async (name, type) => {
    try { await diskCall({ type: 'close' }); return new Blob([await diskFile(name)], { type }); } catch { return null; }
  };

  // WebCodecs needs the audio-thread tap for sound; without it (no Web Audio), use the built-in recorder
  const tapOk = status.audioPath === 'line' && tapReady
    ? await Promise.race([tapReady, new Promise((r) => setTimeout(() => r(false), 1500))]) : false;
  const audioRate = audioTrack ? (tapOk ? actx.sampleRate : -1) : 0;
  const engine = audioRate < 0 ? { ok: false, why: 'no audio tap' } : await checkEngine(audioRate);
  status.engineWhy = engine.ok ? '' : engine.why;
  if (engine.ok) {
    const takeName = nameFor('mp4');
    if (toDisk) diskCall({ type: 'open', name: takeName }).catch(diskFail);
    const rec = new WcRecorder({
      canvas, fps: CFG.fps, bitrate: videoBitrate(), audioRate,
      write: toDisk ? (data, position) => (diskFailed ? Promise.resolve() : diskCall({ type: 'write', data, position }).catch(diskFail)) : null,
      onBytes: (n) => { bytes += n; },
      onError: (e) => {
        status.err = 'encoder: ' + (e.message || e);
        toast('The video encoder stopped. Keeping what was recorded so far.', 5000);
        stopRecording();
      },
    });
    try { await rec.start(); }
    catch (e) {
      status.engineWhy = 'WebCodecs start failed: ' + String(e.message || e).slice(0, 60);
      rec.cancel();
      if (toDisk) await diskCall({ type: 'remove', names: [takeName] }).catch(() => {});
      return startBuiltIn();
    }
    wcRec = rec;
    status.engine = 'WebCodecs · ' + rec.mime;
    if (audioRate) {
      audioSink = (block) => rec.pushAudio(block);
      tapNode.port.postMessage({ on: true });
    }
    finishFn = async () => {
      let r = {};
      if (audioRate) {
        tapNode.port.postMessage({ on: false });
        await new Promise((res) => setTimeout(res, 200));   // let the last block arrive
        audioSink = null;
      }
      try { r = await rec.stop(); } catch { /* the encoder failed; whatever reached storage is still kept */ }
      return { blob: toDisk ? await readDisk(takeName, 'video/mp4') : (r.blob || null), ext: 'mp4', diskName: toDisk ? takeName : '', steady: true };
    };
    return beginTake();
  }
  return startBuiltIn();

  function startBuiltIn() {
    const pm = pickMime();
    if (!pm) { toast('This browser can\'t record video.'); unplugMic(); sleepAudio(); releaseMic(); return; }
    let vStream = canvas.captureStream(0);
    mrTrack = vStream.getVideoTracks()[0];
    if (typeof mrTrack?.requestFrame !== 'function') { mrTrack?.stop(); vStream = canvas.captureStream(CFG.fps); mrTrack = null; }
    const stream = new MediaStream([...vStream.getVideoTracks(), ...(audioTrack ? [audioTrack] : [])]);
    try { recorder = new MediaRecorder(stream, { mimeType: pm.mime, videoBitsPerSecond: videoBitrate(), audioBitsPerSecond: 160_000 }); }
    catch { recorder = new MediaRecorder(stream); }
    const type = (recorder.mimeType || pm.mime).split(';')[0] || 'video/mp4';
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const takeName = nameFor(ext);
    const startedAt = performance.now();
    status.engine = 'built-in recorder · ' + type + (mrTrack ? ' · frame-locked' : '');
    if (toDisk) diskCall({ type: 'open', name: takeName }).catch(diskFail);
    recorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      bytes += e.data.size;
      if (toDisk) { if (!diskFailed) diskCall({ type: 'chunk', blob: e.data }).catch(diskFail); }
      else chunks.push(e.data);
    };
    let stopped;
    const stoppedP = new Promise((r) => { stopped = r; });
    recorder.onstop = () => { for (const t of vStream.getVideoTracks()) t.stop(); stopped(); };
    recorder.onerror = (e) => {
      status.err = 'recorder: ' + (e.error?.message || e.name || 'error');
      // an encoder that can't handle the size usually fails right away
      if (performance.now() - startedAt < 5000 && (CFG.quality === 2160 || CFG.fps === 60)) {
        toast('This phone couldn\'t record at that size. Try 1080 × 1920 or 30 fps under Look.', 6000);
      }
    };
    finishFn = async () => {
      try { recorder.requestData?.(); } catch {}
      try { recorder.stop(); } catch { stopped(); }
      await stoppedP;
      let blob;
      if (toDisk) blob = await readDisk(takeName, type);
      else { blob = new Blob(chunks, { type }); chunks = []; }
      return { blob, ext, diskName: toDisk ? takeName : '' };
    };
    recorder.start(1000);
    beginTake();
  }

  function beginTake() {
    recording = true; recStart = performance.now();
    document.body.classList.add('recording');
    $('rec').setAttribute('aria-label', 'Stop recording');
    let quietFor = 0, quietWarned = !audioTrack;
    const tick = () => {
      const mb = bytes / 1e6;
      $('timerText').textContent = `${fmt(elapsed())} · ${mb < 1000 ? mb.toFixed(0) + ' MB' : (mb / 1000).toFixed(2) + ' GB'}`;
      status.rec = 'recording ' + $('timerText').textContent;
      // the meter shows that sound is really reaching the take
      const lv = micLevel();
      status.level = lv;
      $('meterFill').style.transform = `scaleX(${Math.min(1, Math.sqrt(lv) * 2.2).toFixed(3)})`;
      if (status.audioPath === 'line') {
        quietFor = lv < 0.0015 ? quietFor + 0.25 : 0;
        if (quietFor >= 8 && !quietWarned) {
          quietWarned = true;
          toast('No sound is reaching the mic. Check nothing is covering it and no other app is using it.', 6000);
        }
      }
    };
    tick(); timerT = setInterval(tick, 250);
    $('meter').hidden = status.audioPath !== 'line';
    keepAwake();
    takeMeta = { micNote, shape };
  }
}

// called from the frame loop right after the stage is drawn
function recordFrame() {
  if (!recording) return;
  if (wcRec) wcRec.frame(elapsed());
  else if (mrTrack) mrTrack.requestFrame();
}

function stopRecording() {
  if (!recording) return;
  const secs = elapsed();
  recording = false;
  clearInterval(timerT);
  document.body.classList.remove('recording');
  $('rec').setAttribute('aria-label', 'Record');
  status.rec = '';
  const fin = finishFn, meta = takeMeta || {};
  finishFn = null;
  if (fin) finalizeTake(fin, secs, meta);
}
async function finalizeTake(fin, secs, { micNote = '', shape = '' }) {
  setStatus('Finishing the video…');
  $('rec').disabled = true;
  let res = {};
  try { res = await fin(); } catch { res = {}; }
  setStatus('');
  $('rec').disabled = false;
  if (wcRec) status.lastStats = wcRec.stats;
  wcRec = null; mrTrack = null;
  // hand the audio back before playback: a live mic keeps iPhones in call mode, which mangles what you hear
  unplugMic(); sleepAudio(); releaseMic();
  status.level = undefined;
  if (camRestartPending) { camRestartPending = false; restartCamera(); }
  if (!res.blob || res.blob.size < 2000) {
    if (res.diskName) diskCall({ type: 'remove', names: [res.diskName] }).catch(() => {});
    toast('That take came out empty. Try again, and give it a second before stopping.', 4500);
    return;
  }
  finishTake(res.blob, secs, res.ext, micNote, res.steady ? shape + ' constant' : shape, res.diskName);
}
async function countdownThenRecord() {
  counting = true;
  audioLine();   // must start inside the tap, or iPhones keep it switched off
  const micReady = status.mic === 'unavailable' ? Promise.resolve(false) : openMic();   // the mic warms up during the 3-2-1
  if (actx) checkEngine(status.mic !== 'unavailable' ? actx.sampleRate : 0);   // warm up the encoder check too
  const el = $('count');
  if (CFG.countdown) {
    el.classList.add('show');
    for (const n of [3, 2, 1]) { el.textContent = n; await new Promise((r) => setTimeout(r, 800)); if (!counting) { el.classList.remove('show'); releaseMic(); sleepAudio(); return; } }
    el.classList.remove('show');
  }
  const ok = await micReady;
  if (actx && actx.state !== 'running') {
    await Promise.race([actx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1200))]);
  }
  if (!counting) { releaseMic(); sleepAudio(); return; }
  counting = false;
  if (!ok) toast('No mic, so this take is silent. Allow the microphone for this site to add sound.', 4500);
  startingRec = true;
  try { await startRecording(); } finally { startingRec = false; }
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function finishTake(blob, secs, ext, micNote, shape, diskName = '') {
  if (take?.url) URL.revokeObjectURL(take.url);
  if (take?.disk && take.disk !== diskName) diskCall({ type: 'remove', names: [take.disk] }).catch(() => {});
  const name = diskName || `ziticam-${stamp()}-${BGS[CFG.bg].label.toLowerCase()}.${ext}`;
  take = { blob, url: URL.createObjectURL(blob), name, ext, disk: diskName, meta: `${fmt(secs)} · ${(blob.size / 1e6).toFixed(1)} MB · ${shape} · ${ext.toUpperCase()} on ${BGS[CFG.bg].label.toLowerCase()} · ${micNote}` };
  $('takeBtn').hidden = false;
  openReview();
}
function openReview() {
  if (!take) return;
  const v = $('reviewVideo');
  v.src = take.url;
  v.play().catch(() => {});
  $('reviewMeta').textContent = take.meta;
  openSheet('review');
}
function unloadReview() {
  // fully unload the player: a paused video still holding the last take can starve the next recording
  const v = $('reviewVideo'); v.pause(); v.removeAttribute('src'); v.load();
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
function deleteTake() {
  closeSheets();
  if (take) {
    URL.revokeObjectURL(take.url);
    if (take.disk) diskCall({ type: 'remove', names: [take.disk] }).catch(() => {});
    take = null;
  }
  $('takeBtn').hidden = true;
  toast('Deleted.');
}

// ---------------------------------------------------------------- wake lock + app switching
let wakeLock = null;
async function keepAwake() {
  try { if (!wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch { /* not allowed: fine */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (recording) stopRecording();          // finalize the take instead of losing it (the mic closes when it's written)
    else { releaseMic(true); sleepAudio(); }
    counting = false;
  } else if (started) {
    keepAwake();
    const tr = camStream?.getVideoTracks()[0];
    if (camStream && (!tr || tr.readyState === 'ended')) restartCamera();
  }
});
// a take saved to storage survives a reload; one held in memory doesn't
window.addEventListener('beforeunload', (e) => { if (recording || (take && !take.disk)) { e.preventDefault(); e.returnValue = ''; } });
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  if (recording) stopRecording();
  toast('The phone reset its graphics. If the picture stays blank, reload the page.', 6000);
});

// ---------------------------------------------------------------- UI
const sheetOpen = () => !!document.querySelector('.sheet.show');
function openSheet(id) { $('scrim').classList.add('show'); $(id).classList.add('show'); }
function closeSheets() {
  if ($('review').classList.contains('show')) unloadReview();
  $('scrim').classList.remove('show');
  for (const s of document.querySelectorAll('.sheet')) s.classList.remove('show');
}

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
    if (!trackerReady() && status.tracker !== 'failed') setStatus('Loading face tracker…');
    if (!micGranted) toast('No mic access, so takes will be silent. Allow the microphone for this site to fix it.', 5000);
    else if (take?.meta?.includes('last session')) toast('Your last take was kept. Tap Last take to save it.', 5000);
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

function setOutput(k, v) {
  if (recording || counting || startingRec) { toast('Stop recording to change the size or frame rate.'); return; }
  CFG[k] = v; applyOutput(); applyLook(); saveCfg();
  if (k === 'quality' && v === 2160 && !store.get('zitipocket.seen4k', false)) {
    store.set('zitipocket.seen4k', true);
    toast('4K: sharpest on recent iPhones. The eyes and mouth come from the 720p selfie camera, so the noodle gains the most.', 6500);
  }
}

function wire() {
  buildSliders();
  $('startBtn').addEventListener('click', start);
  $('rec').addEventListener('click', () => {
    if (startingRec) return;
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
  $('takeBtn').addEventListener('click', openReview);
  $('lookBtn').addEventListener('click', () => openSheet('look'));
  $('closeLook').addEventListener('click', closeSheets);
  $('scrim').addEventListener('click', closeSheets);
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
  for (const b of document.querySelectorAll('#qualSeg button')) b.addEventListener('click', () => setOutput('quality', +b.dataset.q));
  for (const b of document.querySelectorAll('#fpsSeg button')) b.addEventListener('click', () => setOutput('fps', +b.dataset.fps));
  $('shareBtn').addEventListener('click', shareTake);
  $('downloadBtn').addEventListener('click', downloadTake);
  $('discardBtn').addEventListener('click', deleteTake);
  $('keepBtn').addEventListener('click', closeSheets);
}

wire();
applyOutput();
applyLook();
updateLoadline();
requestAnimationFrame(frame);
(q.get('notrack') === '1' ? new Promise(() => {}) : startTracker())
  .then(() => { setStatus(''); updateLoadline(); })
  .catch((e) => { status.tracker = 'failed'; status.err = 'tracker: ' + (e.message || e); setStatus('Face tracker didn\'t load. Check your connection and reload.'); updateLoadline(); });
if (q.get('autostart') === '1') start();
initDisk();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// tiny hook for automated checks
window.__zp = {
  status, CFG, insets, rig, renderer, scene, camera, onFace, applyLook, setOutput, startRecording, stopRecording, zRect, disk,
  get take() { return take; }, get landmarker() { return landmarker || (workerReady ? worker : null); }, pickMime,
  get micLive() { return micLive(); }, get camLive() { return camStream?.getVideoTracks()[0]?.readyState === 'live'; }, get keepMicOpen() { return keepMicOpen; },
  get recording() { return recording; }, get engine() { return status.engine; }, get wcStats() { return wcRec?.stats || status.lastStats; }, get smoothLevel() { return pace.lvl; }, get actx() { return actx; },
};
