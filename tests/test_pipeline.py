"""
test_pipeline.py
Automated verification suite testing:
1. Snapping algorithm accuracy on synthetic audio with known onset/offset
2. Crosstalk cross-channel energy ratio calculation
3. SRT parsing and serialization roundtrip
4. ELAN .eaf XML export integrity
"""

import os
import sys
import wave
import struct
import math
import shutil
import tempfile

BACKEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "backend")
sys.path.insert(0, BACKEND_DIR)
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

from audio_engine import MultiSpeakerSession, AudioChannel
from snapper import snap_annotation_to_wave
from srt_handler import parse_srt, save_srt, export_multi_speaker_eaf


def generate_test_wav(file_path: str, duration: float, sample_rate: int = 16000, tone_start: float = 0.0, tone_end: float = 0.0, amplitude: float = 0.5):
    """Generates synthetic 16-bit mono WAV with a tone during [tone_start, tone_end]."""
    total_frames = int(duration * sample_rate)
    tone_start_frame = int(tone_start * sample_rate)
    tone_end_frame = int(tone_end * sample_rate)

    freq = 440.0 # A4 tone
    frames = []

    for i in range(total_frames):
        if tone_start_frame <= i <= tone_end_frame:
            val = amplitude * math.sin(2.0 * math.pi * freq * (i / sample_rate))
        else:
            val = 0.001 * math.sin(2.0 * math.pi * 60.0 * (i / sample_rate)) # Low baseline noise
        val_int = int(max(-32767, min(32767, val * 32767)))
        frames.append(struct.pack("<h", val_int))

    with wave.open(file_path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"".join(frames))


