"""Audio transient onset artifact shared by click and keypress providers."""

from __future__ import annotations

import hashlib
import json
import math
import wave
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np

from jams_worker.errors import PipelineError
from jams_worker.providers.physical_effort_params import AudioOnsetParams

AUDIO_ONSETS_ID = "audio_onsets_v1"
AUDIO_ONSETS_BUILDER_VERSION = "1.0.0"
FEATURE_NAMES = (
    "log_energy_0_500",
    "log_energy_500_2000",
    "log_energy_2000_4000",
    "log_energy_4000_8000",
    "ratio_500_2000_to_0_500",
    "ratio_2000_4000_to_500_2000",
    "ratio_4000_8000_to_2000_4000",
    "spectral_centroid_hz",
    "spectral_flatness_2000_8000",
    "hf_ratio_2000_8000",
    "decay_to_minus_20_db_ms",
    "crest_factor",
)


@dataclass(frozen=True, slots=True)
class SpeechRegion:
    t_start_ms: int
    t_end_ms: int


@dataclass(frozen=True, slots=True)
class AudioOnset:
    t_ms: int
    feats: tuple[float, ...]
    label: str
    train_id: int | None
    in_speech: bool
    requires_visual: bool
    threshold: float
    flux_peak: float
    spec_selfsim: float | None


@dataclass(frozen=True, slots=True)
class AudioOnsetArtifact:
    path: Path
    builder_version: str
    noise_floor: dict[str, float]
    onsets: tuple[AudioOnset, ...]


def _read_wav_mono(path: Path, params: AudioOnsetParams) -> np.ndarray:
    with wave.open(str(path), "rb") as wav:
        if wav.getframerate() != params.sample_rate_hz:
            raise PipelineError("corrupt_file", f"{path} is not 16 kHz audio")
        channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        if sample_width != 2:
            raise PipelineError("corrupt_file", f"{path} is not PCM16 audio")
        pcm = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1).astype(np.float32)
    return pcm.astype(np.float32) / 32768.0


def _mad(values: np.ndarray) -> float:
    median = float(np.median(values))
    return float(np.median(np.abs(values - median)))


def _source_hash(
    path: Path,
    speech_regions: tuple[SpeechRegion, ...],
    params: AudioOnsetParams,
) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    digest.update(
        json.dumps([asdict(region) for region in speech_regions], sort_keys=True).encode()
    )
    digest.update(json.dumps(asdict(params), sort_keys=True).encode())
    digest.update(AUDIO_ONSETS_BUILDER_VERSION.encode())
    return digest.hexdigest()[:16]


def artifact_path(
    audio_path: Path,
    workdir: Path,
    speech_regions: tuple[SpeechRegion, ...],
    params: AudioOnsetParams,
) -> Path:
    return workdir / AUDIO_ONSETS_ID / f"{_source_hash(audio_path, speech_regions, params)}.json"


def _frame_matrix(samples: np.ndarray, params: AudioOnsetParams) -> np.ndarray:
    if len(samples) < params.stft_window_samples:
        samples = np.pad(samples, (0, params.stft_window_samples - len(samples)))
    frame_count = 1 + (len(samples) - params.stft_window_samples) // params.stft_hop_samples
    shape = (frame_count, params.stft_window_samples)
    strides = (samples.strides[0] * params.stft_hop_samples, samples.strides[0])
    return np.lib.stride_tricks.as_strided(samples, shape=shape, strides=strides)


def _stft(samples: np.ndarray, params: AudioOnsetParams) -> tuple[np.ndarray, np.ndarray]:
    emphasized = np.empty_like(samples)
    emphasized[0] = samples[0] if len(samples) else 0.0
    emphasized[1:] = samples[1:] - (params.preemphasis * samples[:-1])
    frames = _frame_matrix(emphasized, params)
    window = np.hanning(params.stft_window_samples).astype(np.float32)
    spectra = np.abs(np.fft.rfft(frames * window, axis=1)).astype(np.float32)
    freqs = np.fft.rfftfreq(params.stft_window_samples, 1.0 / params.sample_rate_hz)
    return spectra, freqs


