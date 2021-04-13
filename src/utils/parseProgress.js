const ts2sec = (ts) => {
  const [h, m, s] = ts.split(':');
  return (parseFloat(h) * 60 * 60) + (parseFloat(m) * 60) + parseFloat(s);
};

class ProgressObserver {
  /**
   * @param {(payload: { ratio: number, time?: number, duration?: number }) => any} onProgress
   */
  constructor(onProgress) {
    this.duration = 0;
    this.ratio = 0;
    this.onProgress = onProgress || (() => {});
  }

  /**
   * @param {string} message
   */
  observe(message) {
    if (typeof message === 'string') {
      if (message.startsWith('  Duration')) {
        const ts = message.split(', ')[0].split(': ')[1];
        const d = ts2sec(ts);
        this.onProgress({ duration: d, ratio: this.ratio });
        if (this.duration === 0 || this.duration > d) {
          this.duration = d;
        }
      } else if (message.startsWith('frame') || message.startsWith('size')) {
        const ts = message.split('time=')[1].split(' ')[0];
        const t = ts2sec(ts);
        this.ratio = t / this.duration;
        this.onProgress({ ratio: this.ratio, time: t });
      } else if (message.startsWith('video:')) {
        this.onProgress({ ratio: 1 });
        this.duration = 0;
      }
    }
  }

  resetState() {
    this.duration = 0;
    this.ratio = 0;
  }
}

module.exports = ProgressObserver;
