/**
 * Dropbox API v2 Storage Provider Adapter Scaffold (Multi-Provider Roadmap).
 * Endpoints:
 *   RPC API: https://api.dropboxapi.com/2/
 *   Content API: https://content.dropboxapi.com/2/
 */

export const SNAPSHOT_FILENAME = "_docworks_radar_snapshot.json";

export class DropboxProviderClient {
  constructor(accessToken, capabilities = {}) {
    this._token = accessToken;
    this.providerId = "dropbox";
    this.providerName = "Dropbox";
    this.snapshotFilename = SNAPSHOT_FILENAME;
    this.legacySnapshotFilename = null;
    this.capabilities = {
      supports_version_history: true,
      supports_collaborators: true,
      supports_link_expiry: true,
      supports_download_disable: true,
      supports_link_password: true,
      supports_public_link_stats: false,
      ...capabilities,
    };
  }

  _notImplemented(methodName) {
    throw new Error(
      `DropboxProviderClient.${methodName}() is scheduled for the multi-provider Dropbox milestone (see shared/providers/ARCHITECTURE.md).`
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
