import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { AppError } from '../errors.js';
import { resolveInside } from '../security/paths.js';

export const LEGACY_DENSITIES = Object.freeze({ mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 });
export const ADAPTIVE_DENSITIES = Object.freeze({ mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 });
export const SAFE_ZONE_RATIO = 66 / 108;
export const PREVIEW_SIZE = 512;

const WORKING_MAXIMUM_SIDE = 2048;
const MINIMUM_SIDE = 8;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const MAXIMUM_DIMENSION_ERROR = 'The image is corrupted or exceeds the allowed dimensions.';

export const DEFAULT_ICON_SETTINGS = Object.freeze({
  background: 'transparent',
  adaptiveBackground: '#FFFFFF',
  scale: 1,
  padding: 0.1,
  offsetX: 0,
  offsetY: 0,
  fit: 'contain'
});

const invalidSettings = (message) => new AppError(422, 'invalid_icon_settings', message);

const readNumber = (value, fallback, minimum, maximum, label) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidSettings(`${label} must be a number between ${minimum} and ${maximum}.`);
  }
  return value;
};

const readColor = (value, fallback, allowTransparent, label) => {
  if (value === undefined || value === null) return fallback;
  if (allowTransparent && value === 'transparent') return 'transparent';
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
    throw invalidSettings(`${label} must be a color in #RRGGBB format.`);
  }
  return value.toUpperCase();
};

export function normalizeIconSettings(input = {}) {
  const fit = input.fit ?? DEFAULT_ICON_SETTINGS.fit;
  if (fit !== 'contain' && fit !== 'cover') {
    throw invalidSettings('fit must be either contain or cover.');
  }
  return Object.freeze({
    background: readColor(input.background, DEFAULT_ICON_SETTINGS.background, true, 'background'),
    adaptiveBackground: readColor(input.adaptiveBackground, DEFAULT_ICON_SETTINGS.adaptiveBackground, false, 'adaptiveBackground'),
    scale: readNumber(input.scale, DEFAULT_ICON_SETTINGS.scale, 0.1, 1, 'scale'),
    padding: readNumber(input.padding, DEFAULT_ICON_SETTINGS.padding, 0, 0.4, 'padding'),
    offsetX: readNumber(input.offsetX, DEFAULT_ICON_SETTINGS.offsetX, -0.5, 0.5, 'offsetX'),
    offsetY: readNumber(input.offsetY, DEFAULT_ICON_SETTINGS.offsetY, -0.5, 0.5, 'offsetY'),
    fit
  });
}

const contentFraction = (settings) => (1 - 2 * settings.padding) * settings.scale;

const toBackground = (color) => {
  if (color === 'transparent') return { r: 0, g: 0, b: 0, alpha: 0 };
  return {
    r: Number.parseInt(color.slice(1, 3), 16),
    g: Number.parseInt(color.slice(3, 5), 16),
    b: Number.parseInt(color.slice(5, 7), 16),
    alpha: 1
  };
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function detectFormat(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }
  return null;
}

export async function prepareImage(buffer, { maxBytes, maxPixels }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AppError(422, 'invalid_image', 'The image file is empty.');
  }
  if (buffer.length > maxBytes) {
    throw new AppError(413, 'image_too_large', 'The image file exceeds the allowed size.');
  }
  const format = detectFormat(buffer);
  if (format === null) {
    throw new AppError(415, 'unsupported_image', 'Only PNG, JPEG and WebP images are supported.');
  }
  const options = { limitInputPixels: maxPixels, failOn: 'error' };
  let metadata;
  try {
    metadata = await sharp(buffer, options).metadata();
  } catch {
    throw new AppError(422, 'invalid_image', MAXIMUM_DIMENSION_ERROR);
  }
  if (!metadata.width || !metadata.height) {
    throw new AppError(422, 'invalid_image', MAXIMUM_DIMENSION_ERROR);
  }
  if (metadata.width * metadata.height > maxPixels) {
    throw new AppError(413, 'image_too_many_pixels', 'The image has too many pixels.');
  }
  if (Math.min(metadata.width, metadata.height) < MINIMUM_SIDE) {
    throw new AppError(422, 'image_too_small', 'The image is too small to be used as an icon.');
  }
  let working;
  try {
    working = await sharp(buffer, options)
      .rotate()
      .resize({
        width: WORKING_MAXIMUM_SIDE,
        height: WORKING_MAXIMUM_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
        kernel: 'lanczos3'
      })
      .ensureAlpha()
      .toColourspace('srgb')
      .png({ compressionLevel: 6 })
      .toBuffer();
  } catch {
    throw new AppError(422, 'invalid_image', 'The image could not be decoded. It may be corrupted.');
  }
  const orientation = metadata.orientation ?? 1;
  const swapped = orientation >= 5;
  const stats = await sharp(working).stats();
  const alphaChannel = stats.channels[3];
  return {
    working,
    info: {
      format,
      width: swapped ? metadata.height : metadata.width,
      height: swapped ? metadata.width : metadata.height,
      hasTransparency: alphaChannel ? alphaChannel.min < 250 : false,
      orientation
    }
  };
}

