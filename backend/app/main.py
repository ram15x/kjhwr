from __future__ import annotations

import asyncio
import math
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

API_ROOT = "https://data.elexon.co.uk/bmrs/api/v1/datasets"
LONDON = ZoneInfo("Europe/London")
UTC = timezone.utc
CACHE_SECONDS = 20 * 60
app = FastAPI(title="Wind Ledger API", version="1.0.0")
_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_pending: dict[str, asyncio.Task[dict[str, Any]]] = {}
_cache_lock = asyncio.Lock()


def parse_instant(value: Any) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed.astimezone(UTC)
    except ValueError:
        return None


def utc_param(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def month_bounds(month: str) -> tuple[date, date]:
    try:
        first = date.fromisoformat(f"{month}-01")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Month must use YYYY-MM format") from exc
    following = date(first.year + (first.month == 12), 1 if first.month == 12 else first.month + 1, 1)
    return first, following


async def fetch_window(client: httpx.AsyncClient, dataset: str, start: datetime, end: datetime) -> list[dict[str, Any]]:
    url = f"{API_ROOT}/{dataset}/stream"
    response = await client.get(url, params={"publishDateTimeFrom": utc_param(start), "publishDateTimeTo": utc_param(end)})
    if response.status_code == 429:
        await asyncio.sleep(1)
        response = await client.get(url, params={"publishDateTimeFrom": utc_param(start), "publishDateTimeTo": utc_param(end)})
    response.raise_for_status()
    payload = response.json()
    rows = payload.get("data", []) if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise ValueError(f"Unexpected {dataset} response shape")
    return [row for row in rows if isinstance(row, dict)]


async def fetch_dataset(client: httpx.AsyncClient, dataset: str, start: datetime, end: datetime) -> list[dict[str, Any]]:
    # Seven-day publication windows keep each request bounded and avoid relying on
    # undocumented maximum ranges. Fetch sequentially to be considerate of the API.
    rows: list[dict[str, Any]] = []
    cursor = start
    while cursor < end:
        window_end = min(cursor + timedelta(days=7), end)
        rows.extend(await fetch_window(client, dataset, cursor, window_end))
        cursor = window_end
    return rows


async def load_month(month: str) -> dict[str, Any]:
    first, following = month_bounds(month)
    # A decision on a date covers delivery on the following date. Pull a short
    # actual-publication buffer so delayed outturn records can still be matched.
    # Include two days of lead-in so a forecast published before the first
    # decision date is still eligible for its earliest delivery hours.
    forecast_start = datetime.combine(first - timedelta(days=2), time.min, LONDON).astimezone(UTC)
    forecast_end = datetime.combine(following, time(23, 59), LONDON).astimezone(UTC)
    actual_start = datetime.combine(first + timedelta(days=1), time.min, LONDON).astimezone(UTC)
    actual_end = (datetime.combine(following + timedelta(days=1), time.min, LONDON) + timedelta(days=2)).astimezone(UTC)
    timeout = httpx.Timeout(40, connect=15)
    limits = httpx.Limits(max_connections=3, max_keepalive_connections=2)
    try:
        async with httpx.AsyncClient(timeout=timeout, limits=limits, headers={"User-Agent": "WindLedger/1.0"}) as client:
            forecasts = await fetch_dataset(client, "WINDFOR", forecast_start, forecast_end)
            actuals = await fetch_dataset(client, "FUELHH", actual_start, actual_end)
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=f"Elexon data request failed: {exc}") from exc

    forecast_by_start: dict[datetime, list[tuple[datetime, float]]] = defaultdict(list)
    for row in forecasts:
        start_time = parse_instant(row.get("startTime"))
        publish_time = parse_instant(row.get("publishTime"))
        try:
            generation = float(row.get("generation"))
        except (TypeError, ValueError):
            continue
        if start_time is not None and publish_time is not None and math.isfinite(generation):
            # January 2026 WINDFOR records are hourly; retain their native hour.
            forecast_by_start[start_time].append((publish_time, generation))

    actual_by_start: dict[datetime, tuple[datetime, float]] = {}
    for row in actuals:
        if str(row.get("fuelType", "")).upper() != "WIND":
            continue
        start_time = parse_instant(row.get("startTime"))
        publish_time = parse_instant(row.get("publishTime"))
        try:
            generation = float(row.get("generation"))
        except (TypeError, ValueError):
            continue
        if start_time is None or publish_time is None or not math.isfinite(generation):
            continue
        previous = actual_by_start.get(start_time)
        if previous is None or publish_time > previous[0]:
            actual_by_start[start_time] = (publish_time, generation)

    return {"first": first, "following": following, "forecast_by_start": forecast_by_start, "actual_by_start": actual_by_start,
            "forecast_rows": len(forecasts), "actual_rows": len(actuals)}


