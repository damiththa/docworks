#!/usr/bin/env bash
set -euo pipefail

# Idempotent single-project GCP bootstrap for DocWorks (`docworks-514722`).
# Hosts BOTH DEV and PROD cleanly isolated inside one GCP project:
#   - Shared APIs, Firestore Native DB `(default)`, and Artifact Registry `docworks-apps`
#   - Distinct least-privilege runtime SAs (`docworks-prod-runner` and `docworks-dev-runner`)
#   - Distinct Secret Manager containers per provider & environment (`*` and `*_DEV`)
#
# Usage:
#   ./deploy/setup_gcp_prod.sh --providers box
#   ./deploy/setup_gcp_prod.sh --providers box,dropbox,gdrive

PROJECT_ID="${PROJECT_ID:-docworks-514722}"
REGION="${REGION:-us-central1}"
AR_REPO="${AR_REPO:-docworks-apps}"
PROVIDERS_CSV="${PROVIDERS_CSV:-box}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      PROJECT_ID="${2:-}"
      shift 2
      ;;
    --region)
      REGION="${2:-}"
      shift 2
      ;;
    --providers)
      PROVIDERS_CSV="${2:-box}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--project docworks-514722] [--region us-central1] [--providers box,dropbox,gdrive]" >&2
      exit 1
      ;;
  esac
done

retry_cmd() {
  local attempt=1
  local max_attempts=6
  while ! "$@"; do
    if (( attempt >= max_attempts )); then
      echo "Command failed after ${max_attempts} attempts: $*" >&2
      return 1
    fi
    echo "Waiting 5s for GCP IAM propagation (attempt ${attempt}/${max_attempts})..."
    sleep 5
    attempt=$((attempt + 1))
  done
}

echo "==> Enabling required GCP APIs on ${PROJECT_ID}..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  cloudresourcemanager.googleapis.com \
  --project="${PROJECT_ID}" \
  --quiet

echo "==> Ensuring Firestore Native database exists in ${REGION}..."
gcloud firestore databases create \
  --project="${PROJECT_ID}" \
  --location="${REGION}" \
  --type=firestore-native \
  --quiet || true

echo "==> Ensuring Artifact Registry Docker repository ${AR_REPO} exists..."
if ! gcloud artifacts repositories describe "${AR_REPO}" --project="${PROJECT_ID}" --location="${REGION}" >/dev/null 2>&1; then
  gcloud artifacts repositories create "${AR_REPO}" \
    --project="${PROJECT_ID}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="DocWorks Suite container images (ScrubDoc & DiffDoc DEV/PROD)" \
    --quiet
fi

for sa_pair in \
  "docworks-prod-runner|DocWorks PROD Cloud Run Runtime|Least-privilege PROD SA (Firestore + Secret Manager only)" \
  "docworks-dev-runner|DocWorks DEV Cloud Run Runtime|Least-privilege DEV SA (Firestore + Secret Manager only)"; do
  IFS='|' read -r sa_name sa_display sa_desc <<< "${sa_pair}"
  sa_email="${sa_name}@${PROJECT_ID}.iam.gserviceaccount.com"

  echo "==> Ensuring runtime Service Account ${sa_email} exists..."
  if ! gcloud iam service-accounts describe "${sa_email}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud iam service-accounts create "${sa_name}" \
      --project="${PROJECT_ID}" \
      --display-name="${sa_display}" \
      --description="${sa_desc}" \
      --quiet
    sleep 8
  fi

  for role in roles/datastore.user roles/secretmanager.secretAccessor; do
    retry_cmd gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
      --member="serviceAccount:${sa_email}" \
      --role="${role}" \
      --condition=None \
      --quiet >/dev/null
  done
done

echo "==> Ensuring PROD & DEV Secret Manager containers exist for providers: ${PROVIDERS_CSV}..."
IFS=',' read -ra PROVIDER_LIST <<< "${PROVIDERS_CSV}"
for raw_prov in "${PROVIDER_LIST[@]}"; do
  prov="$(echo "${raw_prov}" | tr '[:upper:]' '[:lower:]' | tr -d ' ')"
  if [[ -z "${prov}" ]]; then
    continue
  fi
  prov_upper="$(echo "${prov}" | tr '[:lower:]' '[:upper:]')"

  for env_suffix in "" "_DEV"; do
    pepper_secret="HMAC_PEPPER_${prov_upper}${env_suffix}"
    for secret_id in \
      "${pepper_secret}" \
      "${prov_upper}_SCRUBDOC_CLIENT_ID${env_suffix}" \
      "${prov_upper}_SCRUBDOC_CLIENT_SECRET${env_suffix}" \
      "${prov_upper}_DIFFDOC_CLIENT_ID${env_suffix}" \
      "${prov_upper}_DIFFDOC_CLIENT_SECRET${env_suffix}"; do
      if ! gcloud secrets describe "${secret_id}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
        gcloud secrets create "${secret_id}" \
          --project="${PROJECT_ID}" \
          --replication-policy=automatic \
          --quiet
      fi
    done

    ver_count="$(gcloud secrets versions list "${pepper_secret}" \
      --project="${PROJECT_ID}" \
      --filter="state=ENABLED" \
      --format="value(name)" | awk 'NF {c++} END {print c+0}')"
    if [[ "${ver_count}" -eq 0 ]]; then
      echo "Generating initial 32-byte random pepper version for ${pepper_secret}..."
      openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add "${pepper_secret}" \
        --project="${PROJECT_ID}" \
        --data-file=- \
        --quiet >/dev/null
    fi
  done
done

echo "==> Infrastructure bootstrap complete for ${PROJECT_ID} (DEV + PROD)."
