#!/usr/bin/env bash
set -euo pipefail

# Idempotent GCP PROD bootstrap script for project `docworks-514722`.
# Creates APIs, Firestore Native DB, Artifact Registry repository,
# least-privilege runtime Service Account + IAM bindings, and Secret Manager containers.

PROJECT_ID="${PROJECT_ID:-docworks-514722}"
REGION="${REGION:-us-central1}"
AR_REPO="${AR_REPO:-docworks-apps}"
RUNTIME_SA_NAME="docworks-prod-runner"
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

echo "==> Ensuring Secret Manager secret containers exist..."
for secret_id in \
  HMAC_PEPPER_BOX \
  BOX_SCRUBDOC_CLIENT_ID \
  BOX_SCRUBDOC_CLIENT_SECRET \
  BOX_DIFFDOC_CLIENT_ID \
  BOX_DIFFDOC_CLIENT_SECRET; do
  gcloud secrets create "${secret_id}" \
    --project="${PROJECT_ID}" \
    --replication-policy=automatic \
    --quiet || true
done

echo "==> Infrastructure bootstrap complete for ${PROJECT_ID}."
