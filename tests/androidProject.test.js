import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { validateBuildConfig } from '../backend/src/android/buildConfig.js';
import { escapeAndroidString, localStartUrl, writeAndroidProject } from '../backend/src/android/templateWriter.js';
import { generateIconResources, prepareImage } from '../backend/src/icons/iconGenerator.js';
import { makeTemporaryDirectory, sampleIcon, validConfig } from './helpers/fixtures.js';

const limits = { maxBytes: 5 * 1024 * 1024, maxPixels: 25000000 };
const read = (directory, ...parts) => fs.readFile(path.join(directory, ...parts), 'utf8');

async function generate(configOverrides, siteFiles = { 'index.html': '<html></html>' }) {
  const root = await makeTemporaryDirectory('project-');
  const siteDirectory = path.join(root, 'site');
  for (const [name, content] of Object.entries(siteFiles)) {
    await fs.mkdir(path.dirname(path.join(siteDirectory, name)), { recursive: true });
    await fs.writeFile(path.join(siteDirectory, name), content);
  }
  const config = validateBuildConfig(validConfig(configOverrides));
  const prepared = await prepareImage(await sampleIcon(), limits);
  const icons = await generateIconResources(prepared.working, config.icon, prepared.info);
  const projectDirectory = path.join(root, 'project');
  const result = await writeAndroidProject({
    projectDirectory,
    config,
    siteDirectory,
    site: { rootDirectory: '', entryFile: 'index.html' },
    remote: { startUrl: 'https://example.com/start', host: 'example.com' },
    iconFiles: icons.files
  });
  return { root, projectDirectory, result, icons, config };
}

