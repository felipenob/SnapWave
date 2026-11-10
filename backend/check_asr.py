import sys

pkgs = ['faster_whisper', 'whisper', 'transformers', 'torch', 'torchaudio', 'nemo', 'soundfile']
for p in pkgs:
    try:
        m = __import__(p)
        print(f"{p}: INSTALLED ({getattr(m, '__version__', 'ok')})")
    except ImportError:
        print(f"{p}: NOT_FOUND")
