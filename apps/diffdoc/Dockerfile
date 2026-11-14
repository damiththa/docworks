FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    APP_ID=diffdoc \
    PORT=8080

WORKDIR /app

# Fetch pinned MIT/Apache-2.0 client-side browser bundles at Cloud Build time
# so zero third-party CDNs are queried from users' browsers at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && mkdir -p /app/vendor \
    && curl -fsSL https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js -o /app/vendor/pdf-lib.min.js \
    && curl -fsSL https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js -o /app/vendor/pdf.min.js \
    && curl -fsSL https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js -o /app/vendor/pdf.worker.min.js \
    && curl -fsSL https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js -o /app/vendor/jszip.min.js \
    && apt-get purge -y --auto-remove curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY shared /app/shared
COPY apps/diffdoc /app/apps/diffdoc

RUN useradd --create-home --shell /sbin/nologin docworks \
    && chown -R docworks:docworks /app
USER docworks

EXPOSE 8080

CMD ["uvicorn", "apps.diffdoc.main:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
