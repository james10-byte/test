import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { startMockApi } from '../helpers/mockApi.js';

const ROUTES = ['#/', '#/studio', '#/monitor', '#/history', '#/settings', '#/docs', '#/about'];
const VIEWPORTS = { desktop: { width: 1280, height: 800 }, tablet: { width: 820, height: 1100 }, mobile: { width: 375, height: 812 } };

let browser;
let api;
let directory;
let htmlFile;
let iconFile;

before(async () => {
  browser = await chromium.launch();
  api = await startMockApi({ stepMs: 100 });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ui-test-'));
  htmlFile = path.join(directory, 'index.html');
  await fs.writeFile(htmlFile, '<!doctype html><html><body><h1>Hello</h1></body></html>');
  iconFile = path.join(directory, 'icon.png');
  await sharp({ create: { width: 300, height: 150, channels: 4, background: { r: 200, g: 40, b: 90, alpha: 1 } } }).png().toFile(iconFile);
});

after(async () => {
  await browser.close();
  await api.close();
});

async function openPage(viewport = VIEWPORTS.desktop, options = {}) {
  const context = await browser.newContext({ viewport, acceptDownloads: true, locale: options.locale ?? 'en-US', hasTouch: viewport.width < 500 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(api.url);
  await page.waitForSelector('.shell');
  return { page, context, errors };
}

const hasHorizontalOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

async function fillStudio(page, name) {
  await page.locator('#app-name').fill(name);
  await page.locator('#source-file').setInputFiles(htmlFile);
}

test('no route overflows horizontally on desktop, tablet and mobile', async () => {
  for (const [label, viewport] of Object.entries(VIEWPORTS)) {
    const { page, context, errors } = await openPage(viewport);
    for (const route of ROUTES) {
      await page.goto(`${api.url}/${route}`);
      await page.waitForSelector('.main h1, .main .empty-title');
      assert.equal(await hasHorizontalOverflow(page), false, `${label} overflows on ${route}`);
    }
    assert.deepEqual(errors, [], `${label} logged errors`);
    await context.close();
  }
});

test('the dashboard starts with an invitation to build, with real zero statistics', async () => {
  const { page, context } = await openPage();
  await page.goto(`${api.url}/#/`);
  await page.waitForSelector('.empty-title');
  assert.equal(await page.locator('.empty-title').textContent(), 'No builds yet');
  assert.equal(await page.locator('.page-title').textContent(), 'Dashboard');
  await context.close();
});

test('studio validation reports every invalid field and focuses the first', async () => {
  const { page, context } = await openPage();
  await page.goto(`${api.url}/#/studio`);
  await page.locator('#package-id').fill('Bad');
  await page.locator('#version-code').fill('0');
  await page.getByRole('button', { name: 'Build APK' }).click();
  assert.equal(await page.locator('[role="alert"]').first().isVisible(), true);
  assert.equal(await page.locator('#app-name').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('#package-id').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('#version-code').getAttribute('aria-invalid'), 'true');
  assert.match(await page.locator('#package-id-error').textContent(), /lowercase segments/);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'source-file');
  await page.locator('#app-name').fill('Demo');
  assert.equal(await page.locator('#app-name').getAttribute('aria-invalid'), null);
  await context.close();
});

test('website urls must use https', async () => {
  const { page, context } = await openPage();
  await page.goto(`${api.url}/#/studio`);
  await page.locator('label.segment', { hasText: 'Website URL' }).click();
  await page.locator('#app-name').fill('Site');
  await page.locator('#source-url').fill('http://example.com');
  await page.getByRole('button', { name: 'Build APK' }).click();
  assert.match(await page.locator('#source-error').textContent(), /https/);
  await page.locator('#source-url').fill('https://example.com');
  assert.equal(await page.locator('#source-error').isHidden(), true);
  await context.close();
});

test('choosing an icon shows previews produced by the API and updates on every control', async () => {
  const { page, context } = await openPage();
  await page.goto(`${api.url}/#/studio`);
  const before = api.requests.filter((entry) => entry === 'POST /api/icons/preview').length;
  await page.locator('#icon-file').setInputFiles(iconFile);
  await page.waitForSelector('.preview-grid');
  assert.equal(await page.locator('.preview-grid img').count(), 6);
  assert.equal(await page.locator('.home-screen img').count(), 1);
  await page.locator('#icon-padding').fill('0.3');
  await page.locator('#icon-fit').selectOption('cover');
  await page.locator('#icon-transparent').uncheck();
  await page.waitForFunction((count) => true, before);
  await page.waitForTimeout(600);
  assert.ok(api.requests.filter((entry) => entry === 'POST /api/icons/preview').length > before + 1);
  await page.getByRole('button', { name: 'Reset to recommended' }).click();
  assert.equal(await page.locator('#icon-padding').inputValue(), '0.1');
  assert.equal(await page.locator('#icon-transparent').isChecked(), true);
  await context.close();
});

test('a full build is followed live, downloaded with integrity checks, listed and deleted', async () => {
  const { page, context, errors } = await openPage();
  await page.goto(`${api.url}/#/studio`);
  await fillStudio(page, 'Demo App');
  await page.locator('#icon-file').setInputFiles(iconFile);
  await page.getByRole('button', { name: 'Build APK' }).click();
  await page.waitForURL(/#\/monitor\/[a-f0-9]{32}/);
  await page.waitForSelector('.badge-completed');
  assert.match(await page.locator('.log').textContent(), /Build completed/);
  assert.match(await page.locator('.log').textContent(), /Starting Gradle/);
  assert.equal(await page.locator('.stage-done').count(), 5);
  assert.match(await page.locator('.warning').first().textContent(), /Missing local files/);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download APK' }).click()]);
  assert.equal(download.suggestedFilename(), 'Demo-debug.apk');
  const saved = await download.path();
  assert.equal((await fs.stat(saved)).size, api.apkSize);
  await page.goto(`${api.url}/#/history`);
  await page.waitForSelector('.table tbody tr');
  assert.equal(await page.locator('.table tbody tr').count(), 1);
  assert.match(await page.locator('.table tbody tr').first().textContent(), /Demo App/);
  await page.goto(`${api.url}/#/`);
  await page.waitForSelector('.ledger');
  assert.equal(await page.locator('.ledger-total dd').textContent(), '1');
  assert.equal(await page.locator('.ledger-succeeded dd').textContent(), '1');
  await page.goto(`${api.url}/#/history`);
  await page.getByRole('button', { name: 'Delete Demo App' }).click();
  await page.locator('dialog').getByRole('button', { name: 'Delete' }).click();
  await page.waitForSelector('.empty-title');
  assert.deepEqual(errors, []);
  await context.close();
});

test('a failed build explains what went wrong and keeps the log', async () => {
  const { page, context } = await openPage();
  await page.goto(`${api.url}/#/studio`);
  await fillStudio(page, 'Will fail');
  await page.getByRole('button', { name: 'Build APK' }).click();
  await page.waitForSelector('.badge-failed');
  assert.match(await page.locator('.notice-danger').textContent(), /exit code 1/);
  assert.equal(await page.getByRole('button', { name: 'Download APK' }).count(), 0);
  assert.equal(await page.locator('.stage-final').count(), 1);
  await context.close();
});

test('a running build can be cancelled', async () => {
  const { page, context } = await openPage();
  await page.goto(`${api.url}/#/studio`);
  await fillStudio(page, 'Very slow');
  await page.getByRole('button', { name: 'Build APK' }).click();
  await page.waitForSelector('.badge-compiling');
  await page.getByRole('button', { name: 'Cancel build' }).click();
  await page.waitForSelector('.badge-cancelled');
  assert.equal(await page.getByRole('button', { name: 'Cancel build' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Delete build' }).count(), 1);
  await context.close();
});

test('server errors during submission are shown with their details', async () => {
  const { page, context } = await openPage();
  await page.goto(`${api.url}/#/studio`);
  await page.locator('label.segment', { hasText: 'ZIP website' }).click();
  await page.locator('#app-name').fill('Zip site');
  const tiny = path.join(directory, 'tiny.zip');
  await fs.writeFile(tiny, 'PK');
  await page.locator('#source-file').setInputFiles(tiny);
  await page.getByRole('button', { name: 'Build APK' }).click();
  await page.waitForSelector('.notice-danger');
  assert.match(await page.locator('.notice-danger').textContent(), /Several HTML files were found/);
  assert.match(await page.locator('.notice-danger').textContent(), /a\.html, b\.html/);
  await context.close();
});

test('other access tokens cannot open a build', async () => {
  const { page, context } = await openPage();
  const [build] = [...api.builds.values()];
  const id = build?.id ?? 'f'.repeat(32);
  await page.goto(`${api.url}/#/monitor/${id}`);
  await page.waitForSelector('.empty-title');
  assert.match(await page.locator('.empty-title').textContent(), /does not exist or belongs to another access token/);
  await context.close();
});

test('application names are rendered as text, never as markup', async () => {
  const { page, context } = await openPage();
  await page.goto(`${api.url}/#/studio`);
  await fillStudio(page, '<img src=x onerror=alert(1)>');
  await page.getByRole('button', { name: 'Build APK' }).click();
  await page.waitForSelector('.badge-completed');
  assert.equal(await page.locator('img[src="x"]').count(), 0);
  assert.match(await page.locator('h1.page-title').textContent(), /<img src=x onerror=alert\(1\)>/);
  await context.close();
});

test('the interface switches language and keeps the choice', async () => {
  const { page, context } = await openPage();
  await page.goto(`${api.url}/#/settings`);
  await page.locator('#language').selectOption('fr');
  await page.waitForSelector('h1.page-title:has-text("Paramètres")');
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'fr');
  assert.equal(await page.locator('.nav-link').first().textContent(), 'Tableau de bord');
  await page.reload();
  await page.waitForSelector('h1.page-title:has-text("Paramètres")');
  await page.locator('#language').selectOption('pt');
  await page.waitForSelector('h1.page-title:has-text("Configurações")');
  await context.close();
});

test('the theme can be switched and persists', async () => {
  const { page, context } = await openPage();
  await page.goto(`${api.url}/#/settings`);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.locator('label.segment', { hasText: 'Light' }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await page.reload();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await context.close();
});

test('default build values saved in settings prefill the studio', async () => {
  const { page, context } = await openPage();
  await page.goto(`${api.url}/#/settings`);
  await page.locator('#default-package').fill('org.demo.base');
  await page.locator('#default-orientation').selectOption('landscape');
  await page.getByRole('button', { name: 'Save defaults' }).click();
  await page.goto(`${api.url}/#/studio`);
  assert.equal(await page.locator('#package-id').inputValue(), 'org.demo.base');
  assert.equal(await page.locator('#orientation').inputValue(), 'landscape');
  await page.goto(`${api.url}/#/settings`);
  await page.locator('#default-package').fill('bad');
  await page.getByRole('button', { name: 'Save defaults' }).click();
  assert.equal(await page.locator('.settings-form .field-error[role="alert"]').first().isVisible(), true);
  await context.close();
});

test('going offline shows a banner and recovering hides it', async () => {
  const { page, context } = await openPage();
  await context.setOffline(true);
  await page.waitForSelector('#banner:not([hidden])');
  assert.match(await page.locator('#banner').textContent(), /offline/);
  await context.setOffline(false);
  await page.waitForSelector('#banner[hidden]', { state: 'attached' });
  await context.close();
});

test('an unreachable server is reported', async () => {
  const { page, context } = await openPage();
  await page.goto(`${api.url}/#/settings`);
  await page.locator('#api-base').fill('http://127.0.0.1:9');
  await page.getByRole('button', { name: 'Save connection' }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForSelector('#banner:not([hidden])');
  assert.match(await page.locator('#banner').textContent(), /cannot be reached/);
  await context.close();
});

test('mobile navigation opens as a drawer, navigates and closes', async () => {
  const { page, context } = await openPage(VIEWPORTS.mobile);
  const toggle = page.getByRole('button', { name: 'Menu' });
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await page.locator('.nav-link', { hasText: 'History' }).click();
  await page.waitForSelector('h1.page-title:has-text("Build history")');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await toggle.click();
  await page.keyboard.press('Escape');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await context.close();
});

test('keyboard users reach the skip link first and see a visible focus ring', async () => {
  const { page, context } = await openPage();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.className), 'skip-link');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  assert.notEqual(outline, 'none');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('brand')), true);
  await context.close();
});

test('the studio is usable on a narrow phone without horizontal scrolling after choosing files', async () => {
  const { page, context } = await openPage({ width: 320, height: 640 });
  await page.goto(`${api.url}/#/studio`);
  await fillStudio(page, 'A very long application name that wraps');
  await page.locator('#icon-file').setInputFiles(iconFile);
  await page.waitForSelector('.preview-grid');
  assert.equal(await hasHorizontalOverflow(page), false);
  await context.close();
});

test('history rows stay readable on mobile', async () => {
  const { page, context } = await openPage(VIEWPORTS.mobile);
  await page.goto(`${api.url}/#/studio`);
  await fillStudio(page, 'Mobile row');
  await page.getByRole('button', { name: 'Build APK' }).click();
  await page.waitForSelector('.badge-completed');
  await page.goto(`${api.url}/#/history`);
  await page.waitForSelector('.table tbody tr');
  assert.equal(await hasHorizontalOverflow(page), false);
  assert.equal(await page.locator('.table thead').evaluate((node) => node.getBoundingClientRect().width <= 1), true);
  await context.close();
});

test('the api key is sent when configured', async () => {
  const guarded = await startMockApi({ stepMs: 50, requireApiKey: 'topsecret' });
  const context = await browser.newContext({ viewport: VIEWPORTS.desktop });
  const page = await context.newPage();
  await page.goto(`${guarded.url}/#/settings`);
  await page.waitForSelector('#api-key');
  await page.locator('#api-key').fill('topsecret');
  await page.getByRole('button', { name: 'Save connection' }).click();
  await page.goto(`${guarded.url}/#/history`);
  await page.waitForSelector('.empty-title');
  assert.equal(await page.locator('.empty-title').textContent(), 'Your history is empty');
  await context.close();
  await guarded.close();
});
