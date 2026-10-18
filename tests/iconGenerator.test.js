import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import {
  ADAPTIVE_DENSITIES,
  LEGACY_DENSITIES,
  SAFE_ZONE_RATIO,
  generateIconResources,
  normalizeIconSettings,
  prepareImage,
  renderPreviews,
  writeIconResources
} from '../backend/src/icons/iconGenerator.js';

const limits = { maxBytes: 5 * 1024 * 1024, maxPixels: 25000000 };

const solid = (width, height, color = { r: 220, g: 40, b: 40, alpha: 1 }) =>
  sharp({ create: { width, height, channels: 4, background: color } });

const opaqueBoundingBox = async (buffer) => {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * 4 + 3] > 128) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
};

const pixel = async (buffer, x, y) => {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * 4;
  return { r: data[offset], g: data[offset + 1], b: data[offset + 2], a: data[offset + 3] };
};

const resource = (result, name) => result.files.find((file) => file.path === name);

test('accepts png, jpeg and webp by content', async () => {
  for (const format of ['png', 'jpeg', 'webp']) {
    const buffer = await solid(300, 300).toFormat(format).toBuffer();
    const prepared = await prepareImage(buffer, limits);
    assert.equal(prepared.info.format, format);
    assert.equal(prepared.info.width, 300);
  }
});

test('a png renamed to a jpg extension is still processed by its real content', async () => {
  const buffer = await solid(64, 64).png().toBuffer();
  const prepared = await prepareImage(buffer, limits);
  assert.equal(prepared.info.format, 'png');
});

test('rejects unsupported, invalid, empty and corrupted files', async () => {
  const run = (buffer, code) => assert.rejects(() => prepareImage(buffer, limits), (error) => error.code === code);
  await run(Buffer.alloc(0), 'invalid_image');
  await run(Buffer.from('GIF89a-not-supported'), 'unsupported_image');
  await run(Buffer.from('this is plain text, not an image'), 'unsupported_image');
  const valid = await solid(200, 200).png().toBuffer();
  await run(valid.subarray(0, Math.floor(valid.length / 2)), 'invalid_image');
  const corruptedHeader = Buffer.concat([valid.subarray(0, 8), Buffer.from('garbagegarbagegarbage')]);
  await run(corruptedHeader, 'invalid_image');
});

test('rejects oversized files and excessive pixel counts', async () => {
  const buffer = await solid(1500, 1500).png().toBuffer();
  await assert.rejects(() => prepareImage(buffer, { maxBytes: 100, maxPixels: 25000000 }), (error) => error.code === 'image_too_large');
  await assert.rejects(() => prepareImage(buffer, { maxBytes: 5 * 1024 * 1024, maxPixels: 1000000 }), (error) => ['image_too_many_pixels', 'invalid_image'].includes(error.code));
});

test('rejects images that are too small', async () => {
  const buffer = await solid(4, 4).png().toBuffer();
  await assert.rejects(() => prepareImage(buffer, limits), (error) => error.code === 'image_too_small');
});

test('accepts small valid images and large permitted images', async () => {
  const small = await prepareImage(await solid(16, 16).png().toBuffer(), limits);
  assert.equal(small.info.width, 16);
  const large = await prepareImage(await solid(3000, 2000).jpeg().toBuffer(), limits);
  const metadata = await sharp(large.working).metadata();
  assert.ok(Math.max(metadata.width, metadata.height) <= 2048);
  assert.equal(Math.round((metadata.width / metadata.height) * 100), 150);
});

test('applies exif orientation', async () => {
  const buffer = await solid(40, 20).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const prepared = await prepareImage(buffer, limits);
  const metadata = await sharp(prepared.working).metadata();
  assert.equal(metadata.width, 20);
  assert.equal(metadata.height, 40);
  assert.equal(prepared.info.width, 20);
  assert.equal(prepared.info.height, 40);
});

test('detects transparency', async () => {
  const transparent = await solid(100, 100, { r: 0, g: 0, b: 0, alpha: 0 }).png().toBuffer();
  assert.equal((await prepareImage(transparent, limits)).info.hasTransparency, true);
  const opaque = await solid(100, 100).png().toBuffer();
  assert.equal((await prepareImage(opaque, limits)).info.hasTransparency, false);
});

test('settings are validated and defaulted', () => {
  assert.equal(normalizeIconSettings({}).fit, 'contain');
  assert.equal(normalizeIconSettings({ background: '#abcdef' }).background, '#ABCDEF');
  for (const bad of [{ scale: 2 }, { padding: -1 }, { offsetX: 1 }, { background: 'red' }, { fit: 'stretch' }, { adaptiveBackground: 'transparent' }, { scale: 'big' }]) {
    assert.throws(() => normalizeIconSettings(bad), (error) => error.code === 'invalid_icon_settings');
  }
});

