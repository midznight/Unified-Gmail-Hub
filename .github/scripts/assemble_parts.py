from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PARTS = ROOT / "tmp" / "parts"

def join_parts(prefix: str, destination: str) -> None:
    chunks = sorted(PARTS.glob(f"{prefix}.*.part"))
    if not chunks:
        raise SystemExit(f"No parts found for {prefix}")
    content = "".join(path.read_text(encoding="utf-8") for path in chunks)
    target = ROOT / destination
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8", newline="\n")
    print(f"Assembled {destination} from {len(chunks)} parts ({len(content)} characters)")

join_parts("src_index", "src/index.js")
join_parts("public_index", "public/index.html")
