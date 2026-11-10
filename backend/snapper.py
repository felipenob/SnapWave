"""
snapper.py
Adaptive waveform snapping and silence/speech onset-offset analyzer.
Provides the single-key 'Snap to Wave' functionality:
- Trims leading and trailing silence
- Extends boundaries if speech was prematurely truncated
- Adds safety padding (+50ms) to protect unvoiced consonants
- Detects internal silence pauses (>600ms) to suggest or perform splitting
"""

import math
from typing import Dict, List, Tuple, Optional

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    np = None
    HAS_NUMPY = False


def calculate_frame_energies(
    samples,
    sample_rate: int,
    frame_ms: float = 10.0,
    hop_ms: float = 5.0
) -> Tuple[List[float], float]:
    """
    Computes RMS energy in dBFS for overlapping frames across the sample array.
    Returns:
        (energies_db, hop_sec)
    """
    frame_len = max(1, int((frame_ms / 1000.0) * sample_rate))
    hop_len = max(1, int((hop_ms / 1000.0) * sample_rate))
    hop_sec = hop_len / float(sample_rate)

    energies = []
    n_samples = len(samples)

    if HAS_NUMPY and isinstance(samples, np.ndarray):
        for start_idx in range(0, n_samples - frame_len + 1, hop_len):
            chunk = samples[start_idx:start_idx + frame_len]
            mean_sq = float(np.mean(chunk ** 2))
            if mean_sq < 1e-9:
                energies.append(-90.0)
            else:
                energies.append(10.0 * math.log10(mean_sq))
    else:
        for start_idx in range(0, n_samples - frame_len + 1, hop_len):
            chunk = samples[start_idx:start_idx + frame_len]
            if len(chunk) == 0:
                continue
            mean_sq = sum(s * s for s in chunk) / len(chunk)
            if mean_sq < 1e-9:
                energies.append(-90.0)
            else:
                energies.append(10.0 * math.log10(mean_sq))

    return energies, hop_sec


def estimate_noise_floor(energies: List[float]) -> float:
    """Estimates local ambient noise floor using 15th percentile of energy."""
    if not energies:
        return -60.0
    sorted_e = sorted(energies)
    p15_idx = int(len(sorted_e) * 0.15)
    return sorted_e[min(p15_idx, len(sorted_e) - 1)]


