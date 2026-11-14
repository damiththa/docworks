from __future__ import annotations

import hashlib
import hmac
import time


def compute_user_hash(provider_id: str, provider_user_id: str, pepper: str) -> str:
    """
    Computes a unified, provider-scoped irreversible HMAC-SHA256 hash so:
      1. Zero raw user IDs, names, or emails ever touch Firestore or logs.
      2. Both ScrubDoc and DiffDoc on the same storage provider resolve the same user_hash,
         enabling shared ShareRadar limits and DocWorks Suite Bundle upgrades.
    """
    if not pepper:
        raise ValueError("HMAC_PEPPER is not configured in Secret Manager.")
    msg = f"docworks:v1:{provider_id}_user:{provider_user_id}".encode("utf-8")
    return hmac.new(pepper.encode("utf-8"), msg, hashlib.sha256).hexdigest()


def issue_session_proof(
    user_hash: str,
    app_id: str,
    provider_id: str,
    pepper: str,
    ttl_seconds: int = 3600,
) -> str:
    """
    Issues a stateless, app-and-provider-bound HMAC proof so quota checks never send
    cloud storage OAuth tokens back to Cloud Run.
    """
    exp = int(time.time()) + ttl_seconds
    payload = f"{provider_id}.{app_id}.{user_hash}.{exp}"
    sig = hmac.new(pepper.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def verify_session_proof(
    proof: str,
    expected_app_id: str,
    expected_provider_id: str,
    pepper: str,
) -> str | None:
    """Validates a stateless session proof and returns user_hash if authentic, unexpired, and scoped."""
    if not proof or not pepper:
        return None
    parts = proof.split(".")
    if len(parts) != 5:
        return None
    provider_id, app_id, user_hash, exp_str, provided_sig = parts
    if provider_id != expected_provider_id or app_id != expected_app_id:
        return None
    try:
        exp = int(exp_str)
    except ValueError:
        return None
    if exp < int(time.time()):
        return None
    payload = f"{provider_id}.{app_id}.{user_hash}.{exp}"
    expected_sig = hmac.new(pepper.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(provided_sig, expected_sig):
        return None
    return user_hash
