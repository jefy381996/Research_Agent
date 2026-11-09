# Alternative to Railway's Nixpacks build: `railway up` picks this up if present.
# 3.13, not 3.11: numpy and matplotlib publish no cp311 wheels at these
# pins, so a 3.11 image tries to compile them from source and fails for
# want of a toolchain. 3.13 is also what the test suite runs on.
FROM python:3.13-slim

WORKDIR /srv
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8000

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# The database ships with the image, so the service answers on first request
# with no migration step and no external database to provision.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",8000)}/api/health').read()"

CMD ["sh", "-c", "python -m uvicorn api:app --host 0.0.0.0 --port ${PORT:-8000}"]
