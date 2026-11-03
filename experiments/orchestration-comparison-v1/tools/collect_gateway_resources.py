#!/usr/bin/env python3
"""Sample a Gateway process tree without reading command lines or environment variables."""

from __future__ import annotations

import argparse
import csv
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    import psutil
except ImportError:
    print("Missing dependency: install requirements-resources.txt with the same Python interpreter.", file=sys.stderr)
    raise SystemExit(2)


FIELDS = [
    "recorded_at_utc", "run_id", "strategy", "scenario_id", "phase", "elapsed_seconds",
    "root_pid", "root_name", "process_count", "process_pids", "cpu_pct_host_capacity",
    "cpu_pct_one_core", "memory_rss_mb",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid", type=int, required=True, help="PID of the isolated OpenClaw Gateway root process")
    parser.add_argument("--run-id", required=True, help="Unique run ID matching results-template.csv")
    parser.add_argument("--strategy", required=True, choices=["A", "B", "C", "baseline"])
    parser.add_argument("--scenario-id", required=True, help="Scenario ID, or 'baseline' for idle baseline")
    parser.add_argument("--phase", required=True, choices=["baseline", "run"])
    parser.add_argument("--duration-seconds", type=float, required=True)
    parser.add_argument("--interval-seconds", type=float, default=1.0)
    parser.add_argument("--output", type=Path, required=True, help="CSV path; existing compatible CSV will be appended")
    args = parser.parse_args()
    if args.duration_seconds <= 0 or args.interval_seconds <= 0:
        parser.error("duration and interval must be positive")
    if args.phase == "baseline" and args.strategy != "baseline":
        parser.error("baseline phase must use strategy=baseline")
    if args.phase == "run" and args.strategy == "baseline":
        parser.error("run phase must use strategy A, B, or C")
    return args


def snapshot(root_pid: int) -> tuple[dict[int, tuple[float, int, str]], str]:
    """Return pid -> (user+system CPU seconds, RSS bytes, process name) for root and descendants."""
    try:
        root = psutil.Process(root_pid)
        processes = [root, *root.children(recursive=True)]
        root_name = root.name()
    except psutil.NoSuchProcess as exc:
        raise RuntimeError(f"Gateway PID {root_pid} is not running") from exc

    result: dict[int, tuple[float, int, str]] = {}
    for process in processes:
        try:
            if process.status() == psutil.STATUS_ZOMBIE:
                continue
            times = process.cpu_times()
            rss = process.memory_info().rss
            result[process.pid] = (times.user + times.system, rss, process.name())
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
    if root_pid not in result:
        raise RuntimeError(f"Cannot read Gateway PID {root_pid}; check permissions and process state")
    return result, root_name


def append_row(path: Path, row: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    exists = path.exists() and path.stat().st_size > 0
    if exists:
        with path.open("r", newline="", encoding="utf-8") as current:
            header = next(csv.reader(current), [])
        if header != FIELDS:
            raise RuntimeError(f"Existing CSV has an incompatible header: {path}")
    with path.open("a", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(output, fieldnames=FIELDS)
        if not exists:
            writer.writeheader()
        writer.writerow(row)


def main() -> int:
    args = parse_args()
    if args.interval_seconds < 0.2:
        print("Warning: intervals below 0.2 seconds may add measurement overhead.", file=sys.stderr)

    previous, root_name = snapshot(args.pid)
    previous_time = time.monotonic()
    started = previous_time
    cpu_count = max(1, psutil.cpu_count(logical=True) or 1)

    while True:
        remaining = args.duration_seconds - (time.monotonic() - started)
        if remaining <= 0:
            break
        time.sleep(min(args.interval_seconds, remaining))
        current, current_root_name = snapshot(args.pid)
        now = time.monotonic()
        elapsed = max(now - previous_time, 1e-9)
        cpu_delta = 0.0
        for pid, (cpu_seconds, _rss, _name) in current.items():
            old = previous.get(pid)
            cpu_delta += cpu_seconds if old is None else max(0.0, cpu_seconds - old[0])
        total_cpu_pct = cpu_delta / elapsed * 100.0
        memory_bytes = sum(item[1] for item in current.values())
        row = {
            "recorded_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "run_id": args.run_id,
            "strategy": args.strategy,
            "scenario_id": args.scenario_id,
            "phase": args.phase,
            "elapsed_seconds": f"{time.monotonic() - started:.3f}",
            "root_pid": args.pid,
            "root_name": current_root_name or root_name,
            "process_count": len(current),
            "process_pids": ";".join(str(pid) for pid in sorted(current)),
            "cpu_pct_host_capacity": f"{total_cpu_pct / cpu_count:.3f}",
            "cpu_pct_one_core": f"{total_cpu_pct:.3f}",
            "memory_rss_mb": f"{memory_bytes / (1024 * 1024):.3f}",
        }
        append_row(args.output, row)
        previous, previous_time = current, now

    print(f"Resource samples appended: {args.output}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"Resource collection failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
