"""ตัดไฮไลต์จากคลิปยาว has no target length — the server drops it.

A highlight that stands on its own ends where the thought ends. A number fixed
before the clip is read leaves the selector only bad options: pad a highlight
past its ending, or cut one before it. Owner decision, 2026-09-23.

The web UI stopped asking, but the rule belongs on the server too: a desktop
build from before the change still sends one, and it must get the same cut.
"""

from tests.admin_helpers import (  # noqa: F401
    _admin_env,
    bearer,
    client,
    db,
    email,
    make_user,
    user_token,
)


async def _create(c, token: str, mode: str, target: int | None):
    return await c.post(
        "/videos/local",
        json={
            "mode": mode,
            "target_duration_sec": target,
            "clips": [{"id": "c1", "durationSec": 120}],
        },
        headers=bearer(token),
    )


async def _target_of(uid: str) -> int | None:
    rows = await db(
        "SELECT target_duration_sec FROM video_projects WHERE uid = :u", u=uid
    )
    return rows[0][0]


async def test_speech_highlights_stores_no_target_length():
    token = await user_token(await make_user(email("hl"), plan="pro"))
    async with client() as c:
        r = await _create(c, token, "speech_highlights", 60)
    assert r.status_code == 201
    assert await _target_of(r.json()["uid"]) is None


async def test_other_modes_keep_the_length_they_were_given():
    # The rule is about ONE mode. dub_first's target is the script's length and
    # has nothing to do with highlight selection — dropping it here would change
    # a different feature.
    token = await user_token(await make_user(email("hl"), plan="pro"))
    async with client() as c:
        r = await _create(c, token, "dub_first", 60)
    assert r.status_code == 201
    assert await _target_of(r.json()["uid"]) == 60


async def test_speech_scenes_keeps_its_length():
    # ตัดฉากเด่น picks segments to fill a length the user asked for; only the
    # long-clip highlight mode decides its own.
    token = await user_token(await make_user(email("hl"), plan="pro"))
    async with client() as c:
        r = await _create(c, token, "speech_scenes", 45)
    assert r.status_code == 201
    assert await _target_of(r.json()["uid"]) == 45
