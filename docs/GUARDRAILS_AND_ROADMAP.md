# DocWorks Guardrails, Consolidated Roadmap & Multi-Provider Plan

> **Single Source of Truth:** Consolidates all mandatory security guardrails, commercial notes, and `v1.1+` product enhancements across both **ScrubDoc** and **DiffDoc** inside `damiththa/docworks` and GCP project `docworks-514722`.

---

## 1. Non-Negotiable Operational & Security Guardrails

- **Always Check With Owner Before Every Deployment:** Confirm explicitly with the repository owner before triggering any live Cloud Run deployment (`workflow_dispatch`, flipping `auto_deploy_on_push: true`, merging a deploy PR to `main`, or running `deploy/deploy_app.sh --confirm`).
- **Zero Local Code Testing / Zero Local Secret Storage:** Never run local Python servers, virtual environments, npm/Node installs, or local Docker tests. Container builds execute remotely in GitHub Actions / GCP Cloud Build and verify via remote `/health` checks. Zero secrets are stored locally or committed to Git.
- **Zero-PII Cloud Boundary:**
  - Zero uploaded user file bytes, filenames, folder paths, Shared Link URLs, emails, display names, or OAuth refresh/access tokens ever touch GCP logs or Firestore (`uvicorn --no-access-log`).
  - `/api/oauth/exchange` fetches **strictly** numeric/opaque provider user IDs (never name or email), computes `HMAC_SHA256(HMAC_PEPPER, "docworks:v1:{provider}_user:{id}")`, discards `refresh_token`, and returns the volatile `access_token` solely to browser RAM.
  - Firestore stores strictly anonymous usage counters and plan booleans (`plan_bundle`, `plan_scrubdoc`, `plan_diffdoc`, `radar_plan`, `scrub_used`, `diffs_used`, `radar_fixes_used`, `period`) inside `entitlements_{provider}` (PROD) or `entitlements_{provider}_dev` (DEV).
- **Zero Third-Party Runtime CDNs & Permissive Licensing Only:**
  - `pdf-lib@1.17.1` (`MIT`), `pdfjs-dist@3.11.174` (`Apache-2.0`), `exifr@7.1.3` (`MIT`), `jszip@3.10.1` (`MIT`), and lazy-loaded `tesseract.js@5.1.1` (`Apache-2.0`) are vendored at image build time (`/app/vendor` -> `/static/vendor/`).
  - Parses `.xlsx` OpenXML worksheets (`<f>` formulas + `<v>` values) directly via `JSZip` + browser `DOMParser`, avoiding `xlsx` (`CVE-2023-30533`) and strictly avoiding `AGPL-3.0` dependencies (such as `MuPDF` / `PyMuPDF`).
  - `shared/backend/csp.py` locks `script-src 'self' 'wasm-unsafe-eval'`, `connect-src`, and `frame-ancestors` strictly to the active provider.
- **Anti-Version-History Leak (`_Clean` as `v1` Default):**
  - Sanitized/redacted deliverables default to uploading a **brand-new `v1` file (`_Clean`)** into the parent folder so collaborators with Editor rights cannot revert or download unredacted `v1` bytes from provider version history (with optional explicit overwrite confirmation when requested).
- **Single-Action Suite Navigation:**
  - Keep `#main-tabs` unified across both apps with three views: `<Primary Tool> | ShareRadar Pro | Other Files in Folder`, never duplicating redundant file-switch buttons.
- **Support Contact Policy:**
  - `SUPPORT_EMAIL` defaults to `""` so `/privacy` and `/terms` expose zero email addresses publicly by default; `box.developer@mdms.anonaddy.me` is reserved solely if required on marketplace submission forms or when `SUPPORT_EMAIL` is intentionally enabled at deploy time.

---

## 2. `v1.1+` Consolidated Enhancement Backlog

