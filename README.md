# Wind Ledger

A day-ahead wind forecast review dashboard for the UK electricity market. It aligns Elexon WINDFOR revisions with FUELHH wind generation outturn and measures only forecasts published by the selected decision cutoff.

## Scope and assumptions

- The selected month means **decision dates** in that month. A decision on date D is evaluated against delivery on D+1. The challenge analysis is scoped to January 2026.
- The default decision cutoff is **12:30 Europe/London**. The challenge does not specify a precise trading cutoff; this is an explicit, adjustable analysis assumption, not a client-confirmed rule.
- For each delivery hour, the app selects the latest WINDFOR row with `publishTime` at or before the decision cutoff. The January 2026 stream response has hourly `startTime` values, while FUELHH has half-hourly values; the app averages the two half-hour actual MW values to form an hourly actual before scoring. If either half-hour actual is missing, that hourly pair is omitted from error metrics and reduces coverage. No later forecast revision is used in the decision-time score.
- Actuals are national FUELHH rows filtered to `fuelType=WIND`. If Elexon returns multiple revisions for an interval, the latest published row in the requested window is used. The request includes actual publications through two days after the final delivery date; this bounded window is an implementation assumption.
- MAE, RMSE and signed bias are calculated over intervals where both forecast and actual are present. Coverage means paired hourly forecast-and-actual intervals divided by all expected delivery hours; it is shown beside the metrics. MAPE is excluded because it is unstable when actual generation is zero or small.
- Times are shown in Europe/London; source timestamps are retained as UTC instants. January 2026 decision dates include delivery hours through 1 February 2026. UK daylight-saving transitions are handled using Europe/London calendar days.

## Run locally

Prerequisites for native development: Python 3.10+ and Node.js 20+. For the container workflow, install Docker Desktop (or Docker Engine) with Docker Compose.

### Run the complete app with Docker

From the repository root:

```bash
docker compose up --build
```

Open [http://localhost:8080](http://localhost:8080). The container builds the React app and serves it with the Python API. Stop it with `Ctrl+C`; run `docker compose down` to remove the stopped container.

### Run frontend and backend separately

In terminal 1, install and start the API:

```bash
cd backend
python -m venv .venv
```

Activate the virtual environment (`.venv\Scripts\Activate.ps1` in Windows PowerShell, or `source .venv/bin/activate` on macOS/Linux), then run:

```bash
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000
```

In terminal 2, install and start the React development server:

```bash
cd frontend
npm ci
npm run dev
```

Open the Vite URL printed in terminal 2 (normally [http://localhost:5173](http://localhost:5173)). Vite proxies `/api` requests to `http://localhost:8000`. The API health endpoint is `/api/health`; the analysis endpoint accepts `month` and `cutoff`, for example `/api/analysis?month=2026-01&cutoff=12:30`.

## Test

Run the backend logic and cache tests from the repository root:

```bash
python -m unittest discover -s backend/tests -v
```

Build the production frontend with `cd frontend && npm run build`. The test suite covers cutoff-aware revision selection, hourly actual aggregation, missing data, daylight-saving delivery-hour counts, cache reuse, forced refresh, concurrent loads, and recovery after an upstream failure.

## Data source

The backend calls Elexon's public BMRS Insights API ([WINDFOR stream](https://bmrs.elexon.co.uk/api-documentation/endpoint/datasets/WINDFOR/stream) and [FUELHH stream](https://bmrs.elexon.co.uk/api-documentation/endpoint/datasets/FUELHH/stream)). It requests bounded publication-time windows, including a two-day forecast lead-in for the first decision date, so eligible earlier revisions can be considered without using information published after the decision. Actual revisions are selected from a publication window ending two days after the last delivery day. No API key is required by the public Insights API.

## Repository layout

- `backend/app/main.py` — HTTP API, Elexon retrieval, interval alignment, metrics, caching.
- `backend/app/__init__.py` — Python package marker.
- `backend/tests/` — backend analysis and cache unit tests.
- `backend/requirements.txt` — Python dependencies.
- `frontend/src/` — React dashboard and charts, including the selected-day decision snapshot.
- `frontend/index.html` — application shell.
- `frontend/package.json`, `frontend/package-lock.json` — frontend dependencies and lockfile.
- `frontend/vite.config.js` — Vite development/build configuration.
- `Dockerfile`, `docker-compose.yml`, `.dockerignore` — container image and local orchestration.
- `vercel.json` — Vercel frontend/backend routing and service configuration.
- `README.md` — scope, assumptions, setup, testing, and deployment information.

## Deployment

**Live Vercel app:** [https://gridbricks-wind-forecast-sable.vercel.app/](https://gridbricks-wind-forecast-sable.vercel.app/)

**Public source repo:** [https://github.com/ram15x/kjhwr](https://github.com/ram15x/kjhwr)

The existing production app is deployed on Vercel from this repository. The root [`vercel.json`](vercel.json) declares the frontend and FastAPI backend services on one Vercel deployment: `/api/*` routes to the backend and other paths route to the React frontend. The app uses Elexon's public API and has no application secrets or API keys to configure.

To recreate the deployment, import `ram15x/kjhwr` into Vercel, keep the repository root as the project root, and use the Services configuration defined in `vercel.json`. The framework setting must use **Services** if Vercel does not detect it automatically. Vercel currently documents Services as a private beta that may require access to be enabled for a team; see the [Vercel Services documentation](https://vercel.com/docs/services). For the already-created project, check its Vercel Deployments page after a push to the configured production branch and confirm the deployment is Ready before sharing the app link.

The Docker image can also run on a container host. It serves the built React app and Python API from one process, listens on the platform-provided `PORT` (default `8080`), and can be built locally with `docker compose up --build`.

## AI assistance

AI tools were used to assist with planning and implementation. All source-data rules and outputs should be reviewed against Elexon documentation before operational use.
