// Runs on the audio thread, which drawing can never block. While a take is recording it collects the mic line
// into blocks and posts them out; messages queue rather than drop, so the take's audio has no gaps.
// If the mic is briefly unplugged (reconnecting), it posts silence instead, keeping the audio timeline continuous.

const BLOCK = 4096;

class ZitiTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.buf = new Float32Array(BLOCK);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data.on !== undefined) { this.flush(); this.on = e.data.on; this.n = 0; }
    };
  }

  flush() {
    if (this.on && this.n > 0) {
      const out = this.buf.slice(0, this.n);
      this.port.postMessage(out, [out.buffer]);
    }
    this.n = 0;
  }

  process(inputs) {
    if (!this.on) return true;
    const chans = inputs[0];
    const frames = chans && chans.length ? chans[0].length : 128;
    for (let i = 0; i < frames; i++) {
      let v = 0;
      if (chans && chans.length) { for (let c = 0; c < chans.length; c++) v += chans[c][i]; v /= chans.length; }
      this.buf[this.n++] = v;
      if (this.n === BLOCK) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(BLOCK);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('ziti-tap', ZitiTap);
