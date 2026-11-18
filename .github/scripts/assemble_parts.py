from pathlib import Path
import base64
import gzip
import hashlib

ROOT = Path(__file__).resolve().parents[2]
PARTS = ROOT / "tmp" / "parts"
chunks = sorted(PARTS.glob("public_index.*.part"))
if not chunks:
    raise SystemExit("No public_index parts found")

encoded = "".join(path.read_text(encoding="ascii").strip() for path in chunks)
html = gzip.decompress(base64.b64decode(encoded, validate=True))
digest = hashlib.sha256(html).hexdigest()
if not html.startswith(b"<!DOCTYPE html>") or not html.rstrip().endswith(b"</html>"):
    raise SystemExit("Assembled HTML failed document boundary checks")

target = ROOT / "public" / "index.html"
target.parent.mkdir(parents=True, exist_ok=True)
target.write_bytes(html)
print(f"Assembled public/index.html from {len(chunks)} compressed parts ({len(html)} bytes, sha256 {digest})")