### ScrubDoc Enhancements (`apps/scrubdoc`)
- [ ] **Native `.boxnote` Scrubbing & Clean PDF Export:** Parse `.boxnote` ProseMirror JSON in browser RAM, expose embedded collaborator/revision metadata in Privacy X-Ray, run Auto-PII redaction, and render a clean `_Clean.pdf` via `pdf-lib` back to storage.
- [ ] **Visual Canvas Redaction for Native & Uploaded Office Files (`.docx`, `.pptx`, `.xlsx`):** Leverage Box `[pdf]` Representations API (`X-Rep-Hints: [pdf]`) in-browser so Word/Excel/PowerPoint files support full pixel/text coordinate blackouts exported as byte-flattened 250-DPI `_Clean.pdf`.
- [ ] **Tier 3 Opt-In In-Browser AI NER (`ONNX NER`):** Optional quantized browser model to detect unlabeled person, organization, and clinic names in free-form paragraphs beyond regex patterns.
- [ ] **Batch Folder Scrub & Redact:** Clean hidden metadata and apply Auto-PII redaction across multiple files in a folder in one pass.
- [ ] **Popup vs. Separate Tab Tuning & OCR UX Monitoring:** Monitor lazy-loaded Wasm OCR (`ocr_engine.js`) speed on multi-page scans and tune popup/new-tab integration launch settings during Box review.

### DiffDoc Enhancements (`apps/diffdoc`)
- [ ] **Opt-In Vertex AI Gemini Flash "Executive Change Brief" (Pro):** Keeping `v1` 100% browser-only, optionally allow user-initiated `/api/ai/executive-brief` sending strictly the compact diff hunk delta (never raw files) to GCP Vertex AI (`gemini-2.5-flash`) under zero-data-retention terms.
- [ ] **Native Office & Presentation Visual Diffs (`.pptx`, `.docx`, `.xlsx`, `.boxnote`):** Use `[pdf]` Representations API so slide decks and rich Office layouts render directly inside `VisualComparator` (`Curtain Slider` + `Crimson Pixel Delta`), plus `.boxnote` JSON redlining.
- [ ] **In-Browser Wasm OCR for Scanned Contract Redlines (`Tesseract.js`):** Add opt-in OCR when comparing scanned PDFs without text layers so word-level text redlines & `$ / % / Date` callouts work on scans too.
- [ ] **Side-by-Side Folder Tree & Checksum Diff:** Folder Web Integration comparing two directories recursively by relative path and provider content hash (`sha1`) without downloading unchanged files.