def _adaptive_threshold(strength: np.ndarray, params: AudioOnsetParams) -> np.ndarray:
    if len(strength) == 0:
        return strength
    hop_ms = 1000.0 * params.stft_hop_samples / params.sample_rate_hz
    radius = max(1, round(params.adaptive_window_ms / hop_ms))
    centers = np.arange(0, len(strength), max(1, params.threshold_sample_stride))
    if centers[-1] != len(strength) - 1:
        centers = np.append(centers, len(strength) - 1)

    sampled = []
    for center in centers:
        window = strength[max(0, center - radius) : min(len(strength), center + radius + 1)]
        median = float(np.median(window))
        sampled.append(median + params.adaptive_mad_multiplier * _mad(window))

    adaptive = np.interp(np.arange(len(strength)), centers, np.asarray(sampled, dtype=np.float32))
    global_median = float(np.median(strength))
    global_floor = global_median + params.global_mad_multiplier * _mad(strength)
    return np.maximum(adaptive, global_floor).astype(np.float32)


def _speech_mask(frame_ms: np.ndarray, speech_regions: tuple[SpeechRegion, ...]) -> np.ndarray:
    mask = np.zeros(len(frame_ms), dtype=np.bool_)
    for region in speech_regions:
        mask |= (frame_ms >= region.t_start_ms) & (frame_ms <= region.t_end_ms)
    return mask


def _peak_indices(
    flux: np.ndarray,
    threshold: np.ndarray,
    in_speech: np.ndarray,
    params: AudioOnsetParams,
) -> list[int]:
    if len(flux) < 3:
        return []
    effective_threshold = threshold.copy()
    if params.speech_policy == "exclude":
        effective_threshold[in_speech] = np.inf
    else:
        effective_threshold[in_speech] *= params.in_speech_threshold_multiplier

    candidates = np.flatnonzero(
        (flux[1:-1] > effective_threshold[1:-1])
        & (flux[1:-1] >= flux[:-2])
        & (flux[1:-1] > flux[2:])
    ) + 1
    refractory_frames = max(
        1,
        round(params.refractory_ms * params.sample_rate_hz / (1000 * params.stft_hop_samples)),
    )
    picked: list[int] = []
    for index in sorted(candidates.tolist(), key=lambda item: float(flux[item]), reverse=True):
        if all(abs(index - existing) > refractory_frames for existing in picked):
            picked.append(index)
    return sorted(picked)


def _band_energy(spectrum: np.ndarray, freqs: np.ndarray, low: float, high: float) -> float:
    band = spectrum[(freqs >= low) & (freqs < high)]
    if band.size == 0:
        return 0.0
    return float(np.sum(np.square(band)))


def _decay_ms(
    energy: np.ndarray,
    frame_index: int,
    params: AudioOnsetParams,
) -> float:
    peak = float(energy[frame_index])
    if peak <= 0:
        return 0.0
    target = peak * 0.01
    cap_frames = max(1, round(60 * params.sample_rate_hz / (1000 * params.stft_hop_samples)))
    for offset in range(1, cap_frames + 1):
        index = frame_index + offset
        if index >= len(energy) or float(energy[index]) <= target:
            return float(offset * params.stft_hop_samples * 1000 / params.sample_rate_hz)
    return 60.0


def _feature_vector(
    samples: np.ndarray,
    spectra: np.ndarray,
    freqs: np.ndarray,
    frame_energy: np.ndarray,
    frame_index: int,
    params: AudioOnsetParams,
) -> tuple[float, ...]:
    spectrum = spectra[frame_index]
    energies = [
        _band_energy(spectrum, freqs, 0, 500),
        _band_energy(spectrum, freqs, 500, 2000),
        _band_energy(spectrum, freqs, 2000, 4000),
        _band_energy(spectrum, freqs, 4000, 8001),
    ]
    eps = 1e-9
    total_energy = max(eps, sum(energies))
    magnitude_sum = float(np.sum(spectrum))
    centroid = float(np.sum(freqs * spectrum) / magnitude_sum) if magnitude_sum > eps else 0.0
    high = spectrum[(freqs >= 2000) & (freqs <= 8000)]
    flatness = (
        float(np.exp(np.mean(np.log(high + eps))) / (np.mean(high) + eps))
        if high.size
        else 0.0
    )
    hf_ratio = float((energies[2] + energies[3]) / total_energy)
    sample_index = frame_index * params.stft_hop_samples
    window = samples[sample_index : sample_index + params.stft_window_samples]
    rms = float(np.sqrt(np.mean(np.square(window)))) if window.size else 0.0
    crest = float(np.max(np.abs(window)) / rms) if rms > eps and window.size else 0.0
    feats = (
        *(math.log1p(value) for value in energies),
        math.log((energies[1] + eps) / (energies[0] + eps)),
        math.log((energies[2] + eps) / (energies[1] + eps)),
        math.log((energies[3] + eps) / (energies[2] + eps)),
        centroid,
        flatness,
        hf_ratio,
        _decay_ms(frame_energy, frame_index, params),
        crest,
    )
    return tuple(round(float(value), 6) for value in feats)


