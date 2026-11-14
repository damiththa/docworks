# DocWorks Suite (`ScrubDoc` & `DiffDoc`)

Unified **Zero-PII, 100% In-Browser** document security, comparison, and sharing governance suite built for cloud storage marketplaces (**Box.com** active at launch, architected for **Dropbox** and **Google Drive** expansion).

## Applications in This Suite

| App | Route Prefix / Service | Core Capabilities |
|---|---|---|
| **ScrubDoc** | `apps/scrubdoc` -> `scrubdoc-<provider>` | Privacy X-Ray & metadata scrubber (EXIF/GPS, PDF info, DOCX author/comments), PII/PHI auto-detection + local Wasm Tesseract OCR, permanent burn-in redaction (`_Clean` v1 copy or replace original), and **ShareRadar Pro** folder hygiene. |
| **DiffDoc** | `apps/diffdoc` -> `diffdoc-<provider>` | Version History (`v1..vN`) & sibling file redlines across PDF, DOCX, XLSX, CSV, TXT, MD, JSON, PNG, JPG, WEBP: word-level clause diffs, visual curtain & crimson pixel diffs, multi-sheet Excel formula/override audits, `Redline_Report.pdf` export, and **ShareRadar Pro**. |

## Zero-PII Security Architecture

- **100% Browser RAM Document Processing:** Files flow directly over HTTPS CORS between the user's browser and their cloud storage provider (`api.box.com`, `upload.box.com`, `dl.boxcloud.com`). Our backend never downloads, caches, or logs user files, filenames, redactions, diffs, or OAuth tokens.
- **Opaque HMAC Entitlements Only:** Cloud Run stores only a keyed SHA-256 hash (`docworks:v1:{provider}_user:{provider_user_id}` with Secret Manager `HMAC_PEPPER`) inside Firestore Native Mode (`entitlements_{provider}`).
- **Strict Dynamic CSP:** `shared/backend/csp.py` locks `connect-src` and `frame-ancestors` strictly to the active provider. All frontend vendor libraries (`pdf-lib`, `pdfjs-dist`, `jszip`, `exifr`, `tesseract.js`) are pinned inside the Docker image at build time — zero external CDNs at runtime.

## Repository Layout

```text
docworks/
├── shared/
│   ├── backend/          # FastAPI app factory, Firestore entitlements, OAuth exchange, CSP, parameterized legal HTML
│   ├── frontend/         # Canonical suite shell (suite-shell.css, suite_shell.js, shareradar_engine.js, /template)
│   └── providers/        # Storage provider adapters (box active; dropbox & gdrive scaffolds + registry.js)
├── apps/
│   ├── scrubdoc/         # ScrubDoc service entrypoint, Dockerfile, static workspace & marketplace copy
│   └── diffdoc/          # DiffDoc service entrypoint, Dockerfile, comparison workspace & marketplace copy
├── deploy/               # Cloud Build, keyless WIF setup, & guarded Cloud Run PROD scripts
├── docs/                 # Architecture specs, GitHub Actions CI/CD guide, roadmaps, and studies
└── samples/              # Reference test files
```

## Branching, CI/CD & Environment Workflow

- **GitHub Actions CI/CD (Keyless OIDC / WIF):** See [docs/GITHUB_ACTIONS.md](docs/GITHUB_ACTIONS.md) and workflows under `.github/workflows/` (`ci-verify.yml` for static verification, `deploy.yml` for gated DEV/PROD Cloud Run deployments provisioned via `deploy/setup_gcp_wif.sh`).
- **`dev` branch -> DEV GCP (`safeshare-box` / `#902354967061`):** Preserves existing DEV service names (`safeshare` and `boxdiff`) and URLs so DEV Box Developer Console credentials stay valid during iteration. Note: zero local code tests are run; verification happens via GitHub Actions, Cloud Run builds, and remote `/health` checks.
- **`main` branch -> PROD GCP (`docworks-514722` / `#746704433311`):** Single GCP project hosting both `scrubdoc-<provider>` and `diffdoc-<provider>` on Cloud Run (`us-central1`) sharing unified Firestore `entitlements_{provider}` documents and least-privilege runtime Service Account `docworks-prod-runner@docworks-514722.iam.gserviceaccount.com`.

## Health & Verification Endpoints

Both services expose `GET` and `HEAD`:
- `/health`, `/api/health`, `/healthz` -> `{ "status": "ok", "suite": "DocWorks", "service": "...", "provider": "...", "zero_pii": true }`
- `/api/public-config` -> active app/provider capability matrix and non-secret OAuth authorize URL template
- `/privacy`, `/terms` -> provider-aware parameterized legal disclosures
- `/template` -> standalone DocWorks Suite Shell preview
