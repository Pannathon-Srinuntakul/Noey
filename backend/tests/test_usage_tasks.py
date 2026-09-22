"""Task grouping — the shares (never token counts) GET /usage/me reports per task."""

from packages.llm.usage import USAGE_TASKS, task_for_feature


def test_every_recorded_feature_maps_to_a_known_task() -> None:
    # The feature strings actually written by the app (grep UsageCtx()).
    recorded = ["video_cut", "video_effects", "video_style", "chat", "prompt_cron"]
    for feature in recorded:
        assert task_for_feature(feature) in USAGE_TASKS


def test_legacy_feature_names_still_group() -> None:
    # Rows written before the split must not silently vanish from the totals.
    assert task_for_feature("video") == "cut"
    assert task_for_feature("video_edit") == "cut"


def test_unknown_and_missing_features_fall_back_to_other() -> None:
    assert task_for_feature("something_new") == "other"
    assert task_for_feature(None) == "other"
    assert task_for_feature("") == "other"


def test_free_plan_has_a_monthly_limit_so_a_percentage_exists() -> None:
    # A share of "unlimited" is not a number — the settings screen needs a limit.
    from packages.billing import limits

    assert limits.window_limit("free", "monthly") == 100_000
    assert limits.plan_limits("free").windows == ("monthly",)


def test_build_usage_tasks_always_lists_all_four() -> None:
    from packages.llm.usage import build_usage_tasks

    rows = build_usage_tasks({"video_cut": 100})
    assert [r["task"] for r in rows] == list(USAGE_TASKS)
    # Zero tasks are reported, not omitted.
    assert all(r["pct"] == 0.0 for r in rows if r["task"] != "cut")


def test_build_usage_tasks_percentages_sum_to_a_hundred() -> None:
    from packages.llm.usage import build_usage_tasks

    rows = build_usage_tasks({"video_cut": 510, "video_effects": 300, "chat": 190})
    by = {r["task"]: r for r in rows}
    assert by["cut"]["pct"] == 51.0
    assert by["effects"]["pct"] == 30.0
    assert by["other"]["pct"] == 19.0
    assert round(sum(float(r["pct"]) for r in rows)) == 100


def test_build_usage_tasks_merges_legacy_features_into_cut() -> None:
    from packages.llm.usage import build_usage_tasks

    by = {r["task"]: r for r in build_usage_tasks({"video": 50, "video_edit": 50})}
    assert by["cut"]["pct"] == 100.0
    # Users never see token counts (docs/token-billing-plan.md §1).
    assert all(set(r) == {"task", "pct"} for r in by.values())


def test_build_usage_tasks_handles_a_period_with_no_usage() -> None:
    from packages.llm.usage import build_usage_tasks

    rows = build_usage_tasks({})
    # No division by zero, and no task claiming a share of nothing.
    assert all(r["pct"] == 0.0 for r in rows)
