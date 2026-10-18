import { spawn } from 'node:child_process';
import { AppError } from '../errors.js';

const PASSTHROUGH_VARIABLES = ['PATH', 'JAVA_HOME', 'LANG'];

export function buildGradleEnvironment(config, parentEnvironment = process.env) {
  const environment = {};
  for (const name of PASSTHROUGH_VARIABLES) {
    if (parentEnvironment[name]) environment[name] = parentEnvironment[name];
  }
  environment.HOME = config.buildHomeDirectory;
  environment.GRADLE_USER_HOME = config.gradleUserHome;
  environment.GRADLE_OPTS = config.gradleJvmArgs;
  environment.ANDROID_USER_HOME = `${config.buildHomeDirectory}/.android`;
  if (config.androidHome) {
    environment.ANDROID_HOME = config.androidHome;
    environment.ANDROID_SDK_ROOT = config.androidHome;
  }
  return environment;
}

export function buildGradleCommandArguments(config, projectArguments) {
  return ['--no-daemon', '--console=plain', 'assembleDebug', ...projectArguments];
}

function createLineReader(onLine) {
  let remainder = '';
  return {
    push(chunk) {
      remainder += chunk.toString('utf8');
      const lines = remainder.split(/\r?\n/);
      remainder = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    },
    flush() {
      if (remainder !== '') onLine(remainder);
      remainder = '';
    }
  };
}

export function runGradle({ command, args, cwd, env, signal, onLine, killGraceMs = 5000 }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const child = spawn(command, args, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let killTimer = null;
    const terminate = () => {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        return;
      }
      killTimer = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          return;
        }
      }, killGraceMs);
    };
    signal.addEventListener('abort', terminate, { once: true });
    const stdout = createLineReader(onLine);
    const stderr = createLineReader(onLine);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', () => {
      signal.removeEventListener('abort', terminate);
      reject(new AppError(500, 'gradle_unavailable', 'The Gradle executable could not be started.'));
    });
    child.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', terminate);
      stdout.flush();
      stderr.flush();
      if (signal.aborted) reject(signal.reason);
      else resolve({ code });
    });
  });
}
