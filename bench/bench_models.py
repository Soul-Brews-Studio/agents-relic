"""The embedding models under test, and the ONE way every script encodes documents.

Shared because the prefixes have to agree. diagnose_para.py and relation.py each
hardcoded e5's "query: " / "passage: " beside a BENCH_DIAG_MODEL switch: right for the
model they were written against, silently wrong for any other, and a wrong prefix costs
recall without raising anything.

Every prefix is the model card's, not a guess:

    e5                 "query: " / "passage: "
    bge-m3             none — its card: dense retrieval needs no instruction
    Qwen3-Embedding    an instruction on queries only (the "query" prompt in its own
                       config_sentence_transformers.json), nothing on documents
    embeddinggemma     "task: search result | query: " / "title: none | text: "

Two runtimes, labelled in the row. `st` rows run the HF weights through
sentence-transformers. `ollama` rows (a name starting `ollama:`) go through a local
Ollama's /api/embed, the path `relic embed --model <name>` takes. embeddinggemma exists
ONLY as an Ollama row: the HF copy is gated. bge-m3 is in both, as a parity check on the
runtime — if the two bge-m3 rows disagree beyond noise, the Ollama rows are a different
measurement and are reported apart.

relic's ollama provider sends raw text both ways, so an Ollama row with a model-card
prefix measures the model, and its no-prefix twin measures what relic would get today.

Document vectors are cached under BENCH_EMB_CACHE when it is set. The paraphrase run and
the null check embed the SAME documents as the known-item run, and at 1024 dims under
load that is minutes per model per script. The key covers everything that changes a
vector — model, document prefix, max_seq_length and the texts themselves — so a new pool
can never be served an old pool's vectors.
"""
import hashlib
import json
import os
import time
import urllib.request

import numpy as np

QWEN3_QUERY = ("Instruct: Given a web search query, retrieve relevant passages that "
               "answer the query\nQuery:")

MODELS = [
    # label                     HF name                                                      query prefix / doc prefix
    ("multilingual-MiniLM-L12", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2", "", ""),
    ("multilingual-e5-small",   "intfloat/multilingual-e5-small", "query: ", "passage: "),
    ("all-MiniLM-L6 (en only)", "sentence-transformers/all-MiniLM-L6-v2", "", ""),
    ("bge-m3",                  "BAAI/bge-m3", "", ""),
    ("Qwen3-Embedding-0.6B",    "Qwen/Qwen3-Embedding-0.6B", QWEN3_QUERY, ""),
    ("embeddinggemma-300m",     "google/embeddinggemma-300m",
     "task: search result | query: ", "title: none | text: "),
    # A control, not a candidate: relic's ollama provider sends raw text both ways, so
    # `qwen3-embedding:0.6b` through ollama gets NO query instruction. This row prices
    # that. Same documents as the row above, so they come out of the cache.
    ("Qwen3-0.6B, no instruct", "Qwen/Qwen3-Embedding-0.6B", "", ""),
    # Ollama rows — see the module docstring.
    ("bge-m3 (ollama)",         "ollama:bge-m3", "", ""),
    ("embeddinggemma (ollama)", "ollama:embeddinggemma",
     "task: search result | query: ", "title: none | text: "),
    ("emb-gemma raw (ollama)", "ollama:embeddinggemma", "", ""),
]

OLLAMA = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")


class OllamaModel:
    """The slice of SentenceTransformer the bench scripts call, over Ollama's /api/embed."""

    def __init__(self, model: str):
        self.model = model
        with urllib.request.urlopen(f"{OLLAMA}/api/show", data=json.dumps({"model": model}).encode(),
                                    timeout=60) as r:
            info = json.loads(r.read()).get("model_info", {})
        # The model's context in tokens, which is what Ollama truncates to (truncate=true).
        self.max_seq_length = next((v for k, v in info.items() if k.endswith(".context_length")), 0)

    def encode(self, texts, normalize_embeddings=True, batch_size=32, show_progress_bar=False):
        out = []
        for i in range(0, len(texts), batch_size):
            req = urllib.request.Request(
                f"{OLLAMA}/api/embed", headers={"content-type": "application/json"},
                data=json.dumps({"model": self.model, "input": texts[i:i + batch_size],
                                 "truncate": True}).encode())
            with urllib.request.urlopen(req, timeout=600) as r:
                out.extend(json.loads(r.read())["embeddings"])
            if show_progress_bar:
                print(f"    {self.model}: {min(i + batch_size, len(texts))}/{len(texts)}", flush=True)
        v = np.asarray(out, dtype=np.float32)
        if normalize_embeddings:
            v /= np.linalg.norm(v, axis=1, keepdims=True)
        return v


def load(name: str, device: str = "mps"):
    """A SentenceTransformer, or an OllamaModel for an `ollama:` name."""
    if name.startswith("ollama:"):
        return OllamaModel(name.split(":", 1)[1])
    from sentence_transformers import SentenceTransformer
    return SentenceTransformer(name, device=device)


def runtime(name: str) -> str:
    return "ollama" if name.startswith("ollama:") else "st"

# 64 is what the 2026-09-18 run used; 32 keeps a 1024-dim model's activations small on a
# machine other agents are also loading. It changes throughput, not rankings.
BATCH = int(os.environ.get("BENCH_BATCH", "64"))


def pick(labels: str | None = None) -> list[tuple[str, str, str, str]]:
    """All models, or the comma-separated labels in `labels` — in MODELS order."""
    if not labels:
        return MODELS
    want = {x.strip() for x in labels.split(",")}
    unknown = want - {m[0] for m in MODELS}
    if unknown:
        raise SystemExit(f"unknown model label(s): {sorted(unknown)}")
    return [m for m in MODELS if m[0] in want]


def prefixes_for(name: str) -> tuple[str, str]:
    """(query prefix, doc prefix) for an HF model name; unknown models get none."""
    for _label, n, qpre, dpre in MODELS:
        if n == name:
            return qpre, dpre
    return "", ""


def encode_docs(m, name: str, dpre: str, texts: list[str]):
    """(D, encode seconds, cached?) — D read back when this exact input was embedded."""
    cache = os.environ.get("BENCH_EMB_CACHE")
    key = hashlib.sha256(json.dumps([name, dpre, m.max_seq_length, texts]).encode()).hexdigest()[:16]
    path = os.path.join(cache, f"{name.replace('/', '__')}-{key}") if cache else None
    if path and os.path.exists(path + ".npy"):
        return np.load(path + ".npy"), json.load(open(path + ".json"))["encode_s"], True
    t0 = time.time()
    D = m.encode([dpre + x for x in texts], normalize_embeddings=True,
                 batch_size=BATCH, show_progress_bar=True)
    s = time.time() - t0
    if path:
        os.makedirs(cache, exist_ok=True)
        np.save(path + ".npy", D)
        json.dump({"model": name, "doc_prefix": dpre, "max_seq_length": m.max_seq_length,
                   "n": len(texts), "dim": int(D.shape[1]), "encode_s": s,
                   "batch_size": BATCH, "loadavg": os.getloadavg()}, open(path + ".json", "w"))
    return D, s, False
