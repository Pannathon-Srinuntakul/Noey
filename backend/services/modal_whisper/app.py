"""Modal Whisper service — GPU transcription endpoint.

Deploy:  modal deploy services/modal_whisper/app.py
Test:    modal run services/modal_whisper/app.py

The Railway worker calls this endpoint via HTTP POST with the WAV audio bytes.
Returns transcript JSON compatible with the existing pipeline.
"""

import modal

app = modal.App("noey-whisper")

# Container image with faster-whisper + Thonburian model pre-downloaded
image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04",
        add_python="3.12",
    )
    .pip_install(
        "faster-whisper==1.1.1",
        "huggingface-hub",
        "pythainlp",
        "fastapi[standard]",
        "requests",
        "httpx",
    )
    .run_commands(
        'python -c "from faster_whisper import WhisperModel; WhisperModel(\'large-v3-turbo\', device=\'cpu\')"'
    )
)

MODEL_ID = "large-v3-turbo"
LANGUAGE = "th"
# Per-chunk ceiling; worker sends ≤3 min WAV per request (see MODAL_CHUNK_SEC in tasks.py).
MODAL_TIMEOUT_SEC = 600


@app.cls(
    gpu="L4",   # was T4 — ~1.5-2x faster, 24 GiB VRAM, cost-efficient inference
    image=image,
    timeout=MODAL_TIMEOUT_SEC,
    scaledown_window=300,   # keep warm 5 min after last request
)
class WhisperService:
    @modal.enter()
    def load_model(self) -> None:
        from faster_whisper import WhisperModel
        self.model = WhisperModel(MODEL_ID, device="cuda", compute_type="float16")

    @modal.method()
    def transcribe(self, audio_bytes: bytes, language: str = LANGUAGE, vad_filter: bool = True) -> dict:
        import tempfile, os, time

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(audio_bytes)
            wav_path = f.name

        try:
            opts = {
                "language": language or None,
                "beam_size": 5,
                "word_timestamps": True,
                "condition_on_previous_text": False,
                "initial_prompt": (
                    "แอฟฟิลิเอต คอมมิชชั่น ลิงก์ในไบโอ คลิกลิงก์ สินค้า รีวิว โปรโมชั่น "
                    "ส่วนลด คูปอง ออเดอร์ แบรนด์ คอนเทนต์ ครีเอเตอร์ ไลฟ์สด ยอดขาย "
                    "ตะกร้า เพิ่มในตะกร้า ชำระเงิน TikTok Shop"
                ),
                "vad_filter": vad_filter,
                "no_speech_threshold": 0.80,
                "log_prob_threshold": -2.0,
                "compression_ratio_threshold": 2.4,
                "temperature": [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
            }
            if vad_filter:
                opts["vad_parameters"] = {
                    "min_silence_duration_ms": 500,
                    "speech_pad_ms": 350,
                    "threshold": 0.30,
                }

            segs, info = self.model.transcribe(wav_path, **opts)
            segments = []
            dropped = 0
            for seg in segs:
                no_speech = getattr(seg, "no_speech_prob", 0.0)
                avg_lp = getattr(seg, "avg_logprob", 0.0)
                comp = getattr(seg, "compression_ratio", 0.0)
                text = (seg.text or "").strip()
                if not text or no_speech >= 0.80 or avg_lp < -2.0 or comp > 2.4:
                    dropped += 1
                    continue
                tight = _tighten({
                    "start": seg.start, "end": seg.end, "text": text,
                    "words": [{"word": w.word, "start": w.start, "end": w.end} for w in (seg.words or [])],
                })
                segments.append(tight)

            return {
                "segments": segments,
                "language": getattr(info, "language", "th"),
                "dropped": dropped,
            }
        finally:
            os.unlink(wav_path)


def _tighten(seg: dict) -> dict:
    """Inline tighten without importing backend packages."""
    words = list(seg.get("words") or [])
    start, end = float(seg["start"]), float(seg["end"])
    if not words:
        return {**seg, "start": round(start, 3), "end": round(end, 3)}
    fixed = []
    for i, w in enumerate(words):
        ws, we = float(w["start"]), float(w["end"])
        if we - ws > 1.2:
            we = ws + 1.2
        if i + 1 < len(words):
            nxt = float(words[i + 1]["start"])
            if nxt > ws:
                we = min(we, max(ws + 0.04, nxt - 0.03))
        we = max(we, ws)
        fixed.append({**w, "start": round(ws, 3), "end": round(we, 3)})
    last_end = float(fixed[-1]["end"])
    overhang = end - last_end
    new_end = last_end + 0.15 if overhang > 1.0 else min(end, last_end + 0.45) if overhang > 0 else max(end, last_end)
    return {**seg, "start": round(start, 3), "end": round(max(new_end, start), 3), "words": fixed}


from pydantic import BaseModel


class TranscribePayload(BaseModel):
    audio_b64: str
    language: str = LANGUAGE
    vad_filter: bool = True


@app.function(image=image, timeout=MODAL_TIMEOUT_SEC)
@modal.fastapi_endpoint(method="POST")
def transcribe_endpoint(payload: TranscribePayload) -> dict:
    """HTTP POST endpoint — receives base64 WAV, returns transcript JSON."""
    import base64
    audio_bytes = base64.b64decode(payload.audio_b64)
    svc = WhisperService()
    result = svc.transcribe.remote(audio_bytes, payload.language, payload.vad_filter)
    return result
