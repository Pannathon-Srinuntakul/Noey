"""Noey desktop sidecar — local ffmpeg render engine.

Spawned by the Electron main process. Talks a JSON-lines protocol on stdout;
reuses the render helpers in ``backend/packages/video`` (added to sys.path by
:mod:`sidecar.bootstrap`) without modifying the backend in any way.
"""
