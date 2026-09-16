/**
 * Onboard profile-name storage: GLW custom JSON at relative offset 336 / 280
 * and feature-support metadata at 616 / 56 (CMD 241/242).
 * Vendor: setCustomJSON / setProfileNamesToAll / Re+Pe. Native rejects
 * oversized UTF-8 instead of truncating and never writes names on connect.
 */

const CUSTOM_PARAM_SIZE = 1024;
const PROFILE_NAMES_OFFSET = 336;
const PROFILE_NAMES_LENGTH = 280;
const FEATURE_SUPPORT_OFFSET = 616;
const FEATURE_SUPPORT_LENGTH = 56;
const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 15;
const MAX_KEYBOARD_PROFILES = 4;
const CHUNK = 56;
const I18N_TOKEN_RE = /i18n<([^>]+)>/g;
const I18N_NAME_TOKEN_RE = /^i18n<[^>]+>\d*$/;
const I18N_PROFILE_KEYS = {
  defaultOnboard: 'Default Onboard'
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function namesOffset(profileIndex) {
  return (profileIndex * CUSTOM_PARAM_SIZE) + PROFILE_NAMES_OFFSET;
}

function featureSupportOffset(profileIndex) {
  return (profileIndex * CUSTOM_PARAM_SIZE) + FEATURE_SUPPORT_OFFSET;
}

function encodeCustomJson(value, length) {
  if (!Number.isInteger(length) || length <= 0) {
    return { valid: false, error: 'Custom JSON region length is invalid' };
  }
  let json;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    return { valid: false, error: err.message || 'Profile name JSON could not be encoded' };
  }
  const bytes = Buffer.from(json, 'utf8');
  if (bytes.length + 1 > length) {
    return { valid: false, error: `UTF-8 JSON does not fit the ${length}-byte region (${bytes.length} bytes)` };
  }
  const out = Buffer.alloc(length, 255);
  bytes.copy(out, 0);
  const writeLength = Math.min(CHUNK * Math.ceil((bytes.length + 1) / CHUNK), length);
  return { valid: true, buffer: out, writeLength, byteLength: bytes.length };
}

function isBlankCustom(buf) {
  if (!buf || buf.length === 0) return true;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0 && buf[i] !== 255) return false;
  }
  return true;
}

function decodeJsonBytes(buf, fallback) {
  if (!buf || buf.length === 0) return { value: fallback, empty: true };
  if (isBlankCustom(buf)) return { value: fallback, empty: true };
  const bytes = Buffer.from(buf);
  let n = bytes.indexOf(255);
  while (n !== -1) {
    if (n === 0) return { value: fallback, empty: true };
    try {
      return { value: JSON.parse(bytes.subarray(0, n).toString('utf8')), empty: false };
    } catch {
      n = bytes.indexOf(255, n + 1);
    }
  }
  try {
    return { value: JSON.parse(bytes.toString('utf8')), empty: false };
  } catch {
    return { value: fallback, empty: true, malformed: true };
  }
}

function defaultOnboardName(index) {
  if (!Number.isInteger(index) || index < 0) return I18N_PROFILE_KEYS.defaultOnboard;
  return index === 0 ? I18N_PROFILE_KEYS.defaultOnboard : `${I18N_PROFILE_KEYS.defaultOnboard}${index + 1}`;
}

function defaultOnboardToken(index) {
  if (!Number.isInteger(index) || index < 0) return 'i18n<defaultOnboard>';
  return index === 0 ? 'i18n<defaultOnboard>' : `i18n<defaultOnboard>${index + 1}`;
}

function isI18nNameToken(value) {
  const text = formatName(value);
  return Boolean(text) && I18N_NAME_TOKEN_RE.test(text);
}

function translateI18nDisplay(value) {
  const text = String(value == null ? '' : value);
  if (text.indexOf('i18n<') === -1) return text;
  return text.replace(I18N_TOKEN_RE, (full, key) => {
    if (Object.prototype.hasOwnProperty.call(I18N_PROFILE_KEYS, key)) {
      return I18N_PROFILE_KEYS[key];
    }
    return full;
  });
}

function displayNamesFromStored(stored, length = MAX_KEYBOARD_PROFILES) {
  const src = Array.isArray(stored) ? stored : [];
  const out = [];
  for (let i = 0; i < length; i++) {
    const raw = typeof src[i] === 'string' ? src[i].trim() : '';
    const translated = translateI18nDisplay(raw).trim();
    out.push(translated || defaultOnboardName(i));
  }
  return out;
}

function translateEmptyNames(stored, length = MAX_KEYBOARD_PROFILES) {
  return displayNamesFromStored(stored, length);
}