test('generated project contains template, icons, assets and generated resources', async () => {
  const { projectDirectory, result } = await generate({}, { 'index.html': '<html></html>', 'css/a.css': 'body{}' });
  for (const file of [
    'settings.gradle.kts',
    'app/build.gradle.kts',
    'app/src/main/AndroidManifest.xml',
    'app/src/main/kotlin/dev/inconnuboy/apkbuilder/template/MainActivity.kt',
    'app/src/main/assets/www/index.html',
    'app/src/main/assets/www/css/a.css',
    'app/src/main/res/mipmap-xxxhdpi/ic_launcher.png',
    'app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml',
    'app/src/main/res/values/ic_launcher_background.xml',
    'app/src/main/res/values/strings.xml',
    'app/src/main/res/values/colors.xml'
  ]) {
    await fs.access(path.join(projectDirectory, file));
  }
  assert.match(await read(projectDirectory, 'app/src/main/res/values/colors.xml'), /status_bar_color">#112233</);
  assert.match(await read(projectDirectory, 'app/src/main/res/values/colors.xml'), /navigation_bar_color">#445566</);
  assert.ok(result.gradleArguments.includes('-Pinconnu.applicationId=com.example.demo'));
  assert.ok(result.gradleArguments.includes('-Pinconnu.versionCode=7'));
  assert.ok(result.gradleArguments.includes('-Pinconnu.orientation=portrait'));
  assert.ok(result.gradleArguments.includes('-Pinconnu.remote=false'));
  assert.ok(result.gradleArguments.includes('-Pinconnu.allowedHost=appassets.androidplatform.net'));
  assert.ok(result.gradleArguments.includes('-Pinconnu.startUrl=https://appassets.androidplatform.net/assets/www/index.html'));
});

test('the manifest references exactly the launcher icons produced by the generator', async () => {
  const { projectDirectory, icons } = await generate({});
  const manifest = await read(projectDirectory, 'app/src/main/AndroidManifest.xml');
  assert.ok(manifest.includes(`android:icon="${icons.manifest.icon}"`));
  assert.ok(manifest.includes(`android:roundIcon="${icons.manifest.roundIcon}"`));
  for (const file of icons.files) {
    await fs.access(path.join(projectDirectory, 'app/src/main/res', file.path));
  }
});

test('the template forbids cleartext traffic and unrestricted file access', async () => {
  const { projectDirectory } = await generate({});
  const manifest = await read(projectDirectory, 'app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  assert.match(manifest, /android:allowBackup="false"/);
  assert.equal((manifest.match(/<uses-permission/g) ?? []).length, 1);
  assert.match(await read(projectDirectory, 'app/src/main/res/xml/network_security_config.xml'), /cleartextTrafficPermitted="false"/);
  const activity = await read(projectDirectory, 'app/src/main/kotlin/dev/inconnuboy/apkbuilder/template/MainActivity.kt');
  assert.match(activity, /allowFileAccess = false/);
  assert.match(activity, /allowContentAccess = false/);
  assert.match(activity, /MIXED_CONTENT_NEVER_ALLOW/);
  assert.doesNotMatch(activity, /addJavascriptInterface/);
  assert.doesNotMatch(activity, /allowUniversalAccessFromFileURLs\s*=\s*true/);
});

test('website applications use the remote start url and host', async () => {
  const root = await makeTemporaryDirectory('remote-');
  const config = validateBuildConfig(validConfig({ inputType: 'url', url: 'https://example.com/start' }));
  const prepared = await prepareImage(await sampleIcon(), limits);
  const icons = await generateIconResources(prepared.working, config.icon, prepared.info);
  const { gradleArguments } = await writeAndroidProject({
    projectDirectory: path.join(root, 'project'),
    config,
    siteDirectory: path.join(root, 'site'),
    site: undefined,
    remote: { startUrl: 'https://example.com/start', host: 'example.com' },
    iconFiles: icons.files
  });
  assert.ok(gradleArguments.includes('-Pinconnu.remote=true'));
  assert.ok(gradleArguments.includes('-Pinconnu.allowedHost=example.com'));
  assert.ok(gradleArguments.includes('-Pinconnu.startUrl=https://example.com/start'));
  await assert.rejects(() => fs.access(path.join(root, 'project/app/src/main/assets')));
});

test('application names are escaped for Android string resources', async () => {
  assert.equal(escapeAndroidString(`Tom's <App> & "Co"`), `Tom\\'s &lt;App&gt; &amp; \\"Co\\"`);
  assert.equal(escapeAndroidString('@home'), '\\@home');
  assert.equal(escapeAndroidString('100%'), '100%');
  const { projectDirectory } = await generate({ appName: `Tom's <App>` });
  const strings = await read(projectDirectory, 'app/src/main/res/values/strings.xml');
  assert.match(strings, /formatted="false">Tom\\'s &lt;App&gt;</);
  assert.match(strings, /name="error_message"/);
  assert.match(strings, /name="retry_label"/);
});

test('local start urls encode path segments', () => {
  assert.equal(localStartUrl('my page.html'), 'https://appassets.androidplatform.net/assets/www/my%20page.html');
});

test('every project property read by the Gradle script is supplied', async () => {
  const { projectDirectory, result } = await generate({});
  const script = await read(projectDirectory, 'app/build.gradle.kts');
  const required = [...script.matchAll(/requiredProperty\("([^"]+)"\)/g)].map((match) => match[1]);
  const supplied = result.gradleArguments.map((argument) => argument.slice(2, argument.indexOf('=')));
  assert.ok(required.length >= 7);
  for (const name of new Set(required)) assert.ok(supplied.includes(name), `${name} not supplied`);
});

test('the template keeps Gradle in one process so no daemon port is opened', async () => {
  const { projectDirectory } = await generate({});
  const properties = await read(projectDirectory, 'gradle.properties');
  assert.doesNotMatch(properties, /org\.gradle\.jvmargs/);
  assert.doesNotMatch(properties, /file\.encoding/);
  assert.match(properties, /^kotlin\.compiler\.execution\.strategy=in-process$/m);
  assert.match(properties, /^org\.gradle\.vfs\.watch=false$/m);
});
