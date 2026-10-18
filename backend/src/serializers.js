export function toPublicBuild(build, queuePosition = null) {
  return {
    id: build.id,
    appName: build.appName,
    inputType: build.inputType,
    state: build.state,
    stage: build.stage,
    errorSummary: build.errorSummary,
    signingMode: build.signingMode,
    config: build.config,
    artifact:
      build.state === 'completed' && build.artifactName
        ? { size: build.artifactSize, sha256: build.artifactSha256 }
        : null,
    queuePosition,
    createdAt: build.createdAt,
    updatedAt: build.updatedAt,
    expiresAt: build.expiresAt
  };
}
