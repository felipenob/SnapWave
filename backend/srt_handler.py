"""
srt_handler.py
Parser, serializer, and ELAN .eaf exporter for subtitle annotations.
Features:
- Microsecond/millisecond precision parsing and serialization
- Non-destructive backup (.srt.bak)
- Direct export to ELAN 7.0 .eaf format with multi-speaker tiers
"""

import os
import re
import shutil
import xml.etree.ElementTree as ET
from typing import List, Dict, Optional


def sec_to_srt_time(seconds: float) -> str:
    """Converts float seconds (e.g. 83.456) to SRT timestamp '00:01:23,456'."""
    if seconds < 0:
        seconds = 0.0
    total_ms = int(round(seconds * 1000.0))
    ms = total_ms % 1000
    total_sec = total_ms // 1000
    s = total_sec % 60
    total_min = total_sec // 60
    m = total_min % 60
    h = total_min // 60
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def srt_time_to_sec(time_str: str) -> float:
    """Converts SRT timestamp '00:01:23,456' to float seconds (83.456)."""
    clean_str = time_str.strip().replace(".", ",")
    parts = clean_str.split(":")
    if len(parts) == 3:
        h = int(parts[0])
        m = int(parts[1])
        s_parts = parts[2].split(",")
        s = int(s_parts[0])
        ms = int(s_parts[1]) if len(s_parts) > 1 else 0
        return h * 3600.0 + m * 60.0 + s + (ms / 1000.0)
    return 0.0


def parse_srt(file_path: str) -> List[Dict]:
    """
    Parses an SRT file into a list of annotation dictionaries:
    [
        {"id": 1, "start": 1.234, "end": 4.567, "text": "Hello world"}
    ]
    """
    if not os.path.exists(file_path):
        return []

    with open(file_path, "r", encoding="utf-8-sig", errors="replace") as f:
        content = f.read()

    # Normalize line endings
    content = content.replace("\r\n", "\n").replace("\r", "\n")
    blocks = re.split(r"\n\s*\n", content.strip())

    subtitles = []
    current_id = 1

    for block in blocks:
        lines = [l.strip() for l in block.split("\n") if l.strip()]
        if not lines:
            continue

        # Find line with timestamp arrow "-->"
        time_line_idx = -1
        for idx, line in enumerate(lines):
            if "-->" in line:
                time_line_idx = idx
                break

        if time_line_idx == -1:
            continue

        time_line = lines[time_line_idx]
        times = time_line.split("-->")
        if len(times) != 2:
            continue

        start_sec = srt_time_to_sec(times[0])
        end_sec = srt_time_to_sec(times[1])

        # Text is all subsequent lines
        text_lines = lines[time_line_idx + 1:]
        text = " ".join(text_lines).strip()

        subtitles.append({
            "id": current_id,
            "start": round(start_sec, 3),
            "end": round(end_sec, 3),
            "text": text
        })
        current_id += 1

    return subtitles


def ensure_no_overlaps(annotations: List[Dict], min_gap: float = 0.005) -> List[Dict]:
    """
    Guarantees annotations never overlap in time.
    Sorts by start time and clamps any overlapping boundaries.
    """
    if not annotations:
        return []

    sorted_annos = sorted(annotations, key=lambda x: x["start"])
    for i in range(1, len(sorted_annos)):
        prev_anno = sorted_annos[i - 1]
        curr_anno = sorted_annos[i]

        if curr_anno["start"] < prev_anno["end"]:
            # If current start is earlier than previous end, clamp previous end
            if curr_anno["start"] > prev_anno["start"] + min_gap:
                prev_anno["end"] = round(curr_anno["start"] - min_gap, 3)
            else:
                # If they start at the same time, shift current start forward
                curr_anno["start"] = round(prev_anno["end"] + min_gap, 3)

        if curr_anno["end"] <= curr_anno["start"]:
            curr_anno["end"] = round(curr_anno["start"] + 0.1, 3)

    return sorted_annos


def create_timestamped_backup(file_path: str, max_backups: int = 30):
    """Saves a timestamped backup copy in a hidden .backups/ folder inside the session."""
    try:
        if not os.path.exists(file_path):
            return
        file_dir = os.path.dirname(file_path)
        base_name, ext = os.path.splitext(os.path.basename(file_path))

        backup_dir = os.path.join(file_dir, ".backups")
        os.makedirs(backup_dir, exist_ok=True)

        from datetime import datetime
        ts_str = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_file = os.path.join(backup_dir, f"{base_name}_{ts_str}{ext}")

        shutil.copy2(file_path, backup_file)

        # Prune old backups if exceeding max_backups
        existing = sorted([
            os.path.join(backup_dir, f) for f in os.listdir(backup_dir)
            if f.startswith(base_name) and f.endswith(ext)
        ])
        while len(existing) > max_backups:
            oldest = existing.pop(0)
            try:
                os.remove(oldest)
            except Exception:
                pass
    except Exception as e:
        print(f"[srt_handler] Backup error: {e}")