test('generates every legacy and adaptive resource with exact dimensions', async () => {
  const { working, info } = await prepareImage(await solid(300, 300).png().toBuffer(), limits);
  const result = await generateIconResources(working, {}, info);
  for (const [density, size] of Object.entries(LEGACY_DENSITIES)) {
    for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
      const file = resource(result, `mipmap-${density}/${name}`);
      assert.ok(file, `${density}/${name} missing`);
      const metadata = await sharp(file.content).metadata();
      assert.equal(metadata.format, 'png');
      assert.equal(metadata.width, size);
      assert.equal(metadata.height, size);
    }
  }
  for (const [density, size] of Object.entries(ADAPTIVE_DENSITIES)) {
    for (const name of ['ic_launcher_foreground.png', 'ic_launcher_monochrome.png']) {
      const metadata = await sharp(resource(result, `mipmap-${density}/${name}`).content).metadata();
      assert.equal(metadata.width, size);
      assert.equal(metadata.height, size);
    }
  }
});

test('adaptive icon xml and manifest references are correct', async () => {
  const { working, info } = await prepareImage(await solid(200, 200).png().toBuffer(), limits);
  const result = await generateIconResources(working, { background: '#112233' }, info);
  const xml = resource(result, 'mipmap-anydpi-v26/ic_launcher.xml').content.toString('utf8');
  assert.match(xml, /<adaptive-icon xmlns:android="http:\/\/schemas.android.com\/apk\/res\/android">/);
  assert.match(xml, /<background android:drawable="@color\/ic_launcher_background"\/>/);
  assert.match(xml, /<foreground android:drawable="@mipmap\/ic_launcher_foreground"\/>/);
  assert.match(xml, /<monochrome android:drawable="@mipmap\/ic_launcher_monochrome"\/>/);
  assert.ok(resource(result, 'mipmap-anydpi-v26/ic_launcher_round.xml'));
  assert.match(resource(result, 'values/ic_launcher_background.xml').content.toString('utf8'), />#112233</);
  assert.deepEqual(result.manifest, { icon: '@mipmap/ic_launcher', roundIcon: '@mipmap/ic_launcher_round' });
});

test('adaptive background falls back to the dedicated color when the icon background is transparent', async () => {
  const { working, info } = await prepareImage(await solid(200, 200).png().toBuffer(), limits);
  const result = await generateIconResources(working, { adaptiveBackground: '#0A0B0C' }, info);
  assert.match(resource(result, 'values/ic_launcher_background.xml').content.toString('utf8'), />#0A0B0C</);
});

test('rectangular images are not distorted and are centered', async () => {
  const { working, info } = await prepareImage(await solid(400, 200).png().toBuffer(), limits);
  const result = await generateIconResources(working, { padding: 0.1 }, info);
  const box = await opaqueBoundingBox(resource(result, 'mipmap-xxxhdpi/ic_launcher.png').content);
  assert.ok(Math.abs(box.width / box.height - 2) < 0.08);
  assert.ok(Math.abs(box.minX - (192 - box.maxX - 1)) <= 1);
  assert.ok(Math.abs(box.minY - (192 - box.maxY - 1)) <= 1);
});

test('portrait images are not distorted', async () => {
  const { working, info } = await prepareImage(await solid(150, 300).png().toBuffer(), limits);
  const result = await generateIconResources(working, {}, info);
  const box = await opaqueBoundingBox(resource(result, 'mipmap-xxxhdpi/ic_launcher.png').content);
  assert.ok(Math.abs(box.height / box.width - 2) < 0.08);
});

test('padding and scale control the artwork size', async () => {
  const { working, info } = await prepareImage(await solid(300, 300).png().toBuffer(), limits);
  const wide = await generateIconResources(working, { padding: 0, scale: 1 }, info);
  const narrow = await generateIconResources(working, { padding: 0.2, scale: 0.5 }, info);
  const wideBox = await opaqueBoundingBox(resource(wide, 'mipmap-xxxhdpi/ic_launcher.png').content);
  const narrowBox = await opaqueBoundingBox(resource(narrow, 'mipmap-xxxhdpi/ic_launcher.png').content);
  assert.equal(wideBox.width, 192);
  assert.ok(Math.abs(narrowBox.width - 192 * 0.6 * 0.5) <= 2);
});

test('offsets move the artwork and stay inside the canvas', async () => {
  const { working, info } = await prepareImage(await solid(300, 300).png().toBuffer(), limits);
  const shifted = await generateIconResources(working, { padding: 0.25, offsetX: 0.5, offsetY: -0.5 }, info);
  const box = await opaqueBoundingBox(resource(shifted, 'mipmap-xxxhdpi/ic_launcher.png').content);
  assert.equal(box.maxX, 191);
  assert.equal(box.minY, 0);
});

test('background color and transparency are honored', async () => {
  const { working, info } = await prepareImage(await solid(200, 200).png().toBuffer(), limits);
  const colored = await generateIconResources(working, { background: '#00FF00' }, info);
  const corner = await pixel(resource(colored, 'mipmap-xxxhdpi/ic_launcher.png').content, 0, 0);
  assert.deepEqual(corner, { r: 0, g: 255, b: 0, a: 255 });
  const transparent = await generateIconResources(working, { background: 'transparent' }, info);
  assert.equal((await pixel(resource(transparent, 'mipmap-xxxhdpi/ic_launcher.png').content, 0, 0)).a, 0);
});

test('the round legacy icon is masked to a circle', async () => {
  const { working, info } = await prepareImage(await solid(200, 200).png().toBuffer(), limits);
  const result = await generateIconResources(working, { background: '#FF0000', padding: 0 }, info);
  const round = resource(result, 'mipmap-xxxhdpi/ic_launcher_round.png').content;
  assert.equal((await pixel(round, 0, 0)).a, 0);
  assert.equal((await pixel(round, 96, 96)).a, 255);
});

test('adaptive foreground artwork stays inside the safe zone', async () => {
  const { working, info } = await prepareImage(await solid(300, 300).png().toBuffer(), limits);
  const result = await generateIconResources(working, { padding: 0, scale: 1 }, info);
  const box = await opaqueBoundingBox(resource(result, 'mipmap-xxxhdpi/ic_launcher_foreground.png').content);
  const safe = Math.round(432 * SAFE_ZONE_RATIO);
  assert.ok(box.width <= safe + 1);
  assert.ok(Math.abs(box.minX - (432 - box.maxX - 1)) <= 1);
});

test('monochrome resources use the alpha silhouette of transparent artwork', async () => {
  const canvas = await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await solid(100, 100).png().toBuffer(), left: 50, top: 50 }])
    .png()
    .toBuffer();
  const { working, info } = await prepareImage(canvas, limits);
  assert.equal(info.hasTransparency, true);
  const result = await generateIconResources(working, {}, info);
  const mono = resource(result, 'mipmap-xxxhdpi/ic_launcher_monochrome.png').content;
  const center = await pixel(mono, 216, 216);
  assert.equal(center.a, 255);
  assert.equal(center.r + center.g + center.b, 0);
  assert.equal((await pixel(mono, 0, 0)).a, 0);
});

