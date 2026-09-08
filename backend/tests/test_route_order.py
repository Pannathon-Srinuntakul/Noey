"""The literal /videos paths must not be shadowed by /videos/{uid}."""
from services.api.main import create_app


def _ordered_paths(app) -> list[str]:
    """Every route path in match order.

    This FastAPI keeps an included router as a wrapper rather than flattening
    it into `app.routes`, so the walk has to descend into them — and the order
    it yields is the order requests are matched in, which is the whole point.
    """
    out: list[str] = []

    def walk(routes) -> None:
        for r in routes:
            # This FastAPI wraps each `include_router` call in a matcher object
            # that keeps the real router on `original_router`; older versions
            # exposed `.routes` directly. Handle both.
            inner = getattr(r, "original_router", None) or getattr(r, "routes", None)
            if inner is not None:
                walk(getattr(inner, "routes", inner))
                continue
            path = getattr(r, "path", None)
            if isinstance(path, str):
                out.append(path)

    walk(app.routes)
    return out


def test_literal_video_paths_are_registered_before_the_uid_route():
    """`GET /videos/{uid}` matches anything, including the word "storage".

    It swallowed `/videos/storage` once already — the request arrived as a
    lookup for a project whose uid was "storage" and 404'd. Registration order
    is the only thing keeping them apart, so it is pinned here.
    """
    paths = _ordered_paths(create_app())
    assert "/videos/{uid}" in paths, "the parameterised route is gone — this test needs rewriting"
    uid_at = paths.index("/videos/{uid}")

    for literal in ("/videos/storage", "/videos/poster", "/videos/transcode", "/videos/local"):
        assert literal in paths, f"{literal} is not registered at all"
        assert paths.index(literal) < uid_at, f"{literal} is shadowed by /videos/{{uid}}"
