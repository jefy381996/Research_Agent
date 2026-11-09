# Putting this on Railway

The whole product is one service. There is no separate database to set up: the
library ships with the repository as a single file, and the service rebuilds
its search index on the first boot — about four seconds, once.

## Part 1 — get it running (five minutes, nothing to configure)

1. Make sure this branch is pushed to GitHub.
2. Go to <https://railway.com> and sign in with GitHub.
3. **New Project** → **Deploy from GitHub repo** → pick this repository.
4. Railway asks which branch. Pick the branch you pushed.
5. It reads `railway.json`, installs what it needs, and starts. Nothing to fill in.
6. Open the service → **Settings** → **Networking** → **Generate Domain**.

That URL is the app. The first request may take a few seconds while the index
builds; after that it is instant. Railway checks `/api/health` to decide the
service is alive.

At this point everything works except **Agent** mode: definitions, battery
measurements, material properties, comparisons, trends, calculators, papers,
search and export. None of it calls anything outside the box.

## Part 2 — switch on Agent mode (two minutes)

Agent mode is the one part that needs an outside model. It is off until you
give it a key, and the interface says so rather than failing silently.

1. Get a key from <https://console.groq.com> → **API Keys**.
2. In Railway, open the service → **Variables** → **New Variable**.
3. Add these two:

   | Name | Value |
   |---|---|
   | `LLM_PROVIDER` | `groq` |
   | `GROQ_API_KEY` | your key |

4. Railway redeploys on its own. Agent mode is now live.

**Read this before the demo.** Groq's free tier allows 8,000 tokens a minute.
The agent sends the question, its thirteen tool descriptions and the rows the
tools return, so a single real question goes past that and comes back as a 413.
Agent mode needs Groq's paid tier — their developer tier starts around $20 and
is far above what a demo uses. Instant mode stays free and unlimited either
way. If you would rather not pay yet, run the demo in Instant mode and show
Agent mode from the cached answers, which replay with no key at all.

To use a different model later, change one variable:

| Provider | `LLM_PROVIDER` | Key variable | Default model |
|---|---|---|---|
| Groq | `groq` | `GROQ_API_KEY` | `openai/gpt-oss-120b` |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-4o-mini` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-5-5` |
| Google | `gemini` | `GEMINI_API_KEY` | `gemini-2.5-flash` |

Set `LLM_MODEL` to override the default for whichever you choose. Nothing else
in the app changes.

## Part 3 — the rest of the settings

All optional. Add them under **Variables** only if you want them.

| Variable | What it does |
|---|---|
| `OPENALEX_API_KEY` | Lets **Live** search reach new papers that are not yet in the library. Without it, live search is off and the stored library still answers. Free from <https://openalex.org/settings/api-key> |
| `ALLOWED_ORIGINS` | Comma-separated sites allowed to call the API from a browser. Set it to your Railway domain if you embed the app elsewhere |
| `AGENT_CONTEXT_CHARS` | How much the agent is allowed to hold at once. Lower it if you hit a rate limit, raise it on a paid tier |
| `AGENT_MAX_ROUNDS` | How many tool rounds the agent may take before it must answer. Default is enough |
| `DB_PATH` | Where the library file lives. Defaults to `data/research_agent.db` |

`PORT` is set by Railway. Do not set it yourself.

## Keeping the library fresh

Railway redeploys from the repository, so new data arrives through git. The
weekly GitHub Action in `.github/workflows/collect.yml` re-collects the papers,
re-extracts the measurements, runs the tests and the scorecard, and commits the
updated library only if every step passed. Point Railway at the same branch and
each refresh deploys itself.

That action needs the OpenAlex key as a repository secret: **Settings** →
**Secrets and variables** → **Actions** → **New repository secret**, named
`OPENALEX_API_KEY`.

## If something goes wrong

| What you see | What it means |
|---|---|
| Build fails on `pip install` | Railway picked the wrong Python. `runtime.txt` pins 3.11.9; check it was read |
| First page load is slow, then fine | Normal. The search index is being rebuilt once |
| Health check fails | The library file is missing from the deployment. Check `data/research_agent.db` is committed |
| Agent mode says it is unavailable | `LLM_PROVIDER` or the matching key is not set |
| Agent mode returns a rate-limit error | Groq's free tier. See Part 2 |

## Other hosts

The same repository runs anywhere that reads a `Procfile` (Render, Fly, Heroku)
and there is a `Dockerfile` for anywhere that does not. The only requirement is
that the start command binds to `$PORT`.

## Running it on your own machine

```bash
pip install -r requirements.txt
```

```bash
python -m uvicorn api:app --port 8000
```

Then open <http://localhost:8000>.