def run_tests():
    temp_dir = tempfile.mkdtemp(prefix="test_session_")
    print(f"Creating test environment in: {temp_dir}")

    try:
        # 1. Create synthetic 4-participant experiment files (3 seconds duration)
        # P1 has strong speech from 0.8s to 2.2s
        p1_wav = os.path.join(temp_dir, "P1.wav")
        generate_test_wav(p1_wav, duration=3.5, tone_start=0.8, tone_end=2.2, amplitude=0.7)

        # P2 has faint bleed from P1 (attenuated by ~16 dB)
        p2_wav = os.path.join(temp_dir, "P2.wav")
        generate_test_wav(p2_wav, duration=3.5, tone_start=0.8, tone_end=2.2, amplitude=0.08)

        # P3 & P4 have only silence/room tone
        p3_wav = os.path.join(temp_dir, "P3.wav")
        generate_test_wav(p3_wav, duration=3.5, tone_start=0.0, tone_end=0.0, amplitude=0.001)

        p4_wav = os.path.join(temp_dir, "P4.wav")
        generate_test_wav(p4_wav, duration=3.5, tone_start=0.0, tone_end=0.0, amplitude=0.001)

        # Create sample SRTs
        # P1 has an oversized, poorly snapped annotation from 0.2s to 3.2s
        p1_srt = os.path.join(temp_dir, "P1.srt")
        with open(p1_srt, "w", encoding="utf-8") as f:
            f.write("1\n00:00:00,200 --> 00:00:03,200\nThis is an untrimmed sentence.\n\n")

        # P2 has a false crosstalk annotation
        p2_srt = os.path.join(temp_dir, "P2.srt")
        with open(p2_srt, "w", encoding="utf-8") as f:
            f.write("1\n00:00:00,800 --> 00:00:02,200\n[Bleed from P1]\n\n")

        # ---------------- TEST 1: SRT Parsing ----------------
        annos_p1 = parse_srt(p1_srt)
        assert len(annos_p1) == 1, f"Expected 1 annotation, got {len(annos_p1)}"
        assert abs(annos_p1[0]["start"] - 0.2) < 0.01, f"Expected start 0.2, got {annos_p1[0]['start']}"
        assert abs(annos_p1[0]["end"] - 3.2) < 0.01, f"Expected end 3.2, got {annos_p1[0]['end']}"
        print("[PASS] Test 1: SRT Parsing Passed")

        # ---------------- TEST 2: MultiSpeakerSession Discovery ----------------
        session = MultiSpeakerSession(temp_dir)
        assert "P1" in session.channels, "P1 channel missing"
        assert "P2" in session.channels, "P2 channel missing"
        assert len(session.channels) == 4, f"Expected 4 channels, got {len(session.channels)}"
        print("[PASS] Test 2: Multi-Speaker Discovery Passed")

        # ---------------- TEST 3: Waveform Snapping (The Requested Feature) ----------------
        # P1 speech was 0.8s to 2.2s.
        # Initial annotation was 0.2s to 3.2s (600ms leading silence, 1000ms trailing silence).
        ch1 = session.channels["P1"]
        win_start = 0.0
        win_end = 3.5
        samples, sr = ch1.read_samples(win_start, win_end)

        snap_res = snap_annotation_to_wave(
            samples=samples,
            sample_rate=sr,
            window_start_sec=win_start,
            current_start_sec=0.2,
            current_end_sec=3.2,
            safety_padding_ms=50.0,
            margin_db=6.0
        )

        new_start = snap_res["new_start"]
        new_end = snap_res["new_end"]
        print(f"  Snapping result: {0.2:.2f}s -> {new_start:.2f}s (onset was 0.8s), {3.2:.2f}s -> {new_end:.2f}s (offset was 2.2s)")

        # With 50ms padding, new_start should be around 0.75s (within 0.1s of 0.75s)
        assert 0.70 <= new_start <= 0.85, f"Snapping onset inaccurate: {new_start}"
        # With 50ms padding, new_end should be around 2.25s (within 0.1s of 2.25s)
        assert 2.15 <= new_end <= 2.30, f"Snapping offset inaccurate: {new_end}"
        assert snap_res["delta_start_ms"] > 300, "Expected positive delta_start_ms trimming leading silence"
        assert snap_res["delta_end_ms"] < -500, "Expected negative delta_end_ms trimming trailing silence"
        print("[PASS] Test 3: Waveform Snapping ('Snap to Wave') Passed")

        # ---------------- TEST 4: Crosstalk Detection ----------------
        # Check P2 during speech window [0.8, 2.2]. P1 is the primary speaker, P2 is bleed.
        crosstalk_res = session.check_crosstalk("P2", 0.8, 2.2, threshold_db=9.0)
        print(f"  Crosstalk check for P2: is_crosstalk={crosstalk_res['is_crosstalk']}, dominant={crosstalk_res['dominant_speaker']}, diff={crosstalk_res['energy_diff_db']} dB")
        assert crosstalk_res["is_crosstalk"] is True, "Expected P2 to be identified as crosstalk"
        assert crosstalk_res["dominant_speaker"] == "P1", f"Expected dominant speaker P1, got {crosstalk_res['dominant_speaker']}"
        assert crosstalk_res["energy_diff_db"] >= 10.0, f"Expected energy diff >= 10dB, got {crosstalk_res['energy_diff_db']}"

        # Conversely, check P1 during speech window: should NOT be crosstalk
        p1_res = session.check_crosstalk("P1", 0.8, 2.2, threshold_db=9.0)
        assert p1_res["is_crosstalk"] is False, "P1 should not be flagged as crosstalk"
        print("[PASS] Test 4: Cross-Channel Crosstalk Detection Passed")

        # ---------------- TEST 5: SRT Saving & Backup ----------------
        annos_p1[0]["start"] = new_start
        annos_p1[0]["end"] = new_end
        annos_p1[0]["text"] = "Snapped sentence."
        save_success = save_srt(p1_srt, annos_p1, create_backup=True)
        assert save_success, "SRT save failed"
        assert os.path.exists(p1_srt + ".bak"), "Backup file was not created"

        # Re-parse to verify
        reloaded = parse_srt(p1_srt)
        assert reloaded[0]["text"] == "Snapped sentence."
        assert abs(reloaded[0]["start"] - new_start) < 0.005
        print("[PASS] Test 5: SRT Saving & Backup Passed")

        # ---------------- TEST 6: ELAN .eaf Export ----------------
        eaf_path = os.path.join(temp_dir, "test.eaf")
        media_files = {p: ch.file_path for p, ch in session.channels.items()}
        all_annos = {"P1": reloaded, "P2": parse_srt(p2_srt), "P3": [], "P4": []}
        eaf_success = export_multi_speaker_eaf(eaf_path, media_files, all_annos)
        assert eaf_success, "EAF export failed"
        assert os.path.exists(eaf_path), "EAF file was not written"
        print("[PASS] Test 6: ELAN .eaf XML Export Passed")

        print("\n" + "=" * 50)
        print("[SUCCESS] ALL TESTS PASSED!")
        print("=" * 50)

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    run_tests()
