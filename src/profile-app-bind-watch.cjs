'use strict';

/**
 * Polls the macOS frontmost app and activates the bound onboard profile.
 * Injectable getFrontmost / switchProfile; no HID of its own.
 */

const { execFile } = require('node:child_process');
const appBind = require('./profile-app-bind.cjs');

function defaultReadFrontmost() {
  return new Promise((resolve) => {
    execFile('lsappinfo', ['info', '-only', 'name,bundleid', 'front'], { timeout: 800 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(appBind.parseLsappinfo(String(stdout || '')));
    });
  });
}

class AppBindWatcher {
  constructor(options = {}) {
    this.getBinds = options.getBinds || (() => []);
    this.getActiveProfile = options.getActiveProfile || (() => null);
    this.isConnected = options.isConnected || (() => false);
    this.isBusy = options.isBusy || (() => false);
    this.switchProfile = options.switchProfile || (async () => ({ success: false, error: 'switchProfile missing' }));
    this.getFrontmost = options.getFrontmost || defaultReadFrontmost;
    this.intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs >= 20 ? options.intervalMs : 1000;
    this.ignoreBundleIds = new Set(
      (options.ignoreBundleIds || ['dev.openmaicong.studio']).map((id) => String(id).toLowerCase())
    );
    this.onSwitch = options.onSwitch || null;
    this._timer = null;
    this._inflight = false;
    this.lastBundleId = null;
    this.lastSwitch = null;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async tick() {
    if (this._inflight) return { skipped: true, reason: 'busy-tick' };
    this._inflight = true;
    try {
      if (typeof this.isConnected === 'function' && !this.isConnected()) {
        return { skipped: true, reason: 'disconnected' };
      }
      if (typeof this.isBusy === 'function' && this.isBusy()) {
        return { skipped: true, reason: 'device-busy' };
      }
      const binds = typeof this.getBinds === 'function' ? (this.getBinds() || []) : [];
      if (!binds.length) return { skipped: true, reason: 'no-binds' };
      const frontmost = await this.getFrontmost();
      const bundleId = frontmost && frontmost.bundleId;
      if (!bundleId) return { skipped: true, reason: 'no-frontmost' };
      if (this.ignoreBundleIds.has(String(bundleId).toLowerCase())) {
        return { skipped: true, reason: 'ignored-app' };
      }
      if (bundleId === this.lastBundleId && this.lastSwitch && this.lastSwitch.success) {
        return { skipped: true, reason: 'unchanged' };
      }
      this.lastBundleId = bundleId;
      const hit = appBind.matchFrontmost(binds, frontmost);
      if (!hit) return { skipped: true, reason: 'unbound-app', bundleId };
      const active = this.getActiveProfile();
      if (active === hit.profileIndex) {
        this.lastSwitch = { success: true, alreadyActive: true, profileIndex: hit.profileIndex, bundleId };
        return this.lastSwitch;
      }
      const switched = await this.switchProfile(hit.profileIndex);
      this.lastSwitch = {
        success: Boolean(switched && switched.success),
        profileIndex: hit.profileIndex,
        bundleId,
        displayName: hit.displayName,
        error: switched && switched.error
      };
      if (this.lastSwitch.success && typeof this.onSwitch === 'function') {
        this.onSwitch(this.lastSwitch);
      }
      return this.lastSwitch;
    } finally {
      this._inflight = false;
    }
  }
}

module.exports = { AppBindWatcher, defaultReadFrontmost };
