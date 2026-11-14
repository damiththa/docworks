from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from shared.backend.config import Settings

ALLOWED_ACTIONS_BY_APP = {
    "scrubdoc": ("scrub", "radar_fix"),
    "diffdoc": ("diff", "radar_fix"),
}


def current_period_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")


class EntitlementStore:
    """
    Unified Zero-PII Entitlement & Monthly Quota Store backed by GCP Firestore Native Mode.

    Entire stored schema per document (`entitlements_{provider}/{user_hash}`):
      - period: "YYYY-MM"
      - plan_bundle: "free" | "pro"     (unlocks ScrubDoc + DiffDoc + ShareRadar Pro)
      - plan_scrubdoc: "free" | "pro"   (unlocks ScrubDoc + ShareRadar Pro)
      - plan_diffdoc: "free" | "pro"    (unlocks DiffDoc + ShareRadar Pro)
      - scrub_used: int
      - diffs_used: int
      - radar_fixes_used: int
      - updated_at: UTC timestamp

    Zero emails, names, filenames, raw user IDs, or OAuth tokens are ever stored.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._memory_fallback: dict[str, dict[str, Any]] = {}
        self._firestore_client = None

    def _get_firestore(self):
        if not self._settings.use_firestore:
            return None
        if self._firestore_client is None:
            from google.cloud import firestore

            self._firestore_client = firestore.AsyncClient(project=self._settings.gcp_project_id)
        return self._firestore_client

    def warm_up(self) -> None:
        """Pre-initializes the Firestore gRPC client during container boot."""
        try:
            self._get_firestore()
        except Exception:
            pass

    @staticmethod
    def _effective_plans(record: dict[str, Any], app_id: str) -> tuple[bool, bool, bool]:
        bundle_pro = record.get("plan_bundle") == "pro" or record.get("plan") == "pro"
        scrub_pro = bundle_pro or record.get("plan_scrubdoc") == "pro"
        diff_pro = bundle_pro or record.get("plan_diffdoc") == "pro"
        radar_pro = scrub_pro or diff_pro
        active_app_pro = scrub_pro if app_id == "scrubdoc" else diff_pro
        return active_app_pro, radar_pro, bundle_pro

    def _format_response(self, record: dict[str, Any]) -> dict[str, Any]:
        app_id = self._settings.app_id
        app_pro, radar_pro, _ = self._effective_plans(record, app_id)
        scrub_pro = record.get("plan_bundle") == "pro" or record.get("plan_scrubdoc") == "pro" or record.get("plan") == "pro"
        diff_pro = record.get("plan_bundle") == "pro" or record.get("plan_diffdoc") == "pro" or record.get("plan") == "pro"

        scrub_used = int(record.get("scrub_used", 0))
        diffs_used = int(record.get("diffs_used", 0))
        radar_used = int(record.get("radar_fixes_used", 0))

        scrub_limit = None if scrub_pro else self._settings.free_scrub_limit_per_month
        diffs_limit = None if diff_pro else self._settings.free_diff_limit_per_month
        radar_limit = None if radar_pro else self._settings.free_radar_fix_limit_per_month

        return {
            "suite": self._settings.suite_name,
            "app_id": app_id,
            "provider": self._settings.provider_id,
            "plan": "pro" if app_pro else "free",
            "radar_plan": "pro" if radar_pro else "free",
            "plan_bundle": "pro" if record.get("plan_bundle") == "pro" else "free",
            "plan_scrubdoc": "pro" if scrub_pro else "free",
            "plan_diffdoc": "pro" if diff_pro else "free",
            "period": record.get("period", current_period_utc()),
            "scrub_used": scrub_used,
            "scrub_limit": scrub_limit,
            "scrub_remaining": None if scrub_limit is None else max(0, scrub_limit - scrub_used),
            "diffs_used": diffs_used,
            "diffs_limit": diffs_limit,
            "diffs_remaining": None if diffs_limit is None else max(0, diffs_limit - diffs_used),
            "radar_fixes_used": radar_used,
            "radar_fixes_limit": radar_limit,
            "radar_fixes_remaining": None if radar_limit is None else max(0, radar_limit - radar_used),
        }

    def _default_record(self, period: str, prior: dict[str, Any] | None = None) -> dict[str, Any]:
        prior = prior or {}
        return {
            "period": period,
            "plan_bundle": prior.get("plan_bundle", "free"),
            "plan_scrubdoc": prior.get("plan_scrubdoc", "free"),
            "plan_diffdoc": prior.get("plan_diffdoc", "free"),
            "scrub_used": 0,
            "diffs_used": 0,
            "radar_fixes_used": 0,
            "updated_at": datetime.now(timezone.utc),
        }

    async def get_status(self, user_hash: str) -> dict[str, Any]:
        period = current_period_utc()
        db = self._get_firestore()
        if db is None:
            rec = self._memory_fallback.get(user_hash)
            if not rec or rec.get("period") != period:
                rec = self._default_record(period, rec)
                self._memory_fallback[user_hash] = rec
            return self._format_response(rec)

        doc_ref = db.collection(self._settings.firestore_collection).document(user_hash)
        snap = await doc_ref.get()
        if not snap.exists:
            init_data = self._default_record(period)
            await doc_ref.set(init_data)
            return self._format_response(init_data)

        data = snap.to_dict() or {}
        if data.get("period") != period:
            rolled = self._default_record(period, data)
            await doc_ref.set(rolled, merge=True)
            return self._format_response(rolled)
        return self._format_response(data)

    def _action_limit_and_field(self, action: str, record: dict[str, Any]) -> tuple[str, int, bool]:
        app_id = self._settings.app_id
        allowed_actions = ALLOWED_ACTIONS_BY_APP.get(app_id, ())
        if action not in allowed_actions:
            raise ValueError(f"Action '{action}' is not valid for app '{app_id}'.")

        bundle_pro = record.get("plan_bundle") == "pro" or record.get("plan") == "pro"
        scrub_pro = bundle_pro or record.get("plan_scrubdoc") == "pro"
        diff_pro = bundle_pro or record.get("plan_diffdoc") == "pro"

        if action == "scrub":
            return "scrub_used", self._settings.free_scrub_limit_per_month, scrub_pro
        if action == "diff":
            return "diffs_used", self._settings.free_diff_limit_per_month, diff_pro
        return "radar_fixes_used", self._settings.free_radar_fix_limit_per_month, (scrub_pro or diff_pro)

    async def consume_quota(
        self,
        user_hash: str,
        action: str,
        units: int = 1,
    ) -> tuple[bool, dict[str, Any]]:
        """
        Atomically verifies and consumes quota for `action` ('scrub', 'diff', or 'radar_fix').
        Returns (allowed: bool, updated_status: dict).
        """
        units = max(1, min(units, 500))
        period = current_period_utc()

        db = self._get_firestore()
        if db is None:
            await self.get_status(user_hash)
            rec = self._memory_fallback[user_hash]
            field_name, limit, is_pro = self._action_limit_and_field(action, rec)
            current_val = int(rec.get(field_name, 0))
            if not is_pro and (current_val + units > limit):
                return False, self._format_response(rec)
            rec[field_name] = current_val + units
            rec["updated_at"] = datetime.now(timezone.utc)
            return True, self._format_response(rec)

        from google.cloud import firestore

        doc_ref = db.collection(self._settings.firestore_collection).document(user_hash)

        @firestore.async_transactional
        async def _txn_consume(transaction):
            snap = await doc_ref.get(transaction=transaction)
            data = snap.to_dict() if snap.exists else {}
            if data.get("period") != period:
                data = self._default_record(period, data)

            field_name, limit, is_pro = self._action_limit_and_field(action, data)
            current_val = int(data.get(field_name, 0))
            if not is_pro and (current_val + units > limit):
                return False, data

            updated = {
                "period": period,
                "plan_bundle": data.get("plan_bundle", "free"),
                "plan_scrubdoc": data.get("plan_scrubdoc", "free"),
                "plan_diffdoc": data.get("plan_diffdoc", "free"),
                "scrub_used": int(data.get("scrub_used", 0)),
                "diffs_used": int(data.get("diffs_used", 0)),
                "radar_fixes_used": int(data.get("radar_fixes_used", 0)),
                field_name: current_val + units,
                "updated_at": datetime.now(timezone.utc),
            }
            transaction.set(doc_ref, updated, merge=True)
            return True, updated

        txn = db.transaction()
        allowed, updated_record = await _txn_consume(txn)
        return allowed, self._format_response(updated_record)
