from pathlib import Path

from shared.backend.app_factory import create_docworks_app

app = create_docworks_app(
    default_app_id="diffdoc",
    app_dir=Path(__file__).resolve().parent,
)
