import sharp from 'sharp';

const DEFAULT_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4F46E5"/><stop offset="1" stop-color="#7C3AED"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/><circle cx="256" cy="256" r="120" fill="#FFFFFF" fill-opacity="0.92"/></svg>`;

export function createDefaultIcon() {
  return sharp(Buffer.from(DEFAULT_ICON_SVG)).png().toBuffer();
}
