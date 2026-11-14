#!/usr/bin/env bash
set -euo pipefail

# Idempotent GCP PROD bootstrap script for project `docworks-514722`.
# Creates APIs, Firestore Native DB, Artifact Registry repository,
# least-privilege runtime Service Account + IAM bindings, and per-provider
# Secret Manager containers (`box` by default; pass `--providers box,dropbox,gdrive`).

PROJECT_ID="${PROJECT_ID:-docworks-514722}"
REGION="${REGION:-us-central1}"
AR_REPO="${AR_REPO:-docworks-apps}"
PROVIDERS_CSV="${PROVIDERS_CSV:-box}"
RUNTIME_SA_NAME="docworks-prod-runner"

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

RUNTIME_SA_EMAIL="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "==> Enabling required GCP APIs on ${PROJECT_ID}..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
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
gcloud artifacts repositories create "${AR_REPO}" \
  --project="${PROJECT_ID}" \
  --repository-format=docker \
  --location="${REGION}" \
  --description="DocWorks Suite production container images (ScrubDoc & DiffDoc)" \
  --quiet || true

echo "==> Ensuring least-privilege Service Account ${RUNTIME_SA_EMAIL} exists..."
gcloud iam service-accounts create "${RUNTIME_SA_NAME}" \
  --project="${PROJECT_ID}" \
  --display-name="DocWorks PROD Cloud Run Runtime" \
  --description="Least-privilege SA for ScrubDoc & DiffDoc (Firestore + Secret Manager only)" \
  --quiet || true

echo "==> Binding least-privilege IAM roles..."
for role in roles/datastore.user roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
    --role="${role}" \
    --condition=None \
    --quiet >/dev/null
done

echo "==> Ensuring Secret Manager containers exist for providers: ${PROVIDERS_CSV}..."
IFS=',' read -ra PROVIDER_LIST <<< "${PROVIDERS_CSV}"
for raw_prov in "${PROVIDER_LIST[@]}"; do
  prov="$(echo "${raw_prov}" | tr '[:upper:]' '[:lower:]' | tr -d ' ')"
  if [[ -z "${prov}" ]]; then
    continue
  fi
  prov_upper="$(echo "${prov}" | tr '[:lower:]' '[:upper:]')"
  pepper_secret="HMAC_PEPPER_${prov_upper}"

  for secret_id in \
    "${pepper_secret}" \
    "${prov_upper}_SCRUBDOC_CLIENT_ID" \
    "${prov_upper}_SCRUBDOC_CLIENT_SECRET" \
    "${prov_upper}_DIFFDOC_CLIENT_ID" \
    "${prov_upper}_DIFFDOC_CLIENT_SECRET"; do
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

echo "==> Infrastructure bootstrap complete for ${PROJECT_ID}."
