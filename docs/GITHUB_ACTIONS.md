# GitHub Actions CI/CD & Keyless GCP Deployment

DocWorks uses **GitHub Actions** with **GCP Workload Identity Federation (OIDC)** inside the single GCP project **`docworks-514722` (`#746704433311`)** — zero static JSON keys stored in GitHub Secrets and zero dependency on any legacy project or repo.

## Workflows

| Workflow | File | Trigger | Purpose |
| --- | --- | --- | --- |
| **CI Static Checks** | `.github/workflows/ci-verify.yml` | `push` / `pull_request` on `main`, `dev` | Runs Python bytecode compile check (`python3 -m compileall`), `render_archify.py` syntax & JSON checks, shell syntax validation (`bash -n deploy/*.sh`), legacy string guard, and required file/icon assertions. |
| **Render & Verify Archify** | `.github/workflows/archify.yml` | `workflow_dispatch` or `push` on docs/scripts | Verifies repository line citations across `docs/architecture/*.architecture.json`, compiles interactive HTML viewers & inline SVGs via `tt-a1i/archify`, and commits updates with `[skip ci]`. |
| **Deploy DocWorks** | `.github/workflows/deploy.yml` | `workflow_dispatch` (manual) or `push` to `dev` / `main` | Resolves `.github/deploy-config.json` across active providers (`box`, and later `dropbox`, `gdrive`), preflight-verifies Secret Manager versions, builds `scrubdoc` / `diffdoc` images, pushes to Artifact Registry (`us-central1`), deploys Cloud Run services into `docworks-514722`, and smoke-tests `/health`, `/api/health`, `/privacy`, `/terms`, `/template`, and app icons. |

---

## Solo Developer PR-to-`main` & Multi-Provider Flow

- **No required reviewers / branch protection bottleneck:** Because this is a solo-owner repository, `dev` and `prod` GitHub Environments do **not** require manual reviewer approval. Once `prod.auto_deploy_on_push` is enabled in `.github/deploy-config.json`, merging a PR to `main` deploys directly to PROD (`docworks-514722`) — always confirm explicitly with the owner before any deploy.
- **Centralized Multi-Provider Manifest (`.github/deploy-config.json`):**
  ```json
  {
    "dev": {
      "auto_deploy_on_push": true,
      "active_providers": ["box"]
    },
    "prod": {
      "auto_deploy_on_push": false,
      "active_providers": ["box"]
    }
  }
  ```
  - **DEV (`dev` branch)** auto-deploys `scrubdoc-box-dev` (`https://scrubdoc-box-dev-kg2pp53kda-uc.a.run.app`) and `diffdoc-box-dev` (`https://diffdoc-box-dev-kg2pp53kda-uc.a.run.app`) on app/shared code pushes.
  - **PROD (`main` branch)** stays paused (`auto_deploy_on_push: false`) until DEV Box verification completes and the owner approves PROD launch.
  - To expand to **Dropbox** or **Google Drive**, provision DEV + PROD Secret Manager containers via `./deploy/setup_gcp_prod.sh --providers box,dropbox,gdrive`, populate the DEV & PROD OAuth secrets, and add `"dropbox"` / `"gdrive"` to `active_providers`.
- **Optional GitHub Variable Overrides (`Settings -> Secrets and variables -> Actions -> Variables`):** `AUTO_DEPLOY_DEV`, `AUTO_DEPLOY_PROD`, `ACTIVE_DEV_PROVIDERS`, `ACTIVE_PROD_PROVIDERS`, `FREE_SCRUB_LIMIT`, `FREE_DIFF_LIMIT`, `FREE_RADAR_FIX_LIMIT`, `SUPPORT_EMAIL`.
- **Manual Deploys:** **Actions -> Deploy DocWorks -> Run workflow** lets you select `environment` (`dev` | `prod`), `apps` (`all` | `scrubdoc` | `diffdoc`), and `provider` (`all_active` | `box` | `dropbox` | `gdrive`) on demand.

---

## Single-Project GCP + Keyless WIF Topology (`docworks-514722`)

