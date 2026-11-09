"""Run analysis code the agent wrote, with its blast radius reduced.

What this does protect against: runaway loops, memory exhaustion, enormous
output, writing over the repository, reading the database file directly, and
inheriting the server's credentials or proxy settings.

What it does NOT do is provide true isolation. The child is an ordinary
process; a determined escape is possible. The real boundary is the container
the service already runs in, and the fact that the code comes from a model
that only ever sees the data we hand it. Treat this as damage limitation, not
a jail, and do not run it on a host where the container boundary is the only
thing between this and something you care about.
"""

from __future__ import annotations

import json
import os
import resource
import subprocess
import sys
import tempfile
import textwrap

CPU_SECONDS = 20
WALL_SECONDS = 30
MEMORY_BYTES = 768 * 1024 * 1024
OUTPUT_BYTES = 24 * 1024 * 1024
MAX_STDOUT = 12000

PREAMBLE = textwrap.dedent('''
    import json, math, statistics, warnings
    warnings.filterwarnings("ignore")
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import pandas as pd, numpy as np

    with open("data.json", encoding="utf-8") as _f:
        _payload = json.load(_f)

    measurements = pd.DataFrame(_payload["measurements"])
    concepts = pd.DataFrame(_payload["concepts"])
    compounds = pd.DataFrame(_payload["compounds"])

    def save_plot(name="plot.png"):
        """Write the current figure so the answer can show it."""
        plt.tight_layout()
        plt.savefig(name, dpi=140, bbox_inches="tight")
        plt.close()
        print(f"[saved {name}]")
''').strip()


NOBODY_UID = int(os.environ.get("SANDBOX_UID", "65534"))
NOBODY_GID = int(os.environ.get("SANDBOX_GID", "65534"))


def _limits():
    """Caps, a new session, and as few privileges as we can get away with.

    Where the service runs as root (the usual case in a container) the child
    drops to an unprivileged user, so it cannot write into the application
    directory even though it can still read what is world-readable. Where the
    service is already unprivileged there is nothing to drop and the child
    inherits the same rights: `privilege_dropped` in the result says which.
    """
    resource.setrlimit(resource.RLIMIT_CPU, (CPU_SECONDS, CPU_SECONDS))
    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
    resource.setrlimit(resource.RLIMIT_FSIZE, (OUTPUT_BYTES, OUTPUT_BYTES))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
    os.setsid()
    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(NOBODY_GID)
        os.setuid(NOBODY_UID)


def run(code: str, data: dict, timeout: int = WALL_SECONDS) -> dict:
    """Execute `code` with the data in scope. Returns output, errors, figures."""
    if not (code or "").strip():
        return {"ok": False, "error": "no code given", "stdout": "", "figures": []}

    workdir = tempfile.mkdtemp(prefix="analysis-")
    dropped = os.geteuid() == 0
    try:
        # The child may be another user by the time it runs, so the one place
        # it is allowed to write has to be open to it.
        os.chmod(workdir, 0o777)
        with open(os.path.join(workdir, "data.json"), "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        script = os.path.join(workdir, "analysis.py")
        with open(script, "w", encoding="utf-8") as fh:
            fh.write(PREAMBLE + "\n\n# ---- agent code ----\n" + code + "\n")

        # Nothing of the server's identity travels into the child: no API keys,
        # no proxy, no database path.
        env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": workdir,
               "LANG": "C.UTF-8", "MPLBACKEND": "Agg",
               "PYTHONDONTWRITEBYTECODE": "1", "MPLCONFIGDIR": workdir}

        try:
            proc = subprocess.run(
                # -I isolates from the environment and the user site directory.
                # -S is deliberately NOT used: it would also drop the installed
                # packages the analysis needs.
                [sys.executable, "-I", "analysis.py"],
                cwd=workdir, env=env, capture_output=True, text=True,
                timeout=timeout, preexec_fn=_limits)
        except subprocess.TimeoutExpired:
            return {"ok": False, "stdout": "",
                    "error": f"the analysis ran longer than {timeout}s and was stopped",
                    "figures": []}
        except Exception as exc:
            return {"ok": False, "stdout": "",
                    "error": f"could not start the analysis: {type(exc).__name__}",
                    "figures": []}

        figures = []
        for name in sorted(os.listdir(workdir)):
            if name.lower().endswith(".png"):
                path = os.path.join(workdir, name)
                if os.path.getsize(path) <= 6 * 1024 * 1024:
                    import base64
                    with open(path, "rb") as fh:
                        figures.append({"name": name,
                                        "png_base64": base64.b64encode(fh.read()).decode()})

        stdout = (proc.stdout or "")[:MAX_STDOUT]
        stderr = (proc.stderr or "")[-2500:]
        return {"ok": proc.returncode == 0, "stdout": stdout,
                "error": "" if proc.returncode == 0 else (stderr or "the analysis failed"),
                "figures": figures, "exit_code": proc.returncode,
                "privilege_dropped": dropped}
    finally:
        import shutil
        shutil.rmtree(workdir, ignore_errors=True)


def dataset(limit_measurements: int = 4000) -> dict:
    """The slice of the library the analysis code can see. Read-only by value:
    the child gets a copy, never the database."""
    import db
    conn = db.connect()
    try:
        rows = [dict(r) for r in conn.execute(
            "SELECT id, openalex_id, material_system, graphene_form, electrode_role,"
            " battery_type, specific_capacity_mah_g, current_density_ma_g, c_rate,"
            " cycle_count, capacity_retention_pct, first_cycle_ce_pct,"
            " temperature_c, areal_loading_mg_cm2, confidence,"
            " (SELECT year FROM papers p WHERE p.openalex_id=e.openalex_id) AS year,"
            " (SELECT journal FROM papers p WHERE p.openalex_id=e.openalex_id) AS journal,"
            " (SELECT title FROM papers p WHERE p.openalex_id=e.openalex_id) AS title"
            " FROM evidence e LIMIT ?", (limit_measurements,))]
        concepts = [dict(r) for r in conn.execute(
            "SELECT slug, title, category, description FROM concepts")]
        compounds = [dict(r) for r in conn.execute(
            "SELECT name, formula, molecular_weight, iupac_name FROM compounds")]
        return {"measurements": rows, "concepts": concepts, "compounds": compounds}
    finally:
        conn.close()
