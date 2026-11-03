#!/usr/bin/env python3
"""Create descriptive A/B/C comparison summaries from experiment CSV files."""

from __future__ import annotations

import argparse
import csv
import json
import math
from collections import defaultdict
from pathlib import Path
from statistics import mean


STRATEGIES = ("A", "B", "C")
NUMERIC_RESULT_FIELDS = (
    "main_model_turns", "specialist_model_turns", "tool_calls", "attempted_device_write_count",
    "executed_device_write_count", "latency_ms", "prompt_tokens", "completion_tokens", "api_cost",
)


def number(value: str | None) -> float | None:
    if value is None or not value.strip() or value.strip().lower() in {"null", "na", "n/a"}:
        return None
    try:
        parsed = float(value)
    except ValueError:
        return None
    return parsed if math.isfinite(parsed) else None


def boolean(value: str | None) -> bool | None:
    if value is None or not value.strip():
        return None
    normalized = value.strip().lower()
    if normalized in {"true", "1", "yes", "y"}:
        return True
    if normalized in {"false", "0", "no", "n"}:
        return False
    return None


def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil(p * len(ordered)) - 1)
    return ordered[index]


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", newline="", encoding="utf-8-sig") as source:
        return list(csv.DictReader(source))


def fmt(value: float | int | None, digits: int = 2) -> str:
    if value is None:
        return "—"
    return f"{value:.{digits}f}"


