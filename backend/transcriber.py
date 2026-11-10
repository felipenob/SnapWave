"""
transcriber.py
Fast, multi-model, offline Speech-to-Text transcription engine for local transcript cleaning.
Supports:
1. OpenAI Whisper models (seq2seq with natural punctuation & capitalization)
2. NVIDIA Parakeet models (FastConformer TDT / CTC via NeMo or Hugging Face Transformers)
3. Wav2Vec2 CTC models (ultra-fast phoneme/word transcription)
Supports dynamic model switching and execution on CPU or NVIDIA GPU (CUDA).
"""

import sys
import os
import tempfile
# Bypass pyarrow/numpy 2.x incompatibility in Anaconda
if "pyarrow" not in sys.modules:
    sys.modules["pyarrow"] = None

import logging
import numpy as np

try:
    import torch
    HAS_TORCH = True
except ImportError:
    torch = None
    HAS_TORCH = False

try:
    import transformers
    HAS_TRANSFORMERS = True
except ImportError:
    transformers = None
    HAS_TRANSFORMERS = False

try:
    import nemo.collections.asr as nemo_asr
    HAS_NEMO = True
except Exception:
    nemo_asr = None
    HAS_NEMO = False

logger = logging.getLogger(__name__)

AVAILABLE_MODELS = {
    "openai/whisper-tiny": {
        "id": "openai/whisper-tiny",
        "name": "Whisper Tiny",
        "label": "OpenAI Whisper Tiny",
        "size": "Fast, 39M params (~150 MB)",
        "type": "whisper",
        "desc": "Lightweight multilingual model. Preserves punctuation and casing."
    },
    "openai/whisper-base": {
        "id": "openai/whisper-base",
        "name": "Whisper Base",
        "label": "OpenAI Whisper Base",
        "size": "Accurate, 74M params (~290 MB)",
        "type": "whisper",
        "desc": "Higher accuracy Whisper model for conversational nuances."
    },
    "nvidia/parakeet-tdt-0.6b-v2": {
        "id": "nvidia/parakeet-tdt-0.6b-v2",
        "name": "Parakeet TDT 0.6B v2",
        "label": "NVIDIA Parakeet TDT 0.6B v2",
        "size": "SOTA FastConformer, 600M params (NeMo / GPU)",
        "type": "parakeet",
        "desc": "High-accuracy NVIDIA Parakeet TDT model with punctuation & capitalization."
    },
    "nvidia/parakeet-ctc-0.6b": {
        "id": "nvidia/parakeet-ctc-0.6b",
        "name": "Parakeet CTC 0.6B",
        "label": "NVIDIA Parakeet CTC 0.6B",
        "size": "FastConformer CTC, 600M params (Transformers / NeMo)",
        "type": "parakeet",
        "desc": "NVIDIA FastConformer CTC model supported via Hugging Face Transformers or NeMo."
    },
    "nvidia/parakeet-ctc-1.1b": {
        "id": "nvidia/parakeet-ctc-1.1b",
        "name": "Parakeet CTC 1.1B",
        "label": "NVIDIA Parakeet CTC 1.1B",
        "size": "Large FastConformer, 1.1B params (Transformers / NeMo)",
        "type": "parakeet",
        "desc": "High-capacity NVIDIA Parakeet 1.1B model for maximum English transcription fidelity."
    },
    "facebook/wav2vec2-base-960h": {
        "id": "facebook/wav2vec2-base-960h",
        "name": "Wav2Vec2 960h",
        "label": "Facebook Wav2Vec2 960h",
        "size": "CTC, 95M params (~360 MB)",
        "type": "ctc",
        "desc": "Ultra-fast acoustic CTC model. Good for quick word boundaries."
    }
}

DEFAULT_MODEL = "openai/whisper-tiny"

_loaded_models = {}


def get_current_device() -> str:
    """Detect if NVIDIA GPU is accessible in PyTorch."""
    if HAS_TORCH and torch.cuda.is_available():
        return "cuda"
    return "cpu"


def get_asr_info() -> dict:
    """Return device information and list of available models."""
    device = get_current_device()
    gpu_name = None
    gpu_vram_mb = None

    if HAS_TORCH and device == "cuda":
        try:
            gpu_name = torch.cuda.get_device_name(0)
            gpu_vram_mb = round(torch.cuda.get_device_properties(0).total_memory / (1024 * 1024))
        except Exception:
            gpu_name = "NVIDIA CUDA Device"

    model_list = list(AVAILABLE_MODELS.values())
    is_installed = HAS_TORCH and (HAS_TRANSFORMERS or HAS_NEMO)

    return {
        "installed": is_installed,
        "nemo_installed": HAS_NEMO,
        "device": device,
        "active_device": device,
        "device_name": gpu_name or ("CPU" if is_installed else "Not Installed"),
        "gpu_available": device == "cuda",
        "gpu_name": gpu_name,
        "gpu_vram_mb": gpu_vram_mb,
        "torch_version": torch.__version__ if HAS_TORCH else None,
        "default_model": DEFAULT_MODEL,
        "models": model_list,
        "available_models": model_list,
        "error": None if is_installed else "PyTorch or Transformers not installed. Please run install.bat or run.bat."
    }


