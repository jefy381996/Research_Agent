# Deploying to Railway

The whole product is one service. There is no separate database to provision:
the evidence library ships with the repository as a single file.

## Steps

1. Push this repository to GitHub (already done, on your branch).
2. Go to <https://railway.com>, choose **New Project** → **Deploy from GitHub repo**,
   and pick this repository.
3. Railway reads `railway.json` and starts the service. Nothing to configure.
4. Open **Settings** → **Networking** → **Generate Domain**. That URL is the app.

That is the whole deployment. The service answers on `/`, and Railway's health
check hits `/api/health`.

## Optional settings

Add these under **Variables** only if you want them:

| Variable | What it does |
|---|---|
| `OPENALEX_API_KEY` | Only needed to refresh the library from inside the service. The app serves without it. |
| `ALLOWED_ORIGINS` | Comma-separated origins allowed to call the API from a browser. Defaults to localhost. |
| `DB_PATH` | Where the library file lives. Defaults to `data/research_agent.db`. |

`PORT` is set by Railway; do not set it yourself.

## Keeping the library fresh

Railway restarts from the repository, so refreshed data arrives through git.
The weekly GitHub Action in `.github/workflows/collect.yml` re-collects the
papers, re-extracts the evidence, runs the tests and the scorecard, and commits
the updated database only if every step passed. Point Railway at the same
branch and each refresh redeploys automatically.

## Other hosts

The same repository runs anywhere that reads a `Procfile` (Render, Fly, Heroku)
and there is a `Dockerfile` for anywhere that does not. The only requirement is
that the start command binds to `$PORT`.

## Running it locally

```bash
pip install -r requirements.txt
```

```bash
python -m uvicorn api:app --port 8000
```