async def get_month_data(month: str) -> dict[str, Any]:
    async with _cache_lock:
        cached = _cache.get(month)
        if cached and asyncio.get_running_loop().time() - cached[0] < CACHE_SECONDS:
            return cached[1]
        task = _pending.get(month)
        if task is None:
            task = asyncio.create_task(load_month(month))
            _pending[month] = task
    try:
        data = await task
    except Exception:
        async with _cache_lock:
            if _pending.get(month) is task:
                _pending.pop(month, None)
        raise
    async with _cache_lock:
        if _pending.get(month) is task:
            _cache[month] = (asyncio.get_running_loop().time(), data)
            _pending.pop(month, None)
    return data


def evaluate_month(data: dict[str, Any], cutoff: time) -> dict[str, Any]:
    points: list[dict[str, Any]] = []
    first: date = data["first"]
    following: date = data["following"]
    decision_day = first
    while decision_day < following:
        decision_at = datetime.combine(decision_day, cutoff, LONDON).astimezone(UTC)
        delivery_start = datetime.combine(decision_day + timedelta(days=1), time.min, LONDON).astimezone(UTC)
        delivery_end = datetime.combine(decision_day + timedelta(days=2), time.min, LONDON).astimezone(UTC)
        start_time = delivery_start
        while start_time < delivery_end:
            eligible = [(published, value) for published, value in data["forecast_by_start"].get(start_time, []) if published <= decision_at]
            forecast = publish_time = None
            if eligible:
                publish_time, forecast = max(eligible, key=lambda pair: pair[0])
            # Compare at the forecast's native hourly resolution. FUELHH is
            # half-hourly, so use the mean MW of both half-hour periods. If one
            # half is missing, leave the hourly actual unmatched.
            actual_first = data["actual_by_start"].get(start_time)
            actual_second = data["actual_by_start"].get(start_time + timedelta(minutes=30))
            actual = ((actual_first[0] if actual_first[0] >= actual_second[0] else actual_second[0]),
                      (actual_first[1] + actual_second[1]) / 2) if actual_first and actual_second else None
            points.append({
                "decisionDate": decision_day.isoformat(),
                "deliveryTime": start_time.isoformat().replace("+00:00", "Z"),
                "deliveryLocal": start_time.astimezone(LONDON).isoformat(),
                "publishTime": publish_time.isoformat().replace("+00:00", "Z") if publish_time else None,
                "publishLocal": publish_time.astimezone(LONDON).isoformat() if publish_time else None,
                "forecastMw": round(forecast, 2) if forecast is not None else None,
                "actualMw": round(actual[1], 2) if actual else None,
                "errorMw": round(forecast - actual[1], 2) if actual and forecast is not None else None,
            })
            start_time += timedelta(hours=1)
        decision_day += timedelta(days=1)

    scored = [p for p in points if p["actualMw"] is not None and p["forecastMw"] is not None]
    errors = [p["errorMw"] for p in scored]
    mae = sum(abs(e) for e in errors) / len(errors) if errors else None
    rmse = math.sqrt(sum(e * e for e in errors) / len(errors)) if errors else None
    bias = sum(errors) / len(errors) if errors else None
    daily: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for point in points:
        daily[point["decisionDate"]].append(point)
    daily_summary = []
    for day, rows in sorted(daily.items()):
        valid = [p["errorMw"] for p in rows if p["errorMw"] is not None]
        daily_summary.append({"decisionDate": day, "intervals": len(rows), "matched": len(valid),
                              "maeMw": round(sum(abs(e) for e in valid) / len(valid), 2) if valid else None,
                              "biasMw": round(sum(valid) / len(valid), 2) if valid else None})
    return {"month": first.strftime("%Y-%m"), "cutoff": cutoff.strftime("%H:%M"), "timezone": "Europe/London",
            "assumptions": {"monthMeaning": "decision dates", "deliveryOffsetDays": 1, "cutoffIsUserConfigurable": True},
            "metrics": {"maeMw": round(mae, 2) if mae is not None else None,
                        "rmseMw": round(rmse, 2) if rmse is not None else None,
                        "biasMw": round(bias, 2) if bias is not None else None,
                        "matchedIntervals": len(scored), "forecastIntervals": sum(p["forecastMw"] is not None for p in points),
                        "expectedIntervals": len(points),
                        "coveragePct": round(100 * len(scored) / len(points), 1) if points else None},
            "daily": daily_summary, "series": points,
            "sourceStatus": {"forecastRowsRead": data["forecast_rows"], "actualRowsRead": data["actual_rows"]}}


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/analysis")
async def analysis(month: str = Query("2026-01", pattern=r"^\d{4}-\d{2}$"),
                   cutoff: str = Query("12:30", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")) -> dict[str, Any]:
    try:
        parsed_cutoff = time.fromisoformat(cutoff)
        data = await get_month_data(month)
        return evaluate_month(data, parsed_cutoff)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not build analysis: {exc}") from exc


dist = Path(__file__).resolve().parents[2] / "static"
if dist.exists():
    app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
