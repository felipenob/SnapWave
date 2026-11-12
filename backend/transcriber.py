"""
transcriber.py
Fast, multi-model, offline Speech-to-Text transcription engine for local transcript cleaning.
Supports:
1. Wav2Vec2 CTC models (ultra-fast phoneme/word transcription)
2. OpenAI Whisper models (seq2seq with natural punctuation & capitalization)
3. NVIDIA Parakeet TDT models (ultra-fast, highly accurate local pipeline)
Supports dynamic model switching and execution on CPU or NVIDIA GPU (CUDA).
"""

import sys
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
    "facebook/wav2vec2-base-960h": {
        "id": "facebook/wav2vec2-base-960h",
        "name": "Wav2Vec2 960h",
        "label": "Facebook Wav2Vec2 960h",
        "size": "CTC, 95M params (~360 MB)",
        "type": "ctc",
        "desc": "Ultra-fast acoustic CTC model. Good for quick word boundaries."
    },
    "openai/whisper-base": {
        "id": "openai/whisper-base",
        "name": "Whisper Base",
        "label": "OpenAI Whisper Base",
        "size": "Accurate, 74M params (~290 MB)",
        "type": "whisper",
        "desc": "Higher accuracy Whisper model for conversational nuances."
    },
    "nvidia/parakeet-tdt-0.6b-v3": {
        "id": "nvidia/parakeet-tdt-0.6b-v3",
        "name": "Parakeet TDT 0.6B",
        "label": "NVIDIA Parakeet TDT v3",
        "size": "Fast/Accurate, 600M params (~1.2 GB)",
        "type": "parakeet",
        "desc": "NVIDIA's advanced local end-to-end ASR pipeline via Hugging Face."
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
    is_installed = HAS_TORCH and HAS_TRANSFORMERS

    return {
        "installed": is_installed,
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
        "error": None if is_installed else "PyTorch or Transformers not installed. Please run run.bat to auto-install."
    }


def get_asr_model(model_name: str = DEFAULT_MODEL):
    """Lazily load and cache the requested model."""
    global _loaded_models

    if not HAS_TORCH or not HAS_TRANSFORMERS:
        raise RuntimeError("Speech-to-Text requires 'torch' and 'transformers'. Please run run.bat to install them.")

    if model_name not in AVAILABLE_MODELS:
        model_name = DEFAULT_MODEL

    if model_name in _loaded_models:
        return _loaded_models[model_name]

    info = AVAILABLE_MODELS[model_name]
    model_type = info["type"]
    device = get_current_device()
    logger.info("Loading ASR model '%s' (type: %s, device: %s)...", model_name, model_type, device)

    # Setup hardware parameters optimized for NVIDIA GPU
    device_arg = 0 if device == "cuda" else -1
    torch_dtype = torch.float16 if device == "cuda" else torch.float32

    if model_type == "parakeet":
        from transformers import pipeline
        try:
            # Load optimized pipeline object directly
            pipe = pipeline(
                "automatic-speech-recognition",
                model=model_name,
                device=device_arg,
                torch_dtype=torch_dtype,
                local_files_only=True
            )
        except Exception:
            pipe = pipeline(
                "automatic-speech-recognition",
                model=model_name,
                device=device_arg,
                torch_dtype=torch_dtype
            )
        # Store pipeline directly in cache structure
        _loaded_models[model_name] = (pipe, None, device, model_type)

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
        _loaded_models[model_name] = (processor, model, device, model_type)

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
        _loaded_models[model_name] = (processor, model, device, model_type)

    logger.info("Successfully cached model '%s' on %s", model_name, device)
    return _loaded_models[model_name]


def resample_audio(samples: np.ndarray, orig_sr: int, target_sr: int = 16000) -> np.ndarray:
    """Resample audio numpy array to target sample rate."""
    if orig_sr == target_sr:
        return samples
    import torchaudio.transforms as T
    tensor = torch.from_numpy(samples.astype(np.float32)).unsqueeze(0)
    resampler = T.Resample(orig_sr, target_sr)
    resampled_tensor = resampler(tensor).squeeze(0)
    return resampled_tensor.numpy()


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

    # Get backend properties
    pipe_or_processor, model, device, model_type = get_asr_model(model_name)

    clean_text = ""

    if model_type == "parakeet":
        # The pipeline automatically handles the numpy array processing
        with torch.no_grad():
            res = pipe_or_processor(samples)
        clean_text = res["text"].strip()

    elif model_type == "whisper":
        inputs = pipe_or_processor(samples, sampling_rate=16000, return_tensors="pt")
        input_features = inputs.input_features.to(device)

        with torch.no_grad():
            predicted_ids = model.generate(input_features, language="en", task="transcribe")

        transcription = pipe_or_processor.batch_decode(predicted_ids, skip_special_tokens=True)[0]
        clean_text = transcription.strip()

    else:  # Wav2Vec2 CTC
        inputs = pipe_or_processor(samples, sampling_rate=16000, return_tensors="pt")
        input_values = inputs.input_values.to(device)

        with torch.no_grad():
            logits = model(input_values).logits

        pred_ids = torch.argmax(logits, dim=-1)
        transcription = pipe_or_processor.batch_decode(pred_ids)[0]
        clean_text = transcription.strip()
        if clean_text:
            clean_text = clean_text.capitalize()

    return {
        "text": clean_text,
        "model": model_name,
        "device": device
    }