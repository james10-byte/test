import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInside } from '../security/paths.js';

export async function removeExpiredBuilds({ database, artifactDirectory, now = new Date() }) {
  const expired = database.listExpired(now.toISOString());
  let removed = 0;
  for (const build of expired) {
    if (build.artifactName) {
      await fs.rm(resolveInside(artifactDirectory, build.artifactName), { force: true });
    }
    database.deleteBuild(build.id);
    removed += 1;
  }
  return removed;
}

export async function removeStaleWorkspaces(workspaceDirectory, { maxAgeMs, now = Date.now() }) {
  let entries;
  try {
    entries = await fs.readdir(workspaceDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = path.join(workspaceDirectory, entry.name);
    const stats = await fs.stat(target);
    if (now - stats.mtimeMs > maxAgeMs) {
      await fs.rm(target, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

export function startCleanupSchedule({ database, artifactDirectory, workspaceDirectory, intervalMs, workspaceMaxAgeMs, logger }) {
  const run = async () => {
    try {
      const builds = await removeExpiredBuilds({ database, artifactDirectory });
      const workspaces = await removeStaleWorkspaces(workspaceDirectory, { maxAgeMs: workspaceMaxAgeMs });
      if (builds > 0 || workspaces > 0) logger.info({ builds, workspaces }, 'cleanup completed');
    } catch (error) {
      logger.error({ err: error }, 'cleanup failed');
    }
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
