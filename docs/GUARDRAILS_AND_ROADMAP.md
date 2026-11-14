# DocWorks Guardrails & Multi-Provider Roadmap

## 1. Non-Negotiable Engineering Guardrails

- **Zero-PII Enforcement:** Never accept uploaded user document bytes, filenames, OAuth access/refresh tokens, emails, or Box/Dropbox/Drive IDs inside backend request logs or Firestore documents.
- **Static Browser-Only Dependencies:** Never load runtime `<script>` or CSS assets from third-party CDNs; always vendor pinned versions into `/app/vendor` inside Dockerfiles and enforce strict CSP headers via `shared/backend/csp.py`.
- **Single-Action Suite Navigation:** Keep `#main-tabs` unified with three concise views (`<Primary Tool> | ShareRadar Pro | Other Files in Folder`), never duplicating redundant file-switch buttons.
- **No Unapproved PROD Deployments & No Local Testing:** Validate builds strictly through Cloud Build + Cloud Run and remote `/health` checks upon explicit owner approval.

## 2. Multi-Provider Expansion Checklist (`Dropbox` & `Google Drive`)

Both `shared/backend/providers.py` and `shared/providers/{dropbox,gdrive}/client.js` already establish the interface contract and capability flags:

- **Dropbox (`STORAGE_PROVIDER=dropbox`):**
  1. Register PKCE/OAuth Redirect URI `<ORIGIN>/callback` and allowed CORS origin in Dropbox App Console.
  2. Implement `dropbox_oauth_exchange` and account ID lookup (`/2/users/get_current_account`) in `shared/backend/providers.py` (`implemented=True`).
  3. Implement `DropboxProviderClient` methods (`downloadFileBytes`, `listFolderPage`, `listFileVersions` via `/2/files/list_revisions`, `uploadNewFile`, `updateSharedLinkSettings`, `removeCollaboration`) respecting capability flags (`supports_version_history=True`, `supports_link_expiry=True`).
  4. Provision secrets with `./deploy/setup_gcp_prod.sh --providers box,dropbox` (creates `HMAC_PEPPER_DROPBOX`, `DROPBOX_SCRUBDOC_CLIENT_*`, `DROPBOX_DIFFDOC_CLIENT_*`), populate the Dropbox OAuth credentials, and add `"dropbox"` to `.github/deploy-config.json` (`active_providers`) so CI/CD automatically deploys `scrubdoc-dropbox` / `diffdoc-dropbox` in `docworks-514722` using isolated Firestore collection `entitlements_dropbox`.

- **Google Drive (`STORAGE_PROVIDER=gdrive`):**
  1. Register OAuth Redirect URI `<ORIGIN>/callback` and restricted Drive scopes in Google Cloud Console (start with `drive.file` + `openid` to keep OAuth review streamlined).
  2. Implement `gdrive_oauth_exchange` and Drive `about.get` user ID lookup in `shared/backend/providers.py` (`implemented=True`) or reuse OpenID `sub`.
  3. Implement `GoogleDriveProviderClient` methods respecting Drive capability constraints (`supports_link_expiry=False`, `supports_link_password=False`, permission-level `anyone` with `allowFileDiscovery: false`). Note that `suite_shell.js` automatically hides unsupported ShareRadar bulk actions via `capabilities`.
  4. Provision secrets with `./deploy/setup_gcp_prod.sh --providers box,dropbox,gdrive`, populate `GDRIVE_SCRUBDOC_CLIENT_*` / `GDRIVE_DIFFDOC_CLIENT_*`, and add `"gdrive"` to `.github/deploy-config.json` (`active_providers`).

## 3. Commercial / Pro Plan Cutover Notes

- Firestore schema `entitlements_{provider}/{user_hash}` is already bundle-ready (`plan_bundle`, `plan_scrubdoc`, `plan_diffdoc`).
- When payment checkout is introduced (e.g., Stripe or LemonSqueezy), pass `user_hash` as opaque client metadata — never user emails — and update the corresponding plan field in Firestore from the verified webhook handler.
