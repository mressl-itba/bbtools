# bbtools

Tools for working with **Blackboard Ultra** exams as plain text, built for course work at ITBA (`campus.itba.edu.ar`).

Blackboard Ultra's exam editor is slow for bulk work: reviewing many questions, fixing wording, reordering answers, or versioning an exam is painful through the web UI. These tools let you **export an exam to [Moodle GIFT](https://docs.moodle.org/en/GIFT_format)** — a compact plain-text question format — edit it in any text editor (and keep it under version control), and **convert it back to a QTI 2.1 package** that imports cleanly into Blackboard Ultra. A companion Chrome extension assists with grading the manually-graded questions.

## What's in the repo

| Part | Description |
| --- | --- |
| [qti2gift.py](qti2gift.py) | Converts a QTI 2.1 exam package (Blackboard Ultra export) to a Moodle GIFT text file |
| [gift2qti.py](gift2qti.py) | Converts a GIFT file back to a QTI 2.1 `.zip` package importable into Blackboard Ultra |
| [chrome-extension/](chrome-extension/) | Chrome extension that assists with grading exams in Blackboard Ultra's grading view |
| [test/](test/) | A sample exam in both formats (`test_exam.gift`, `test_exam.zip`) |

## The converters

### Requirements

Python 3 — standard library only, nothing to install.

### Usage

Export an exam from Blackboard Ultra as a QTI 2.1 package, then:

```sh
# QTI package (.zip or unpacked folder) -> GIFT text file
python qti2gift.py exam.zip [exam.gift]

# edit exam.gift in your editor, then convert back:

# GIFT -> QTI package for Blackboard Ultra import
python gift2qti.py exam.gift [exam.zip]
```

The output name is optional; it defaults to the input name with the extension swapped.

### Supported question types

- **True/False**
- **Multiple choice** (single answer, radio buttons)
- **Multiple answer** (checkboxes — rendered in GIFT as percentage-weighted answers, e.g. `~%50%...`)
- **Essay** (empty `{}` block in GIFT)

Round-trip details worth knowing:

- The exam title is stored as the first `//` comment line of the GIFT file and restored on conversion back.
- The QTI incorrect-answer feedback maps to the GIFT general comment (`####`), and vice versa.
- True/False options are rebuilt as Spanish "Verdadero"/"Falso" labels to match the Blackboard source exams (GIFT's `{T}`/`{F}` doesn't store labels).
- Per-answer GIFT feedback (`#`) is ignored; only the general (`####`) feedback survives.

## The Chrome extension

**BB Ultra — Assisted grading**: an unpacked Manifest V3 extension that activates only in a student's grading view on `campus.itba.edu.ar`. It exports all manually-graded questions (essays, etc.) of every student to a single Markdown file organized by question, lets you grade and comment offline in your editor, and then writes the grades and comments back into Blackboard — saving each one but never touching "Publish grades".

Install: open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and pick the [chrome-extension/](chrome-extension/) folder.

See [chrome-extension/README.md](chrome-extension/README.md) for the full workflow, the `.md` file format, and implementation notes.

## License

[MIT](LICENSE)
