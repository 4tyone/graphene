"""Run the official MnemeBrain BMB against Graphene and record the score.

The scenarios, the runner and the scoring are all the benchmark's own — this
only supplies the adapter and writes the artifact. Spec 10 §2: a number that is
not reproducible from a committed harness does not get published.

    GRAPHENE_BIN=target/debug/gr python3 bench/run_bmb.py
"""

from __future__ import annotations

import json
import os
import pathlib
import sys

# The benchmark is a third-party repo, pinned rather than vendored. Spec 10 §2
# asks for a number anyone can reproduce; a SHA is what makes that possible
# without copying someone else's suite into ours.
HARNESS_REPO = "git@github.com:mnemebrain/mnemebrain-benchmark.git"
HARNESS_COMMIT = "c8bd56a809c3ac624817370dc8b9eb5cdf6a7342"

HERE = pathlib.Path(__file__).resolve().parent
BENCHMARK = HERE.parent / "mnemebrain-benchmark" / "src"
sys.path.insert(0, str(BENCHMARK))
sys.path.insert(0, str(HERE))

from graphene_adapter import GrapheneAdapter  # noqa: E402
from mnemebrain_benchmark.scenarios.loader import load_bmb_scenarios  # noqa: E402
from mnemebrain_benchmark.scoring import aggregate_by_category  # noqa: E402
from mnemebrain_benchmark.system_runner import SystemBenchmarkRunner  # noqa: E402


def main() -> int:
    scenarios = load_bmb_scenarios()
    adapter = GrapheneAdapter()
    runner = SystemBenchmarkRunner()
    results = runner.run_all([adapter], scenarios)

    scores = results[adapter.name()] if isinstance(results, dict) else results
    by_category = aggregate_by_category(scores)

    scored = {k: v for k, v in by_category.items() if not v.skipped}
    skipped = sorted(k for k, v in by_category.items() if v.skipped)
    overall_scored = (
        sum(v.score or 0.0 for v in scored.values()) / len(scored) if scored else 0.0
    )
    overall_all = sum(v.score or 0.0 for v in by_category.values()) / len(by_category)

    total_checks = sum(len(s.checks) for s in scores)
    passed_checks = sum(1 for s in scores for c in s.checks if c.passed)

    artifact = {
        "harness": "mnemebrain-benchmark, unmodified, driven through bench/graphene_adapter.py",
        "harness_repo": HARNESS_REPO,
        "harness_commit": HARNESS_COMMIT,
        "note": (
            "Graphene declares only the capabilities its belief layer implements. "
            "Categories it does not claim are SKIPPED by the benchmark, not scored zero — "
            "they belong to the knowledge-base component, which does not exist yet."
        ),
        "scenarios": len(scenarios),
        "checks_run": total_checks,
        "checks_passed": passed_checks,
        "declared_capabilities": sorted(c.value for c in adapter.capabilities()),
        "categories": {
            k: {
                "score": None if v.skipped else round(v.score or 0.0, 4),
                "skipped": v.skipped,
                "scenarios": len(v.scenario_scores),
            }
            for k, v in sorted(by_category.items())
        },
        "skipped_categories": skipped,
        "known_divergences": [
            {
                "scenario": "bmb_contradiction_resolved_by_retraction",
                "expected": "true",
                "graphene": "both",
                "why": (
                    "The scenario retracts an observation. I6 forbids that — an observation is "
                    "withdrawn by contradicting it, never by deleting it — so the evidence ends "
                    "BOTH rather than OUT, and an attacker that is itself disputed still disputes. "
                    "Support and attack are treated symmetrically: a BOTH premise contests what "
                    "rests on it, so a BOTH attacker contests what it attacks. Making this pass "
                    "would mean either relaxing I6 or breaking that symmetry, and neither is worth "
                    "one check."
                ),
            }
        ],
        "score_over_claimed_categories": round(overall_scored, 4),
        "score_over_all_categories": round(overall_all, 4),
    }

    out = HERE / "score.json"
    out.write_text(json.dumps(artifact, indent=2) + "\n")

    width = max(len(k) for k in by_category)
    print(f"{'category':<{width}}  score   scenarios")
    for k, v in sorted(by_category.items()):
        s = "skipped" if v.skipped else f"{(v.score or 0.0) * 100:5.1f}%"
        print(f"{k:<{width}}  {s:>7}  {len(v.scenario_scores):>9}")
    print()
    print(f"checks: {passed_checks}/{total_checks}")
    print(f"score over claimed categories: {overall_scored * 100:.1f}%")
    print(f"score over all 8 categories:   {overall_all * 100:.1f}%")
    print(f"skipped: {', '.join(skipped) or 'none'}")
    print(f"\nartifact: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
