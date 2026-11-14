/**
 * Google Drive API v3 Storage Provider Adapter Scaffold (Multi-Provider Roadmap).
 * Endpoints:
 *   Drive REST API: https://www.googleapis.com/drive/v3/
 *   Upload API: https://www.googleapis.com/upload/drive/v3/
 */

export const SNAPSHOT_FILENAME = "_docworks_radar_snapshot.json";

export class GoogleDriveProviderClient {
  constructor(accessToken, capabilities = {}) {
    this._token = accessToken;
    this.providerId = "gdrive";
    this.providerName = "Google Drive";
    this.snapshotFilename = SNAPSHOT_FILENAME;
    this.legacySnapshotFilename = null;
    this.capabilities = {
      supports_version_history: true,
      supports_collaborators: true,
      supports_link_expiry: false,
      supports_download_disable: true,
      supports_link_password: false,
      supports_public_link_stats: false,
      ...capabilities,
    };
  }

  _notImplemented(methodName) {
    throw new Error(
      `GoogleDriveProviderClient.${methodName}() is scheduled for the multi-provider Google Drive milestone (see shared/providers/ARCHITECTURE.md).`
    );
  }

  getCurrentUser() { return this._notImplemented("getCurrentUser"); }
  getFileMetadata() { return this._notImplemented("getFileMetadata"); }
  getFolderMetadata() { return this._notImplemented("getFolderMetadata"); }
  listFileVersions() { return this._notImplemented("listFileVersions"); }
  buildVersionTimeline() { return []; }
  downloadFileBytes() { return this._notImplemented("downloadFileBytes"); }
  uploadNewSafeCopy() { return this._notImplemented("uploadNewSafeCopy"); }
  uploadNewFileVersion() { return this._notImplemented("uploadNewFileVersion"); }
  uploadReportPdf() { return this._notImplemented("uploadReportPdf"); }
  upsertUtilityFile() { return this._notImplemented("upsertUtilityFile"); }
  createSharedLinkForFile() { return this._notImplemented("createSharedLinkForFile"); }
  listFolderPage() { return this._notImplemented("listFolderPage"); }
  listItemCollaborations() { return this._notImplemented("listItemCollaborations"); }
  updateSharedLinkSettings() { return this._notImplemented("updateSharedLinkSettings"); }
  removeCollaboration() { return this._notImplemented("removeCollaboration"); }
}
