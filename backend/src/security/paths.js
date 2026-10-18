import path from 'node:path';
import { AppError } from '../errors.js';

export function resolveInside(root, relativeName) {
  const base = path.resolve(root);
  const target = path.resolve(base, relativeName);
  if (target === base || !target.startsWith(base + path.sep)) {
    throw new AppError(400, 'unsafe_path', 'The requested path is outside the permitted directory.');
  }
  return target;
}

export function safeFileStem(value, fallback = 'app') {
  const cleaned = String(value ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return cleaned || fallback;
}
