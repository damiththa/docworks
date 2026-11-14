# GitHub Actions CI/CD & Keyless GCP Deployment

DocWorks uses **GitHub Actions** with **GCP Workload Identity Federation (OIDC)** — zero static JSON service account keys stored in GitHub Secrets.

## Workflows

| Workflow | File | Trigger | Purpose |
| --- | --- | --- | --- |
| **CI Static Checks** | `.github/workflows/ci-verify.yml` | `push` / `pull_request` on `main`, `dev` | Runs Python bytecode compile check (`python3 -m compileall`), shell syntax validation (`bash -n deploy/*.sh`), JSON config checks, legacy string guard, and required file assertions. |
| **Deploy DocWorks** | `.github/workflows/deploy.yml` | `workflow_dispatch` (manual) or `push` to `dev` / `main` | Resolves `.github/deploy-config.json` across active providers (`box`, and later `dropbox`, `gdrive`), preflight-verifies Secret Manager versions, builds `scrubdoc` / `diffdoc` images, pushes to Artifact Registry (`us-central1`), deploys Cloud Run services, and smoke-tests `/health`, `/api/health`, `/privacy`, `/terms`, `/template`. |

---

## Solo Developer PR-to-`main` & Multi-Provider Flow

- **No required reviewers / branch protection bottleneck:** Because this is a solo-owner repository, `dev` and `prod` GitHub Environments do **not** require manual reviewer approval. Once `prod.auto_deploy_on_push` is enabled in `.github/deploy-config.json`, merging a PR to `main` deploys directly to PROD (`docworks-514722`).
- **Centralized Multi-Provider Manifest (`.github/deploy-config.json`):**
  ```json
  {
    "dev": {
      "auto_deploy_on_push": false,
      "active_providers": ["box"]
    },
    "prod": {
      "auto_deploy_on_push": false,
      "active_providers": ["box"]
    }
  }
  ```
  - Right now both `auto_deploy_on_push` flags stay `false` so documentation/infra pushes never deploy unexpectedly before Box PROD credentials are populated or owner approval is given.
  - To expand to **Dropbox** or **Google Drive**, provision their GCP Secret Manager containers (`./deploy/setup_gcp_prod.sh --providers box,dropbox,gdrive`), populate their OAuth secrets, and add `"dropbox"` / `"gdrive"` to `active_providers` — `.github/workflows/deploy.yml` automatically fans out a 2D `app x provider` matrix cleanly inside the same single `docworks-514722` GCP project.
- **Optional GitHub Variable Overrides (`Settings -> Secrets and variables -> Actions -> Variables`):** `AUTO_DEPLOY_DEV`, `AUTO_DEPLOY_PROD`, `ACTIVE_DEV_PROVIDERS`, `ACTIVE_PROD_PROVIDERS`, `FREE_SCRUB_LIMIT`, `FREE_DIFF_LIMIT`, `FREE_RADAR_FIX_LIMIT`, `SUPPORT_EMAIL`.
- **Manual Deploys:** **Actions -> Deploy DocWorks -> Run workflow** lets you select `environment` (`dev` | `prod`), `apps` (`all` | `scrubdoc` | `diffdoc`), and `provider` (`all_active` | `box` | `dropbox` | `gdrive`) on demand.

---

## Keyless GCP WIF Configuration (Pre-Provisioned)

Provisioned via [`deploy/setup_gcp_wif.sh`](../deploy/setup_gcp_wif.sh), scoped strictly to `assertion.repository == 'damiththa/docworks'`.

### DEV (`safeshare-box` / Project `#902354967061`)

- **WIF Provider:** `projects/902354967061/locations/global/workloadIdentityPools/github-actions/providers/github`
- **Deployer SA:** `github-deployer@safeshare-box.iam.gserviceaccount.com`
- **Runtime SA:** `902354967061-compute@developer.gserviceaccount.com`
- **Artifact Registry:** `us-central1-docker.pkg.dev/safeshare-box/cloud-run-source-deploy`
- **Cloud Run Services (`box`):**
  - `scrubdoc` -> `safeshare` (preserves `https://safeshare-4m25thqnbq-uc.a.run.app` and DEV Box credentials `BOX_CLIENT_ID` / `BOX_CLIENT_SECRET`)
  - `diffdoc` -> `boxdiff` (preserves `https://boxdiff-4m25thqnbq-uc.a.run.app` and DEV Box credentials `BOXDIFF_CLIENT_ID` / `BOXDIFF_CLIENT_SECRET`)
- **Future DEV providers (`dropbox`, `gdrive`):** deploy as `<app>-<provider>` inside `safeshare-box`.

### PROD (`docworks-514722` / Project `#746704433311`)

- **WIF Provider:** `projects/746704433311/locations/global/workloadIdentityPools/github-actions/providers/github`
- **Deployer SA:** `github-deployer@docworks-514722.iam.gserviceaccount.com`
- **Runtime SA:** `docworks-prod-runner@docworks-514722.iam.gserviceaccount.com`
- **Artifact Registry:** `us-central1-docker.pkg.dev/docworks-514722/docworks-apps`
- **Cloud Run Services:** `<app>-<provider>` (`scrubdoc-box`, `diffdoc-box`, and later `scrubdoc-dropbox`, `diffdoc-dropbox`, `scrubdoc-gdrive`, `diffdoc-gdrive`)
- **Firestore Collections:** `entitlements_<provider>` inside the single `(default)` Native Firestore database (isolates users by provider while sharing `ScrubDoc + DiffDoc` bundle entitlements per provider).
- **Secret Manager Bindings:** `<PROVIDER>_<APP>_CLIENT_ID`, `<PROVIDER>_<APP>_CLIENT_SECRET`, `HMAC_PEPPER_<PROVIDER>`

### Least-Privilege IAM on `github-deployer`

Each `github-deployer@<project>.iam.gserviceaccount.com` holds only:
- `roles/artifactregistry.writer` (push Docker images)
- `roles/run.admin` (deploy Cloud Run services & inspect URLs)
- `roles/secretmanager.viewer` (preflight check that secret versions are `ENABLED`; cannot read secret plaintext)
- `roles/iam.serviceAccountUser` (scoped **only** to the target runtime SA)
- `roles/iam.workloadIdentityUser` (bound to GitHub repo `damiththa/docworks`)

---

## Secret Manager Readiness Before First Box PROD Deploy

Before deploying `prod` (`box`), ensure enabled versions exist in `docworks-514722` for:
- `BOX_SCRUBDOC_CLIENT_ID`
- `BOX_SCRUBDOC_CLIENT_SECRET`
- `BOX_DIFFDOC_CLIENT_ID`
- `BOX_DIFFDOC_CLIENT_SECRET`
- `HMAC_PEPPER_BOX` (already populated)

The workflow fails fast during preflight if any required secret has zero `ENABLED` versions.
