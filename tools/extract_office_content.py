from __future__ import annotations

import argparse
import json
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}


def qn(prefix: str, tag: str) -> str:
    return f"{{{NS[prefix]}}}{tag}"


def natural_key(value: str):
    return [int(piece) if piece.isdigit() else piece.lower() for piece in re.split(r"(\d+)", value)]


def normalize(text: str) -> str:
    return re.sub(r"[ \t\u00a0]+", " ", text).strip()


def word_run_text(node: ET.Element) -> str:
    out: list[str] = []
    for elem in node.iter():
        if elem.tag in (qn("w", "t"), qn("w", "delText")) and elem.text:
            out.append(elem.text)
        elif elem.tag == qn("w", "tab"):
            out.append("\t")
        elif elem.tag in (qn("w", "br"), qn("w", "cr")):
            out.append("\n")
    return normalize("".join(out))


def word_paragraph_info(paragraph: ET.Element) -> dict:
    text = word_run_text(paragraph)
    style = ""
    ppr = paragraph.find("w:pPr", NS)
    if ppr is not None:
        pstyle = ppr.find("w:pStyle", NS)
        if pstyle is not None:
            style = pstyle.get(qn("w", "val"), "")
    num = ""
    if ppr is not None:
        numpr = ppr.find("w:numPr", NS)
        if numpr is not None:
            ilvl = numpr.find("w:ilvl", NS)
            numid = numpr.find("w:numId", NS)
            num = f"numId={numid.get(qn('w','val'),'') if numid is not None else ''},level={ilvl.get(qn('w','val'),'') if ilvl is not None else ''}"
    return {"type": "paragraph", "style": style, "numbering": num, "text": text}


def extract_docx(path: Path) -> dict:
    with zipfile.ZipFile(path) as zf:
        root = ET.fromstring(zf.read("word/document.xml"))
        body = root.find("w:body", NS)
        blocks: list[dict] = []
        if body is not None:
            for child in body:
                if child.tag == qn("w", "p"):
                    info = word_paragraph_info(child)
                    if info["text"]:
                        blocks.append(info)
                elif child.tag == qn("w", "tbl"):
                    rows: list[list[str]] = []
                    for tr in child.findall("w:tr", NS):
                        cells = []
                        for tc in tr.findall("w:tc", NS):
                            parts = [word_run_text(p) for p in tc.findall("w:p", NS)]
                            cells.append(" / ".join(p for p in parts if p))
                        rows.append(cells)
                    blocks.append({"type": "table", "rows": rows})

        headers_footers: dict[str, list[str]] = {}
        for name in sorted((n for n in zf.namelist() if re.fullmatch(r"word/(header|footer)\d+\.xml", n)), key=natural_key):
            hroot = ET.fromstring(zf.read(name))
            texts = [word_run_text(p) for p in hroot.iter(qn("w", "p"))]
            headers_footers[name] = [t for t in texts if t]

        comments: list[str] = []
        if "word/comments.xml" in zf.namelist():
            croot = ET.fromstring(zf.read("word/comments.xml"))
            for comment in croot.findall("w:comment", NS):
                text = " ".join(word_run_text(p) for p in comment.findall("w:p", NS))
                if text:
                    comments.append(normalize(text))

        media = sorted((n for n in zf.namelist() if n.startswith("word/media/")), key=natural_key)

    return {
        "file": str(path),
        "kind": "docx",
        "blocks": blocks,
        "headers_footers": headers_footers,
        "comments": comments,
        "media": media,
    }


def slide_shape_position(shape: ET.Element) -> tuple[int, int]:
    xfrm = shape.find(".//a:xfrm", NS)
    if xfrm is None:
        xfrm = shape.find(".//p:xfrm", NS)
    if xfrm is not None:
        off = xfrm.find("a:off", NS)
        if off is None:
            off = xfrm.find("p:off", NS)
        if off is not None:
            return int(off.get("y", "0")), int(off.get("x", "0"))
    return 0, 0


def ppt_shape_text(shape: ET.Element) -> str:
    paragraphs: list[str] = []
    for para in shape.findall(".//a:p", NS):
        parts: list[str] = []
        for elem in para.iter():
            if elem.tag == qn("a", "t") and elem.text:
                parts.append(elem.text)
            elif elem.tag == qn("a", "br"):
                parts.append("\n")
        text = normalize("".join(parts))
        if text:
            paragraphs.append(text)
    return "\n".join(paragraphs)


