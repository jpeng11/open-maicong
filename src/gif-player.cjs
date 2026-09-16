/**
 * Host GIF animation player for G75 V2.
 * Reverse-engineered from official vendor GifJsonPlayer (readable.js lines 2730-2900).
 * Plays frames in a loop, handling minimum 30ms ticks, 300ms max ticks with long-frame resending,
 * pause/resume generation tracking, and immediate timer cancellation on stop/reset/disconnect.
 */

const { libraryFramesToPlayer } = require('./gif-library.cjs');

class GifPlayer {
  constructor(options = {}) {
    this.minDuration = Number.isInteger(options.minDuration) ? options.minDuration : 30;
    this.maxDuration = Number.isInteger(options.maxDuration) ? options.maxDuration : 300;
    this.defaultDuration = Number.isInteger(options.defaultDuration) ? options.defaultDuration : 100;
    this.frameCallback = typeof options.onFrame === 'function' ? options.onFrame : () => {};

    this.jsonData = [];
    this.frameCount = 0;
    this.frameIndex = 0;
    this.timer = null;
    this._playId = 0;
    this.isPlaying = false;

    if (options.frames) {
      this.loadFrames(options.frames);
    }
  }

  loadFrames(frames) {
    this.stop();
    if (!Array.isArray(frames)) {
      this.jsonData = [];
      this.frameCount = 0;
      return;
    }
    // If frames already in player format ({dur, colors}) or library format ({duration, data})
    if (frames.length > 0 && frames[0] && Array.isArray(frames[0].colors)) {
      this.jsonData = frames.map((f) => ({
        dur: f.dur != null ? f.dur : this.defaultDuration,
        colors: Array.isArray(f.colors) ? f.colors : []
      }));
    } else {
      this.jsonData = libraryFramesToPlayer(frames);
    }
    this.frameCount = this.jsonData.length;
    this.frameIndex = 0;
  }

  _clearTimer() {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  _play(playId) {
    if (playId !== this._playId || !this.isPlaying || this.frameCount === 0) {
      return;
    }

    if (this.frameIndex >= this.frameCount) {
      this.frameIndex = 0;
    }

    const currentFrame = this.jsonData[this.frameIndex];
    if (!currentFrame) return;

    const colors = currentFrame.colors || [];
    let dur = currentFrame.dur != null ? currentFrame.dur : this.defaultDuration;
    if (dur < this.minDuration) {
      dur = this.minDuration;
    }

    const minDur = this.minDuration;
    const maxDur = this.maxDuration;
    const tickTotalCount = Math.max(1, Math.ceil(dur / maxDur));

    const step = (tick) => {
      if (playId !== this._playId || !this.isPlaying) return;

      if (tick >= tickTotalCount) {
        this.frameIndex++;
        this._play(playId);
        return;
      }

      const remaining = dur - tick * maxDur;
      const tickDelay = Math.min(Math.max(remaining, minDur), maxDur);

      try {
        this.frameCallback(colors, this.frameIndex, this.frameCount);
      } catch {
        // Suppress frame callback exceptions to prevent breaking the playback loop
      }

      if (playId === this._playId && this.isPlaying) {
        this.timer = setTimeout(() => {
          step(tick + 1);
        }, tickDelay);
      }
    };

    step(0);
  }

  start() {
    this._clearTimer();
    this.frameIndex = 0;
    if (this.frameCount === 0) {
      this.isPlaying = false;
      return;
    }
    this.isPlaying = true;
    this._play(++this._playId);
  }

  pause() {
    this.isPlaying = false;
    this._clearTimer();
    ++this._playId;
  }

  resume() {
    if (this.isPlaying || this.frameCount === 0) return;
    this.isPlaying = true;
    this._clearTimer();
    this._play(++this._playId);
  }

  stop() {
    this.isPlaying = false;
    this._clearTimer();
    this.frameIndex = 0;
    ++this._playId;
  }

  destroy() {
    this.stop();
    this.jsonData = [];
    this.frameCount = 0;
    this.frameCallback = () => {};
  }
}

module.exports = {
  GifPlayer
};