def snap_annotation_to_wave(
    samples,
    sample_rate: int,
    window_start_sec: float,
    current_start_sec: float,
    current_end_sec: float,
    safety_padding_ms: float = 50.0,
    margin_db: float = 6.0,
    min_speech_duration_ms: float = 40.0,
    min_pause_split_ms: float = 600.0,
    mode: str = "expand"
) -> Dict:
    """
    Analyzes an audio window around an annotation and snaps its boundaries to speech energy.

    Args:
        samples: Array/list of audio samples for [window_start_sec, window_end_sec]
        sample_rate: Audio sampling rate (e.g. 16000)
        window_start_sec: Timestamp corresponding to samples[0]
        current_start_sec: Existing annotation start time
        current_end_sec: Existing annotation end time
        safety_padding_ms: Safety margin to prevent clipping consonants (default: 50ms)
        margin_db: dB above noise floor to consider speech active (default: 6dB)
        min_speech_duration_ms: Minimum continuous speech burst (default: 40ms)
        min_pause_split_ms: Minimum internal silence gap to trigger split suggestion (default: 600ms)
        mode: "expand" (enlarge outward, default) or "trim" (shorten inward to core speech wave)

    Returns:
        Dict with new_start, new_end, delta_start_ms, delta_end_ms, has_internal_pause, split_point
    """
    if len(samples) == 0 or current_end_sec <= current_start_sec:
        return {
            "new_start": current_start_sec,
            "new_end": current_end_sec,
            "delta_start_ms": 0,
            "delta_end_ms": 0,
            "has_internal_pause": False,
            "split_point": None,
            "mode": mode
        }

    # 1. Compute Short-Time Energy envelope
    energies, hop_sec = calculate_frame_energies(samples, sample_rate, frame_ms=10.0, hop_ms=5.0)
    if not energies:
        return {
            "new_start": current_start_sec,
            "new_end": current_end_sec,
            "delta_start_ms": 0,
            "delta_end_ms": 0,
            "has_internal_pause": False,
            "split_point": None,
            "mode": mode
        }

    # 2. Local noise floor & adaptive threshold
    noise_floor_db = estimate_noise_floor(energies)

    # Helper to convert frame index to absolute seconds
    def frame_to_sec(idx: int) -> float:
        return window_start_sec + (idx * hop_sec)

    # Helper to convert absolute seconds to frame index
    def sec_to_frame(sec: float) -> int:
        idx = int((sec - window_start_sec) / hop_sec)
        return max(0, min(len(energies) - 1, idx))

    curr_start_frame = sec_to_frame(current_start_sec)
    curr_end_frame = sec_to_frame(current_end_sec)
    min_consecutive_frames = max(1, int((min_speech_duration_ms / 1000.0) / hop_sec))

    if mode == "trim":
        # TRIM MODE: Focus strictly on the primary/biggest soundwave inside the annotation
        inner_slice = energies[curr_start_frame:curr_end_frame + 1]
        peak_e = max(inner_slice) if inner_slice else noise_floor_db
        # Set a tighter threshold focused on the primary speech wave (e.g. within 16 dB of peak)
        speech_thresh_db = max(noise_floor_db + 8.0, peak_e - 16.0)
        speech_frames = [1 if e >= speech_thresh_db else 0 for e in energies]

        # Scan strictly INWARD from current_start_sec to find onset
        onset_frame = None
        search_start = curr_start_frame
        search_end = max(curr_start_frame, curr_end_frame - min_consecutive_frames)
        for i in range(search_start, search_end + 1):
            if sum(speech_frames[i:i + min_consecutive_frames]) == min_consecutive_frames:
                onset_frame = i
                break

        # Scan strictly INWARD from current_end_sec to find offset
        offset_frame = None
        search_offset_start = min(curr_end_frame, (onset_frame or curr_start_frame) + min_consecutive_frames)
        search_offset_end = curr_end_frame
        for i in range(search_offset_end, search_offset_start - 1, -1):
            if sum(speech_frames[i - min_consecutive_frames + 1:i + 1]) == min_consecutive_frames:
                offset_frame = i
                break

        # Trim mode uses minimal padding (10ms) and strictly clamps to avoid enlarging
        trim_pad_sec = min(0.015, (safety_padding_ms / 1000.0))
        if onset_frame is not None:
            onset_sec = max(current_start_sec, frame_to_sec(onset_frame) - trim_pad_sec)
        else:
            onset_sec = current_start_sec

        if offset_frame is not None:
            offset_sec = min(current_end_sec, frame_to_sec(offset_frame) + trim_pad_sec)
        else:
            offset_sec = current_end_sec

    else:
        # EXPAND / ENLARGE MODE: Look outward (+/- 0.5s) to recover clipped speech and breathing
        speech_thresh_db = max(noise_floor_db + margin_db, -55.0)
        speech_frames = [1 if e >= speech_thresh_db else 0 for e in energies]

        onset_frame = None
        search_start = max(0, curr_start_frame - int(0.5 / hop_sec))
        search_end = min(len(speech_frames) - min_consecutive_frames, curr_end_frame)
        for i in range(search_start, search_end + 1):
            if sum(speech_frames[i:i + min_consecutive_frames]) == min_consecutive_frames:
                onset_frame = i
                break

        offset_frame = None
        search_offset_start = max(0, curr_start_frame)
        search_offset_end = min(len(speech_frames) - 1, curr_end_frame + int(0.5 / hop_sec))
        for i in range(search_offset_end, search_offset_start + min_consecutive_frames - 1, -1):
            if sum(speech_frames[i - min_consecutive_frames + 1:i + 1]) == min_consecutive_frames:
                offset_frame = i
                break

        if onset_frame is None:
            onset_sec = current_start_sec
        else:
            onset_sec = max(0.0, frame_to_sec(onset_frame) - (safety_padding_ms / 1000.0))

        if offset_frame is None:
            offset_sec = current_end_sec
        else:
            offset_sec = frame_to_sec(offset_frame) + (safety_padding_ms / 1000.0)

    # Ensure valid duration
    if offset_sec <= onset_sec + 0.08:
        new_start = current_start_sec
        new_end = current_end_sec
    else:
        new_start = round(onset_sec, 3)
        new_end = round(offset_sec, 3)

    # 6. Check for internal silence pause
    has_internal_pause = False
    split_point = None
    min_pause_frames = int((min_pause_split_ms / 1000.0) / hop_sec)

    start_f = sec_to_frame(new_start + (safety_padding_ms / 1000.0))
    end_f = sec_to_frame(new_end - (safety_padding_ms / 1000.0))

    if end_f - start_f > min_pause_frames * 2:
        curr_silence_len = 0
        best_silence_len = 0
        best_silence_mid_f = None

        for f in range(start_f, end_f):
            if speech_frames[f] == 0:
                curr_silence_len += 1
            else:
                if curr_silence_len >= min_pause_frames and curr_silence_len > best_silence_len:
                    best_silence_len = curr_silence_len
                    best_silence_mid_f = f - (curr_silence_len // 2)
                curr_silence_len = 0

        if curr_silence_len >= min_pause_frames and curr_silence_len > best_silence_len:
            best_silence_len = curr_silence_len
            best_silence_mid_f = end_f - (curr_silence_len // 2)

        if best_silence_mid_f is not None:
            has_internal_pause = True
            split_point = round(frame_to_sec(best_silence_mid_f), 3)

    delta_start_ms = int((new_start - current_start_sec) * 1000)
    delta_end_ms = int((new_end - current_end_sec) * 1000)

    return {
        "new_start": new_start,
        "new_end": new_end,
        "delta_start_ms": delta_start_ms,
        "delta_end_ms": delta_end_ms,
        "has_internal_pause": has_internal_pause,
        "split_point": split_point
    }
