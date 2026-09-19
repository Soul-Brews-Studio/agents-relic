"""A sentence-transformers model behind a JSON-lines pipe.

Exists so the TypeScript implementation can offer `--provider st` WITHOUT taking a
torch-sized dependency. The model runtime stays in Python, where it already is; the
TypeScript side spawns this and talks to it over stdin/stdout, so both front ends reach
the same models and `relic embed` and `relic-py embed` stay one command rather than two.

A PERSISTENT process, not one subprocess per batch: loading e5-small costs ~10 s and a
backfill is thousands of batches. One-shot invocation would spend all its time loading.

Protocol — one JSON object per line, in both directions:

    <- {"ready": true, "model": "...", "dim": 384}     once, after the model loads
    -> {"texts": ["a", "b"]}
    <- {"embeddings": [[...], [...]]}
    <- {"error": "..."}                                 on failure; the stream continues

stdout carries the protocol and NOTHING else. sentence-transformers and its
dependencies print progress bars and HF warnings, all of which would corrupt the stream
if they landed on stdout — so stderr is where every human-readable byte goes, and the
process is started with warnings silenced.
"""

from __future__ import annotations

import argparse
import json
import sys


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="relic-embed-server")
    ap.add_argument("--model", required=True)
    ap.add_argument("--device", default=None, help="cpu | mps | cuda")
    ap.add_argument("--doc-prefix", default="",
                    help='e5 models want "passage: " on documents')
    a = ap.parse_args(argv)

    import warnings
    warnings.filterwarnings("ignore")
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        # A structured error rather than a traceback: the caller is a program, and the
        # remedy is a different command line, not a stack trace.
        print(json.dumps({"error": "sentence-transformers not installed; run under "
                                   "`uv run --with sentence-transformers`"}), flush=True)
        return 2

    m = SentenceTransformer(a.model, device=a.device) if a.device \
        else SentenceTransformer(a.model)
    dim = int(m.get_sentence_embedding_dimension())
    print(json.dumps({"ready": True, "model": a.model, "dim": dim}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            texts = json.loads(line)["texts"]
            vecs = m.encode([a.doc_prefix + t for t in texts], show_progress_bar=False)
            # normalize_embeddings stays OFF: normalisation happens once on the caller's
            # side for every provider, so `norm` on disk means the same thing whichever
            # backend wrote the row.
            out = {"embeddings": [[float(x) for x in v] for v in vecs]}
        except Exception as e:                       # noqa: BLE001 — reported, not raised
            out = {"error": f"{type(e).__name__}: {e}"[:300]}
        print(json.dumps(out), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
