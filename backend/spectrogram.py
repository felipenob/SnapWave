"""
spectrogram.py
Generates high-contrast speech spectrograms (0-8 kHz) for voice onset and formant analysis.
Optimized for human voice detection (Praat / ELAN style).
"""

import io
import numpy as np

try:
    import scipy.signal as signal
    from PIL import Image
    HAS_SCIPY_PIL = True
except ImportError as _err:
    signal = None
    Image = None
    HAS_SCIPY_PIL = False
    _IMPORT_ERR = str(_err)


def _build_voice_colormap():
    """Builds a 256-color Magma / Voice colormap palette for vocal formants."""
    x = np.linspace(0.0, 1.0, 256)
    
    # Red: starts low, rises rapidly in mid-range (formants)
    r = np.clip(1.6 * (x ** 1.3), 0.0, 1.0)
    # Green: stays low during low energy, kicks in for vowels and peak energy
    g = np.clip(1.9 * (x ** 2.4) - 0.15 * x, 0.0, 1.0)
    # Blue: subtle at low-mid, rises for bright highlights
    b = np.clip(0.6 * np.sin(x * np.pi) + 0.35 * (x ** 3.0) + 0.06, 0.0, 1.0)
    
    palette = np.column_stack([r, g, b])
    palette[0] = [10 / 255.0, 15 / 255.0, 29 / 255.0]  # dark app background (#0a0f1d)
    return (palette * 255).astype(np.uint8)

def _build_bw_colormap():
    """Builds a 256-color Black & White palette: white background (0 energy) to black (max energy)."""
    val = np.linspace(255.0, 0.0, 256).astype(np.uint8)
    return np.column_stack([val, val, val])


_VOICE_PALETTE = _build_voice_colormap() if HAS_SCIPY_PIL else None
_BW_PALETTE = _build_bw_colormap() if HAS_SCIPY_PIL else None


def generate_spectrogram_png(
    samples: np.ndarray,
    sample_rate: int = 16000,
    width: int = 800,
    height: int = 110,
    dynamic_range_db: float = 60.0,
    color_scheme: str = "magma"
) -> bytes:
    """
    Computes STFT spectrogram and returns PNG bytes with voice-optimized colormap.
    Frequency axis: 0 Hz at bottom to 8000 Hz at top (or Nyquist).
    color_scheme: 'magma' (vocal formants on dark) or 'bw' (black energy on white background).
    """
    if width <= 0 or height <= 0:
        width, height = 800, 110

    if not HAS_SCIPY_PIL:
        raise RuntimeError("Spectrogram requires 'scipy' and 'pillow'. Please run run.bat or install them via pip.")

    is_bw = str(color_scheme).lower() in ("bw", "grayscale", "b&w")
    palette = _BW_PALETTE if is_bw else _VOICE_PALETTE
    bg_color = (255, 255, 255) if is_bw else (10, 15, 29)

    if samples is None or len(samples) < 128:
        img = Image.new("RGB", (width, height), color=bg_color)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()

    # Ensure 1D float32
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    samples = samples.astype(np.float32)

    # Window configuration for vocal formant resolution (25ms window, 5ms hop)
    nperseg = min(len(samples), 400)
    noverlap = int(nperseg * 0.75)
    nfft = 512

    f, t, Sxx = signal.spectrogram(
        samples,
        fs=sample_rate,
        window="hann",
        nperseg=nperseg,
        noverlap=noverlap,
        nfft=nfft,
        scaling="density"
    )

    # Convert to dB power
    S_db = 10.0 * np.log10(Sxx + 1e-10)

    # Adaptive contrast normalization for vocal formants
    vmax = np.percentile(S_db, 99.2) if S_db.size > 0 else 0.0
    vmin = vmax - dynamic_range_db

    norm = np.clip((S_db - vmin) / max(1.0, dynamic_range_db), 0.0, 1.0)
    idx = (norm * 255).astype(np.uint8)

    # Map to 24-bit RGB using chosen palette, inverting Y so 0 Hz is at bottom
    rgb = palette[idx[::-1, :]]

    img = Image.fromarray(rgb)
    if img.size != (width, height):
        img = img.resize((width, height), Image.Resampling.BILINEAR)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