def _cosine_similarity(left: np.ndarray, right: np.ndarray) -> float:
    denom = float(np.linalg.norm(left) * np.linalg.norm(right))
    if denom <= 1e-9:
        return 0.0
    return float(np.dot(left, right) / denom)


def _mean_pairwise_similarity(specs: list[np.ndarray]) -> float:
    if len(specs) < 2:
        return 1.0
    sims = [
        _cosine_similarity(left, right)
        for i, left in enumerate(specs)
        for right in specs[i + 1 :]
    ]
    return float(np.mean(sims)) if sims else 1.0


def _classify(
    raw: list[dict[str, Any]],
    params: AudioOnsetParams,
) -> tuple[list[dict[str, Any]], dict[int, float]]:
    groups: list[list[int]] = []
    for index, onset in enumerate(raw):
        gap_ms = onset["t_ms"] - raw[groups[-1][-1]]["t_ms"] if groups else None
        if not groups or gap_ms > params.typing_train_max_gap_ms:
            groups.append([index])
        else:
            groups[-1].append(index)

    train_id = 0
    selfsim_by_train: dict[int, float] = {}
    for group in groups:
        times = [raw[index]["t_ms"] for index in group]
        ioi = np.diff(times)
        mean_ioi = float(np.mean(ioi)) if len(ioi) else 0.0
        cv = float(np.std(ioi) / mean_ioi) if mean_ioi > 0 else math.inf
        selfsim = _mean_pairwise_similarity([raw[index]["spec_vector"] for index in group])
        is_typing = (
            len(group) >= params.typing_min_count
            and params.typing_mean_ioi_min_ms <= mean_ioi <= params.typing_mean_ioi_max_ms
            and cv <= params.typing_ioi_cv_max
            and selfsim >= params.typing_spec_selfsim_min
        )
        if not is_typing:
            continue
        for index in group:
            raw[index]["label"] = "typing"
            raw[index]["train_id"] = train_id
            raw[index]["spec_selfsim"] = selfsim
        selfsim_by_train[train_id] = selfsim
        train_id += 1

    for onset in raw:
        if onset["label"] == "typing":
            continue
        feats = onset["feats"]
        decay_ms = float(feats[10])
        centroid_hz = float(feats[7])
        onset["label"] = (
            "click_candidate"
            if decay_ms <= params.click_decay_max_ms and centroid_hz >= params.click_centroid_min_hz
            else "ambiguous"
        )
    return raw, selfsim_by_train


