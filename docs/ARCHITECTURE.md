# DocWorks Unified Architecture (`ScrubDoc` & `DiffDoc`)

## 1. Design Principles

1. **Zero-PII Server Boundary:** All document parsing, metadata extraction, OCR (`tesseract.js`), PDF redaction (`pdf-lib` / `pdfjs-dist`), comparison (`text_diff`, `visual_diff`, `spreadsheet_diff`), and ShareRadar folder traversal execute exclusively inside browser memory.
2. **One Shared Codebase, Separate Focused Services:** `apps/scrubdoc/main.py` and `apps/diffdoc/main.py` invoke `shared/backend/app_factory.py:create_docworks_app(...)`. Each app ships its own focused Docker image containing only the vendored JS/Wasm bundles it needs (e.g., `DiffDoc` excludes `exifr` and `tesseract.js` to stay lightweight).
3. **Provider Isolation via Adapters:** Adding a new cloud provider (`dropbox`, `gdrive`) requires implementing one Python `ProviderSpec` + OAuth exchange entry in `shared/backend/providers.py` and one JS client module in `shared/providers/<provider>/client.js` registered in `shared/providers/registry.js`. App UI and comparison/redaction engines remain untouched.
4. **Unified Cross-App Entitlements:** Both `ScrubDoc` and `DiffDoc` read and atomically update the same Firestore document per user & provider (`entitlements_{provider}/{hmac_user_hash}`):
   - `plan_bundle`: unlocks unlimited ScrubDoc, DiffDoc, and ShareRadar Pro
   - `plan_scrubdoc` / `plan_diffdoc`: individual app Pro plans (each also unlocks ShareRadar Pro across both apps)
   - `scrub_used`, `diffs_used`, `radar_fixes_used` with automatic monthly UTC period rollover preserving Pro plans

## 2. Static Asset & Template Inheritance

`create_docworks_app` mounts:
- `/static/vendor` -> `/app/vendor` (pinned build-time libraries fetched in Dockerfile)
- `/static/shared` -> `shared/frontend/` (`suite-shell.css`, `suite_shell.js`, `shareradar_engine.js`, `suite-template.html`)
- `/static/providers` -> `shared/providers/` (`registry.js`, `box/client.js`, `dropbox/client.js`, `gdrive/client.js`)
- `/static/app` -> `apps/<app_id>/static/` (`index.html`, app CSS & JS engines)

`shared/frontend/js/suite_shell.js` dynamically injects `#toast-banner`, `#screen-radar`, `#screen-picker`, and `footer.app-footer` so ShareRadar Pro, the 5-column Folder Browser, capability guards, and Zero-PII trust chrome stay identical across both apps.

## 3. Single-Project PROD GCP Topology (`docworks-514722`)

- **Cloud Run Services:** `scrubdoc-box`, `diffdoc-box` (future: `scrubdoc-dropbox`, `diffdoc-dropbox`, `scrubdoc-gdrive`, `diffdoc-gdrive`)
- **Runtime Identity:** `docworks-prod-runner@docworks-514722.iam.gserviceaccount.com`
  - Roles: `roles/datastore.user` + `roles/secretmanager.secretAccessor` only
- **Artifact Registry:** `us-central1-docker.pkg.dev/docworks-514722/docworks-apps/`
- **Secret Manager:** `HMAC_PEPPER_BOX`, `BOX_SCRUBDOC_CLIENT_ID`, `BOX_SCRUBDOC_CLIENT_SECRET`, `BOX_DIFFDOC_CLIENT_ID`, `BOX_DIFFDOC_CLIENT_SECRET`
- **Database:** Firestore Native Mode `(default)` in `us-central1`
