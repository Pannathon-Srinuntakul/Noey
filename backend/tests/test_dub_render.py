"""Extracted dub render cores — real ffmpeg over lavfi-generated clips."""

from __future__ import annotations

import subprocess
import zipfile
from pathlib import Path

import pytest

from packages.video.dub_render import (
    build_dub_bundle_zip,
    concat_stream_copy,
    mix_audio_layers,
    mux_voiceover,
    norm_for_clip,
    prepare_clips_dir,
    trim_one_segment,
    trim_segments_silent,
    write_dub_script_txt,
)
from packages.video.ffmpeg_bin import ffmpeg_cmd, has_audio_stream, media_duration


@pytest.fixture(scope="module")
def sample_clip(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("media") / "src.mp4"
    subprocess.run(
        [
            ffmpeg_cmd(), "-y",
            "-f", "lavfi", "-i", "testsrc=duration=6:size=320x240:rate=30",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest", str(out),
        ],
        check=True, capture_output=True,
    )
    return out


@pytest.fixture(scope="module")
def sample_vo(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("media") / "vo.m4a"
    subprocess.run(
        [
            ffmpeg_cmd(), "-y",
            "-f", "lavfi", "-i", "sine=frequency=880:duration=3",
            "-c:a", "aac", str(out),
        ],
        check=True, capture_output=True,
    )
    return out


@pytest.fixture(scope="module")
def sample_music(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("media") / "music.wav"
    subprocess.run(
        [
            ffmpeg_cmd(), "-y",
            "-f", "lavfi", "-i", "sine=frequency=220:duration=8",
            str(out),
        ],
        check=True, capture_output=True,
    )
    return out


SEGMENTS = [
    {"order": 1, "voiceoverLineId": 1, "sourceClip": "clip0", "sourceIn": 0.0, "sourceOut": 1.0,
     "voiceoverScript": "เปิดคลิป", "outputIn": 0.0, "outputOut": 1.0,
     "voiceoverLineOutputIn": 0.0, "voiceoverLineOutputOut": 1.0},
    {"order": 2, "voiceoverLineId": 2, "sourceClip": "clip0", "sourceIn": 2.0, "sourceOut": 3.5,
     "voiceoverScript": "ช่วงกลาง", "outputIn": 1.0, "outputOut": 2.5,
     "voiceoverLineOutputIn": 1.0, "voiceoverLineOutputOut": 2.5},
    {"order": 3, "voiceoverLineId": 2, "sourceClip": "clip0", "sourceIn": 4.0, "sourceOut": 5.0,
     "outputIn": 2.5, "outputOut": 3.5,
     "voiceoverLineOutputIn": 1.0, "voiceoverLineOutputOut": 3.5},
]


def test_norm_for_clip_maps_and_clamps(tmp_path: Path) -> None:
    files = [tmp_path / "norm_000.mp4", tmp_path / "norm_001.mp4"]
    assert norm_for_clip(files, "clip1") == files[1]
    assert norm_for_clip(files, "clip9") == files[0]  # clamped like the worker
    assert norm_for_clip(files, "weird") == files[0]


def test_prepare_clips_dir_drops_stale(tmp_path: Path) -> None:
    clips = tmp_path / "clips"
    clips.mkdir()
    (clips / "clip_000.mp4").write_bytes(b"stale")
    (clips / "keep.txt").write_text("x")
    prepare_clips_dir(clips)
    assert not (clips / "clip_000.mp4").exists()
    assert (clips / "keep.txt").exists()


def test_silent_render_pipeline(sample_clip: Path, tmp_path: Path) -> None:
    clips_dir = tmp_path / "clips"
    clip_paths = trim_segments_silent([sample_clip], SEGMENTS, clips_dir)
    assert len(clip_paths) == 3
    assert all(not has_audio_stream(p) for p in clip_paths)

    final = tmp_path / "final_silent.mp4"
    concat_stream_copy(clip_paths, final, tmp_path / "concat.txt")
    total_expected = sum(s["sourceOut"] - s["sourceIn"] for s in SEGMENTS)
    assert abs(media_duration(final) - total_expected) < 0.35

    script = tmp_path / "script.txt"
    write_dub_script_txt(SEGMENTS, "โบรชัวร์ทดสอบ", script)
    text = script.read_text(encoding="utf-8")
    assert "Brief: โบรชัวร์ทดสอบ" in text
    assert "[Line 1 | 0.0s → 1.0s]" in text
    assert "[Line 2 | 1.0s → 3.5s | 2 cuts]" in text
    assert "เปิดคลิป" in text
    assert text.rstrip().endswith("Total: 4s")

    zip_path = tmp_path / "dub_bundle.zip"
    build_dub_bundle_zip(final, script, clip_paths, zip_path)
    names = set(zipfile.ZipFile(zip_path).namelist())
    assert names == {"final_silent.mp4", "script.txt",
                     "clips/clip_001.mp4", "clips/clip_002.mp4", "clips/clip_003.mp4"}


def test_trim_one_segment_defaults(sample_clip: Path, tmp_path: Path) -> None:
    clips = tmp_path / "c"
    clips.mkdir()
    # No sourceOut → defaults to sourceIn + 3.0 (worker behavior)
    out = trim_one_segment([sample_clip], {"sourceClip": "clip0", "sourceIn": 1.0}, clips, 0, 1)
    assert abs(media_duration(out) - 3.0) < 0.35


def test_mux_voiceover_replaces_audio(sample_clip: Path, sample_vo: Path, tmp_path: Path) -> None:
    out = tmp_path / "with_vo.mp4"
    mux_voiceover(sample_clip, sample_vo, out)
    assert has_audio_stream(out)
    # -shortest: 6s video + 3s VO → ~3s output
    assert abs(media_duration(out) - 3.0) < 0.35


def test_mix_audio_layers_no_music_matches_mux_voiceover(
    sample_clip: Path, sample_vo: Path, tmp_path: Path
) -> None:
    out = tmp_path / "no_music.mp4"
    mix_audio_layers(sample_clip, sample_vo, None, out)
    assert has_audio_stream(out)
    assert abs(media_duration(out) - 3.0) < 0.35


def test_mix_audio_layers_with_music(
    sample_clip: Path, sample_vo: Path, sample_music: Path, tmp_path: Path
) -> None:
    out = tmp_path / "with_music.mp4"
    mix_audio_layers(sample_clip, sample_vo, sample_music, out, music_volume=0.3)
    assert has_audio_stream(out)
    # -shortest still bounds to the 6s video / 3s VO combo (amix duration="first" == VO).
    assert abs(media_duration(out) - 3.0) < 0.35


def test_mix_audio_layers_with_music_offset_and_trim(
    sample_clip: Path, sample_vo: Path, sample_music: Path, tmp_path: Path
) -> None:
    out = tmp_path / "with_music_offset.mp4"
    mix_audio_layers(
        sample_clip, sample_vo, sample_music, out,
        music_volume=0.3, music_offset_sec=1.0, music_trim_in_sec=2.0,
    )
    assert has_audio_stream(out)
    assert abs(media_duration(out) - 3.0) < 0.35


def test_mix_audio_layers_music_only_no_vo(
    sample_clip: Path, sample_music: Path, tmp_path: Path
) -> None:
    """dub_first's VO is optional — music alone must still produce audible
    output, bounded by the video's own (6s) length, not stretched or looped."""
    out = tmp_path / "music_only.mp4"
    mix_audio_layers(sample_clip, None, sample_music, out, music_volume=0.3)
    assert has_audio_stream(out)
    assert abs(media_duration(out) - 6.0) < 0.35


def test_mix_audio_layers_raises_with_no_layers(sample_clip: Path, tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        mix_audio_layers(sample_clip, None, None, tmp_path / "nope.mp4")
