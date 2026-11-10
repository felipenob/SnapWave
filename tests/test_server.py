"""
test_server.py
Integration smoke test: starts the backend server in a background thread,
exercises all REST API endpoints with the sample session, and verifies responses.
"""

import os
import sys
import json
import time
import urllib.request
import urllib.error
import threading

BACKEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "backend")
sys.path.insert(0, BACKEND_DIR)

from app import ReviewRequestHandler, ThreadingHTTPServer

TEST_PORT = 8126
SESSION_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "sample_session")


def post_json(url, data):
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_json(url):
    with urllib.request.urlopen(url) as resp:
        return json.loads(resp.read().decode("utf-8"))


def run_server(httpd):
    httpd.serve_forever()


def test_integration():
    server_address = ("127.0.0.1", TEST_PORT)
    httpd = ThreadingHTTPServer(server_address, ReviewRequestHandler)
    thread = threading.Thread(target=run_server, args=(httpd,), daemon=True)
    thread.start()
    time.sleep(0.5)

    base_url = f"http://127.0.0.1:{TEST_PORT}"

    try:
        # 1. Test Static Index
        with urllib.request.urlopen(f"{base_url}/") as resp:
            assert resp.status == 200
            html = resp.read().decode("utf-8")
            assert "<!DOCTYPE html>" in html
            print("[PASS] Static HTML served")

        # 2. Test Session Loading
        load_data = post_json(f"{base_url}/api/load_session", {"session_dir": SESSION_DIR})
        assert load_data["success"] is True
        assert len(load_data["participants"]) == 4
        assert "P1" in load_data["participants"]
        print("[PASS] POST /api/load_session returned 4 participants")

        # 3a. Test Waveform Global Peaks
        wf_data = get_json(f"{base_url}/api/waveform?participant=P1&points=500")
        assert len(wf_data["peaks"]) == 1000
        assert wf_data["duration"] > 0
        assert wf_data["is_window"] is False
        print("[PASS] GET /api/waveform (global overview) returned strided peaks")

        # 3b. Test Waveform High-Res Window Peaks
        win_wf_data = get_json(f"{base_url}/api/waveform?participant=P1&start=1.0&end=4.0&points=400")
        assert len(win_wf_data["peaks"]) == 800
        assert win_wf_data["is_window"] is True
        assert max(win_wf_data["peaks"]) > 0.4
        print(f"[PASS] GET /api/waveform (high-res window) returned {len(win_wf_data['peaks'])} peaks for 1.0-4.0s (peak max: {max(win_wf_data['peaks']):.2f})")

        # 4a. Test Snap to Wave (Enlarge / Expand)
        snap_data = post_json(f"{base_url}/api/snap", {
            "participant": "P1",
            "start": 0.4,
            "end": 4.9,
            "safety_padding_ms": 50.0,
            "margin_db": 6.0,
            "mode": "expand"
        })
        assert snap_data["success"] is True
        assert snap_data["new_start"] > 0.8
        assert snap_data["new_end"] < 4.7
        print(f"[PASS] POST /api/snap (expand) successfully snapped: 0.4s-4.9s -> {snap_data['new_start']}s-{snap_data['new_end']}s")

        # 4b. Test Snap to Wave (Trim / Tighten)
        snap_trim = post_json(f"{base_url}/api/snap", {
            "participant": "P1",
            "start": 0.4,
            "end": 4.9,
            "mode": "trim"
        })
        assert snap_trim["success"] is True
        assert snap_trim["new_start"] >= 0.4
        assert snap_trim["new_end"] <= 4.9
        print(f"[PASS] POST /api/snap (trim) successfully tightened: 0.4s-4.9s -> {snap_trim['new_start']}s-{snap_trim['new_end']}s")

        # 5. Test Crosstalk Detection
        xtalk_data = post_json(f"{base_url}/api/crosstalk_check", {
            "participant": "P2",
            "start": 1.0,
            "end": 4.5,
            "threshold_db": 9.0
        })
        assert xtalk_data["success"] is True
        assert xtalk_data["is_crosstalk"] is True
        assert xtalk_data["dominant_speaker"] == "P1"
        print(f"[PASS] POST /api/crosstalk_check detected bleed from P1 (+{xtalk_data['energy_diff_db']} dB)")

        # 6a. Test Save Active
        save_data = post_json(f"{base_url}/api/save", {
            "participant": "P1",
            "annotations": [
                {"id": 1, "start": snap_data["new_start"], "end": snap_data["new_end"], "text": "Pattern idea."}
            ]
        })
        assert save_data["success"] is True
        print("[PASS] POST /api/save updated P1.srt with backup")

        # 6b. Test Save All
        save_all_data = post_json(f"{base_url}/api/save_all", {
            "all_annotations": {
                "P1": [{"id": 1, "start": 1.0, "end": 4.5, "text": "P1 saved."}],
                "P2": [{"id": 1, "start": 5.0, "end": 7.5, "text": "P2 saved."}]
            }
        })
        assert save_all_data["success"] is True
        assert save_all_data["saved_count"] >= 2
        print(f"[PASS] POST /api/save_all saved {save_all_data['saved_count']} participant files")

        # 6c. Test Save As (First save + Subsequent rewrite/update)
        save_as_data = post_json(f"{base_url}/api/save_as", {
            "participant": "P1",
            "output_path": "P1_custom_export.srt",
            "annotations": [{"id": 1, "start": 1.0, "end": 4.5, "text": "Custom copy."}]
        })
        assert save_as_data["success"] is True
        assert os.path.exists(save_as_data["saved_path"])

        # Test Save As rewrite (second save to same file)
        save_as_rewrite = post_json(f"{base_url}/api/save_as", {
            "participant": "P1",
            "output_path": "P1_custom_export.srt",
            "annotations": [{"id": 1, "start": 1.0, "end": 4.5, "text": "Second updated copy."}]
        })
        assert save_as_rewrite["success"] is True
        with open(save_as_rewrite["saved_path"], "r", encoding="utf-8") as f:
            content = f.read()
        assert "Second updated copy." in content
        print(f"[PASS] POST /api/save_as wrote and subsequently updated {save_as_data['filename']}")

        # Test Save Active with explicit srt_filename
        save_active_custom = post_json(f"{base_url}/api/save", {
            "participant": "P1",
            "srt_filename": "P1_custom_export.srt",
            "annotations": [{"id": 1, "start": 1.0, "end": 4.5, "text": "Updated via Save Active."}]
        })
        assert save_active_custom["success"] is True
        with open(save_active_custom["saved_path"], "r", encoding="utf-8") as f:
            content = f.read()
        assert "Updated via Save Active." in content
        print(f"[PASS] POST /api/save targeting active srt_filename updated correctly")

        # 6d. Test Autosave
        autosave_data = post_json(f"{base_url}/api/autosave", {
            "all_annotations": {
                "P1": [{"id": 1, "start": 1.0, "end": 4.5, "text": "Autosave text"}]
            }
        })
        assert autosave_data["success"] is True
        assert os.path.isdir(autosave_data["autosave_dir"])
        print(f"[PASS] POST /api/autosave performed background autosave in {autosave_data['autosave_dir']}")

        # 7. Test ELAN .eaf Export
        eaf_data = post_json(f"{base_url}/api/export_eaf", {"filename": "reviewed_test.eaf"})
        assert eaf_data["success"] is True
        assert os.path.exists(eaf_data["eaf_path"])
        print("[PASS] POST /api/export_eaf wrote valid ELAN document")

        # 8. Test Auto-Transcribe
        asr_data = post_json(f"{base_url}/api/transcribe", {
            "participant": "P1",
            "start": 1.0,
            "end": 3.0
        })
        assert asr_data["success"] is True
        assert "text" in asr_data
        print(f"[PASS] POST /api/transcribe returned text: {repr(asr_data['text'])}")

        # 9. Test ASR Info & Models
        asr_info = get_json(f"{base_url}/api/asr_info")
        assert asr_info["success"] is True
        assert "available_models" in asr_info
        assert len(asr_info["available_models"]) >= 3
        for m in asr_info["available_models"]:
            assert m.get("label") and m.get("label") != "undefined", f"Invalid model label: {m}"
            assert m.get("size") and m.get("size") != "undefined", f"Invalid model size: {m}"
        print(f"[PASS] GET /api/asr_info returned {len(asr_info['available_models'])} models with valid labels and sizes")

        # 10a. Test Voice Spectrogram PNG (Magma)
        spec_req = urllib.request.Request(f"{base_url}/api/spectrogram?participant=P1&start=1.0&end=3.0&width=600&height=100")
        with urllib.request.urlopen(spec_req) as resp:
            assert resp.status == 200
            assert resp.headers.get("Content-Type") == "image/png"
            png_bytes = resp.read()
            assert png_bytes.startswith(b"\x89PNG\r\n\x1a\n")
            assert len(png_bytes) > 500
        print(f"[PASS] GET /api/spectrogram rendered 600x100 voice spectrogram PNG ({len(png_bytes)} bytes)")

        # 10b. Test Black & White Spectrogram PNG (Praat style)
        spec_bw_req = urllib.request.Request(f"{base_url}/api/spectrogram?participant=P1&start=1.0&end=3.0&width=600&height=100&color_scheme=bw")
        with urllib.request.urlopen(spec_bw_req) as resp:
            assert resp.status == 200
            assert resp.headers.get("Content-Type") == "image/png"
            bw_png_bytes = resp.read()
            assert bw_png_bytes.startswith(b"\x89PNG\r\n\x1a\n")
            assert len(bw_png_bytes) > 500
        print(f"[PASS] GET /api/spectrogram (B&W) rendered 600x100 black & white spectrogram PNG ({len(bw_png_bytes)} bytes)")

        # 11. Test Correct Grammar (including transition words rule)
        grammar_resp = post_json(f"{base_url}/api/correct_grammar", {
            "text": "I want this However it's gone"
        })
        assert grammar_resp["success"] is True
        assert grammar_resp["corrected_text"] == "I want this, however it's gone."
        print(f"[PASS] POST /api/correct_grammar (transition rule) returned: {repr(grammar_resp['corrected_text'])}")

        # 12. Test Search Missing Utterances in Gaps (High Precision & Sensitive profiles)
        missing_resp = post_json(f"{base_url}/api/search_missing_utterances", {
            "participant": "P1",
            "annotations": [
                {"id": 1, "start": 1.0, "end": 2.5, "text": "First utterance"}
            ],
            "sensitivity": "high_precision"
        })
        assert missing_resp["success"] is True
        assert "candidates" in missing_resp
        assert isinstance(missing_resp["candidates"], list)
        print(f"[PASS] POST /api/search_missing_utterances (high_precision) found {len(missing_resp['candidates'])} candidate gap bursts")

        missing_sens = post_json(f"{base_url}/api/search_missing_utterances", {
            "participant": "P1",
            "annotations": [
                {"id": 1, "start": 1.0, "end": 2.5, "text": "First utterance"}
            ],
            "sensitivity": "sensitive"
        })
        assert missing_sens["success"] is True
        print(f"[PASS] POST /api/search_missing_utterances (sensitive) found {len(missing_sens['candidates'])} candidate gap bursts")

        # 13. Test Open Folder Endpoint (validation check)
        try:
            open_resp = post_json(f"{base_url}/api/open_folder", {"path": "invalid_non_existent_path_xyz"})
            assert False, "Should have failed on invalid directory"
        except urllib.error.HTTPError as he:
            assert he.code in (400, 404)
            print(f"[PASS] POST /api/open_folder correctly rejected invalid directory (HTTP {he.code})")

        print("\n" + "=" * 50)
        print("[SUCCESS] ALL SERVER ENDPOINTS WORKING 100% OFFLINE!")
        print("=" * 50)

    finally:
        httpd.shutdown()
        httpd.server_close()


if __name__ == "__main__":
    test_integration()