### Commercialization, Billing & Marketplace Launch (`v1.1+`)
- [ ] **Box App Center Publishing Assets (`ScrubDoc` & `DiffDoc`):** Upload the pre-verified square `512x512` RGB PNG icons [`apps/scrubdoc/marketplace/icon_square_512.png`](../apps/scrubdoc/marketplace/icon_square_512.png) and [`apps/diffdoc/marketplace/icon_square_512.png`](../apps/diffdoc/marketplace/icon_square_512.png) (`rx=0` square corners — Box rounds automatically, `>= 50px` edge padding, zero text; never upload rounded-corner `icon_512.png`) + 3 live Box UI screenshots per app, toggle `Development` -> `Online`, and submit both PROD apps (`scrubdoc-box`, `diffdoc-box`). *(Note: unpublished DEV apps may display Box's generic extension icon in Box context menus until submitted/published on PROD.)*
- [ ] **Zero-PII Pro Tier & Bundle Billing Integration:** Connect Stripe / LemonSqueezy checkout + webhook keyed strictly by anonymous `client_reference_id = user_hash` (never email) updating `plan_bundle`, `plan_scrubdoc`, `plan_diffdoc`, and `radar_plan` inside `entitlements_{provider}/{user_hash}`. Beta free quotas are currently `25` scrubs / `5` diffs / `25` ShareRadar fixes per UTC month (`FREE_SCRUB_LIMIT`, `FREE_DIFF_LIMIT`, `FREE_RADAR_FIX_LIMIT`).

---

## 3. Multi-Provider Expansion Checklist (`Dropbox` & `Google Drive`)

Both `shared/backend/providers.py` and `shared/providers/{dropbox,gdrive}/client.js` establish the adapter contract and capability flags inside the single `docworks-514722` project:

- **Dropbox (`STORAGE_PROVIDER=dropbox`):**
  1. Register DEV and PROD apps + PKCE/OAuth Redirect URI `<ORIGIN>/callback` and allowed CORS origins in Dropbox App Console.
  2. Implement `dropbox_oauth_exchange` and account ID lookup (`/2/users/get_current_account`) in `shared/backend/providers.py` (`implemented=True`).
  3. Implement `DropboxProviderClient` methods (`downloadFileBytes`, `listFolderPage`, `listFileVersions` via `/2/files/list_revisions`, `uploadNewFile`, `updateSharedLinkSettings`, `removeCollaboration`) respecting capability flags (`supports_version_history=True`, `supports_link_expiry=True`).
  4. Run `./deploy/setup_gcp_prod.sh --providers box,dropbox` (provisions both DEV `*_DEV` and PROD secrets in `docworks-514722`), populate credentials, and add `"dropbox"` to `.github/deploy-config.json` (`active_providers`).
- **Google Drive (`STORAGE_PROVIDER=gdrive`):**
  1. Register DEV and PROD OAuth Redirect URIs (`<ORIGIN>/callback`) with restricted `drive.file` + `openid` scopes in Google Cloud Console.
  2. Implement `gdrive_oauth_exchange` and OpenID `sub` lookup in `shared/backend/providers.py` (`implemented=True`).
  3. Implement `GoogleDriveProviderClient` methods respecting Drive capability constraints (`supports_link_expiry=False`, `supports_link_password=False`, permission-level `anyone` with `allowFileDiscovery: false`). `suite_shell.js` automatically hides unsupported ShareRadar actions via `capabilities`.
  4. Run `./deploy/setup_gcp_prod.sh --providers box,dropbox,gdrive`, populate `GDRIVE_*` DEV + PROD secrets, and add `"gdrive"` to `.github/deploy-config.json` (`active_providers`).

---

## 4. Current Environment State & PROD Handoff (2026-11-15)

- **Single Canonical Workspace & Repo:** `/Users/madushan/GitStuff/docworks` ↔ `https://github.com/damiththa/docworks` (`main` & `dev` synced). All legacy `safeshare` / `boxdiff` resources (GCP project `safeshare-box` `#902354967061`, GitHub repo `damiththa/safeShare`, `/Users/madushan/GitStuff/safeshare-box`, and old SafeShare/BoxDiff Box apps) were retired cleanly. Zero local `.env` files exist.
- **LIVE DEV (`docworks-514722` / `us-central1`):**
  - `scrubdoc-box-dev`: `https://scrubdoc-box-dev-kg2pp53kda-uc.a.run.app` (`BOX_SCRUBDOC_*_DEV`, `HMAC_PEPPER_BOX_DEV`, Firestore `entitlements_box_dev`) paired with Box Custom App **ScrubDoc (DEV)**.
  - `diffdoc-box-dev`: `https://diffdoc-box-dev-kg2pp53kda-uc.a.run.app` (`BOX_DIFFDOC_*_DEV`, `HMAC_PEPPER_BOX_DEV`, Firestore `entitlements_box_dev`) paired with Box Custom App **DiffDoc (DEV)**.
- **PROD Hold & Box Secret Warning (`prod.auto_deploy_on_push: false`):**
  - Temporary Box PROD apps were deleted during DEV testing so only DEV apps appear in Box right now.
  - Because of that, the 4 PROD Secret Manager containers in `docworks-514722` (`BOX_SCRUBDOC_CLIENT_ID`, `BOX_SCRUBDOC_CLIENT_SECRET`, `BOX_DIFFDOC_CLIENT_ID`, `BOX_DIFFDOC_CLIENT_SECRET`) currently hold **stale credentials from deleted Box apps** (`HMAC_PEPPER_BOX` `v1` stays valid).
  - **Before deploying PROD (after DEV Box testing passes and owner approves):**
    1. Recreate **ScrubDoc (PROD)** & **DiffDoc (PROD)** in Box Developer Console (upload `icon_square_512.png`).
    2. Add new versions (`gcloud secrets versions add ...`) for those 4 PROD Secret Manager secrets in `docworks-514722`.
    3. Flip `prod.auto_deploy_on_push: true` in `.github/deploy-config.json` (or run `workflow_dispatch` on `main`) to deploy `scrubdoc-box` and `diffdoc-box` (default `.run.app` URLs, `SUPPORT_EMAIL=""`, `25`/`5`/`25` quotas).
    4. Configure each new PROD Box app with the live `.run.app` URLs per [`apps/scrubdoc/marketplace/listing_copy.md`](../apps/scrubdoc/marketplace/listing_copy.md) and [`apps/diffdoc/marketplace/listing_copy.md`](../apps/diffdoc/marketplace/listing_copy.md).
