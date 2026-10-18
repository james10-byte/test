import fs from 'node:fs/promises';
import path from 'node:path';
import { validateBuildConfig } from '../backend/src/android/buildConfig.js';
import { writeAndroidProject } from '../backend/src/android/templateWriter.js';
import { createDefaultIcon } from '../backend/src/build/defaultIcon.js';
import { generateIconResources, prepareImage } from '../backend/src/icons/iconGenerator.js';

const output = path.resolve(process.argv[2] ?? 'sample-output');
const projectDirectory = path.join(output, 'project');
const siteDirectory = path.join(output, 'site');

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(siteDirectory, { recursive: true });
await fs.writeFile(path.join(siteDirectory, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Sample</title></head><body><h1>Sample</h1></body></html>');

const config = validateBuildConfig({
  appName: 'Sample App',
  packageId: 'dev.inconnuboy.sample',
  versionName: '1.0.0',
  versionCode: 1,
  inputType: 'html'
});

const prepared = await prepareImage(await createDefaultIcon(), { maxBytes: 10 * 1024 * 1024, maxPixels: 25000000 });
const icons = await generateIconResources(prepared.working, config.icon, prepared.info);
const { gradleArguments } = await writeAndroidProject({
  projectDirectory,
  config,
  siteDirectory,
  site: { rootDirectory: '', entryFile: 'index.html' },
  remote: undefined,
  iconFiles: icons.files
});

await fs.writeFile(path.join(output, 'gradle-arguments.txt'), `${gradleArguments.join('\n')}\n`);
console.log(`Sample project written to ${projectDirectory}`);
