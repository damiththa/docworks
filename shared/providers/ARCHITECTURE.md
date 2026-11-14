# DocWorks Multi-Provider Adapter Contract

Every cloud storage integration (**Box**, **Dropbox**, **Google Drive**) implements the same Zero-PII client/server split so **ScrubDoc**, **DiffDoc**, and **ShareRadar Pro** remain storage-agnostic:

## 1. Backend Adapter (`shared/backend/providers.py`)
Each provider registers a `ProviderSpec` containing:
- `authorize_url` & `token_url`: Provider OAuth 2.0 endpoints (configured for **online / short-lived tokens** — refresh tokens are never persisted).
- `exchange_fn(http_client, settings, auth_code, redirect_uri)`: Exchanges the OAuth code in RAM and returns strictly:
  - `access_token` (passed straight back to browser RAM)
  - `expires_in`
  - `provider_user_id` (opaque numeric/account ID only — hashed irreversibly via `HMAC_SHA256(HMAC_PEPPER, f"docworks:v1:{provider_id}_user:{provider_user_id}")` before touching Firestore).
- `connect_src` & `frame_ancestors`: Tight Content-Security-Policy whitelist restricting Cloud Run to that provider's APIs and embed domains only.
- `capabilities`: Boolean feature flags exported by `GET /api/public-config`.

## 2. Frontend Client Adapter (`shared/providers/<provider>/client.js`)
Exports a class conforming to the normalized `StorageProviderClient` interface:
- **Properties:** `providerId`, `providerName`, `capabilities`, `snapshotFilename` (`"_docworks_radar_snapshot.json"`), `legacySnapshotFilename`.
- **Identity & Navigation:**
  - `getCurrentUser()` -> `{ id, login, name }`
  - `getFileMetadata(fileId)` -> `{ id, name, size, sha1, extension, parent, file_version, version_number, modified_at, shared_link, permissions }`
  - `getFolderMetadata(folderId)` -> `{ id, name, parent, shared_link, permissions }`
  - `listFolderPage(folderId, offset, limit)` -> `{ entries, total_count }`
- **Content Stream (Browser RAM Only):**
  - `downloadFileBytes(fileId, versionId = null)` -> `Uint8Array`
  - `listFileVersions(fileId)` / `buildVersionTimeline(fileMeta, versionsResp)`
  - `uploadNewSafeCopy(parentFolderId, stemName, extWithDot, mimeType, uint8Bytes)`
  - `uploadNewFileVersion(fileId, originalFileName, mimeType, uint8Bytes)`
  - `uploadReportPdf(parentFolderId, baseStem, pdfUint8Bytes)`
  - `upsertUtilityFile(parentFolderId, fileName, mimeType, textContent, existingFileId)`
- **ShareRadar Remediation (Capability-Gated):**
  - `listItemCollaborations(itemType, itemId)`
  - `updateSharedLinkSettings(itemType, itemId, sharedLinkPayload)`
  - `removeCollaboration(collabId)`
  - `createSharedLinkForFile(fileId, access, canDownload)`
