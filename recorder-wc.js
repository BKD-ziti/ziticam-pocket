// Constant-frame-rate recording with WebCodecs: every frame the stage draws is handed to the device's hardware
// H.264 encoder with an exact timestamp (frame n at n / fps), and Mediabunny writes the MP4. Unlike the browser's
// built-in recorder, nothing samples the canvas on its own timer, so frames aren't silently dropped.
// Audio arrives as raw blocks from the audio thread (audio-tap.js) and is timestamped by sample count, so it's gapless.

let mb = null;
// codecs: H.264 + AAC (what phones and editors expect). ?wccodec=vp9 swaps in VP9 + Opus, for testing on browsers without H.264.
const TEST = new URLSearchParams(location.search).get('wccodec') === 'vp9';
const VCODEC = TEST ? 'vp9' : 'avc', ACODEC = TEST ? 'opus' : 'aac';
const lib = async () => (mb ||= await import('./vendor/mediabunny.min.mjs'));

// Is this device able to record W x H at fps with sound this way?
export async function wcSupport({ W, H, fps, bitrate, audioRate }) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return { ok: false, why: 'no WebCodecs video' };
  try {
    const { canEncodeVideo, canEncodeAudio, Quality } = await lib();
    const video = await canEncodeVideo(VCODEC, { width: W, height: H, frameRate: fps, quality: new Quality({ bitrate }) });
    if (!video) return { ok: false, why: `${VCODEC} ${W}x${H}@${fps} not supported` };
    if (audioRate) {
      const audio = typeof AudioEncoder !== 'undefined' && await canEncodeAudio(ACODEC, { numberOfChannels: 1, sampleRate: audioRate, quality: new Quality({ bitrate: 160_000 }) });
      if (!audio) return { ok: false, why: `no WebCodecs ${ACODEC} audio` };
    }
    return { ok: true };
  } catch (e) { return { ok: false, why: String(e.message || e) }; }
}

export class WcRecorder {
  // write(data, position) -> Promise: positioned writes to storage; omit to keep the file in memory.
  // audioRate: sample rate of the mono blocks passed to pushAudio(), or 0 for a silent take.
  constructor({ canvas, fps, bitrate, audioRate, write, onError, onBytes }) {
    Object.assign(this, { canvas, fps, bitrate, audioRate, write, onError, onBytes });
    this.nextSlot = 0; this.pending = 0; this.audioFrames = 0;
    this.stats = { frames: 0, repeats: 0, waits: 0 };
    this.failed = null;
  }

  async start() {
    const { Output, Mp4OutputFormat, StreamTarget, BufferTarget, CanvasSource, AudioSampleSource, AudioSample, Quality } = await lib();
    this.AudioSample = AudioSample;
    const target = this.write
      ? new StreamTarget(new WritableStream({ write: (c) => this.write(c.data, c.position) }))
      : new BufferTarget();
    // fragmented: the file is written front to back in ~1 s pieces, so a take cut short by a crash still plays
    this.output = new Output({ format: new Mp4OutputFormat({ fastStart: this.write ? 'fragmented' : 'in-memory' }), target });
    this.video = new CanvasSource(this.canvas, {
      codec: VCODEC, quality: new Quality({ bitrate: this.bitrate }), keyFrameInterval: 2, latencyMode: 'quality',
      onEncodedPacket: (p) => this.onBytes?.(p.data.byteLength),
    });
    this.output.addVideoTrack(this.video, { frameRate: this.fps });
    if (this.audioRate) {
      this.audio = new AudioSampleSource({ codec: ACODEC, quality: new Quality({ bitrate: 160_000 }), onEncodedPacket: (p) => this.onBytes?.(p.data.byteLength) });
      this.output.addAudioTrack(this.audio);
    }
    await this.output.start();
    this.mime = 'video/mp4';   // (getMimeType would wait for the first encoded frame, which can't come before start)
    this.ready = true;
  }

  fail(e) {
    if (this.failed) return;
    this.failed = e || new Error('encoder error');
    this.onError?.(this.failed);
  }

  // Call right after the stage draws, with recording time in seconds (pauses excluded).
  // Each frame slot gets exactly one frame. If the device hitched and skipped a slot, the current picture fills it
  // (a repeated frame) so the file stays a true constant frame rate and in step with the audio.
  frame(t) {
    if (this.failed || !this.ready) return;
    const slot = Math.round(t * this.fps);
    if (slot < this.nextSlot) return;                 // drawn faster than the frame rate: nothing due yet
    if (this.pending > 8) { this.stats.waits++; return; }   // encoder catching up; the missed slots get filled next frame
    const missed = slot - this.nextSlot;
    // a hiccup of up to a second is filled with the current picture (cheap to encode: nothing changed);
    // anything longer (the app was in the background) is left as a jump rather than padded with a frozen frame
    const fill = Math.min(missed, Math.max(5, this.fps));
    if (missed > fill) this.nextSlot = slot - fill;
    for (let s = this.nextSlot; s <= slot; s++) {
      this.pending++;
      this.video.add(s / this.fps, 1 / this.fps)
        .then(() => { this.pending--; }, (e) => { this.pending--; this.fail(e); });
      if (s < slot) this.stats.repeats++;
    }
    this.stats.frames += slot - this.nextSlot + 1;
    this.nextSlot = slot + 1;
  }

  // one block of mono samples from the audio thread; its timestamp is simply how much audio came before it
  pushAudio(f32) {
    if (this.failed || !this.ready || !this.audio) return;
    const sample = new this.AudioSample({ data: f32, format: 'f32', numberOfChannels: 1, sampleRate: this.audioRate, timestamp: this.audioFrames / this.audioRate });
    this.audioFrames += f32.length;
    this.audio.add(sample).catch((e) => this.fail(e)).finally(() => sample.close());
  }

  // Finish the file. Returns { blob } when held in memory, or {} when it was written to storage.
  async stop() {
    if (this.failed) { try { await this.output.cancel(); } catch {} throw this.failed; }
    await this.output.finalize();
    if (this.write) return {};
    return { blob: new Blob([this.output.target.buffer], { type: this.mime }) };
  }

  async cancel() { try { await this.output?.cancel(); } catch {} }
}