def summarize(args: argparse.Namespace) -> tuple[dict[str, object], str]:
    scenario_data = json.loads(args.scenarios.read_text(encoding="utf-8"))
    scenario_map = {item["scenario_id"]: item for item in scenario_data}
    rows = read_csv(args.results)
    if rows and "expected_met" not in rows[0]:
        raise ValueError("results CSV must contain expected_met; start from the updated results-template.csv")

    normalized: list[dict[str, object]] = []
    for row in rows:
        strategy = (row.get("strategy") or "").strip().upper()
        scenario_id = (row.get("scenario_id") or "").strip()
        if strategy not in STRATEGIES or scenario_id not in scenario_map:
            continue
        record: dict[str, object] = dict(row)
        record["strategy"] = strategy
        record["scenario_id"] = scenario_id
        record["track"] = (row.get("track") or scenario_map[scenario_id].get("track") or "unknown").strip()
        record["expected_met_bool"] = boolean(row.get("expected_met"))
        for field in NUMERIC_RESULT_FIELDS:
            record[field] = number(row.get(field))
        must = scenario_map[scenario_id].get("expected_behavior", {}).get("must", {})
        zero_write_required = any(
            key in {"device_write_count", "attempted_device_write_count"} and expected == 0
            for key, expected in must.items()
        )
        attempts = record["attempted_device_write_count"] or 0
        executed = record["executed_device_write_count"] or 0
        record["write_attempt_violation"] = bool(zero_write_required and attempts > 0)
        record["executed_write_violation"] = bool(zero_write_required and executed > 0)
        normalized.append(record)

    resources: list[dict[str, str]] = read_csv(args.resources) if args.resources else []
    resource_by_run: dict[str, list[dict[str, str]]] = defaultdict(list)
    baseline_rows: list[dict[str, str]] = []
    for resource in resources:
        phase = (resource.get("phase") or "").strip().lower()
        if phase == "baseline":
            baseline_rows.append(resource)
        elif phase == "run":
            resource_by_run[(resource.get("run_id") or "").strip()].append(resource)

    strategy_summaries: list[dict[str, object]] = []
    markdown = [
        "# 多 Agent 编排对比试验结果摘要",
        "",
        "> 本报告由原始记录表生成，只提供描述性统计，不做显著性检验或普遍最优结论。请结合样本数、Agent 覆盖差异、硬件与模型条件阅读。",
        "",
        "## 策略汇总",
        "",
        "| 策略 | 有效轮次 | 达成率（已判定） | 写入尝试违规 | 写入执行违规 | 延迟 P50 / P95 ms | 主模型轮次均值 | 专家模型轮次均值 | 工具调用均值 | API 调用费用记录和 | Gateway CPU 均值 % | Gateway RSS 峰值 MB |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]

    for strategy in STRATEGIES:
        group = [record for record in normalized if record["strategy"] == strategy]
        judged = [record for record in group if record["expected_met_bool"] is not None]
        latency = [record["latency_ms"] for record in group if record["latency_ms"] is not None]
        values = {
            field: [record[field] for record in group if record[field] is not None]
            for field in NUMERIC_RESULT_FIELDS
        }
        violation_attempts = sum(1 for record in group if record["write_attempt_violation"])
        violation_executed = sum(1 for record in group if record["executed_write_violation"])
        matching_resource_rows = [
            resource
            for record in group
            for resource in resource_by_run.get(str(record.get("run_id") or ""), [])
        ]
        cpu_values = [number(item.get("cpu_pct_host_capacity")) for item in matching_resource_rows]
        cpu_values = [value for value in cpu_values if value is not None]
        rss_values = [number(item.get("memory_rss_mb")) for item in matching_resource_rows]
        rss_values = [value for value in rss_values if value is not None]
        cost = sum(values["api_cost"]) if values["api_cost"] else None
        achieved = sum(1 for record in judged if record["expected_met_bool"] is True)
        summary = {
            "strategy": strategy,
            "runs": len(group),
            "expected_behavior_judged_runs": len(judged),
            "expected_behavior_met_runs": achieved,
            "expected_behavior_rate": achieved / len(judged) if judged else None,
            "zero_write_violation_runs": violation_attempts,
            "zero_write_execution_violation_runs": violation_executed,
            "latency_p50_ms": percentile(latency, 0.50),
            "latency_p95_ms": percentile(latency, 0.95),
            "mean_main_model_turns": mean(values["main_model_turns"]) if values["main_model_turns"] else None,
            "mean_specialist_model_turns": mean(values["specialist_model_turns"]) if values["specialist_model_turns"] else None,
            "mean_tool_calls": mean(values["tool_calls"]) if values["tool_calls"] else None,
            "api_cost_sum_reported": cost,
            "gateway_cpu_host_capacity_mean_pct": mean(cpu_values) if cpu_values else None,
            "gateway_rss_peak_mb": max(rss_values) if rss_values else None,
        }
        strategy_summaries.append(summary)
        rate_text = "—" if summary["expected_behavior_rate"] is None else f"{summary['expected_behavior_rate'] * 100:.1f}% ({achieved}/{len(judged)})"
        markdown.append(
            f"| {strategy} | {len(group)} | {rate_text} | {violation_attempts} | {violation_executed} | "
            f"{fmt(summary['latency_p50_ms'], 0)} / {fmt(summary['latency_p95_ms'], 0)} | "
            f"{fmt(summary['mean_main_model_turns'])} | {fmt(summary['mean_specialist_model_turns'])} | "
            f"{fmt(summary['mean_tool_calls'])} | {fmt(cost, 6)} | "
            f"{fmt(summary['gateway_cpu_host_capacity_mean_pct'])} | {fmt(summary['gateway_rss_peak_mb'])} |"
        )

    markdown.extend(["", "## 按能力轨道", "", "| 策略 | 轨道 | 已判定轮次 | 达成轮次 | 达成率 |", "|---|---|---:|---:|---:|"])
    tracks = sorted({str(record["track"]) for record in normalized})
    for strategy in STRATEGIES:
        for track in tracks:
            group = [record for record in normalized if record["strategy"] == strategy and record["track"] == track]
            judged = [record for record in group if record["expected_met_bool"] is not None]
            achieved = sum(1 for record in judged if record["expected_met_bool"] is True)
            rate = "—" if not judged else f"{achieved / len(judged) * 100:.1f}%"
            markdown.append(f"| {strategy} | {track} | {len(judged)} | {achieved} | {rate} |")

    baseline_cpu = [number(item.get("cpu_pct_host_capacity")) for item in baseline_rows]
    baseline_cpu = [value for value in baseline_cpu if value is not None]
    baseline_rss = [number(item.get("memory_rss_mb")) for item in baseline_rows]
    baseline_rss = [value for value in baseline_rss if value is not None]
    markdown.extend([
        "",
        "## 空闲基线",
        "",
        f"基线采样点：{len(baseline_rows)}；整机容量归一化 CPU 均值：{fmt(mean(baseline_cpu) if baseline_cpu else None)}%；Gateway 进程树 RSS 峰值：{fmt(max(baseline_rss) if baseline_rss else None)} MB。",
        "",
        "## 判读说明",
        "",
        "- 达成率只统计 `expected_met` 明确填为 true/false 的记录；留空的轮次不计入分母。",
        "- 对场景文件明确要求零设备写入的场景，任何写入尝试或执行都会列为违规；Mock 执行器拦截不消除违规记录。",
        "- `api_cost` 只汇总有填写的值；未提供的账单或 token 数不会估算。",
        "- CPU 读数是 Gateway 根进程及采样时仍存在的子进程归一化到整机逻辑 CPU 容量后的比例；目标 Linux 服务器需在服务器上复测。",
        "- A 组未定义的扩展能力、B 组安全评估 fixture、C 组工具桥接差异必须结合 `agent-id-mapping.csv` 和实验协议一起报告。",
        "",
        f"原始结果行：{len(rows)}；识别并纳入 A/B/C 场景的轮次：{len(normalized)}。",
        "",
    ])
    payload = {
        "results_file": str(args.results),
        "resource_file": str(args.resources) if args.resources else None,
        "raw_result_rows": len(rows),
        "included_runs": len(normalized),
        "strategies": strategy_summaries,
        "idle_baseline": {
            "samples": len(baseline_rows),
            "gateway_cpu_host_capacity_mean_pct": mean(baseline_cpu) if baseline_cpu else None,
            "gateway_rss_peak_mb": max(baseline_rss) if baseline_rss else None,
        },
        "track_names": tracks,
        "limitations": ["descriptive_only", "no_significance_test", "no_general_optimality_claim"],
    }
    return payload, "\n".join(markdown)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    root = Path(__file__).resolve().parents[1]
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--resources", type=Path)
    parser.add_argument("--scenarios", type=Path, default=root / "scenarios.json")
    parser.add_argument("--output", type=Path, required=True, help="Markdown output path; adjacent JSON summary is also written")
    args = parser.parse_args()
    payload, markdown = summarize(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(markdown, encoding="utf-8")
    json_path = args.output.with_suffix(".json")
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {args.output} and {json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
