export function formatBytes(bytes, locale = 'en') {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = index === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)} ${units[index]}`;
}

export function formatDate(iso, locale = 'en') {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(time));
}

export function formatDuration(milliseconds) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function shortHash(hash) {
  if (typeof hash !== 'string' || hash.length < 16) return hash ?? '';
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

export function isExpired(expiresAt, now = Date.now()) {
  if (!expiresAt) return false;
  const time = Date.parse(expiresAt);
  return !Number.isNaN(time) && time <= now;
}

export const ACTIVE_STATES = Object.freeze(['queued', 'preparing', 'compiling', 'validating']);

export const isActiveState = (state) => ACTIVE_STATES.includes(state);
