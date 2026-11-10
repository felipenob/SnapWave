"""
create_sample_session.py
Generates a realistic 4-speaker sample session in ./sample_session/
for immediate testing of the review interface.
Includes:
- Untrimmed speech onsets/offsets (to test pressing 'W' for Snap to Wave)
- Real crosstalk bleed on P2 from P1 (to test pressing 'D' for Crosstalk removal)
- Agreement tokens (to test 'Suggested: @ Backchannel')
- Pauses (to test 'S' for Split)
"""

import os
import wave
import struct
import math

SESSION_DIR = os.path.join(os.path.dirname(__file__), "sample_session")
SAMPLE_RATE = 16000
DURATION = 15.0 # 15 seconds session


def generate_tone(freq, duration_sec, amplitude=0.4):
    n = int(duration_sec * SAMPLE_RATE)
    return [amplitude * math.sin(2.0 * math.pi * freq * (i / SAMPLE_RATE)) for i in range(n)]


def generate_silence(duration_sec, noise_amp=0.002):
    n = int(duration_sec * SAMPLE_RATE)
    return [noise_amp * math.sin(2.0 * math.pi * 55.0 * (i / SAMPLE_RATE)) for i in range(n)]


def build_audio(segments):
    samples = []
    for kind, dur, amp, freq in segments:
        if kind == "tone":
            samples.extend(generate_tone(freq, dur, amp))
        else:
            samples.extend(generate_silence(dur, amp))
    return samples


def write_wav(path, samples):
    frames = []
    for s in samples:
        v = int(max(-32767, min(32767, s * 32767)))
        frames.append(struct.pack("<h", v))
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(b"".join(frames))


def main():
    os.makedirs(SESSION_DIR, exist_ok=True)
    print(f"Generating sample experiment session in: {SESSION_DIR}")

    # --- P1: Speaks 1.0 - 4.5s (freq 320), then 8.0 - 11.0s (freq 320) ---
    p1_samples = build_audio([
        ("silence", 1.0, 0.002, 0),
        ("tone", 3.5, 0.6, 320),     # 1.0 - 4.5s
        ("silence", 3.5, 0.002, 0),   # 4.5 - 8.0s
        ("tone", 3.0, 0.6, 320),     # 8.0 - 11.0s
        ("silence", 4.0, 0.002, 0)
    ])
    write_wav(os.path.join(SESSION_DIR, "P1.wav"), p1_samples)

    # --- P2: Faint bleed from P1 during 1.0-4.5s, then P2 speaks at 5.0 - 7.5s (freq 480) ---
    p2_samples = build_audio([
        ("silence", 1.0, 0.002, 0),
        ("tone", 3.5, 0.06, 320),    # Bleed from P1 (attenuated)
        ("silence", 0.5, 0.002, 0),   # 4.5 - 5.0s
        ("tone", 2.5, 0.65, 480),    # 5.0 - 7.5s (P2 real speech)
        ("silence", 7.5, 0.002, 0)
    ])
    write_wav(os.path.join(SESSION_DIR, "P2.wav"), p2_samples)

    # --- P3: Backchannel "Uh-huh" at 2.5 - 3.2s, speaks at 12.0 - 14.0s (freq 600) ---
    p3_samples = build_audio([
        ("silence", 2.5, 0.002, 0),
        ("tone", 0.7, 0.5, 580),     # 2.5 - 3.2s backchannel
        ("silence", 8.8, 0.002, 0),
        ("tone", 2.0, 0.55, 600),    # 12.0 - 14.0s
        ("silence", 1.0, 0.002, 0)
    ])
    write_wav(os.path.join(SESSION_DIR, "P3.wav"), p3_samples)

    # --- P4: Mostly room tone, brief laughter tone at 9.5 - 10.5s ---
    p4_samples = build_audio([
        ("silence", 9.5, 0.002, 0),
        ("tone", 1.0, 0.45, 750),    # 9.5 - 10.5s laugh
        ("silence", 4.5, 0.002, 0)
    ])
    write_wav(os.path.join(SESSION_DIR, "P4.wav"), p4_samples)

    # --- Sample SRTs with realistic ASR outputs ---
    # P1: Untrimmed annotations (0.4s to 4.9s - lots of silence that 'W' will snap!)
    with open(os.path.join(SESSION_DIR, "P1.srt"), "w", encoding="utf-8") as f:
        f.write("1\n00:00:00,400 --> 00:00:04,900\nWe should think of the pattern of it.\n\n")
        f.write("2\n00:00:07,500 --> 00:00:11,500\nThis is basi# wait, this is how we do it.\n\n")

    # P2: Has a false crosstalk annotation during P1's speech, then real speech
    with open(os.path.join(SESSION_DIR, "P2.srt"), "w", encoding="utf-8") as f:
        f.write("1\n00:00:01,000 --> 00:00:04,500\nWe should think pattern (Crosstalk bleed from P1)\n\n")
        f.write("2\n00:00:04,800 --> 00:00:07,800\nI totally agree with that idea.\n\n")

    # P3: Backchannel "Uh-huh" (tests Smart Backchannel auto-suggestion!)
    with open(os.path.join(SESSION_DIR, "P3.srt"), "w", encoding="utf-8") as f:
        f.write("1\n00:00:02,300 --> 00:00:03,400\nUh-huh.\n\n")
        f.write("2\n00:00:11,800 --> 00:00:14,200\nLet us check the next item.\n\n")

    # P4: Laughter segment
    with open(os.path.join(SESSION_DIR, "P4.srt"), "w", encoding="utf-8") as f:
        f.write("1\n00:00:09,300 --> 00:00:10,800\nhahaha\n\n")

    print("[SUCCESS] Sample experiment session generated successfully in sample_session/")


if __name__ == "__main__":
    main()
