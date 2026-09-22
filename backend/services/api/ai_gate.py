"""The verified-email gate on endpoints that START paid AI work.

ONE list, read by `current_user` (services/api/deps.py) — every authenticated
request passes through there before its endpoint runs, so no endpoint needs
editing and the refusal (403) comes before any upload is stored, any project
is marked busy or any job is queued. The policy itself is
`packages.llm.usage.ai_access_problem`, which `check_ai_access` also
applies before every model call (the worker's calls included).

Add a route here when you add an endpoint that queues or makes a model or
speech-to-text call — and make that endpoint call
``services.api.billing_start.start_paid_run`` too (reservation against the
plan's windows, free-tier and circuit-breaker checks). tests/test_email_flows.py
fails if an entry stops matching a real route; tests/test_billing_start.py fails
if one of them does not reserve.
"""

from fastapi import HTTPException, Request

from packages.llm.usage import ai_access_problem

#: (method, route path template) — `request.scope["route"].path`.
AI_ROUTES: frozenset[tuple[str, str]] = frozenset({
    ("POST", "/videos"),                              # server pipeline: STT + planning
    ("POST", "/videos/{uid}/voiceover"),              # plan_dub_timeline
    ("POST", "/videos/{uid}/analyze-frames"),         # dub cut from frames
    ("POST", "/videos/{uid}/analyze-video"),          # dub cut from the video proxy
    ("POST", "/videos/{uid}/plan-dub"),               # synchronous model call
    ("POST", "/videos/{uid}/transcribe-audio"),       # STT + planning (speech modes)
    ("POST", "/videos/{uid}/reedit-dub-scenes"),      # re-edit pass
    ("POST", "/videos/{uid}/plan-effects"),           # effects placement pass
    ("POST", "/effect-styles"),                       # style distillation
    ("POST", "/effect-styles/{uid}/regenerate"),      # style distillation
})


def enforce_ai_gate(request: Request, user: object) -> None:
    """403 (Thai detail) when this route starts AI work and the user may not."""
    route = request.scope.get("route")
    if (request.method, getattr(route, "path", None)) not in AI_ROUTES:
        return
    problem = ai_access_problem(user)
    if problem:
        raise HTTPException(status_code=403, detail=problem)
