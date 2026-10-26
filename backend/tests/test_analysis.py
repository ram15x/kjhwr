import asyncio
import sys
import unittest
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app.main as service


UTC = timezone.utc


def empty_month(first: date, following: date) -> dict:
    return {
        "first": first,
        "following": following,
        "forecast_by_start": {},
        "actual_by_start": {},
        "forecast_rows": 0,
        "actual_rows": 0,
    }


class AnalysisTests(unittest.TestCase):
    def test_month_bounds_and_invalid_month(self):
        self.assertEqual(service.month_bounds("2026-01"), (date(2026, 1, 1), date(2026, 2, 1)))
        self.assertEqual(service.month_bounds("2024-02"), (date(2024, 2, 1), date(2024, 3, 1)))
        with self.assertRaises(Exception):
            service.month_bounds("2026-13")

    def test_instants_and_dst_delivery_hour_counts(self):
        self.assertEqual(service.parse_instant("2026-01-01T00:00:00"), datetime(2026, 1, 1, tzinfo=UTC))
        self.assertIsNone(service.parse_instant("not-a-time"))
        march = service.evaluate_month(empty_month(date(2026, 3, 1), date(2026, 4, 1)), time(12, 30))
        october = service.evaluate_month(empty_month(date(2026, 10, 1), date(2026, 11, 1)), time(12, 30))
        self.assertEqual(march["metrics"]["expectedIntervals"], 743)
        self.assertEqual(october["metrics"]["expectedIntervals"], 745)

    def test_latest_forecast_before_cutoff_and_two_half_hour_actuals(self):
        delivery = datetime(2026, 1, 2, tzinfo=UTC)
        early_publish = datetime(2026, 1, 1, 11, 30, tzinfo=UTC)
        late_publish = datetime(2026, 1, 1, 12, 45, tzinfo=UTC)
        data = {
            "first": date(2026, 1, 1),
            "following": date(2026, 2, 1),
            "forecast_by_start": {delivery: [(early_publish, 20.0), (late_publish, 40.0)]},
            "actual_by_start": {
                delivery: (datetime(2026, 1, 3, tzinfo=UTC), 12.0),
                delivery + timedelta(minutes=30): (datetime(2026, 1, 3, tzinfo=UTC), 14.0),
            },
            "forecast_rows": 2,
            "actual_rows": 2,
        }

        result = service.evaluate_month(data, time(12, 30))
        first = result["series"][0]
        self.assertEqual(first["forecastMw"], 20.0)
        self.assertEqual(first["publishTime"], "2026-01-01T11:30:00Z")
        self.assertEqual(first["actualMw"], 13.0)
        self.assertEqual(first["errorMw"], 7.0)
        self.assertEqual(result["metrics"]["matchedIntervals"], 1)
        self.assertEqual(result["metrics"]["expectedIntervals"], 744)
        self.assertEqual(result["metrics"]["coveragePct"], 0.1)
        self.assertEqual(result["metrics"]["maeMw"], 7.0)
        self.assertEqual(result["metrics"]["rmseMw"], 7.0)
        self.assertEqual(result["metrics"]["biasMw"], 7.0)

    def test_missing_half_hour_actual_is_not_scored(self):
        delivery = datetime(2026, 1, 2, tzinfo=UTC)
        data = {
            "first": date(2026, 1, 1),
            "following": date(2026, 2, 1),
            "forecast_by_start": {delivery: [(datetime(2026, 1, 1, 11, 30, tzinfo=UTC), 20.0)]},
            "actual_by_start": {delivery: (datetime(2026, 1, 3, tzinfo=UTC), 12.0)},
            "forecast_rows": 1,
            "actual_rows": 1,
        }

        result = service.evaluate_month(data, time(12, 30))
        self.assertIsNone(result["series"][0]["actualMw"])
        self.assertEqual(result["metrics"]["matchedIntervals"], 0)
        self.assertIsNone(result["metrics"]["maeMw"])
        self.assertEqual(result["metrics"]["coveragePct"], 0.0)


class CacheTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        service._cache.clear()
        service._pending.clear()
        service._cache_lock = asyncio.Lock()

    async def asyncTearDown(self):
        service._cache.clear()
        service._pending.clear()

    async def test_cache_hit_and_forced_bypass(self):
        calls = []

        async def fake_load(month):
            calls.append(month)
            return {"value": len(calls)}

        with patch.object(service, "load_month", new=fake_load):
            first = await service.get_month_data("2026-01")
            cached = await service.get_month_data("2026-01")
            forced = await service.get_month_data("2026-01", force_refresh=True)
            self.assertIs(first, cached)
            self.assertEqual(forced, {"value": 2})
            self.assertEqual(len(calls), 2)

    async def test_concurrent_requests_share_load(self):
        gate = asyncio.Event()
        calls = []

        async def slow_load(month):
            calls.append(month)
            await gate.wait()
            return {"month": month}

        with patch.object(service, "load_month", new=slow_load):
            first = asyncio.create_task(service.get_month_data("2026-02"))
            await asyncio.sleep(0)
            second = asyncio.create_task(service.get_month_data("2026-02"))
            await asyncio.sleep(0)
            gate.set()
            self.assertEqual(await first, await second)
            self.assertEqual(len(calls), 1)

    async def test_failed_load_is_cleared_and_can_retry(self):
        calls = []

        async def flaky_load(month):
            calls.append(month)
            if len(calls) == 1:
                raise RuntimeError("upstream")
            return {"ok": True}

        with patch.object(service, "load_month", new=flaky_load):
            with self.assertRaises(RuntimeError):
                await service.get_month_data("2026-03")
            self.assertEqual(await service.get_month_data("2026-03"), {"ok": True})
            self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