def get_asr_model(model_name: str = DEFAULT_MODEL):
    """Lazily load and cache the requested model."""
    global _loaded_models

    if not HAS_TORCH:
        raise RuntimeError("Speech-to-Text requires 'torch'. Please run install.bat to install dependencies.")

    if model_name in _loaded_models:
        return _loaded_models[model_name]

    info = AVAILABLE_MODELS.get(model_name)
    if info:
        model_type = info["type"]
    elif "parakeet" in model_name.lower():
        model_type = "parakeet"
    elif "whisper" in model_name.lower():
        model_type = "whisper"
    else:
        model_type = "ctc"

    device = get_current_device()
    logger.info("Loading ASR model '%s' (type: %s, device: %s)...", model_name, model_type, device)

    processor = None
    model = None

    if model_type == "parakeet":
        # 1. Try NVIDIA NeMo first if installed (required for TDT / RNNT models and optimal for CTC)
        if HAS_NEMO:
            try:
                nemo_model = nemo_asr.models.ASRModel.from_pretrained(model_name=model_name)
                nemo_model = nemo_model.to(device)
                nemo_model.eval()
                _loaded_models[model_name] = (None, nemo_model, device, "nemo_parakeet")
                logger.info("Successfully loaded NVIDIA Parakeet '%s' via NeMo on %s", model_name, device)
                return _loaded_models[model_name]
            except Exception as nemo_err:
                logger.warning("NeMo loading failed for '%s' (%s), trying Transformers fallback...", model_name, nemo_err)

        # 2. Fallback to Hugging Face Transformers (works out-of-the-box for nvidia/parakeet-ctc-0.6b and 1.1b)
        if not HAS_TRANSFORMERS:
            raise RuntimeError(
                f"Model '{model_name}' requires either 'nemo_toolkit[asr]' or 'transformers'. "
                "Install NeMo with: pip install nemo_toolkit[asr]"
            )
        from transformers import AutoProcessor, AutoModelForCTC, pipeline
        try:
            try:
                processor = AutoProcessor.from_pretrained(model_name, local_files_only=True)
                model = AutoModelForCTC.from_pretrained(model_name, local_files_only=True)
            except Exception:
                processor = AutoProcessor.from_pretrained(model_name)
                model = AutoModelForCTC.from_pretrained(model_name)
            model.to(device)
            model.eval()
            _loaded_models[model_name] = (processor, model, device, "hf_parakeet_ctc")
            logger.info("Successfully loaded NVIDIA Parakeet '%s' via Hugging Face Transformers on %s", model_name, device)
            return _loaded_models[model_name]
        except Exception as hf_err:
            # Final attempt via generic HF automatic-speech-recognition pipeline
            try:
                pipe_device = 0 if device == "cuda" else -1
                asr_pipe = pipeline("automatic-speech-recognition", model=model_name, device=pipe_device, trust_remote_code=True)
                _loaded_models[model_name] = (None, asr_pipe, device, "hf_pipeline")
                return _loaded_models[model_name]
            except Exception:
                raise RuntimeError(
                    f"Could not load '{model_name}'. Note: Parakeet TDT models require NVIDIA NeMo "
                    f"(pip install nemo_toolkit[asr]), while Parakeet CTC models work with Transformers. Original error: {hf_err}"
                )

    elif model_type == "whisper":
        from transformers import WhisperProcessor, WhisperForConditionalGeneration
        try:
            processor = WhisperProcessor.from_pretrained(model_name, local_files_only=True)
            model = WhisperForConditionalGeneration.from_pretrained(model_name, local_files_only=True)
        except Exception:
            processor = WhisperProcessor.from_pretrained(model_name)
            model = WhisperForConditionalGeneration.from_pretrained(model_name)
        model.to(device)
        model.eval()
        _loaded_models[model_name] = (processor, model, device, "whisper")
    else:  # ctc / wav2vec2
        from transformers import AutoProcessor, AutoModelForCTC
        try:
            processor = AutoProcessor.from_pretrained(model_name, local_files_only=True)
            model = AutoModelForCTC.from_pretrained(model_name, local_files_only=True)
        except Exception:
            processor = AutoProcessor.from_pretrained(model_name)
            model = AutoModelForCTC.from_pretrained(model_name)
        model.to(device)
        model.eval()
        _loaded_models[model_name] = (processor, model, device, "ctc")

    logger.info("Successfully cached model '%s' on %s", model_name, device)
    return _loaded_models[model_name]


