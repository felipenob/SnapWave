"""
audio_engine.py
Multi-channel audio processing engine for multi-speaker transcription cleaning.
Supports 16-bit, 24-bit PCM and 32-bit float WAV files.
Calculates global and high-resolution windowed waveform peaks for instant UI rendering.
Calculates multi-channel RMS energy for crosstalk detection.
"""

import os
import wave
import struct
import math
from typing import Dict, List, Tuple, Optional

try:
    import numpy as np
    HAS_NUMPY = True
except ImportError:
    np = None
    HAS_NUMPY = False


class AudioChannel:
    """Represents a single participant's audio track."""
    def __init__(self, participant_id: str, file_path: str):
        self.participant_id = participant_id
        self.file_path = file_path
        self.sample_rate = 16000
        self.num_channels = 1
        self.sample_width = 2
        self.total_samples = 0
        self.duration_seconds = 0.0
        self._global_peaks_cache = None
        self._inspect_file()

    def _inspect_file(self):
        """Quickly reads WAV header without loading entire audio into memory."""
        try:
            with wave.open(self.file_path, "rb") as wf:
                self.sample_rate = wf.getframerate()
                self.num_channels = wf.getnchannels()
                self.sample_width = wf.getsampwidth()
                self.total_samples = wf.getnframes()
                self.duration_seconds = self.total_samples / float(self.sample_rate) if self.sample_rate > 0 else 0.0
        except Exception as e:
            print(f"[AudioChannel] Error inspecting {self.file_path}: {e}")

    def read_samples(self, start_sec: float, end_sec: float) -> Tuple[List[float], int]:
        """
        Reads audio samples within [start_sec, end_sec] as normalized float values in [-1.0, 1.0].
        Returns (samples_list_or_numpy, sample_rate).
        """
        start_frame = max(0, int(start_sec * self.sample_rate))
        end_frame = min(self.total_samples, int(end_sec * self.sample_rate))
        num_frames = max(0, end_frame - start_frame)

        if num_frames == 0:
            return ([] if not HAS_NUMPY else np.array([], dtype=np.float32)), self.sample_rate

        with wave.open(self.file_path, "rb") as wf:
            wf.setpos(start_frame)
            raw_bytes = wf.readframes(num_frames)

        if self.sample_width == 2:  # 16-bit PCM
            if HAS_NUMPY:
                data = np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                if self.num_channels > 1:
                    data = data.reshape(-1, self.num_channels).mean(axis=1)
                return data, self.sample_rate
            else:
                total_samples = len(raw_bytes) // 2
                fmt = f"<{total_samples}h"
                ints = struct.unpack(fmt, raw_bytes)
                if self.num_channels > 1:
                    mono = []
                    for i in range(0, len(ints), self.num_channels):
                        mono.append(sum(ints[i:i+self.num_channels]) / (self.num_channels * 32768.0))
                    return mono, self.sample_rate
                else:
                    return [s / 32768.0 for s in ints], self.sample_rate

        elif self.sample_width == 3:  # 24-bit PCM
            if HAS_NUMPY:
                a = np.frombuffer(raw_bytes, dtype=np.uint8)
                a = a.reshape(-1, 3)
                ints = (a[:, 0].astype(np.int32) |
                        (a[:, 1].astype(np.int32) << 8) |
                        ((a[:, 2].astype(np.int32) ^ 0x80) << 16) - 0x800000)
                data = ints.astype(np.float32) / 8388608.0
                if self.num_channels > 1:
                    data = data.reshape(-1, self.num_channels).mean(axis=1)
                return data, self.sample_rate
            else:
                samples = []
                for i in range(0, len(raw_bytes), 3):
                    b = raw_bytes[i:i+3]
                    val = int.from_bytes(b, byteorder="little", signed=True)
                    samples.append(val / 8388608.0)
                if self.num_channels > 1:
                    mono = []
                    for i in range(0, len(samples), self.num_channels):
                        mono.append(sum(samples[i:i+self.num_channels]) / self.num_channels)
                    return mono, self.sample_rate
                return samples, self.sample_rate

        elif self.sample_width == 4:  # 32-bit float or PCM
            if HAS_NUMPY:
                data = np.frombuffer(raw_bytes, dtype=np.float32)
                if self.num_channels > 1:
                    data = data.reshape(-1, self.num_channels).mean(axis=1)
                return data, self.sample_rate
            else:
                total_samples = len(raw_bytes) // 4
                fmt = f"<{total_samples}f"
                samples = list(struct.unpack(fmt, raw_bytes))
                return samples, self.sample_rate

        return ([] if not HAS_NUMPY else np.array([], dtype=np.float32)), self.sample_rate

    def get_rms_db(self, start_sec: float, end_sec: float) -> float:
        """Calculates RMS energy in dBFS for the segment [start_sec, end_sec]."""
        samples, _ = self.read_samples(start_sec, end_sec)
        if len(samples) == 0:
            return -100.0

        if HAS_NUMPY:
            mean_sq = float(np.mean(samples ** 2))
        else:
            mean_sq = sum(s * s for s in samples) / len(samples)

        if mean_sq < 1e-10:
            return -100.0
        return 10.0 * math.log10(mean_sq)

    def compute_peaks(self, num_points: int = 1500) -> List[float]:
        """
        Computes overview waveform peaks across the ENTIRE file using strided seeking.
        Works reliably for files of any length (from 1 second to 3+ hours).
        """
        if self._global_peaks_cache is not None and len(self._global_peaks_cache) == num_points * 2:
            return self._global_peaks_cache

        if self.total_samples == 0:
            return [0.0] * (num_points * 2)

        step = max(1, self.total_samples // num_points)
        peaks = []
        window_size = min(512, step)

        try:
            with wave.open(self.file_path, "rb") as wf:
                for i in range(num_points):
                    pos = min(self.total_samples - 1, int(i * step))
                    wf.setpos(pos)
                    read_count = min(window_size, self.total_samples - pos)
                    raw = wf.readframes(read_count)
                    if not raw:
                        peaks.extend([0.0, 0.0])
                        continue

                    if self.sample_width == 2:
                        if HAS_NUMPY:
                            chunk = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                            if self.num_channels > 1:
                                chunk = chunk.reshape(-1, self.num_channels).mean(axis=1)
                            peaks.append(float(np.min(chunk)))
                            peaks.append(float(np.max(chunk)))
                        else:
                            total = len(raw) // 2
                            ints = struct.unpack(f"<{total}h", raw)
                            if self.num_channels > 1:
                                ints = [ints[k] for k in range(0, len(ints), self.num_channels)]
                            vals = [v / 32768.0 for v in ints]
                            peaks.append(min(vals))
                            peaks.append(max(vals))
                    else:
                        # Fallback using read_samples
                        t_sec = pos / float(self.sample_rate)
                        chunk, _ = self.read_samples(t_sec, t_sec + (window_size / float(self.sample_rate)))
                        if len(chunk) > 0:
                            if HAS_NUMPY:
                                peaks.append(float(np.min(chunk)))
                                peaks.append(float(np.max(chunk)))
                            else:
                                peaks.append(min(chunk))
                                peaks.append(max(chunk))
                        else:
                            peaks.extend([0.0, 0.0])

        except Exception as e:
            print(f"[AudioChannel] Error computing global peaks for {self.file_path}: {e}")

        # Ensure exact length
        target_len = num_points * 2
        if len(peaks) < target_len:
            peaks.extend([0.0] * (target_len - len(peaks)))
        else:
            peaks = peaks[:target_len]

        self._global_peaks_cache = peaks
        return peaks

    def compute_window_peaks(self, start_sec: float, end_sec: float, num_points: int = 1000) -> List[float]:
        """
        Computes high-resolution waveform peaks for a specific time window [start_sec, end_sec].
        Produces sharp, pixel-perfect waveforms when viewing individual utterances.
        """
        samples, _ = self.read_samples(start_sec, end_sec)
        n_samples = len(samples)

        if n_samples == 0:
            return [0.0] * (num_points * 2)

        peaks = []
        step = max(1, n_samples // num_points)

        if HAS_NUMPY and isinstance(samples, np.ndarray):
            for i in range(0, n_samples, step):
                chunk = samples[i:i + step]
                if len(chunk) > 0:
                    peaks.append(float(np.min(chunk)))
                    peaks.append(float(np.max(chunk)))
        else:
            for i in range(0, n_samples, step):
                chunk = samples[i:i + step]
                if len(chunk) > 0:
                    peaks.append(min(chunk))
                    peaks.append(max(chunk))

        target_len = num_points * 2
        if len(peaks) < target_len:
            peaks.extend([0.0] * (target_len - len(peaks)))
        else:
            peaks = peaks[:target_len]

        return peaks


class MultiSpeakerSession:
    """Manages all 4 synchronized participant channels in an experiment session."""
    def __init__(self, session_dir: str):
        self.session_dir = session_dir
        self.channels: Dict[str, AudioChannel] = {}
        self.srt_files: Dict[str, str] = {}
        self.discover_files()

    def discover_files(self):
        """Scans session_dir for participant audio and srt files."""
        if not os.path.isdir(self.session_dir):
            return

        all_files = os.listdir(self.session_dir)
        for fname in all_files:
            if fname.lower().endswith(".wav"):
                p_id = os.path.splitext(fname)[0]
                full_path = os.path.join(self.session_dir, fname)
                self.channels[p_id] = AudioChannel(p_id, full_path)

        # Discovered SRT files
        all_srts = [f for f in all_files if f.lower().endswith(".srt") and not f.endswith(".bak")]

        # 1. Exact match pass: <p_id>.srt
        for p_id in self.channels.keys():
            exact_name = f"{p_id}.srt"
            if exact_name in all_srts:
                self.srt_files[p_id] = os.path.join(self.session_dir, exact_name)
            else:
                matched = [f for f in all_srts if f.lower() == exact_name.lower()]
                if matched:
                    self.srt_files[p_id] = os.path.join(self.session_dir, matched[0])

        # 2. Fuzzy match pass for channels without exact match (e.g. 1_cleaned.srt or P1.srt)
        for p_id in self.channels.keys():
            if p_id in self.srt_files:
                continue
            candidates = [
                f for f in all_srts
                if f.lower().startswith(f"{p_id.lower()}_") or f.lower().startswith(f"{p_id.lower()}.")
            ]
            if candidates:
                cleaned_cand = [c for c in candidates if "cleaned" in c.lower()]
                chosen = cleaned_cand[0] if cleaned_cand else candidates[0]
                self.srt_files[p_id] = os.path.join(self.session_dir, chosen)
            else:
                p_cand = [f for f in all_srts if f.lower() == f"p{p_id.lower()}.srt"]
                if p_cand:
                    self.srt_files[p_id] = os.path.join(self.session_dir, p_cand[0])

        # 3. Also index any remaining SRT files by their base name
        for fname in all_srts:
            base = os.path.splitext(fname)[0]
            if base not in self.srt_files:
                self.srt_files[base] = os.path.join(self.session_dir, fname)

    def check_crosstalk(
        self,
        target_speaker: str,
        start_sec: float,
        end_sec: float,
        threshold_db: float = 9.0
    ) -> Dict:
        """
        Computes multi-channel RMS energy across all active participants during [start_sec, end_sec].
        """
        energies = {}
        for p_id, channel in self.channels.items():
            energies[p_id] = channel.get_rms_db(start_sec, end_sec)

        if target_speaker not in energies:
            return {
                "is_crosstalk": False,
                "target_energy_db": -100.0,
                "dominant_speaker": target_speaker,
                "dominant_energy_db": -100.0,
                "energy_diff_db": 0.0,
                "all_energies": energies
            }

        target_energy = energies[target_speaker]
        dominant_speaker = max(energies, key=energies.get)
        dominant_energy = energies[dominant_speaker]
        energy_diff = dominant_energy - target_energy

        is_crosstalk = (dominant_speaker != target_speaker) and (energy_diff >= threshold_db)

        return {
            "is_crosstalk": is_crosstalk,
            "target_energy_db": round(target_energy, 1),
            "dominant_speaker": dominant_speaker,
            "dominant_energy_db": round(dominant_energy, 1),
            "energy_diff_db": round(energy_diff, 1),
            "all_energies": {k: round(v, 1) for k, v in energies.items()}
        }
