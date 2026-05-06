#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--audio', required=True)
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--language', default='ja')
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        print(f'failed to import faster_whisper: {exc}', file=sys.stderr)
        return 2

    model = WhisperModel(args.model_dir, device='cpu', compute_type='int8')
    segments, info = model.transcribe(args.audio, language=args.language, vad_filter=True)
    text = ' '.join(segment.text.strip() for segment in segments if segment.text.strip()).strip()

    payload = {
        'text': text,
        'language': getattr(info, 'language', args.language),
        'duration': getattr(info, 'duration', None)
    }
    Path(args.output).write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
