"""Index NCERT textbooks into the local ChromaDB store.

Usage (from the project root, with the venv's python):
  python -m ncert.ingest download jesc1              # Class 10 Science, straight from ncert.nic.in
  python -m ncert.ingest download jesc1 jemh1 lebo1  # several books
  python -m ncert.ingest folder "C:/Downloads/jesc1dd" --class 10 --subject science
  python -m ncert.ingest list                        # what's indexed
  python -m ncert.ingest books                       # known book codes

NCERT publishes each chapter as https://ncert.nic.in/textbook/pdf/<code><NN>.pdf
(e.g. jesc101.pdf). If the site is unreachable, download the book zip in a
browser from https://ncert.nic.in/textbook.php, unzip it, and use `folder`.
"""
from __future__ import annotations

import argparse
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

from . import store

PDF_DIR = store.ROOT / "data" / "ncert_pdfs"
BASE_URL = "https://ncert.nic.in/textbook/pdf/"

# English-medium book codes: <class letter><e><subject><part>. Class letters:
# f=6, g=7, h=8, i=9, j=10, k=11, l=12. Pass --class/--subject for others.
BOOKS = {
    "hesc1": (8, "science"), "hemh1": (8, "maths"),
    "iesc1": (9, "science"), "iemh1": (9, "maths"),
    "jesc1": (10, "science"), "jemh1": (10, "maths"),
    "jess1": (10, "geography"), "jess2": (10, "economics"), "jess3": (10, "history"), "jess4": (10, "political science"),
    "keph1": (11, "physics"), "keph2": (11, "physics"), "kech1": (11, "chemistry"), "kech2": (11, "chemistry"),
    "kebo1": (11, "biology"), "kemh1": (11, "maths"),
    "leph1": (12, "physics"), "leph2": (12, "physics"), "lech1": (12, "chemistry"), "lech2": (12, "chemistry"),
    "lebo1": (12, "biology"), "lemh1": (12, "maths"), "lemh2": (12, "maths"),
}
CLASS_LETTERS = {"f": 6, "g": 7, "h": 8, "i": 9, "j": 10, "k": 11, "l": 12}


def download_book(code: str) -> Path:
    out = PDF_DIR / code
    out.mkdir(parents=True, exist_ok=True)
    for n in range(1, 31):
        name = f"{code}{n:02d}.pdf"
        target = out / name
        if target.exists() and target.stat().st_size > 0:
            continue
        req = urllib.request.Request(BASE_URL + name, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                data = res.read()
        except urllib.error.HTTPError as err:
            if err.code == 404 and n > 1:
                break  # past the last chapter
            raise
        if not data.startswith(b"%PDF"):
            break
        target.write_bytes(data)
        print(f"  downloaded {name} ({len(data) // 1024} KB)")
    return out


def chapter_files(folder: Path, code_hint: str | None) -> list[tuple[int, Path]]:
    """Map PDFs in a folder to chapter numbers, skipping prelims/answers/appendices."""
    files = sorted(folder.glob("*.pdf"))
    chapters = []
    for i, f in enumerate(files, start=1):
        stem = f.stem.lower()
        if re.search(r"(ps|an|a\d)$", stem) and re.match(r"^[a-l][eh][a-z]{2}\d", stem):
            continue  # NCERT prelims (…ps), answers (…an), appendices (…a1)
        m = re.match(r"^[a-l][eh][a-z]{2}\d(\d{2})$", stem) or re.search(r"(\d+)$", stem)
        chapters.append((int(m.group(1)) if m else i, f))
    return sorted(chapters)


def index_folder(folder: Path, class_num: int, subject: str, book: str) -> None:
    items = chapter_files(folder, book)
    if not items:
        sys.exit(f"No chapter PDFs found in {folder}")
    total = 0
    for chapter, f in items:
        try:
            n = store.index_pdf(f, class_num=class_num, subject=subject, book=book, chapter=chapter)
            total += n
            print(f"  Class {class_num} {subject} ch{chapter:>2}: {f.name} -> {n} chunks")
        except Exception as err:  # keep going; one bad PDF shouldn't stop the book
            print(f"  ! {f.name}: {err}")
    print(f"Indexed {total} chunks for Class {class_num} {subject} ({book}).")


def resolve_book(code: str, class_num: int | None, subject: str | None) -> tuple[int, str]:
    if code in BOOKS and not (class_num and subject):
        return BOOKS[code]
    if not class_num:
        class_num = CLASS_LETTERS.get(code[:1])
    if not (class_num and subject):
        sys.exit(f"Unknown book code '{code}'. Pass --class and --subject.")
    return class_num, subject


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("download", help="download + index books by NCERT code")
    d.add_argument("codes", nargs="+")
    d.add_argument("--class", dest="class_num", type=int)
    d.add_argument("--subject")
    f = sub.add_parser("folder", help="index a folder of chapter PDFs")
    f.add_argument("path", type=Path)
    f.add_argument("--class", dest="class_num", type=int, required=True)
    f.add_argument("--subject", required=True)
    f.add_argument("--book", help="book id (default: folder name)")
    sub.add_parser("list", help="show indexed classes, subjects and chapters")
    sub.add_parser("books", help="show known book codes")
    args = ap.parse_args()

    if args.cmd == "download":
        for code in args.codes:
            class_num, subject = resolve_book(code.lower(), args.class_num, args.subject)
            print(f"{code}: Class {class_num} {subject}")
            try:
                folder = download_book(code.lower())
            except Exception as err:
                print(f"  ! download failed: {err}\n    Download the book in a browser from https://ncert.nic.in/textbook.php and use: python -m ncert.ingest folder <path> --class {class_num} --subject \"{subject}\"")
                continue
            index_folder(folder, class_num, subject.lower(), code.lower())
    elif args.cmd == "folder":
        index_folder(args.path, args.class_num, args.subject.lower(), args.book or args.path.name.lower())
    elif args.cmd == "list":
        cat = store.catalog()
        if not cat:
            print("Nothing indexed yet.")
        for cls, subjects in cat.items():
            for subj, chapters in subjects.items():
                print(f"Class {cls} {subj}: {len(chapters)} chapters")
                for c in chapters:
                    print(f"   {c['chapter']:>2}. {c['title']}")
    elif args.cmd == "books":
        for code, (cls, subj) in BOOKS.items():
            print(f"  {code}  Class {cls:<2} {subj}")


if __name__ == "__main__":
    main()
