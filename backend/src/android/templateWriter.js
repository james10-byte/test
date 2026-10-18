import fs from 'node:fs/promises';
import path from 'node:path';
import { writeIconResources } from '../icons/iconGenerator.js';

export const TEMPLATE_DIRECTORY = path.resolve(import.meta.dirname, '../../../android-template');
export const ASSET_HOST = 'appassets.androidplatform.net';

export function escapeAndroidString(value) {
  let escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '\\"')
    .replaceAll("'", "\\'");
  if (escaped.startsWith('@') || escaped.startsWith('?')) escaped = `\\${escaped}`;
  return escaped;
}

const stringsXml = (appName) => `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name" formatted="false">${escapeAndroidString(appName)}</string>
    <string name="error_message">The page could not be loaded. Check your connection and try again.</string>
    <string name="retry_label">Retry</string>
</resources>
`;

const colorsXml = (config) => `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="status_bar_color">${config.statusBarColor}</color>
    <color name="navigation_bar_color">${config.navigationBarColor}</color>
    <color name="window_background">#FFFFFF</color>
</resources>
`;

export function localStartUrl(entryFile) {
  return `https://${ASSET_HOST}/assets/www/${entryFile.split('/').map(encodeURIComponent).join('/')}`;
}

export function buildGradleArguments(config, site, remote) {
  const local = config.inputType !== 'url';
  const startUrl = local ? localStartUrl(site.entryFile) : remote.startUrl;
  const allowedHost = local ? ASSET_HOST : remote.host;
  return [
    `-Pinconnu.applicationId=${config.packageId}`,
    `-Pinconnu.versionName=${config.versionName}`,
    `-Pinconnu.versionCode=${config.versionCode}`,
    `-Pinconnu.orientation=${config.orientation}`,
    `-Pinconnu.startUrl=${startUrl}`,
    `-Pinconnu.allowedHost=${allowedHost}`,
    `-Pinconnu.remote=${local ? 'false' : 'true'}`
  ];
}

export async function writeAndroidProject({ projectDirectory, config, siteDirectory, site, remote, iconFiles }) {
  await fs.cp(TEMPLATE_DIRECTORY, projectDirectory, { recursive: true, errorOnExist: true, force: false });
  const mainDirectory = path.join(projectDirectory, 'app', 'src', 'main');
  const resourceDirectory = path.join(mainDirectory, 'res');
  await writeIconResources(resourceDirectory, iconFiles);
  await fs.writeFile(path.join(resourceDirectory, 'values', 'strings.xml'), stringsXml(config.appName), { mode: 0o644 });
  await fs.writeFile(path.join(resourceDirectory, 'values', 'colors.xml'), colorsXml(config), { mode: 0o644 });
  if (config.inputType !== 'url') {
    const source = path.join(siteDirectory, ...site.rootDirectory.split('/').filter(Boolean));
    await fs.cp(source, path.join(mainDirectory, 'assets', 'www'), { recursive: true, dereference: false });
  }
  return { gradleArguments: buildGradleArguments(config, site, remote) };
}