def save_srt(file_path: str, annotations: List[Dict], create_backup: bool = True) -> bool:
    """
    Saves annotations list back to SRT format with non-overlapping bounds.
    Creates both standard .bak and organized timestamped backups in .backups/.
    """
    try:
        if create_backup and os.path.exists(file_path):
            # 1. Standard .bak
            bak_path = file_path + ".bak"
            if not os.path.exists(bak_path):
                shutil.copy2(file_path, bak_path)
            # 2. Timestamped backup in .backups/
            create_timestamped_backup(file_path)

        # Enforce no overlaps
        cleaned_annos = ensure_no_overlaps(annotations)

        lines = []
        for idx, anno in enumerate(cleaned_annos, start=1):
            start_str = sec_to_srt_time(anno["start"])
            end_str = sec_to_srt_time(anno["end"])
            text = anno.get("text", "").strip()

            lines.append(str(idx))
            lines.append(f"{start_str} --> {end_str}")
            lines.append(text)
            lines.append("")

        target_dir = os.path.dirname(os.path.abspath(file_path))
        os.makedirs(target_dir, exist_ok=True)

        # Atomic write with flush and fsync for instant Windows filesystem sync
        tmp_path = file_path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
            f.flush()
            os.fsync(f.fileno())

        os.replace(tmp_path, file_path)
        return True
    except Exception as e:
        print(f"[srt_handler] Error saving {file_path}: {e}")
        return False


def autosave_session_files(session_dir: str, all_annotations: Dict[str, List[Dict]]) -> Dict:
    """
    Performs background autosave to session_dir/.autosave/ directory.
    Prevents data loss without touching main production files until user saves.
    """
    autosave_dir = os.path.join(session_dir, ".autosave")
    os.makedirs(autosave_dir, exist_ok=True)
    saved_files = []

    for p_id, annos in all_annotations.items():
        auto_path = os.path.join(autosave_dir, f"{p_id}_autosave.srt")
        if save_srt(auto_path, annos, create_backup=False):
            saved_files.append(os.path.basename(auto_path))

    return {
        "success": True,
        "autosave_dir": autosave_dir,
        "saved_files": saved_files
    }


def export_multi_speaker_eaf(
    output_eaf_path: str,
    media_files: Dict[str, str],
    speaker_annotations: Dict[str, List[Dict]]
) -> bool:
    """
    Exports a synchronized multi-speaker session directly into an ELAN .eaf XML document.
    Enables immediate loading into ELAN 7.0 without manual tier creation.
    """
    try:
        root = ET.Element("ANNOTATION_DOCUMENT", {
            "AUTHOR": "FastReviewInterface",
            "DATE": "2026-10-13T00:00:00+00:00",
            "FORMAT": "3.0",
            "VERSION": "3.0",
            "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
            "xsi:noNamespaceSchemaLocation": "http://www.mpi.nl/tools/elan/EAFv3.0.xsd"
        })

        # Header with Media Descriptors
        header = ET.SubElement(root, "HEADER", {"MEDIA_FILE": "", "TIME_UNITS": "milliseconds"})
        for p_id, audio_path in media_files.items():
            rel_media = os.path.basename(audio_path)
            ET.SubElement(header, "MEDIA_DESCRIPTOR", {
                "MEDIA_URL": f"file:///{audio_path.replace(os.sep, '/')}",
                "MIME_TYPE": "audio/x-wav",
                "RELATIVE_MEDIA_URL": f"./{rel_media}"
            })

        # Time Order table
        time_order = ET.SubElement(root, "TIME_ORDER")
        time_slots = {}
        ts_counter = 1

        # Collect and sort all unique timestamps
        all_timestamps_ms = set()
        for p_id, annos in speaker_annotations.items():
            for a in annos:
                all_timestamps_ms.add(int(round(a["start"] * 1000.0)))
                all_timestamps_ms.add(int(round(a["end"] * 1000.0)))

        for t_ms in sorted(all_timestamps_ms):
            ts_id = f"ts{ts_counter}"
            time_slots[t_ms] = ts_id
            ET.SubElement(time_order, "TIME_SLOT", {
                "TIME_SLOT_ID": ts_id,
                "TIME_VALUE": str(t_ms)
            })
            ts_counter += 1

        # Tiers for each participant
        annotation_counter = 1
        for p_id, annos in speaker_annotations.items():
            tier = ET.SubElement(root, "TIER", {
                "LINGUISTIC_TYPE_REF": "default-lt",
                "PARTICIPANT": p_id,
                "TIER_ID": f"{p_id}_Transcript"
            })

            for a in sorted(annos, key=lambda x: x["start"]):
                start_ms = int(round(a["start"] * 1000.0))
                end_ms = int(round(a["end"] * 1000.0))
                ts_start = time_slots.get(start_ms)
                ts_end = time_slots.get(end_ms)

                if ts_start and ts_end:
                    ann_elem = ET.SubElement(tier, "ANNOTATION")
                    align_ann = ET.SubElement(ann_elem, "ALIGNABLE_ANNOTATION", {
                        "ANNOTATION_ID": f"a{annotation_counter}",
                        "TIME_SLOT_REF1": ts_start,
                        "TIME_SLOT_REF2": ts_end
                    })
                    ann_val = ET.SubElement(align_ann, "ANNOTATION_VALUE")
                    ann_val.text = a.get("text", "")
                    annotation_counter += 1

        # Linguistic type definition
        ET.SubElement(root, "LINGUISTIC_TYPE", {
            "GRAPHIC_REFERENCES": "false",
            "LINGUISTIC_TYPE_ID": "default-lt",
            "TIME_ALIGNABLE": "true"
        })

        # Save formatted XML
        tree = ET.ElementTree(root)
        tree.write(output_eaf_path, encoding="utf-8", xml_declaration=True)
        return True

    except Exception as e:
        print(f"[srt_handler] Error exporting EAF: {e}")
        return False
