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
import time
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
    # Books that share a subject get their own name, since chapters are numbered per book.
    "jeff1": (10, "english first flight"), "jefp1": (10, "english footprints without feet"),
    "jewe2": (10, "english words and expressions"), "jehp1": (10, "health and physical education"),
    # Hindi/Sanskrit books (jhks1, jhsk1…) are left out: their PDFs use legacy fonts
    # or scanned pages, so the extracted text is unreadable without OCR.
    "keph1": (11, "physics"), "keph2": (11, "physics"), "kech1": (11, "chemistry"), "kech2": (11, "chemistry"),
    "kebo1": (11, "biology"), "kemh1": (11, "maths"),
    "leph1": (12, "physics"), "leph2": (12, "physics"), "lech1": (12, "chemistry"), "lech2": (12, "chemistry"),
    "lebo1": (12, "biology"), "lemh1": (12, "maths"), "lemh2": (12, "maths"),
}
CLASS_LETTERS = {"f": 6, "g": 7, "h": 8, "i": 9, "j": 10, "k": 11, "l": 12}

# Real chapter titles (checked against each PDF). Guessing them from the first
# page gives junk like "Science128", and Kiki matches topics to chapters by title.
CHAPTER_TITLES = {
    "jesc1": ["Chemical Reactions and Equations", "Acids, Bases and Salts", "Metals and Non-metals", "Carbon and its Compounds",
              "Life Processes", "Control and Coordination", "How do Organisms Reproduce?", "Heredity",
              "Light – Reflection and Refraction", "The Human Eye and the Colourful World", "Electricity",
              "Magnetic Effects of Electric Current", "Our Environment"],
    "jemh1": ["Real Numbers", "Polynomials", "Pair of Linear Equations in Two Variables", "Quadratic Equations",
              "Arithmetic Progressions", "Triangles", "Coordinate Geometry", "Introduction to Trigonometry",
              "Some Applications of Trigonometry", "Circles", "Areas Related to Circles", "Surface Areas and Volumes",
              "Statistics", "Probability"],
    "jess1": ["Resources and Development", "Forest and Wildlife Resources", "Water Resources", "Agriculture",
              "Minerals and Energy Resources", "Manufacturing Industries", "Lifelines of National Economy"],
    "jess2": ["Development", "Sectors of the Indian Economy", "Money and Credit", "Globalisation and the Indian Economy",
              "Consumer Rights"],
    "jess3": ["The Rise of Nationalism in Europe", "Nationalism in India", "The Making of a Global World",
              "The Age of Industrialisation", "Print Culture and the Modern World"],
    "jess4": ["Power-sharing", "Federalism", "Gender, Religion and Caste", "Political Parties", "Outcomes of Democracy"],
    "jeff1": ["A Letter to God", "Nelson Mandela: Long Walk to Freedom", "Two Stories about Flying",
              "From the Diary of Anne Frank", "Glimpses of India", "Mijbil the Otter", "Madam Rides the Bus",
              "The Sermon at Benares", "The Proposal"],
    "jefp1": ["A Triumph of Surgery", "The Thief's Story", "The Midnight Visitor", "A Question of Trust",
              "Footprints without Feet", "The Making of a Scientist", "The Necklace", "Bholi",
              "The Book That Saved the Earth"],
    "jewe2": ["Unit 1: A Letter to God", "Unit 2: Nelson Mandela", "Unit 3: Two Stories about Flying"],
    "jehp1": ["Physical Education: Aims and Objectives", "Effects of Physical Activity on the Body's Organ Systems",
              "Growth and Development", "Individual Sports: Track and Field", "Other Individual Sports"],
}


def download_book(code: str) -> Path:
    out = PDF_DIR / code
    out.mkdir(parents=True, exist_ok=True)
    for n in range(1, 31):
        name = f"{code}{n:02d}.pdf"
        target = out / name
        if target.exists() and target.stat().st_size > 0:
            continue
        req = urllib.request.Request(BASE_URL + name, headers={"User-Agent": "Mozilla/5.0"})
        for attempt in range(4):  # ncert.nic.in often times out; retry before giving up
            try:
                with urllib.request.urlopen(req, timeout=60) as res:
                    data = res.read()
                break
            except urllib.error.HTTPError as err:
                if err.code == 404:
                    data = None
                    break
                if attempt == 3:
                    raise
            except OSError:
                if attempt == 3:
                    raise
            time.sleep(3 * (attempt + 1))
        if data is None:
            if n > 1:
                break  # past the last chapter
            raise RuntimeError(f"{name} not found")
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
    titles = CHAPTER_TITLES.get(book, [])
    for chapter, f in items:
        title = titles[chapter - 1] if chapter <= len(titles) else None
        try:
            n = store.index_pdf(f, class_num=class_num, subject=subject, book=book, chapter=chapter, chapter_title=title)
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