test('monochrome resources derive opacity from darkness for opaque artwork', async () => {
  const { working, info } = await prepareImage(await solid(200, 200, { r: 255, g: 255, b: 255, alpha: 1 }).png().toBuffer(), limits);
  const result = await generateIconResources(working, {}, info);
  const mono = resource(result, 'mipmap-xxxhdpi/ic_launcher_monochrome.png').content;
  assert.equal((await pixel(mono, 216, 216)).a, 0);
});

test('generation is deterministic', async () => {
  const { working, info } = await prepareImage(await solid(200, 100).png().toBuffer(), limits);
  const first = await generateIconResources(working, { background: '#123456', padding: 0.15 }, info);
  const second = await generateIconResources(working, { background: '#123456', padding: 0.15 }, info);
  assert.equal(first.files.length, second.files.length);
  for (let index = 0; index < first.files.length; index += 1) {
    assert.equal(first.files[index].path, second.files[index].path);
    assert.ok(first.files[index].content.equals(second.files[index].content));
  }
});

test('previews are produced from the real processing output', async () => {
  const { working } = await prepareImage(await solid(300, 150).png().toBuffer(), limits);
  const previews = await renderPreviews(working, { background: '#2244AA' });
  for (const name of ['square', 'rounded', 'round', 'adaptive', 'transparency']) {
    const metadata = await sharp(previews[name]).metadata();
    assert.equal(metadata.width, 512);
    assert.equal(metadata.height, 512);
  }
  const box = await opaqueBoundingBox(previews.square);
  assert.equal(box.width, 512);
  assert.equal((await pixel(previews.rounded, 0, 0)).a, 0);
  assert.equal((await pixel(previews.adaptive, 0, 0)).a, 0);
});

test('resources are written to disk under the requested resource directory', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'icon-test-'));
  const { working, info } = await prepareImage(await solid(200, 200).png().toBuffer(), limits);
  const result = await generateIconResources(working, {}, info);
  await writeIconResources(directory, result.files);
  const stat = await fs.stat(path.join(directory, 'mipmap-hdpi', 'ic_launcher.png'));
  assert.ok(stat.size > 0);
  await fs.access(path.join(directory, 'mipmap-anydpi-v26', 'ic_launcher.xml'));
  await fs.access(path.join(directory, 'values', 'ic_launcher_background.xml'));
  await assert.rejects(() => writeIconResources(directory, [{ path: '../escape.png', content: Buffer.from('x') }]), (error) => error.code === 'unsafe_path');
  await fs.rm(directory, { recursive: true });
});
