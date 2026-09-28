"""
Geometry audit of a generated .pptx, straight from its XML.

This is NOT a substitute for looking at the rendered slides. It cannot see
contrast, wrapping or how a font actually sets. It catches the two defects
that are invisible in a content dump and silently shipped by pptxgenjs:

  * a shape positioned past the canvas edge — pptxgenjs writes the
    coordinates rather than clamping, so the shape simply is not there
  * two text frames overlapping, which renders as text through text

Run: python check-geometry.py agentx.pptx
"""

import sys
import zipfile
import defusedxml.ElementTree as ET

EMU = 914400.0
NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
}

SLIDE_W, SLIDE_H = 13.333, 7.5
MARGIN = 0.5


def frames(xml):
    """Every shape with a position and size, as inches, plus its text."""
    root = ET.fromstring(xml)
    out = []
    for sp in root.iter():
        if not sp.tag.endswith("}sp") and not sp.tag.endswith("}pic"):
            continue
        xfrm = sp.find(".//a:xfrm", NS)
        if xfrm is None:
            continue
        off, ext = xfrm.find("a:off", NS), xfrm.find("a:ext", NS)
        if off is None or ext is None:
            continue
        text = "".join(t.text or "" for t in sp.iter(f"{{{NS['a']}}}t"))
        out.append(
            {
                "x": int(off.get("x", 0)) / EMU,
                "y": int(off.get("y", 0)) / EMU,
                "w": int(ext.get("cx", 0)) / EMU,
                "h": int(ext.get("cy", 0)) / EMU,
                "text": text.strip()[:48],
                "has_text": bool(text.strip()),
            }
        )
    return out


def overlap(a, b):
    """Area shared by two boxes, in square inches."""
    dx = min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"])
    dy = min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"])
    return dx * dy if dx > 0 and dy > 0 else 0.0


def main(pptx):
    problems = 0
    with zipfile.ZipFile(pptx) as z:
        names = sorted(
            (n for n in z.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml")),
            key=lambda n: int("".join(c for c in n if c.isdigit())),
        )
        for n in names:
            num = "".join(c for c in n.split("/")[-1] if c.isdigit())
            boxes = frames(z.read(n))

            for b in boxes:
                if b["x"] < -0.01 or b["y"] < -0.01:
                    print(f"  slide {num}: negative position ({b['x']:.2f}, {b['y']:.2f}) {b['text']!r}")
                    problems += 1
                if b["x"] + b["w"] > SLIDE_W + 0.01 or b["y"] + b["h"] > SLIDE_H + 0.01:
                    print(
                        f"  slide {num}: past the canvas edge, ends at "
                        f"({b['x'] + b['w']:.2f}, {b['y'] + b['h']:.2f}) {b['text']!r}"
                    )
                    problems += 1
                if b["has_text"] and (b["x"] < MARGIN - 0.01 or b["x"] + b["w"] > SLIDE_W - MARGIN + 0.01):
                    print(f"  slide {num}: text inside the {MARGIN}\" margin {b['text']!r}")
                    problems += 1

            # Text over text. A text frame sitting on a card is expected, so
            # only text-bearing pairs count.
            texts = [b for b in boxes if b["has_text"]]
            for i, a in enumerate(texts):
                for b in texts[i + 1 :]:
                    shared = overlap(a, b)
                    if shared > 0.05:
                        print(
                            f"  slide {num}: {shared:.2f} sq in of text overlapping "
                            f"{a['text']!r} / {b['text']!r}"
                        )
                        problems += 1

    print(f"\n{'FAILED' if problems else 'Geometry OK'} — {problems} problem(s) across {len(names)} slides")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "agentx.pptx"))
