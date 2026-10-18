import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateBuildConfig } from '../android/buildConfig.js';
import { AppError } from '../errors.js';
import { prepareImage } from '../icons/iconGenerator.js';
import { collectPackagingWarnings, ingestHtml, ingestZip } from '../project/projectIngest.js';
import { resolveInside } from '../security/paths.js';
import { probeUrl } from '../security/urlGuard.js';
import { toPublicBuild } from '../serializers.js';
import { createDefaultIcon } from './defaultIcon.js';

export function createBuildService({ config, database, queue, probe = probeUrl }) {
  const imageLimits = { maxBytes: config.limits.maxImageBytes, maxPixels: config.limits.maxImagePixels };

  const assertQuota = (ownerHash) => {
    if (database.stats(ownerHash).active >= config.limits.maxActiveBuildsPerClient) {
      throw new AppError(429, 'too_many_active_builds', 'Too many builds are already in progress. Wait for one to finish.');
    }
    if (database.storageUsedBytes(ownerHash) >= config.limits.maxStorageBytesPerClient) {
      throw new AppError(413, 'storage_quota_exceeded', 'The storage quota is reached. Delete older builds first.');
    }
  };

  return {
    async submit({ ownerHash, rawConfig, source, icon }) {
      const buildConfig = validateBuildConfig(rawConfig);
      assertQuota(ownerHash);
      const id = randomBytes(16).toString('hex');
      const workspace = resolveInside(config.workspaceDirectory, id);
      let recorded = false;
      try {
        await fs.mkdir(workspace, { recursive: true });
        const stored = { ...buildConfig };
        let warnings = [];
        if (buildConfig.inputType === 'url') {
          const result = await probe(buildConfig.url);
          if (!result.secure) throw new AppError(422, 'https_required', 'The website redirects to an unencrypted address.');
          const finalUrl = new URL(result.finalUrl);
          stored.remote = { startUrl: finalUrl.toString(), host: finalUrl.hostname };
          if (result.redirects > 0) {
            warnings.push({ code: 'redirected', message: 'The website redirects. The final address will be used.', items: [finalUrl.toString()] });
          }
          warnings.push({ code: 'online_required', message: 'This application displays a remote website and needs an internet connection.', items: [] });
        } else {
          if (!Buffer.isBuffer(source) || source.length === 0) {
            throw new AppError(422, 'missing_source', 'A website file is required in the "source" field.');
          }
          const siteDirectory = path.join(workspace, 'site');
          const ingested =
            buildConfig.inputType === 'html'
              ? await ingestHtml(source, siteDirectory, { maxBytes: config.limits.maxHtmlBytes })
              : await ingestZip(source, siteDirectory, config.limits);
          stored.site = { rootDirectory: ingested.rootDirectory, entryFile: ingested.entryFile };
          warnings = [...ingested.warnings, ...collectPackagingWarnings(ingested.files)];
        }
        const prepared = await prepareImage(icon ?? (await createDefaultIcon()), imageLimits);
        await fs.writeFile(path.join(workspace, 'icon.png'), prepared.working, { mode: 0o600 });
        stored.iconInfo = { hasTransparency: prepared.info.hasTransparency, usingDefault: !icon };
        stored.warnings = warnings;
        database.createBuild({ id, ownerHash, appName: buildConfig.appName, inputType: buildConfig.inputType, config: stored, signingMode: buildConfig.signing });
        recorded = true;
        queue.enqueue(id);
        return toPublicBuild(database.getBuild(id), queue.position(id));
      } catch (error) {
        if (recorded) database.deleteBuild(id);
        await fs.rm(workspace, { recursive: true, force: true });
        throw error;
      }
    }
  };
}
