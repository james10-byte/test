import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateApk } from '../android/apkValidator.js';
import { writeAndroidProject } from '../android/templateWriter.js';
import { TERMINAL_STATES } from '../db/database.js';
import { AppError } from '../errors.js';
import { generateIconResources } from '../icons/iconGenerator.js';
import { resolveInside } from '../security/paths.js';
import { toPublicBuild } from '../serializers.js';
import { createLogFilter } from './logFilter.js';
import { buildGradleCommandArguments, buildGradleEnvironment, runGradle } from './gradleRunner.js';

const MAXIMUM_LOG_LINES = 5000;
const APK_RELATIVE_PATH = ['app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'];

export function createBuildRunner({ config, database, events, logger, gradle = runGradle, validate = validateApk }) {
  return async function runBuild(id, signal) {
    const initial = database.getBuild(id);
    if (!initial || TERMINAL_STATES.has(initial.state)) return;
    const workspace = resolveInside(config.workspaceDirectory, id);
    const projectDirectory = path.join(workspace, 'project');
    const replacements = [
      [workspace, '<workspace>'],
      [config.gradleUserHome, '<gradle-home>'],
      [config.buildHomeDirectory, '<build-home>'],
      ...(config.androidHome ? [[config.androidHome, '<android-sdk>']] : [])
    ];
    let lineCount = 0;

    const sanitize = (line) => replacements.reduce((text, [from, to]) => text.replaceAll(from, to), line);

    const log = (line) => {
      if (lineCount > MAXIMUM_LOG_LINES) return;
      lineCount += 1;
      const text = lineCount > MAXIMUM_LOG_LINES ? 'Log output truncated.' : sanitize(line);
      const seq = database.appendLog(id, text);
      events.publish(id, { type: 'log', seq, data: { line: text, at: new Date().toISOString() } });
    };

    const logFilter = createLogFilter(log);

    const advance = (state, options) => {
      const updated = database.transition(id, state, options);
      events.publish(id, { type: 'state', data: toPublicBuild(updated) });
      return updated;
    };

    const finish = (state, options) => {
      const updated = database.transition(id, state, options);
      events.publish(id, { type: 'state', data: toPublicBuild(updated) });
      events.publish(id, { type: 'end', data: { state } });
    };

    try {
      advance('preparing', { stage: 'preparing' });
      log('Preparing the Android project.');
      if (!config.androidHome) {
        throw new AppError(500, 'android_sdk_missing', 'The Android SDK is not configured on this server.');
      }
      const { config: buildConfig } = initial;
      const working = await fs.readFile(path.join(workspace, 'icon.png')).catch(() => {
        throw new AppError(500, 'workspace_missing', 'The build inputs are no longer available. Submit the build again.');
      });
      const icons = await generateIconResources(working, buildConfig.icon, buildConfig.iconInfo);
      log(`Generated ${icons.files.length} icon resources.`);
      signal.throwIfAborted();
      const { gradleArguments } = await writeAndroidProject({
        projectDirectory,
        config: buildConfig,
        siteDirectory: path.join(workspace, 'site'),
        site: buildConfig.site,
        remote: buildConfig.remote,
        iconFiles: icons.files
      });
      await fs.mkdir(config.buildHomeDirectory, { recursive: true });
      await fs.mkdir(config.gradleUserHome, { recursive: true });
      signal.throwIfAborted();

      advance('compiling', { stage: 'compiling' });
      log('Starting Gradle.');
      const result = await gradle({
        command: config.gradleCommand,
        args: buildGradleCommandArguments(config, gradleArguments),
        cwd: projectDirectory,
        env: buildGradleEnvironment(config),
        signal,
        onLine: logFilter.push
      });
      if (logFilter.ignoredCount() > 0) log(`Ignored ${logFilter.ignoredCount()} unexpected connection(s) to a local Gradle port.`);
      if (result.code !== 0) {
        throw new AppError(500, 'gradle_failed', `The Gradle build failed with exit code ${result.code}. Review the build log.`);
      }

      advance('validating', { stage: 'validating' });
      log('Validating the generated APK.');
      const apkFile = path.join(projectDirectory, ...APK_RELATIVE_PATH);
      const validation = await validate(apkFile, {
        expectedPackage: buildConfig.packageId,
        expectedVersionCode: buildConfig.versionCode,
        androidHome: config.androidHome
      });
      log(`Checks: ${Object.entries(validation.checks).map(([name, value]) => `${name}=${value}`).join(', ')}.`);
      const artifactName = `${id}.apk`;
      const artifactFile = resolveInside(config.artifactDirectory, artifactName);
      await fs.mkdir(config.artifactDirectory, { recursive: true });
      await fs.copyFile(apkFile, artifactFile);
      const stored = await fs.readFile(artifactFile);
      const sha256 = createHash('sha256').update(stored).digest('hex');
      if (sha256 !== validation.sha256) {
        await fs.rm(artifactFile, { force: true });
        throw new AppError(500, 'artifact_corrupted', 'The stored artifact does not match the validated APK.');
      }
      const expiresAt = new Date(Date.now() + config.retentionHours * 3600 * 1000).toISOString();
      log('Build completed.');
      finish('completed', { stage: 'completed', artifact: { name: artifactName, size: stored.length, sha256 }, expiresAt });
    } catch (error) {
      const current = database.getBuild(id);
      if (!current || TERMINAL_STATES.has(current.state)) return;
      if (signal.aborted && signal.reason?.name === 'AbortError') {
        log('Build cancelled.');
        finish('cancelled', { stage: 'cancelled' });
      } else if (signal.aborted && signal.reason?.name === 'TimeoutError') {
        log('Build exceeded the time limit.');
        finish('failed', { stage: 'failed', errorSummary: 'The build exceeded the time limit.' });
      } else if (error instanceof AppError) {
        log(error.message);
        finish('failed', { stage: 'failed', errorSummary: error.message });
      } else {
        logger.error({ err: error, buildId: id }, 'unexpected build failure');
        log('The build failed unexpectedly.');
        finish('failed', { stage: 'failed', errorSummary: 'The build failed unexpectedly.' });
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  };
}