async function composeSquare(working, { canvas, fraction, fit, offsetX, offsetY, background }) {
  const box = Math.max(1, Math.round(canvas * fraction));
  const resized = await sharp(working)
    .resize({
      width: box,
      height: box,
      fit: fit === 'cover' ? 'cover' : 'inside',
      position: 'centre',
      kernel: 'lanczos3',
      withoutEnlargement: false
    })
    .png()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = resized.info;
  const clamp = (value, maximum) => Math.min(Math.max(value, 0), maximum);
  const left = clamp(Math.round((canvas - width) / 2 + offsetX * canvas), canvas - width);
  const top = clamp(Math.round((canvas - height) / 2 + offsetY * canvas), canvas - height);
  return sharp({ create: { width: canvas, height: canvas, channels: 4, background } })
    .composite([{ input: resized.data, left, top }])
    .png()
    .toBuffer();
}

const circleMask = (size) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`
  );

const roundedMask = (size, ratio) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${Math.round(size * ratio)}" ry="${Math.round(size * ratio)}" fill="#fff"/></svg>`
  );

const applyMask = (image, mask) =>
  sharp(image).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();

async function toMonochrome(foreground, sourceHasTransparency) {
  const { data, info } = await sharp(foreground).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const output = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3];
    if (sourceHasTransparency) {
      output[index + 3] = alpha;
    } else {
      const luminance = Math.round(0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2]);
      output[index + 3] = Math.round((alpha * (255 - luminance)) / 255);
    }
  }
  return sharp(output, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

const adaptiveBackgroundColor = (settings) =>
  settings.background === 'transparent' ? settings.adaptiveBackground : settings.background;

const adaptiveIconXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>
</adaptive-icon>
`;

const backgroundColorXml = (color) => `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${color}</color>
</resources>
`;

export async function generateIconResources(working, rawSettings, { hasTransparency }) {
  const settings = normalizeIconSettings(rawSettings);
  const fraction = contentFraction(settings);
  const background = toBackground(settings.background);
  const transparent = toBackground('transparent');
  const files = [];
  for (const [density, size] of Object.entries(LEGACY_DENSITIES)) {
    const square = await composeSquare(working, {
      canvas: size,
      fraction,
      fit: settings.fit,
      offsetX: settings.offsetX,
      offsetY: settings.offsetY,
      background
    });
    files.push({ path: `mipmap-${density}/ic_launcher.png`, content: square });
    files.push({ path: `mipmap-${density}/ic_launcher_round.png`, content: await applyMask(square, circleMask(size)) });
  }
  for (const [density, size] of Object.entries(ADAPTIVE_DENSITIES)) {
    const foreground = await composeSquare(working, {
      canvas: size,
      fraction: fraction * SAFE_ZONE_RATIO,
      fit: settings.fit,
      offsetX: settings.offsetX,
      offsetY: settings.offsetY,
      background: transparent
    });
    files.push({ path: `mipmap-${density}/ic_launcher_foreground.png`, content: foreground });
    files.push({
      path: `mipmap-${density}/ic_launcher_monochrome.png`,
      content: await toMonochrome(foreground, hasTransparency)
    });
  }
  const adaptiveXml = Buffer.from(adaptiveIconXml, 'utf8');
  files.push({ path: 'mipmap-anydpi-v26/ic_launcher.xml', content: adaptiveXml });
  files.push({ path: 'mipmap-anydpi-v26/ic_launcher_round.xml', content: adaptiveXml });
  files.push({
    path: 'values/ic_launcher_background.xml',
    content: Buffer.from(backgroundColorXml(adaptiveBackgroundColor(settings)), 'utf8')
  });
  return {
    files,
    manifest: { icon: '@mipmap/ic_launcher', roundIcon: '@mipmap/ic_launcher_round' }
  };
}

export async function writeIconResources(resourceDirectory, files) {
  for (const file of files) {
    const target = resolveInside(resourceDirectory, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, { mode: 0o644 });
  }
}

const checkerboard = (size) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><defs><pattern id="c" width="32" height="32" patternUnits="userSpaceOnUse"><rect width="32" height="32" fill="#eef0f4"/><rect width="16" height="16" fill="#c9ccd3"/><rect x="16" y="16" width="16" height="16" fill="#c9ccd3"/></pattern></defs><rect width="${size}" height="${size}" fill="url(#c)"/></svg>`
  );

export async function renderPreviews(working, rawSettings) {
  const settings = normalizeIconSettings(rawSettings);
  const fraction = contentFraction(settings);
  const size = PREVIEW_SIZE;
  const square = await composeSquare(working, {
    canvas: size,
    fraction,
    fit: settings.fit,
    offsetX: settings.offsetX,
    offsetY: settings.offsetY,
    background: toBackground(settings.background)
  });
  const foreground = await composeSquare(working, {
    canvas: size,
    fraction: fraction * SAFE_ZONE_RATIO,
    fit: settings.fit,
    offsetX: settings.offsetX,
    offsetY: settings.offsetY,
    background: toBackground('transparent')
  });
  const adaptiveBase = await sharp({
    create: { width: size, height: size, channels: 4, background: toBackground(adaptiveBackgroundColor(settings)) }
  })
    .composite([{ input: foreground }])
    .png()
    .toBuffer();
  const transparency = await sharp(checkerboard(size))
    .composite([{ input: square }])
    .png()
    .toBuffer();
  return {
    square,
    rounded: await applyMask(square, roundedMask(size, 0.22)),
    round: await applyMask(square, circleMask(size)),
    adaptive: await applyMask(adaptiveBase, circleMask(size)),
    transparency
  };
}
