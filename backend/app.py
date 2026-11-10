"""
app.py
Fast, lightweight, 100% offline local review server for multi-speaker transcription cleaning.
Uses Python's standard library ThreadingHTTPServer.
Provides REST endpoints for waveform data (global & high-res window), audio streaming,
snapping, crosstalk checking, save, save-all, and save-as.
"""

import os
import sys
import json
import math
import urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from typing import Dict, Optional

# Ensure standard output/error never crashes on Windows console charmaps (cp1252, etc.)
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
if hasattr(sys.stderr, "reconfigure"):
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
FRONTEND_DIR = os.path.join(PROJECT_DIR, "frontend")
LOGS_DIR = os.path.join(PROJECT_DIR, "logs")
os.makedirs(LOGS_DIR, exist_ok=True)
LOG_FILE_PATH = os.path.join(LOGS_DIR, "app.log")

sys.path.insert(0, SCRIPT_DIR)

from audio_engine import MultiSpeakerSession, AudioChannel
from snapper import snap_annotation_to_wave
from srt_handler import parse_srt, save_srt, export_multi_speaker_eaf, autosave_session_files

current_session: Optional[MultiSpeakerSession] = None
session_annotations: Dict[str, list] = {}


def write_app_log(message: str):
    """Write timestamped log message to logs/app.log and stderr."""
    try:
        import datetime
        now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        line = f"[{now}] {message}\n"
        with open(LOG_FILE_PATH, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass


class ReviewRequestHandler(BaseHTTPRequestHandler):
    """Handles static files and API requests."""

    def log_message(self, format, *args):
        # Quiet audio chunk streaming logs
        if args and len(args) > 0 and "/api/audio" in str(args[0]):
            return
        msg = format % args
        sys.stderr.write(f"[{self.log_date_time_string()}] {msg}\n")
        write_app_log(msg)

    def _send_json(self, data: dict, status: int = 200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, message: str, status: int = 400):
        self._send_json({"error": message, "success": False}, status=status)

    def do_OPTIONS(self):
        """CORS preflight handling."""
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/api/audio":
            self._handle_audio_stream(query)
            return

        if path == "/api/waveform":
            self._handle_waveform(query)
            return

        if path == "/api/spectrogram":
            self._handle_spectrogram(query)
            return

        if path == "/api/session_info":
            global current_session, session_annotations
            if current_session is None:
                self._send_json({"loaded": False})
            else:
                participants = list(current_session.channels.keys())
                srt_filenames = {
                    p: os.path.basename(current_session.srt_files[p])
                    if p in current_session.srt_files else f"{p}.srt"
                    for p in participants
                }
                self._send_json({
                    "loaded": True,
                    "session_dir": current_session.session_dir,
                    "participants": participants,
                    "srt_filenames": srt_filenames,
                    "annotations": session_annotations
                })
            return

        if path == "/api/asr_info":
            try:
                from transcriber import get_asr_info
                self._send_json({"success": True, **get_asr_info()})
            except Exception as e:
                self._send_error_json(str(e), 500)
            return

        self._handle_static(path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        content_len = int(self.headers.get("Content-Length", 0))
        body_bytes = self.rfile.read(content_len) if content_len > 0 else b"{}"
        try:
            body = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
        except Exception:
            body = {}

        if path == "/api/load_session":
            self._handle_load_session(body)
        elif path == "/api/snap":
            self._handle_snap(body)
        elif path == "/api/crosstalk_check":
            self._handle_crosstalk_check(body)
        elif path == "/api/save":
            self._handle_save(body)
        elif path == "/api/save_all":
            self._handle_save_all(body)
        elif path == "/api/save_as":
            self._handle_save_as(body)
        elif path == "/api/autosave":
            self._handle_autosave(body)
        elif path == "/api/export_eaf":
            self._handle_export_eaf(body)
        elif path == "/api/transcribe":
            self._handle_transcribe(body)
        elif path == "/api/correct_grammar":
            self._handle_correct_grammar(body)
        elif path == "/api/search_missing_utterances":
            self._handle_search_missing_utterances(body)
        elif path == "/api/open_folder":
            self._handle_open_folder(body)
        elif path == "/api/browse_folder":
            self._handle_browse_folder(body)
        else:
            self._send_error_json("Unknown API endpoint", 404)

    # ---------------- API Implementations ----------------

    def _handle_load_session(self, body: dict):
        global current_session, session_annotations
        session_dir = body.get("session_dir", "").strip()

        if not session_dir or not os.path.isdir(session_dir):
            self._send_error_json(f"Directory not found: '{session_dir}'")
            return

        try:
            current_session = MultiSpeakerSession(session_dir)
            session_annotations = {}

            for p_id, srt_path in current_session.srt_files.items():
                session_annotations[p_id] = parse_srt(srt_path)

            for p_id in current_session.channels.keys():
                if p_id not in session_annotations:
                    session_annotations[p_id] = []

            participants = sorted(list(current_session.channels.keys()))

            durations = {
                p: round(ch.duration_seconds, 2)
                for p, ch in current_session.channels.items()
            }

            srt_filenames = {
                p: os.path.basename(current_session.srt_files[p])
                if p in current_session.srt_files else f"{p}.srt"
                for p in participants
            }

            self._send_json({
                "success": True,
                "session_dir": session_dir,
                "participants": participants,
                "durations": durations,
                "srt_filenames": srt_filenames,
                "annotations": session_annotations
            })
        except Exception as e:
            self._send_error_json(f"Error loading session: {str(e)}", 500)

    def _handle_waveform(self, query: dict):
        global current_session
        if current_session is None:
            self._send_error_json("No session loaded", 400)
            return

        p_id = query.get("participant", [""])[0]
        if p_id not in current_session.channels:
            self._send_error_json(f"Unknown participant: '{p_id}'", 404)
            return

        channel = current_session.channels[p_id]
        num_points = int(query.get("points", [1200])[0])

        start_str = query.get("start", [None])[0]
        end_str = query.get("end", [None])[0]

        # Check if window peaks requested
        if start_str is not None and end_str is not None:
            try:
                start_sec = max(0.0, float(start_str))
                end_sec = min(channel.duration_seconds, float(end_str))
                peaks = channel.compute_window_peaks(start_sec, end_sec, num_points=num_points)
                self._send_json({
                    "participant": p_id,
                    "is_window": True,
                    "start": round(start_sec, 3),
                    "end": round(end_sec, 3),
                    "peaks": peaks
                })
                return
            except Exception as e:
                print(f"[app] Error computing window peaks: {e}")

        # Default: Full-file overview peaks
        peaks = channel.compute_peaks(num_points=num_points)
        self._send_json({
            "participant": p_id,
            "is_window": False,
            "duration": round(channel.duration_seconds, 3),
            "sample_rate": channel.sample_rate,
            "peaks": peaks
        })

    def _handle_spectrogram(self, query: dict):
        """Generates and streams an image/png spectrogram for a specific time range."""
        global current_session
        if current_session is None:
            self._send_error_json("No session loaded", 400)
            return

        p_id = query.get("participant", [""])[0]
        if p_id not in current_session.channels:
            self._send_error_json(f"Unknown participant: '{p_id}'", 404)
            return

        channel = current_session.channels[p_id]
        try:
            start_sec = max(0.0, float(query.get("start", [0.0])[0]))
            end_sec = min(channel.duration_seconds, float(query.get("end", [5.0])[0]))
            width = max(100, min(2400, int(query.get("width", [800])[0])))
            height = max(40, min(400, int(query.get("height", [110])[0])))
            color_scheme = query.get("color_scheme", ["magma"])[0]

            if end_sec <= start_sec:
                end_sec = start_sec + 0.1

            samples, sr = channel.read_samples(start_sec, end_sec)
            from spectrogram import generate_spectrogram_png
            png_bytes = generate_spectrogram_png(samples, sr, width=width, height=height, color_scheme=color_scheme)

            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(png_bytes)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "public, max-age=60")
            self.end_headers()
            self.wfile.write(png_bytes)
        except Exception as e:
            sys.stderr.write(f"Spectrogram error: {e}\n")
            self._send_error_json(f"Spectrogram generation failed: {str(e)}", 500)

    def _handle_audio_stream(self, query: dict):
        global current_session
        if current_session is None:
            self.send_error(404, "No session loaded")
            return

        p_id = query.get("participant", [""])[0]
        if p_id not in current_session.channels:
            self.send_error(404, f"Participant {p_id} not found")
            return

        file_path = current_session.channels[p_id].file_path
        if not os.path.exists(file_path):
            self.send_error(404, "File not found")
            return

        file_size = os.path.getsize(file_path)
        range_header = self.headers.get("Range")

        if range_header:
            try:
                bytes_range = range_header.strip().replace("bytes=", "")
                start_str, end_str = bytes_range.split("-")
                start = int(start_str) if start_str else 0
                end = int(end_str) if end_str else file_size - 1
                end = min(end, file_size - 1)
                content_length = end - start + 1

                self.send_response(206)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                self.send_header("Content-Length", str(content_length))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()

                with open(file_path, "rb") as f:
                    f.seek(start)
                    bytes_remaining = content_length
                    while bytes_remaining > 0:
                        chunk_size = min(65536, bytes_remaining)
                        chunk = f.read(chunk_size)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        bytes_remaining -= len(chunk)
                return
            except Exception:
                pass

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(file_size))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        try:
            with open(file_path, "rb") as f:
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            pass

    def _handle_snap(self, body: dict):
        global current_session
        if current_session is None:
            self._send_error_json("No session loaded", 400)
            return

        p_id = body.get("participant", "")
        start_sec = float(body.get("start", 0.0))
        end_sec = float(body.get("end", 0.0))
        safety_padding_ms = float(body.get("safety_padding_ms", 50.0))
        margin_db = float(body.get("margin_db", 6.0))
        mode = body.get("mode", "expand")

        if p_id not in current_session.channels:
            self._send_error_json(f"Unknown participant: {p_id}", 404)
            return

        channel = current_session.channels[p_id]
        window_margin = 0.5
        win_start = max(0.0, start_sec - window_margin)
        win_end = min(channel.duration_seconds, end_sec + window_margin)

        samples, sr = channel.read_samples(win_start, win_end)

        result = snap_annotation_to_wave(
            samples=samples,
            sample_rate=sr,
            window_start_sec=win_start,
            current_start_sec=start_sec,
            current_end_sec=end_sec,
            safety_padding_ms=safety_padding_ms,
            margin_db=margin_db,
            mode=mode
        )

        self._send_json({"success": True, **result})

    def _handle_crosstalk_check(self, body: dict):
        global current_session
        if current_session is None:
            self._send_error_json("No session loaded", 400)
            return

        p_id = body.get("participant", "")
        start_sec = float(body.get("start", 0.0))
        end_sec = float(body.get("end", 0.0))
        threshold_db = float(body.get("threshold_db", 9.0))

        result = current_session.check_crosstalk(
            target_speaker=p_id,
            start_sec=start_sec,
            end_sec=end_sec,
            threshold_db=threshold_db
        )

        self._send_json({"success": True, **result})

    def _handle_transcribe(self, body: dict):
        global current_session
        if current_session is None:
            self._send_error_json("No session loaded", 400)
            return

        p_id = body.get("participant", "")
        start_sec = float(body.get("start", 0.0))
        end_sec = float(body.get("end", 0.0))

        if p_id not in current_session.channels:
            self._send_error_json(f"Unknown participant: {p_id}", 404)
            return

        if end_sec <= start_sec:
            self._send_error_json("Invalid audio range for transcription", 400)
            return

        channel = current_session.channels[p_id]
        samples, sr = channel.read_samples(start_sec, end_sec)

        model_name = body.get("model", "openai/whisper-tiny")

        try:
            from transcriber import transcribe_audio_slice
            result = transcribe_audio_slice(samples, sr, model_name=model_name)
            if isinstance(result, dict):
                if result.get("error"):
                    self._send_error_json(result["error"], 500)
                    return
                text_str = result.get("text", "")
                used_model = result.get("model", model_name)
                device = result.get("device", "cpu")
            else:
                text_str = str(result)
                used_model = model_name
                device = "cpu"
            self._send_json({"success": True, "text": text_str, "model": used_model, "device": device})
        except Exception as e:
            sys.stderr.write(f"Transcription error: {e}\n")
            self._send_error_json(f"Transcription failed: {str(e)}", 500)

    def _handle_correct_grammar(self, body: dict):
        text = body.get("text", "")
        try:
            from grammar import correct_grammar_and_punctuation
            corrected = correct_grammar_and_punctuation(text)
            self._send_json({"success": True, "original": text, "corrected": corrected, "corrected_text": corrected})
        except Exception as e:
            sys.stderr.write(f"Grammar error: {e}\n")
            self._send_error_json(f"Grammar correction failed: {str(e)}", 500)

    def _handle_search_missing_utterances(self, body: dict):
        global current_session, session_annotations
        if current_session is None:
            self._send_error_json("No session loaded", 400)
            return

        p_id = body.get("participant", "").strip()
        if p_id not in current_session.channels:
            self._send_error_json(f"Unknown participant: {p_id}", 404)
            return

        channel = current_session.channels[p_id]
        annos = body.get("annotations", session_annotations.get(p_id, []))

        # Sensitivity Profiles: high_precision (default, few false positives), balanced, sensitive
        sensitivity = body.get("sensitivity", "high_precision")
        if sensitivity == "sensitive":
            min_duration = float(body.get("min_duration", 0.28))
            margin_above_noise = 7.0
            min_peak_thresh = -48.0
            min_active_frames_req = 3
            bleed_margin_default = 9.0
            concurrent_bleed_thresh = 6.0
        elif sensitivity == "balanced":
            min_duration = float(body.get("min_duration", 0.35))
            margin_above_noise = 10.0
            min_peak_thresh = -42.0
            min_active_frames_req = 4
            bleed_margin_default = 8.0
            concurrent_bleed_thresh = 4.5
        else:  # high_precision (default)
            min_duration = float(body.get("min_duration", 0.40))
            margin_above_noise = 13.0
            min_peak_thresh = -38.0
            min_active_frames_req = 5
            bleed_margin_default = 6.0
            concurrent_bleed_thresh = 3.5

        max_duration = float(body.get("max_duration", 15.0))
        min_gap = float(body.get("min_gap", 0.35))
        energy_threshold_db = float(body.get("threshold_db", min_peak_thresh - 6.0))

        # Sort annotations by start time
        sorted_anns = sorted(annos, key=lambda a: float(a.get("start", 0.0)))
        gaps = []
        last_end = 0.0

        for a in sorted_anns:
            st = float(a.get("start", 0.0))
            if st - last_end >= min_gap:
                gaps.append((last_end, st))
            last_end = max(last_end, float(a.get("end", 0.0)))

        if channel.duration_seconds - last_end >= min_gap:
            gaps.append((last_end, channel.duration_seconds))

        candidates = []
        sr = channel.sample_rate

        # Analysis frame: 40ms frame, 20ms hop
        frame_len = max(64, int(sr * 0.04))
        hop_len = max(32, int(sr * 0.02))

        try:
            import numpy as np
            has_np = True
        except ImportError:
            has_np = False

        for gap_start, gap_end in gaps:
            gap_dur = gap_end - gap_start
            if gap_dur < min_duration:
                continue

            samples, _ = channel.read_samples(gap_start, gap_end)
            if len(samples) < frame_len:
                continue

            # Apply light acoustic bandpass (180 Hz to 4000 Hz) to eliminate sub-bass rumble and hiss
            analysis_samples = samples
            if has_np and isinstance(samples, np.ndarray) and len(samples) > 256:
                try:
                    from scipy import signal
                    nyq = sr * 0.5
                    low_cut = 180.0 / nyq
                    high_cut = min(0.95, 4200.0 / nyq)
                    if 0 < low_cut < high_cut < 1.0:
                        b, a = signal.butter(2, [low_cut, high_cut], btype="bandpass")
                        analysis_samples = signal.lfilter(b, a, samples)
                except Exception:
                    analysis_samples = samples

            if has_np and isinstance(analysis_samples, np.ndarray):
                n_frames = 1 + (len(analysis_samples) - frame_len) // hop_len
                if n_frames <= 0:
                    continue
                frame_rms = []
                for i in range(n_frames):
                    chunk = analysis_samples[i * hop_len : i * hop_len + frame_len]
                    ms = float(np.mean(chunk ** 2))
                    frame_rms.append(10.0 * math.log10(ms + 1e-10) if ms > 1e-10 else -100.0)
                frame_rms = np.array(frame_rms)
                noise_floor = float(np.percentile(frame_rms, 15))
            else:
                n_frames = 1 + (len(analysis_samples) - frame_len) // hop_len
                frame_rms = []
                for i in range(n_frames):
                    chunk = analysis_samples[i * hop_len : i * hop_len + frame_len]
                    ms = sum(s * s for s in chunk) / len(chunk)
                    frame_rms.append(10.0 * math.log10(ms + 1e-10) if ms > 1e-10 else -100.0)
                sorted_rms = sorted(frame_rms)
                noise_floor = sorted_rms[int(len(sorted_rms) * 0.15)] if sorted_rms else -60.0

            thresh = max(energy_threshold_db, noise_floor + margin_above_noise)
            active_frames = [r > thresh for r in frame_rms]
            merge_tolerance_frames = int(0.20 / (hop_len / sr))

            i = 0
            while i < len(active_frames):
                if active_frames[i]:
                    burst_start_f = i
                    last_active = i
                    active_count = 1
                    i += 1
                    while i < len(active_frames):
                        if active_frames[i]:
                            last_active = i
                            active_count += 1
                        elif (i - last_active) > merge_tolerance_frames:
                            break
                        i += 1
                    burst_end_f = last_active

                    cand_start = gap_start + (burst_start_f * hop_len / sr) - 0.04
                    cand_end = gap_start + ((burst_end_f * hop_len + frame_len) / sr) + 0.04
                    cand_start = max(gap_start, round(cand_start, 3))
                    cand_end = min(gap_end, round(cand_end, 3))
                    dur = cand_end - cand_start

                    burst_rms_slice = frame_rms[burst_start_f : burst_end_f + 1]
                    peak_db = float(max(burst_rms_slice)) if len(burst_rms_slice) > 0 else -100.0

                    # Stricter checks: filter out momentary taps, breaths, and sub-threshold noise
                    if min_duration <= dur <= max_duration and active_count >= min_active_frames_req and peak_db >= min_peak_thresh:
                        # Check if any other participant has an annotation covering this time window
                        concurrent_speaker = None
                        for other_p, other_list in session_annotations.items():
                            if other_p == p_id:
                                continue
                            for oa in other_list:
                                o_st = float(oa.get("start", 0.0))
                                o_en = float(oa.get("end", 0.0))
                                if max(cand_start, o_st) < min(cand_end, o_en):
                                    concurrent_speaker = other_p
                                    break
                            if concurrent_speaker:
                                break

                        bleed_margin = concurrent_bleed_thresh if concurrent_speaker else bleed_margin_default
                        crosstalk_info = current_session.check_crosstalk(p_id, cand_start, cand_end, threshold_db=bleed_margin)
                        is_crosstalk = crosstalk_info["is_crosstalk"]
                        dominant_speaker = crosstalk_info["dominant_speaker"]

                        # If concurrent speaker is actively annotated and mic energy is higher, flag as bleed
                        if concurrent_speaker and not is_crosstalk:
                            other_mic_energy = crosstalk_info["all_energies"].get(concurrent_speaker, -100.0)
                            target_mic_energy = crosstalk_info.get("target_energy_db", -100.0)
                            if other_mic_energy - target_mic_energy >= 2.5:
                                is_crosstalk = True
                                dominant_speaker = concurrent_speaker

                        candidates.append({
                            "start": cand_start,
                            "end": cand_end,
                            "duration": round(dur, 2),
                            "peak_db": round(peak_db, 1),
                            "is_crosstalk": is_crosstalk,
                            "dominant_speaker": dominant_speaker,
                            "dominant_energy_db": crosstalk_info["dominant_energy_db"],
                            "energy_diff_db": crosstalk_info["energy_diff_db"]
                        })
                else:
                    i += 1

        self._send_json({
            "success": True,
            "participant": p_id,
            "sensitivity": sensitivity,
            "count": len(candidates),
            "candidates": candidates
        })

    def _handle_save(self, body: dict):
        global current_session, session_annotations
        if current_session is None:
            self._send_error_json("No session loaded", 400)
            return

        p_id = body.get("participant", "")
        annos = body.get("annotations", [])
        explicit_filename = body.get("srt_filename", "").strip()

        if explicit_filename:
            if os.path.isabs(explicit_filename):
                srt_path = explicit_filename
            else:
                srt_path = os.path.join(current_session.session_dir, explicit_filename)
        elif p_id in current_session.srt_files:
            srt_path = current_session.srt_files[p_id]
        else:
            srt_path = os.path.join(current_session.session_dir, f"{p_id}.srt")

        success = save_srt(srt_path, annos, create_backup=True)
        if success:
            session_annotations[p_id] = annos
            current_session.srt_files[p_id] = srt_path
            self._send_json({
                "success": True,
                "participant": p_id,
                "saved_path": srt_path,
                "filename": os.path.basename(srt_path)
            })
        else:
            self._send_error_json(f"Failed to save {srt_path}", 500)

    def _handle_save_all(self, body: dict):
        """Saves all participant annotations currently in the session."""
        global current_session, session_annotations
        if current_session is None:
            self._send_error_json("No session loaded", 400)
            return

        all_annos = body.get("all_annotations", session_annotations)
        saved_files = []

        for p_id, annos in all_annos.items():
            if p_id in current_session.srt_files:
                srt_path = current_session.srt_files[p_id]
            else:
                srt_path = os.path.join(current_session.session_dir, f"{p_id}.srt")

            if save_srt(srt_path, annos, create_backup=True):
                session_annotations[p_id] = annos
                saved_files.append(os.path.basename(srt_path))

        self._send_json({
            "success": True,
            "saved_count": len(saved_files),
            "saved_files": saved_files
        })

    def _handle_save_as(self, body: dict):
        """Saves annotations to a user-specified custom path and switches active track to it."""
        global current_session, session_annotations
        if current_session is None:
            self._send_error_json("No session loaded", 400)
            return

        p_id = body.get("participant", "")
        annos = body.get("annotations", [])
        custom_name_or_path = body.get("output_path", "").strip()

        if not custom_name_or_path:
            self._send_error_json("Missing output path", 400)
            return

        # If only a filename was given, save in session directory
        if not os.path.isabs(custom_name_or_path):
            target_path = os.path.join(current_session.session_dir, custom_name_or_path)
        else:
            target_path = custom_name_or_path

        if not target_path.lower().endswith(".srt"):
            target_path += ".srt"

        success = save_srt(target_path, annos, create_backup=False)
        if success:
            if p_id:
                current_session.srt_files[p_id] = target_path
                session_annotations[p_id] = annos
            self._send_json({
                "success": True,
                "saved_path": target_path,
                "filename": os.path.basename(target_path)
            })
        else:
            self._send_error_json(f"Failed to save {target_path}", 500)

    def _handle_autosave(self, body: dict):
        """Performs background autosave without touching production files."""
        global current_session, session_annotations
        if current_session is None:
            self._send_error_json("No session loaded", 400)
            return

        all_annos = body.get("all_annotations", session_annotations)
        result = autosave_session_files(current_session.session_dir, all_annos)
        self._send_json(result)

    def _handle_export_eaf(self, body: dict):
        global current_session, session_annotations
        if current_session is None:
            self._send_error_json("No session loaded", 400)
            return

        out_name = body.get("filename", "session.eaf")
        if not out_name.endswith(".eaf"):
            out_name += ".eaf"
        out_path = os.path.join(current_session.session_dir, out_name)

        media_files = {p: ch.file_path for p, ch in current_session.channels.items()}
        success = export_multi_speaker_eaf(out_path, media_files, session_annotations)

        if success:
            self._send_json({"success": True, "eaf_path": out_path})
        else:
            self._send_error_json("Failed to export EAF file", 500)

    def _handle_open_folder(self, body: dict):
        global current_session
        target_dir = body.get("path", "").strip()
        if not target_dir and current_session:
            target_dir = current_session.session_dir
        if not target_dir:
            self._send_error_json("No path provided and no active session", 400)
            return

        if not os.path.exists(target_dir):
            self._send_error_json(f"Path does not exist: {target_dir}", 404)
            return

        target_dir = os.path.normpath(target_dir)
        try:
            if sys.platform == "win32":
                os.startfile(target_dir)
            elif sys.platform == "darwin":
                import subprocess
                subprocess.Popen(["open", target_dir])
            else:
                import subprocess
                subprocess.Popen(["xdg-open", target_dir])
            self._send_json({"success": True, "path": target_dir})
        except Exception as e:
            self._send_error_json(f"Could not open folder: {str(e)}", 500)

    def _handle_browse_folder(self, body: dict):
        """Pops up a native OS folder selection dialog and returns the chosen directory path."""
        global current_session
        initial_dir = body.get("initial_dir", "").strip()
        if not initial_dir and current_session:
            initial_dir = current_session.session_dir

        code = (
            "import sys, os\n"
            "try:\n"
            "    import tkinter as tk\n"
            "    from tkinter import filedialog\n"
            "    root = tk.Tk()\n"
            "    root.withdraw()\n"
            "    root.attributes('-topmost', True)\n"
            "    init_dir = sys.argv[1] if len(sys.argv) > 1 and os.path.isdir(sys.argv[1]) else None\n"
            "    chosen = filedialog.askdirectory(title='Select Experiment Session Folder', initialdir=init_dir)\n"
            "    root.destroy()\n"
            "    if chosen:\n"
            "        print(os.path.normpath(chosen))\n"
            "except Exception:\n"
            "    sys.exit(1)\n"
        )

        selected_path = ""
        try:
            import subprocess
            cmd = [sys.executable, "-c", code]
            if initial_dir and os.path.isdir(initial_dir):
                cmd.append(initial_dir)
            proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=180)
            if proc.returncode == 0:
                selected_path = proc.stdout.strip()
        except Exception as e:
            sys.stderr.write(f"Tkinter folder picker error: {e}\n")

        # Fallback to PowerShell FolderBrowserDialog on Windows if Tkinter yielded nothing
        if not selected_path and sys.platform == "win32":
            try:
                import subprocess
                ps_script = (
                    "Add-Type -AssemblyName System.Windows.Forms; "
                    "$f = New-Object System.Windows.Forms.FolderBrowserDialog; "
                    "$f.Description = 'Select Experiment Session Folder'; "
                    + (f"$f.SelectedPath = '{initial_dir}'; " if initial_dir and os.path.isdir(initial_dir) else "")
                    + "if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }"
                )
                proc = subprocess.run(["powershell", "-NoProfile", "-Command", ps_script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=180)
                if proc.returncode == 0 and proc.stdout.strip():
                    selected_path = os.path.normpath(proc.stdout.strip())
            except Exception as e:
                sys.stderr.write(f"PowerShell folder picker error: {e}\n")

        self._send_json({
            "success": True,
            "path": selected_path,
            "canceled": not bool(selected_path)
        })

    # ---------------- Static File Serving ----------------

    def _handle_static(self, path: str):
        if path == "/" or path == "":
            rel_path = "index.html"
        else:
            rel_path = path.lstrip("/")

        full_path = os.path.normpath(os.path.join(FRONTEND_DIR, rel_path))

        if not full_path.startswith(FRONTEND_DIR) or not os.path.exists(full_path) or os.path.isdir(full_path):
            self.send_error(404, "File Not Found")
            return

        ext = os.path.splitext(full_path)[1].lower()
        mime_types = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".png": "image/png",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon"
        }
        content_type = mime_types.get(ext, "application/octet-stream")

        with open(full_path, "rb") as f:
            content = f.read()

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


def start_server(port: int = 8000):
    server_address = ("127.0.0.1", port)
    httpd = ThreadingHTTPServer(server_address, ReviewRequestHandler)
    print("=" * 65)
    print(f"[*] Multi-Speaker Review Interface running 100% OFFLINE at:")
    print(f"    http://localhost:{port}")
    print("=" * 65)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server.")
        httpd.server_close()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    start_server(port)