def _build(
    path: Path,
    speech_regions: tuple[SpeechRegion, ...],
    params: AudioOnsetParams,
) -> dict[str, Any]:
    samples = _read_wav_mono(path, params)
    spectra, freqs = _stft(samples, params)
    # Decay uses the same envelope for every onset; compute it once per recording.
    frame_energy = np.sum(np.square(spectra), axis=1)
    logmag = np.log1p(spectra)
    hf_bins = (freqs >= 2000) & (freqs <= 8000)
    flux = np.zeros(len(spectra), dtype=np.float32)
    flux[1:] = np.sum(np.maximum(0.0, logmag[1:, hf_bins] - logmag[:-1, hf_bins]), axis=1)
    threshold = _adaptive_threshold(flux, params)
    frame_ms = np.rint(
        np.arange(len(spectra), dtype=np.float32)
        * params.stft_hop_samples
        * 1000.0
        / params.sample_rate_hz
    ).astype(np.int32)
    padded_speech = tuple(
        SpeechRegion(
            max(0, region.t_start_ms - params.speech_pad_ms),
            region.t_end_ms + params.speech_pad_ms,
        )
        for region in speech_regions
    )
    in_speech = _speech_mask(frame_ms, padded_speech)

    raw: list[dict[str, Any]] = []
    previous_t_ms: int | None = None
    for frame_index in _peak_indices(flux, threshold, in_speech, params):
        feats = _feature_vector(samples, spectra, freqs, frame_energy, frame_index, params)
        if feats[9] < params.hf_ratio_min:
            continue
        t_ms = int(frame_ms[frame_index])
        if previous_t_ms is not None and t_ms - previous_t_ms < params.merge_ms:
            if raw and float(flux[frame_index]) > raw[-1]["flux_peak"]:
                raw.pop()
            else:
                continue
        raw.append(
            {
                "t_ms": t_ms,
                "feats": feats,
                "label": "ambiguous",
                "train_id": None,
                "in_speech": bool(in_speech[frame_index]),
                "requires_visual": bool(in_speech[frame_index])
                and params.speech_policy != "exclude",
                "threshold": float(threshold[frame_index]),
                "flux_peak": float(flux[frame_index]),
                "spec_vector": spectra[frame_index, hf_bins].astype(np.float32),
                "spec_selfsim": None,
            }
        )
        previous_t_ms = t_ms

    classified, _selfsim_by_train = _classify(raw, params)
    onsets = [
        {
            "t_ms": int(onset["t_ms"]),
            "feats": list(onset["feats"]),
            "label": str(onset["label"]),
            "train_id": onset["train_id"],
            "in_speech": bool(onset["in_speech"]),
            "requires_visual": bool(onset["requires_visual"]),
            "threshold": round(float(onset["threshold"]), 6),
            "flux_peak": round(float(onset["flux_peak"]), 6),
            "spec_selfsim": (
                None
                if onset["spec_selfsim"] is None
                else round(float(onset["spec_selfsim"]), 6)
            ),
        }
        for onset in classified
    ]
    return {
        "builder_version": AUDIO_ONSETS_BUILDER_VERSION,
        "params": asdict(params),
        "feature_names": FEATURE_NAMES,
        "noise_floor": {
            "median_flux": round(float(np.median(flux)), 6),
            "mad_flux": round(_mad(flux), 6),
            "global_floor": round(
                float(np.median(flux)) + params.global_mad_multiplier * _mad(flux),
                6,
            ),
        },
        "speech_regions": [asdict(region) for region in padded_speech],
        "onsets": onsets,
    }


def _load(path: Path) -> AudioOnsetArtifact:
    data = json.loads(path.read_text(encoding="utf-8"))
    return AudioOnsetArtifact(
        path=path,
        builder_version=str(data["builder_version"]),
        noise_floor=dict(data.get("noise_floor") or {}),
        onsets=tuple(
            AudioOnset(
                t_ms=int(row["t_ms"]),
                feats=tuple(float(value) for value in row["feats"]),
                label=str(row["label"]),
                train_id=int(row["train_id"]) if row.get("train_id") is not None else None,
                in_speech=bool(row["in_speech"]),
                requires_visual=bool(row.get("requires_visual", False)),
                threshold=float(row.get("threshold", 0.0)),
                flux_peak=float(row.get("flux_peak", 0.0)),
                spec_selfsim=(
                    float(row["spec_selfsim"]) if row.get("spec_selfsim") is not None else None
                ),
            )
            for row in data.get("onsets", [])
        ),
    )


def ensure_audio_onsets(
    audio_path: Path,
    workdir: Path,
    *,
    speech_regions: tuple[SpeechRegion, ...] = (),
    params: AudioOnsetParams | None = None,
) -> AudioOnsetArtifact:
    params = params or AudioOnsetParams()
    path = artifact_path(audio_path, workdir, speech_regions, params)
    if path.exists():
        return _load(path)

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".tmp.json")
    payload = _build(audio_path, speech_regions, params)
    tmp_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp_path.replace(path)
    return _load(path)