Provisioned via [`deploy/setup_gcp_prod.sh`](../deploy/setup_gcp_prod.sh) and [`deploy/setup_gcp_wif.sh`](../deploy/setup_gcp_wif.sh), scoped strictly to `assertion.repository == 'damiththa/docworks'`:

- **WIF Provider:** `projects/746704433311/locations/global/workloadIdentityPools/github-actions/providers/github`
- **Deployer SA:** `github-deployer@docworks-514722.iam.gserviceaccount.com`
- **Artifact Registry:** `us-central1-docker.pkg.dev/docworks-514722/docworks-apps`

### Environment Isolation Within `docworks-514722`

| Dimension | DEV (`dev` branch) | PROD (`main` branch) |
| --- | --- | --- |
| **Runtime SA** | `docworks-dev-runner@docworks-514722.iam.gserviceaccount.com` | `docworks-prod-runner@docworks-514722.iam.gserviceaccount.com` |
| **Cloud Run Services (`box`)** | `scrubdoc-box-dev`, `diffdoc-box-dev` | `scrubdoc-box`, `diffdoc-box` |
| **Cloud Run Services (future providers)** | `<app>-<provider>-dev` | `<app>-<provider>` |
| **Firestore Collection** | `entitlements_<provider>_dev` | `entitlements_<provider>` |
| **Secret Manager Bindings** | `HMAC_PEPPER_<PROV>_DEV`, `<PROV>_<APP>_CLIENT_ID_DEV`, `<PROV>_<APP>_CLIENT_SECRET_DEV` | `HMAC_PEPPER_<PROV>`, `<PROV>_<APP>_CLIENT_ID`, `<PROV>_<APP>_CLIENT_SECRET` |

### Least-Privilege IAM on `github-deployer@docworks-514722.iam.gserviceaccount.com`

- `roles/artifactregistry.writer` (push Docker images)
- `roles/run.admin` (deploy Cloud Run services & inspect URLs)
- `roles/secretmanager.viewer` (preflight check that secret versions are `ENABLED`; cannot read secret plaintext)
- `roles/iam.serviceAccountUser` (scoped **strictly** on `docworks-prod-runner` and `docworks-dev-runner`)
- `roles/iam.workloadIdentityUser` (bound to GitHub repo `damiththa/docworks`)

---

## Box Developer Console Apps Needed (2 DEV + 2 PROD)

Because DEV and PROD have separate Cloud Run URLs and Secret Manager credentials inside `docworks-514722`:
1. **Box DEV Apps (Active for `scrubdoc-box-dev` & `diffdoc-box-dev`):**
   - `BOX_SCRUBDOC_CLIENT_ID_DEV` & `BOX_SCRUBDOC_CLIENT_SECRET_DEV` (`v1` live)
   - `BOX_DIFFDOC_CLIENT_ID_DEV` & `BOX_DIFFDOC_CLIENT_SECRET_DEV` (`v1` live)
   - `HMAC_PEPPER_BOX_DEV` (`v1` live random 32-byte hex version via `setup_gcp_prod.sh`)
2. **Box PROD Apps (Pending Recreation for `scrubdoc-box` & `diffdoc-box` Marketplace launch):**
   - `BOX_SCRUBDOC_CLIENT_ID` & `BOX_SCRUBDOC_CLIENT_SECRET` *(secret containers exist, **must add new versions** with fresh Client ID/Secret once the deleted Box PROD apps are recreated!)*
   - `BOX_DIFFDOC_CLIENT_ID` & `BOX_DIFFDOC_CLIENT_SECRET` *(secret containers exist, **must add new versions** once Box PROD apps are recreated!)*
   - `HMAC_PEPPER_BOX` (`v1` live — keep as-is)

GitHub Actions preflight fails fast before building Docker images if any required secret has zero `ENABLED` versions. Remember to refresh the 4 Box PROD OAuth secrets above before enabling `prod.auto_deploy_on_push: true`, since those `v1` values came from temporary PROD Box apps later deleted during DEV testing.
