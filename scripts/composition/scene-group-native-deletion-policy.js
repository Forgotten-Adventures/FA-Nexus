export function shouldIgnoreSceneGroupNativeDeletion(options = {}) {
  return options?.faNexusSceneGroupDelete === true
    || options?.faNexusSceneGroupRollback === true
    || options?.faNexusPreviewDocument === true
    || options?.faNexusPathEditorWallWrite === true
    || options?.faNexusBuildingEditorDocumentWrite === true
    || options?.faNexusBuildingCurrentEdit === true
    || options?.faNexusBuildingCommitMutex === true;
}