function namesAreStoredEmpty(stored) {
  if (!Array.isArray(stored) || stored.length === 0) return true;
  return stored.every((n) => n == null || (typeof n === 'string' && n.trim() === ''));
}

function formatName(value) {
  return String(value == null ? '' : value).trim();
}

function validateProfileName(name, options = {}) {
  const text = formatName(name);
  if (!text) return { valid: false, error: 'The configuration name cannot be empty' };
  if (text.length < MIN_NAME_LENGTH || text.length > MAX_NAME_LENGTH) {
    return {
      valid: false,
      error: `The length of the configuration name should be between ${MIN_NAME_LENGTH} and ${MAX_NAME_LENGTH} characters`
    };
  }
  const others = Array.isArray(options.existing) ? options.existing : [];
  const ignore = options.ignoreKey || null;
  if (!options.allowConflict) {
    for (const item of others) {
      if (ignore && item && item.key === ignore) continue;
      const other = translateI18nDisplay(formatName(item && (item.displayName || item.name)));
      if (other && other === text) {
        return { valid: false, error: 'The configuration name already exists' };
      }
    }
  }
  return { valid: true, name: text };
}

function uniqueLocalName(base, existing) {
  const seed = translateI18nDisplay(formatName(base)) || 'New configuration 1';
  const names = new Set((existing || []).map((item) => translateI18nDisplay(formatName(item && (item.displayName || item.name)))));
  if (seed.length >= MIN_NAME_LENGTH && seed.length <= MAX_NAME_LENGTH && !names.has(seed)) {
    return seed;
  }
  if (seed.length > MAX_NAME_LENGTH) {
    const truncated = seed.slice(0, MAX_NAME_LENGTH);
    if (truncated.length >= MIN_NAME_LENGTH && !names.has(truncated)) {
      return truncated;
    }
  }
  const stripped = seed.replace(/\s*\(\d+\)$/, '').trim() || 'New configuration';
  let n = 1;
  const m = /\((\d+)\)$/.exec(seed);
  if (m) n = parseInt(m[1], 10);
  for (let i = 0; i < 64; i++) {
    const suffix = ` (${n + i})`;
    let candidate = stripped + suffix;
    if (candidate.length > MAX_NAME_LENGTH) {
      candidate = stripped.slice(0, Math.max(MIN_NAME_LENGTH, MAX_NAME_LENGTH - suffix.length)) + suffix;
    }
    if (candidate.length > MAX_NAME_LENGTH) continue;
    if (!names.has(candidate)) return candidate;
  }
  return null;
}

function allocateLocalName(base, existing) {
  const original = formatName(base);
  const name = uniqueLocalName(base, existing);
  if (!name) {
    return { valid: false, error: 'Could not allocate a unique configuration name' };
  }
  return { valid: true, name, original };
}

function extraWithPreservedOriginal(extra, allocated) {
  const next = isPlainObject(extra) ? { ...extra } : {};
  if (next.confirmShareFailed === undefined) next.confirmShareFailed = false;
  if (!allocated) return next;
  const original = allocated.original;
  const displayOriginal = translateI18nDisplay(original);
  if (isI18nNameToken(original) && next.storedName === undefined) {
    next.storedName = original;
  }
  if (displayOriginal && displayOriginal !== allocated.name && next.displayName === undefined) {
    next.displayName = displayOriginal;
  }
  return next;
}

function seedDeviceProfileNames(device, stored) {
  const encoded = encodeProfileNames(stored);
  if (!encoded.valid) return encoded;
  if (!device || !Buffer.isBuffer(device.custom)) {
    return { valid: false, error: 'Device custom region is missing' };
  }
  for (let slot = 0; slot < MAX_KEYBOARD_PROFILES; slot++) {
    encoded.buffer.copy(device.custom, namesOffset(slot));
  }
  return { valid: true, stored: Array.isArray(stored) ? stored.slice() : [] };
}

function encodeProfileNames(names) {
  if (!Array.isArray(names)) {
    return { valid: false, error: 'Profile names must be an array indexed by physical slot' };
  }
  if (names.length > MAX_KEYBOARD_PROFILES) {
    return { valid: false, error: `Profile names array exceeds ${MAX_KEYBOARD_PROFILES} physical slots` };
  }
  const normalized = [];
  for (let i = 0; i < MAX_KEYBOARD_PROFILES; i++) {
    const v = names[i];
    if (v == null) {
      normalized[i] = '';
      continue;
    }
    if (typeof v !== 'string') {
      return { valid: false, error: `Profile name at slot ${i} must be a string` };
    }
    normalized[i] = v;
  }
  return encodeCustomJson(normalized, PROFILE_NAMES_LENGTH);
}

