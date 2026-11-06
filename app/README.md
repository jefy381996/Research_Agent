# The research agent app

This folder is the app itself: one page, a stylesheet, its logic, and a data
file. No build step, no server.

The page gives Claude six of its own functions — searching the measurements,
comparing material systems, reading the papers, and the calculators — and
Claude chooses which to call. It may only say what those calls return, so every
number traces back to a sentence in a paper. Where Claude is unavailable, the
page answers from its own search instead, so it is never a blank screen.

Rebuild the data file after changing the library:

```bash
python build_demo.py --out app/data.json
```

Serve it anywhere static:

```bash
python -m http.server 8002 --directory app
```

The published copy lives at <https://claude.ai/artifact/QuP8gNZpF5guDB4NvsjFoW>,
where the Claude-powered agent and the saved notebook are switched on.
