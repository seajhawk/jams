"""Physical keypress burst provider."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from jams_worker.pipeline import PipelineContext
from jams_worker.providers.audio_onsets import (
    AudioOnset,
    AudioOnsetArtifact,
    SpeechRegion,
    ensure_audio_onsets,
)
from jams_worker.providers.physical_effort_params import AudioOnsetParams, KeypressParams
from jams_worker.providers.proxy_motion import MotionArtifact, ensure_proxy_motion

PROVIDER_ID = "physical.keypresses"
PROVIDER_VERSION = "1.0.0"


@dataclass(frozen=True, slots=True)
class KeypressBurst:
    t_start_ms: int
    t_end_ms: int
    count: int
    confidence: float
    onset_count: int
    count_merged: bool
    visually_corroborated: bool
    spec_selfsim: float | None


def _artifact_blob_path(context: PipelineContext, kinds: tuple[str, ...]) -> str | None:
    placeholders = ", ".join(["%s"] * len(kinds))
    row = context.db_conn.execute(
        f"""
        select blob_path
        from analysis_artifacts
        where run_id = %s
          and kind in ({placeholders})
        order by created_at desc
        limit 1
        """,
        (context.run_id, *kinds),
    ).fetchone()
    if row is None:
        return None
    return str(row[0])


def _download_derived(context: PipelineContext, blob_path: str, target: Path) -> None:
    container = context.blob_service_client.get_container_client("derived")
    blob = container.get_blob_client(blob_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("wb") as file:
        blob.download_blob().readinto(file)


def _audio(context: PipelineContext) -> Path | None:
    local = context.workdir / "audio.wav"
    if local.exists():
        return local
    blob_path = _artifact_blob_path(context, ("audio_wav_16k", "audio_wav"))
    if blob_path is None:
        return None
    _download_derived(context, blob_path, local)
    return local


def _normalized_video(context: PipelineContext) -> Path | None:
    local = context.workdir / "normalized.mp4"
    if local.exists():
        return local
    blob_path = _artifact_blob_path(context, ("video_normalized", "normalized_video"))
    if blob_path is None:
        return None
    _download_derived(context, blob_path, local)
    return local


def _speech_regions_from_transcript(path: Path) -> tuple[SpeechRegion, ...]:
    if not path.exists():
        return ()
    payload = json.loads(path.read_text(encoding="utf-8"))
    regions = payload.get("vad_regions")
    if not isinstance(regions, list):
        regions = payload.get("utterances", [])
    result: list[SpeechRegion] = []
    for row in regions:
        if not isinstance(row, dict):
            continue
        start = row.get("t_start_ms", row.get("t0"))
        end = row.get("t_end_ms", row.get("t1"))
        if isinstance(start, int) and isinstance(end, int) and end >= start:
            result.append(SpeechRegion(start, end))
    return tuple(result)


def _transcript(context: PipelineContext) -> Path | None:
    local = context.workdir / "transcript.json"
    if local.exists():
        return local
    blob_path = _artifact_blob_path(context, ("transcript_json",))
    if blob_path is None:
        return None
    _download_derived(context, blob_path, local)
    return local


def speech_regions_for_context(context: PipelineContext) -> tuple[SpeechRegion, ...]:
    transcript = _transcript(context)
    return _speech_regions_from_transcript(transcript) if transcript is not None else ()


def _cosine(left: np.ndarray, right: np.ndarray) -> float:
    denom = float(np.linalg.norm(left) * np.linalg.norm(right))
    if denom <= 1e-9:
        return 0.0
    return float(np.dot(left, right) / denom)


def _alternate_pair_sim(onsets: list[AudioOnset]) -> float:
    even = [
        np.asarray(onset.feats[:4], dtype=np.float32)
        for index, onset in enumerate(onsets)
        if index % 2 == 0
    ]
    odd = [
        np.asarray(onset.feats[:4], dtype=np.float32)
        for index, onset in enumerate(onsets)
        if index % 2 == 1
    ]
    count = min(len(even), len(odd))
    if count == 0:
        return 0.0
    return float(np.mean([_cosine(even[index], odd[index]) for index in range(count)]))


def _is_visual_peak(motion: MotionArtifact, t_ms: int, params: KeypressParams) -> bool:
    if len(motion.diff_energy) < 3:
        return False
    indices = np.flatnonzero(
        (motion.frame_ms >= t_ms - params.visual_peak_window_ms)
        & (motion.frame_ms <= t_ms + params.visual_peak_window_ms)
    )
    if len(indices) == 0:
        return False
    baseline = float(np.percentile(motion.diff_energy, 65))
    for index in indices:
        if index <= 0 or index >= len(motion.diff_energy) - 1:
            continue
        value = float(motion.diff_energy[index])
        if (
            value >= baseline
            and value >= float(motion.diff_energy[index - 1])
            and value >= float(motion.diff_energy[index + 1])
        ):
            return True
    return False


def _visually_corroborated(
    onsets: list[AudioOnset],
    motion: MotionArtifact | None,
    params: KeypressParams,
) -> bool:
    if motion is None or not onsets:
        return False
    hits = sum(1 for onset in onsets if _is_visual_peak(motion, onset.t_ms, params))
    return hits / len(onsets) >= params.visual_peak_share_min


def _confidence(
    onsets: list[AudioOnset],
    *,
    spec_selfsim: float | None,
    visually_corroborated: bool,
    count_merged: bool,
    params: KeypressParams,
) -> float:
    confidence = 0.55
    if spec_selfsim is not None and spec_selfsim >= params.spec_selfsim_bonus_min:
        confidence += 0.15
    if visually_corroborated:
        confidence += 0.15
    if all(not onset.in_speech for onset in onsets):
        confidence += 0.10
    if count_merged:
        confidence -= 0.15
    return round(max(0.30, min(0.90, confidence)), 4)


def _burst_from_onsets(
    onsets: list[AudioOnset],
    *,
    motion: MotionArtifact | None,
    params: KeypressParams,
) -> KeypressBurst | None:
    if not onsets:
        return None
    count = len(onsets)
    count_merged = False
    if len(onsets) >= 4:
        ioi = np.diff([onset.t_ms for onset in onsets])
        if (
            len(ioi)
            and float(np.mean(ioi <= params.pair_ioi_max_ms)) >= params.pair_ioi_fraction_min
            and _alternate_pair_sim(onsets) >= params.pair_spec_sim_min
        ):
            count = math.ceil(len(onsets) / 2)
            count_merged = True

    spec_selfsim = next(
        (onset.spec_selfsim for onset in onsets if onset.spec_selfsim is not None),
        None,
    )
    corroborated = _visually_corroborated(onsets, motion, params)
    confidence = _confidence(
        onsets,
        spec_selfsim=spec_selfsim,
        visually_corroborated=corroborated,
        count_merged=count_merged,
        params=params,
    )
    if confidence < params.suppress_below:
        return None
    return KeypressBurst(
        t_start_ms=max(0, onsets[0].t_ms - 30),
        t_end_ms=onsets[-1].t_ms + 80,
        count=count,
        confidence=confidence,
        onset_count=len(onsets),
        count_merged=count_merged,
        visually_corroborated=corroborated,
        spec_selfsim=spec_selfsim,
    )


def detect_keypress_bursts(
    artifact: AudioOnsetArtifact,
    *,
    motion: MotionArtifact | None = None,
    params: KeypressParams | None = None,
) -> list[KeypressBurst]:
    params = params or KeypressParams()
    typing = sorted(
        [onset for onset in artifact.onsets if onset.label == "typing"],
        key=lambda onset: onset.t_ms,
    )
    if not typing:
        return []

    bursts: list[KeypressBurst] = []
    current: list[AudioOnset] = []
    for onset in typing:
        if not current or onset.t_ms - current[-1].t_ms < params.pause_split_ms:
            current.append(onset)
            continue
        burst = _burst_from_onsets(current, motion=motion, params=params)
        if burst is not None:
            bursts.append(burst)
        current = [onset]
    burst = _burst_from_onsets(current, motion=motion, params=params)
    if burst is not None:
        bursts.append(burst)
    return bursts


class KeypressesProvider:
    def __init__(
        self,
        *,
        onset_params: AudioOnsetParams | None = None,
        params: KeypressParams | None = None,
    ) -> None:
        self._onset_params = onset_params or AudioOnsetParams()
        self._params = params or KeypressParams()

    @property
    def id(self) -> str:
        return PROVIDER_ID

    @property
    def version(self) -> str:
        return PROVIDER_VERSION

    @property
    def requires(self) -> list[str]:
        return ["artifact:audio_wav", "artifact:audio_onsets_v1", "artifact:proxy_motion_v1"]

    @property
    def provides(self) -> list[str]:
        return ["measure:keypresses"]

    def run(self, context: PipelineContext) -> list[dict[str, Any]]:
        context.heartbeat(self.id, 10, "Detecting keypress bursts")
        audio = _audio(context)
        if audio is None:
            context.report_provider_summary(
                self.id,
                {"status": "skipped", "reason": "no_audio", "skipped": "no_audio"},
            )
            return []

        speech_regions = speech_regions_for_context(context)
        artifact = ensure_audio_onsets(
            audio,
            context.workdir,
            speech_regions=speech_regions,
            params=self._onset_params,
        )
        video = _normalized_video(context)
        motion = ensure_proxy_motion(video, context.workdir) if video is not None else None
        bursts = detect_keypress_bursts(artifact, motion=motion, params=self._params)
        context.report_provider_summary(
            self.id,
            {
                "status": "ok",
                "measure_count": len(bursts),
                "estimated_keys": sum(burst.count for burst in bursts),
                "audio_onsets": len(artifact.onsets),
            },
        )
        context.heartbeat(self.id, 95, f"Detected {len(bursts)} keypress bursts")
        return [
            {
                "kind": "keypresses",
                "category": "physical",
                "t_start_ms": burst.t_start_ms,
                "t_end_ms": burst.t_end_ms,
                "value_num": burst.count,
                "value_text": None,
                "unit": "keys",
                "confidence": burst.confidence,
                "source": "video_analysis",
                "payload": {
                    "type": "multiple",
                    "count": burst.count,
                    "keys": None,
                    "onset_count": burst.onset_count,
                    "count_merged": burst.count_merged,
                    "visually_corroborated": burst.visually_corroborated,
                    "spec_selfsim": burst.spec_selfsim,
                    "audio_onsets_builder_version": artifact.builder_version,
                },
            }
            for burst in bursts
        ]
