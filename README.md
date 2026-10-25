# Wind Ledger

A day-ahead wind forecast review dashboard for the UK electricity market. It aligns Elexon WINDFOR revisions with FUELHH wind generation outturn and measures only forecasts published by the selected decision cutoff.

## Scope and assumptions

- The selected month means **decision dates** in that month. A decision on date D is evaluated against delivery on D+1.
- The default decision cutoff is **12:30 Europe/London**. The challenge does not specify a precise trading cutoff; this is an explicit, adjustable analysis assumption, not a client-confirmed rule.
- For each delivery hour, the app selects the latest WINDFOR row with `publishTime` at or before the decision cutoff. The January 2026 stream response has hourly `startTime` values, while FUELHH has half-hourly values; the app averages the two half-hour actual MW values to form an hourly actual before scoring. If either half-hour actual is missing, that hourly pair is omitted from error metrics and reduces coverage. No later forecast revision is used in the decision-time score.
- Actuals are national FUELHH rows filtered to `fuelType=WIND`. If Elexon returns multiple revisions for an interval, the latest published row in the requested window is used. The request includes actual publications through two days after the final delivery date; this bounded window is an implementation assumption.
- MAE, RMSE and signed bias are calculated over intervals where both forecast and actual are present. Coverage means paired hourly forecast-and-actual intervals divided by all expected delivery hours; it is shown beside the metrics. MAPE is excluded because it is unstable when actual generation is zero or small.
- Times are shown in Europe/London; source timestamps are retained as UTC instants. January 2026 decision dates include delivery hours through 1 February 2026. UK daylight-saving transitions are handled using Europe/London calendar days.

## Run locally

Prerequisites: Python 3.10+, Node.js 20+, and Docker (optional).

1. Backend: `cd backend`, create/activate a virtual environment, then run `pip install -r requirements.txt`.
2. Start the API: `uvicorn app.main:app --reload --port 8000`.
3. Frontend: in another terminal, `cd frontend`, run `npm ci` and `npm run dev`.
4. Open the Vite URL shown in the terminal. The frontend proxies `/api` calls to `http://localhost:8000`.

To run both services in Docker, use `docker compose up --build` from the repository root and open `http://localhost:8080`.

## Data source

The backend calls Elexon's public BMRS Insights API ([WINDFOR stream](https://bmrs.elexon.co.uk/api-documentation/endpoint/datasets/WINDFOR/stream) and [FUELHH stream](https://bmrs.elexon.co.uk/api-documentation/endpoint/datasets/FUELHH/stream)). It requests bounded publication-time windows, including a two-day forecast lead-in for the first decision date, so eligible earlier revisions can be considered without using information published after the decision. Actual revisions are selected from a publication window ending two days after the last delivery day. No API key is required by the public Insights API.

## Repository layout

- `backend/app/main.py` — HTTP API, Elexon retrieval, interval alignment, metrics, caching.
- `frontend/src/` — React dashboard and chart components.
- `frontend/index.html` — application shell.
- `docker-compose.yml`, `Dockerfile` — local container orchestration and production image.
- `README.md` — scope, assumptions, and setup.

## Deployment

For Vercel, the root `vercel.json` defines the Vite frontend and FastAPI backend as two services under one deployment URL. Select the **Services** framework when importing the repository if Vercel does not select it automatically. Requests to `/api/*` go to FastAPI; all other paths go to the frontend. Vercel Services is currently in beta.

The Docker image also serves the built React app and Python API from one process on container hosts such as Heroku. It listens on the host-provided `PORT` (default 8080). Add the deployed URL here after deployment.

## AI assistance

AI tools were used to assist with planning and implementation. All source-data rules and outputs should be reviewed against Elexon documentation before operational use.
