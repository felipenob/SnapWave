# 🎙️ SnapWave

### Multi-Speaker Transcript Review & Alignment Studio

![Python 3.10–3.12](https://img.shields.io/badge/Python-3.11%20Recommended-3776AB?logo=python&logoColor=white)
![100% Offline](https://img.shields.io/badge/Privacy-100%25%20Offline-10b981)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-0284c7)
![ASR Models](https://img.shields.io/badge/ASR-Whisper%20%7C%20NVIDIA%20Parakeet%20%7C%20Wav2Vec2-76b900)
![License](https://img.shields.io/badge/License-MIT-blue)

**SnapWave** is a fast, standalone, **100% offline** desktop application for reviewing, cleaning, aligning, and transcribing multi-speaker conversational audio datasets (`.wav` + `.srt`), with one-click export to **ELAN (`.eaf`)**.

Designed for speech researchers, linguists, and behavioral scientists who need to verify and clean automatic speech recognition (ASR) transcripts across multiple synchronized microphones at high speed—replacing slow manual timeline dragging with instant, single-key acoustic actions.

---

## ✨ Key Features

- **⚡ Dual Acoustic Boundary Snapping (Strict No-Overlap)**
  - **Enlarge (`Alt+Q`)**: Expands annotation boundaries outward to capture full vocal onsets and offsets with safety padding.
  - **Trim (`Alt+W`)**: Tightens boundaries inward to isolate the primary speech burst and strip leading/trailing silence.
- **🔍 Missing Utterances Scanner**
  - Scans unannotated gaps across a speaker's audio channel to detect missed speech bursts.
  - Automatically compares multi-channel microphone RMS energy (dB) to separate **Likely Speech** from **Crosstalk / Mic Bleed** from other speakers.
  - Audition, auto-transcribe, apply grammar fixes, and insert missing utterances directly into your working `.srt`.
- **🎙️ Built-In Offline Speech-to-Text (CPU & NVIDIA CUDA GPU)**
  - **OpenAI Whisper** (`whisper-tiny`, `whisper-base`)
  - **NVIDIA Parakeet** (`nvidia/parakeet-tdt-0.6b-v2`, `nvidia/parakeet-ctc-0.6b`, `nvidia/parakeet-ctc-1.1b` via NeMo or Hugging Face Transformers)
  - **Facebook Wav2Vec2** (`wav2vec2-base-960h`)
- **✨ Offline Rule-Based Grammar & Casing Cleaner (`Alt+G`)**
  - Fixes sentence capitalization, restores English contractions (`dont` ➔ `don't`, `im` ➔ `I'm`), inserts commas before mid-sentence conjunctive adverbs (`however`, `therefore`, `moreover`), and adds question marks to interrogatives while preserving custom annotation tags.
- **📊 Real-Time Voice Spectrogram (0–8 kHz) & Multi-Track Waveform**
  - Switch between **Voice Magma** and **Praat/ELAN Black & White** spectrogram color schemes.
  - Interactive zoom, auto-following playhead, slim non-obstructive boundary handles, and 4-channel activity overview.
- **🎧 Solo & Context Ducking Audio Modes (`M`)**
  - Listen to the active participant in isolation (**Solo Mode**) or hear all other participants attenuated at 15% volume (**Context Ducking**) to verify conversational turn-taking.
- **⌨️ Fully Customizable Keyboard Shortcuts & Reorderable Toolbar**
  - Rebind any playback, editing, or guideline tag shortcut in the **⌨️ Shortcuts** modal.
  - Drag and drop the action buttons below the waveform to match your personal workflow.
- **💾 Atomic Saves, Timestamped Backups & ELAN (`.eaf`) Export**
  - Every `Ctrl+S` performs an atomic write and stores a timestamped backup in `.backups/`.
  - Background autosave protects unsaved edits in `.autosave/` every 45 seconds.
  - Export all participant tiers into a synchronized **ELAN `.eaf`** XML file with one click.

---

## 📋 Prerequisites & System Requirements

| Requirement | Recommendation | Notes |
| :--- | :--- | :--- |
| **Operating System** | Windows 10 / 11 (64-bit) | Also compatible with macOS & Linux via Python |
| **Python Version** | **Python 3.11 (64-bit)** *(Recommended)* | Python `3.10`–`3.12` are supported. **Avoid Python 3.13+**, as PyTorch/NeMo prebuilt wheels may not be available yet. |
| **GPU (Optional)** | NVIDIA CUDA GPU (e.g. RTX 30/40 series) | Optional. Enables hardware-accelerated Whisper & NVIDIA Parakeet inference. |

> [!IMPORTANT]
> **Why Python 3.11?**
> Scientific and deep-learning packages (`torch`, `torchaudio`, `scipy`, `nemo_toolkit`) publish precompiled binary wheels primarily for **Python 3.10, 3.11, and 3.12**. If a brand-new Python version (such as 3.13 or 3.14) is installed by default, `pip` may fail trying to compile C++/CUDA extensions from source. Our `install.bat` script automatically checks for Python 3.11 and can install it for you via Windows `winget`.

---

## 🚀 Installation

### Option A: One-Click Automated Setup on Windows (Recommended)

1. **Clone or Download** this repository and extract it to a folder on your PC.
2. Double-click **`install.bat`** (or simply double-click **`run.bat`** on first launch).
3. The installer will:
   - Automatically detect **Python 3.11** (or offer to install Python 3.11 automatically via Windows `winget` if missing).
   - Create an isolated virtual environment in `.venv/` so it never conflicts with your system Python.
   - Ask you to choose your hardware profile:
     - **`[1] Standard CPU Mode`** — Works out-of-the-box on any laptop or desktop.
     - **`[2] NVIDIA GPU Mode (CUDA 12.4)`** — Installs GPU-accelerated PyTorch for Whisper & Parakeet CTC.
     - **`[3] NVIDIA GPU + NeMo Toolkit`** — Installs CUDA PyTorch + `nemo_toolkit[asr]` for `nvidia/parakeet-tdt-0.6b-v2`.
4. Once complete, double-click **`run.bat`** anytime to launch the standalone desktop application!

### Option B: Manual Installation (Windows / macOS / Linux)

```bash
# 1. Create and activate a Python 3.11 virtual environment
python3.11 -m venv .venv

# Windows:
.venv\Scripts\activate
# macOS / Linux:
source .venv/bin/activate

# 2. (Optional) For NVIDIA GPU acceleration, install PyTorch with CUDA first:
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124

# 3. Install core dependencies
pip install -r requirements.txt

# 4. (Optional) To use NVIDIA Parakeet TDT models via NeMo:
pip install Cython packaging "nemo_toolkit[asr]"

# 5. Launch the standalone desktop app
python desktop.py
```

*(Pass `--browser` to `python desktop.py --browser` if you prefer opening the interface in Chrome/Edge instead of the standalone native window).*

---

## 📂 Session Folder Structure

Point the application to any folder containing synchronized `.wav` and `.srt` files for your participants (e.g., `1.wav` / `1.srt` or `P1.wav` / `P1.srt`):

```text
Session_01/
├── 1.wav          # Participant 1 audio (16kHz / 44.1kHz / 48kHz WAV)
├── 1.srt          # Participant 1 transcript (or 1_cleaned.srt)
├── 2.wav
├── 2.srt
├── 3.wav
├── 3.srt
├── 4.wav
└── 4.srt
```

Click **`📂 Select Folder`** in the top bar to browse for your session directory natively.

---

## ⌨️ Default Keyboard Shortcuts

All shortcuts can be customized at any time by clicking **`⌨️ Shortcuts`** in the top bar or footer. Because action shortcuts use `Alt` combinations by default, they work seamlessly **even while your cursor is actively typing inside the transcript text box**.

| Action | Default Shortcut | Description |
| :--- | :---: | :--- |
| **Play / Pause** | `Tab` | Play or pause the active utterance |
| **Next Utterance** | `PageDown` or `Enter` | Save text edit and advance to next utterance |
| **Previous Utterance** | `PageUp` | Move to previous utterance |
| **Focus Text Input** | `Enter` | Focus transcript box (when outside text box) |
| **Enlarge to Wave** | `Alt+Q` | Expand utterance boundaries outward to vocal edges |
| **Trim to Wave** | `Alt+W` | Trim utterance boundaries inward to main speech burst |
| **Add Utterance** | `Alt+A` | Insert a new non-overlapping annotation at playhead/gap |
| **Auto-Transcribe** | `Alt+T` | Run offline ASR on the active audio segment |
| **Correct Grammar** | `Alt+G` | Fix casing, punctuation, clause commas & contractions |
| **Split Utterance** | `Alt+S` | Split active utterance into two at playhead or pause |
| **Merge with Next** | `Alt+M` | Merge active utterance with the following utterance |
| **Delete Utterance** | `Alt+Delete` | Delete current utterance |
| **Seek Backward / Forward** | `Shift+Left` / `Shift+Right` | Move playhead 2 seconds backward or forward |
| **Toggle Solo / Ducking** | `M` | Switch between Solo audio and Context Ducking (outside text box) |
| **Switch Participant** | `1` – `4` | Switch active speaker tab (outside text box) |
| **Full Screen** | `F11` | Toggle full-screen workspace view |
| **Save Active `.srt`** | `Ctrl+S` | Save current participant `.srt` with backup |
| **Undo / Redo** | `Ctrl+Z` / `Ctrl+Y` | Full 50-step undo/redo history |

### Conversation Guideline Tag Shortcuts (Customizable)

| Symbol | Tag Name | Default Shortcut | Behavior |
| :---: | :--- | :---: | :--- |
| `[@]` | Backchannel | `Alt+B` | Sets utterance to `@` (e.g., *uh-huh*, *yeah*, *mhm*) |
| `[%]` | Laugh | `Alt+L` | Sets standalone laugh annotation `%` |
| `[$]` | Vocal Noise | `Alt+N` | Sets vocal noise `$` (sigh, cough, throat clear) |
| `[#]` | Word Cut-off | `Alt+#` | Inserts `#` at cursor for incomplete/cut-off words |
| `[…]` | Discontinuity | `Alt+.` | Inserts `…` for sentence break or prolongation |
| `[^...^]` | Interjection | `Alt+I` | Wraps selected word or inserts `^Ah^` |
| `[&...&]` | Non-English | `Alt+E` | Wraps foreign/non-English words in `&...&` |
| `[-]` | Stutter Hyphen | `Alt+-` | Inserts `-` to connect stuttered syllables |
| `[~]` | Unclear / Inaudible | `Alt+U` | Inserts `~` for unintelligible speech |

---

## 🏗️ Project Architecture

```text
├── desktop.py               # Standalone native desktop window launcher (pywebview + HTTP daemon)
├── install.bat              # Automated Windows installer (Python 3.11 detection + .venv + CPU/CUDA/NeMo)
├── run.bat                  # One-click application launcher
├── requirements.txt         # Core Python dependencies
├── backend/
│   ├── app.py               # Local REST API server, session management & ELAN (.eaf) exporter
│   ├── audio_engine.py      # WAV loading, RMS envelope, boundary snapping, crosstalk & gap scanner
│   ├── transcriber.py       # Offline ASR engine (Whisper, NVIDIA Parakeet, Wav2Vec2)
│   ├── grammar_corrector.py # Deterministic offline grammar, casing & punctuation cleaner
│   └── srt_handler.py       # Atomic SRT parser/writer, overlap resolver & backup manager
├── frontend/
│   ├── index.html           # Main application UI
│   ├── styles.css           # Dark-mode acoustic studio styling & Praat B&W spectrogram theme
│   ├── waveform.js          # HTML5 Canvas multi-resolution waveform & FFT voice spectrogram
│   └── app.js               # State controller, audio mixer, undo/redo stack & shortcut engine
└── tests/
    └── test_server.py       # End-to-end API & acoustic engine integration test suite
```

---

## 🧪 Running Tests

To verify all backend endpoints, acoustic snapping modes, missing utterance scanner, and atomic file saving:

```bash
python tests/test_server.py
```

---

## 📄 License

Distributed under the **MIT License**. Free for academic, research, and commercial use.