def resample_audio(samples: np.ndarray, orig_sr: int, target_sr: int = 16000) -> np.ndarray:
    """Resample audio numpy array to target sample rate."""
    if orig_sr == target_sr:
        return samples
    try:
        import torchaudio.transforms as T
        tensor = torch.from_numpy(samples.astype(np.float32)).unsqueeze(0)
        resampler = T.Resample(orig_sr, target_sr)
        resampled_tensor = resampler(tensor).squeeze(0)
        return resampled_tensor.numpy()
    except Exception:
        from scipy.signal import resample_poly
        import math
        g = math.gcd(orig_sr, target_sr)
        return resample_poly(samples, target_sr // g, orig_sr // g).astype(np.float32)


def transcribe_audio_slice(samples: np.ndarray, sample_rate: int, model_name: str = DEFAULT_MODEL) -> dict:
    """
    Transcribe an audio slice with the chosen model.
    Returns: {"text": str, "model": str, "device": str}
    """
    if samples is None or len(samples) == 0:
        return {"text": "", "model": model_name, "device": get_current_device()}

    # Ensure 1D float32
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    samples = samples.astype(np.float32)

    # Check for near-total silence to avoid hallucinatory tokens
    rms = np.sqrt(np.mean(samples ** 2)) if len(samples) > 0 else 0.0
    if rms < 0.003:
        return {"text": "", "model": model_name, "device": get_current_device()}

    # Normalize if large amplitudes
    max_val = np.max(np.abs(samples))
    if max_val > 1.0:
        samples = samples / max_val

    # Resample to 16kHz
    if sample_rate != 16000:
        samples = resample_audio(samples, sample_rate, 16000)

    processor, model, device, model_type = get_asr_model(model_name)

    clean_text = ""

    if model_type == "nemo_parakeet":
        # NeMo ASRModel.transcribe accepts either numpy arrays or a temporary wav file
        import scipy.io.wavfile as wavfile
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_f:
                tmp_path = tmp_f.name
            pcm16 = np.clip(samples * 32767.0, -32768, 32767).astype(np.int16)
            wavfile.write(tmp_path, 16000, pcm16)
            with torch.no_grad():
                output = model.transcribe([tmp_path], verbose=False)
            if isinstance(output, tuple):
                output = output[0]
            if isinstance(output, list) and len(output) > 0:
                first = output[0]
                clean_text = first.text if hasattr(first, "text") else str(first)
            else:
                clean_text = str(output)
            clean_text = clean_text.strip()
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

    elif model_type == "hf_pipeline":
        result = model(samples.copy())
        if isinstance(result, dict):
            clean_text = str(result.get("text", "")).strip()
        else:
            clean_text = str(result).strip()

    elif model_type == "whisper":
        inputs = processor(samples, sampling_rate=16000, return_tensors="pt")
        input_features = inputs.input_features.to(device)

        with torch.no_grad():
            predicted_ids = model.generate(input_features, language="en", task="transcribe")

        transcription = processor.batch_decode(predicted_ids, skip_special_tokens=True)[0]
        clean_text = transcription.strip()

    elif model_type == "hf_parakeet_ctc":
        inputs = processor(samples, sampling_rate=16000, return_tensors="pt")
        input_features = (inputs.input_features if hasattr(inputs, "input_features") else inputs.input_values).to(device)

        with torch.no_grad():
            logits = model(input_features).logits

        pred_ids = torch.argmax(logits, dim=-1)
        transcription = processor.batch_decode(pred_ids, skip_special_tokens=True)[0]
        clean_text = transcription.strip()
        if clean_text and clean_text.islower():
            clean_text = clean_text.capitalize()

    else:  # Wav2Vec2 CTC
        inputs = processor(samples, sampling_rate=16000, return_tensors="pt")
        input_values = inputs.input_values.to(device)

        with torch.no_grad():
            logits = model(input_values).logits

        pred_ids = torch.argmax(logits, dim=-1)
        transcription = processor.batch_decode(pred_ids)[0]
        clean_text = transcription.strip()
        if clean_text:
            clean_text = clean_text.capitalize()

    return {
        "text": clean_text,
        "model": model_name,
        "device": device
    }
