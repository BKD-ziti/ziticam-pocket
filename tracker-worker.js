// The face tracker, off the main thread. The page sends camera frames, this sends back face points
// plus the same frame, so the ziti's eyes and mouth are cut from exactly what was measured.
// A classic worker: MediaPipe loads its wasm with importScripts, which module workers don't have.

let landmarker = null;

async function init({ bases, model }) {
  let lastErr;
  for (const base of bases) {
    try {
      const { FaceLandmarker, FilesetResolver } = await import(`${base}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${base}/wasm`);
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: model, delegate },
        runningMode: 'VIDEO', numFaces: 1,
        outputFaceBlendshapes: true, outputFacialTransformationMatrixes: false,
        minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
      let mode = 'GPU';
      try { landmarker = await FaceLandmarker.createFromOptions(fileset, opts('GPU')); }
      catch (e) { landmarker = await FaceLandmarker.createFromOptions(fileset, opts('CPU')); mode = 'CPU (' + String(e.message || e).slice(0, 40) + ')'; }
      postMessage({ type: 'ready', tracker: mode, src: base });
      return;
    } catch (e) { lastErr = e; }
  }
  postMessage({ type: 'failed', err: String(lastErr?.message || lastErr || 'no tracker source reachable') });
}

function detect({ bitmap, ts }) {
  const t0 = performance.now();
  let lm = null, jaw = 0, err = '';
  try {
    const res = landmarker.detectForVideo(bitmap, ts);
    lm = res.faceLandmarks?.[0] || null;
    jaw = res.faceBlendshapes?.[0]?.categories?.find((c) => c.categoryName === 'jawOpen')?.score ?? 0;
  } catch (e) { err = String(e.message || e); }
  postMessage({ type: 'result', bitmap, ts, lm, jaw, det: performance.now() - t0, err }, [bitmap]);
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') init(m);
  else if (m.type === 'frame') {
    if (landmarker) detect(m);
    else postMessage({ type: 'result', bitmap: m.bitmap, ts: m.ts, lm: null, jaw: 0, det: 0, err: 'not ready' }, [m.bitmap]);
  }
};