def extract_pptx(path: Path) -> dict:
    with zipfile.ZipFile(path) as zf:
        names = set(zf.namelist())
        slide_names = sorted((n for n in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)), key=natural_key)
        slides: list[dict] = []
        for slide_name in slide_names:
            sroot = ET.fromstring(zf.read(slide_name))
            shapes: list[tuple[tuple[int, int], str]] = []
            sp_tree = sroot.find(".//p:spTree", NS)
            if sp_tree is not None:
                for shape in list(sp_tree):
                    text = ppt_shape_text(shape)
                    if text:
                        shapes.append((slide_shape_position(shape), text))
            shapes.sort(key=lambda item: item[0])

            num_match = re.search(r"(\d+)", Path(slide_name).stem)
            slide_num = int(num_match.group(1)) if num_match else len(slides) + 1
            note_name = f"ppt/notesSlides/notesSlide{slide_num}.xml"
            notes: list[str] = []
            if note_name in names:
                nroot = ET.fromstring(zf.read(note_name))
                for sp in nroot.findall(".//p:sp", NS):
                    text = ppt_shape_text(sp)
                    if text and not re.fullmatch(r"\d+", text):
                        notes.append(text)
            slides.append({
                "number": slide_num,
                "text_blocks": [text for _, text in shapes],
                "notes": notes,
            })

        media = sorted((n for n in names if n.startswith("ppt/media/")), key=natural_key)
        charts = sorted((n for n in names if n.startswith("ppt/charts/chart") and n.endswith(".xml")), key=natural_key)

    return {"file": str(path), "kind": "pptx", "slides": slides, "media": media, "charts": charts}


def to_markdown(data: dict) -> str:
    lines = [f"# {Path(data['file']).name}", "", f"Source: `{data['file']}`", ""]
    if data["kind"] == "docx":
        for block in data["blocks"]:
            if block["type"] == "paragraph":
                style = block["style"]
                text = block["text"]
                if re.search(r"heading|标题", style, re.I):
                    match = re.search(r"(\d+)", style)
                    level = min(int(match.group(1)), 6) if match else 2
                    lines.extend(["#" * level + " " + text, ""])
                else:
                    prefix = f"[{style}] " if style and style not in ("Normal", "正文") else ""
                    lines.extend([prefix + text, ""])
            else:
                lines.append("[TABLE]")
                for row in block["rows"]:
                    lines.append(" | ".join(cell.replace("\n", " ") for cell in row))
                lines.append("[/TABLE]")
                lines.append("")
        if data["headers_footers"]:
            lines.extend(["## Headers and footers", ""])
            for name, texts in data["headers_footers"].items():
                if texts:
                    lines.append(f"- {name}: {' / '.join(texts)}")
            lines.append("")
        if data["comments"]:
            lines.extend(["## Comments", ""])
            lines.extend(f"- {comment}" for comment in data["comments"])
            lines.append("")
    else:
        for slide in data["slides"]:
            lines.extend([f"## Slide {slide['number']}", ""])
            for text in slide["text_blocks"]:
                lines.extend([text, ""])
            if slide["notes"]:
                lines.append("[NOTES]")
                lines.extend(slide["notes"])
                lines.extend(["[/NOTES]", ""])
    lines.extend(["## Package inventory", "", f"- Media files: {len(data.get('media', []))}"])
    if "charts" in data:
        lines.append(f"- Chart XML files: {len(data['charts'])}")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    manifest: list[dict] = []
    for path in args.paths:
        suffix = path.suffix.lower()
        if suffix == ".docx":
            data = extract_docx(path)
        elif suffix == ".pptx":
            data = extract_pptx(path)
        else:
            raise ValueError(f"Unsupported file type: {path}")
        target = args.output_dir / f"{path.stem}.md"
        target.write_text(to_markdown(data), encoding="utf-8")
        manifest.append({
            "source": str(path),
            "output": str(target),
            "kind": data["kind"],
            "blocks": len(data.get("blocks", [])),
            "slides": len(data.get("slides", [])),
            "media": len(data.get("media", [])),
            "charts": len(data.get("charts", [])),
        })
    (args.output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