function decodeProfileNames(buf) {
  const decoded = decodeJsonBytes(buf, []);
  if (decoded.malformed) {
    return { valid: false, error: 'Profile-name region is not valid JSON', names: [], stored: [] };
  }
  if (!Array.isArray(decoded.value)) {
    return { valid: false, error: 'Profile-name region must decode to an array', names: [], stored: [] };
  }
  const stored = decoded.value.map((n) => (typeof n === 'string' ? n : ''));
  while (stored.length < MAX_KEYBOARD_PROFILES) stored.push('');
  const empty = namesAreStoredEmpty(stored);
  return {
    valid: true,
    empty,
    stored: stored.slice(0, MAX_KEYBOARD_PROFILES),
    names: displayNamesFromStored(stored, MAX_KEYBOARD_PROFILES)
  };
}

function encodeFeatureSupportTuple(obj) {
  const src = isPlainObject(obj) ? obj : {};
  const macroUpdatedAt = Number.isFinite(src.macroUpdatedAt) ? src.macroUpdatedAt : 0;
  const profileNameUpdatedAt = Number.isFinite(src.profileNameUpdatedAt) ? src.profileNameUpdatedAt : 0;
  const browserId = src.browserId == null ? '' : String(src.browserId);
  const expired = Number.isFinite(src.browserIdExpiredAt) ? src.browserIdExpiredAt : 0;
  const token = `${browserId}_${expired.toString(36)}`;
  return [macroUpdatedAt, profileNameUpdatedAt, token];
}

function decodeFeatureSupportTuple(arr) {
  const src = Array.isArray(arr) ? arr : [0, 0, ''];
  const token = (src[2] == null ? '' : String(src[2]));
  const parts = token.split('_');
  const browserId = parts[0] || '';
  const expiredRaw = parts[1] || '';
  return {
    macroUpdatedAt: src[0] || 0,
    profileNameUpdatedAt: src[1] || 0,
    browserId,
    browserIdExpiredAt: expiredRaw ? parseInt(expiredRaw, 36) : 0
  };
}

function decodeFeatureSupport(buf) {
  const decoded = decodeJsonBytes(buf, [0, 0, '']);
  if (decoded.malformed) {
    return { valid: false, error: 'Feature-support region is not valid JSON', support: decodeFeatureSupportTuple([0, 0, '']), raw: buf };
  }
  if (!Array.isArray(decoded.value)) {
    return { valid: false, error: 'Feature-support region must decode to an array', support: decodeFeatureSupportTuple([0, 0, '']), raw: buf };
  }
  return {
    valid: true,
    empty: decoded.empty,
    support: decodeFeatureSupportTuple(decoded.value),
    raw: buf
  };
}

function mergeFeatureSupport(current, patch) {
  const base = isPlainObject(current) ? { ...current } : decodeFeatureSupportTuple([0, 0, '']);
  const next = { ...base };
  if (isPlainObject(patch)) {
    if (patch.macroUpdatedAt !== undefined) next.macroUpdatedAt = patch.macroUpdatedAt;
    if (patch.profileNameUpdatedAt !== undefined) next.profileNameUpdatedAt = patch.profileNameUpdatedAt;
    if (patch.browserId !== undefined) next.browserId = patch.browserId == null ? '' : String(patch.browserId);
    if (patch.browserIdExpiredAt !== undefined) next.browserIdExpiredAt = patch.browserIdExpiredAt;
  }
  const encoded = encodeCustomJson(encodeFeatureSupportTuple(next), FEATURE_SUPPORT_LENGTH);
  if (!encoded.valid) return encoded;
  return { valid: true, support: next, buffer: encoded.buffer, writeLength: encoded.writeLength };
}

function encodeFeatureSupport(obj) {
  return mergeFeatureSupport(obj, null);
}

module.exports = {
  CUSTOM_PARAM_SIZE,
  PROFILE_NAMES_OFFSET,
  PROFILE_NAMES_LENGTH,
  FEATURE_SUPPORT_OFFSET,
  FEATURE_SUPPORT_LENGTH,
  MIN_NAME_LENGTH,
  MAX_NAME_LENGTH,
  MAX_KEYBOARD_PROFILES,
  namesOffset,
  featureSupportOffset,
  encodeCustomJson,
  decodeJsonBytes,
  defaultOnboardName,
  defaultOnboardToken,
  isI18nNameToken,
  translateI18nDisplay,
  displayNamesFromStored,
  translateEmptyNames,
  seedDeviceProfileNames,
  namesAreStoredEmpty,
  formatName,
  validateProfileName,
  uniqueLocalName,
  allocateLocalName,
  extraWithPreservedOriginal,
  encodeProfileNames,
  decodeProfileNames,
  encodeFeatureSupportTuple,
  decodeFeatureSupportTuple,
  decodeFeatureSupport,
  mergeFeatureSupport,
  encodeFeatureSupport
};
