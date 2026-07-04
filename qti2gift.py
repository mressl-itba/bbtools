#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
qti2gift  -  Convert a QTI 2.1 exam (Blackboard Ultra) to Moodle GIFT.

Usage:
    python qti2gift.py <input.zip | qti21_folder> [output.gift]

Supported question types:
    - True/False        (choiceInteraction, ids *_true / *_false)
    - Multiple choice   (choiceInteraction, single correct answer)
    - Multiple answer   (choiceInteraction, several correct answers)
    - Essay             (extendedTextInteraction)

The QTI incorrect-answer feedback (modalFeedback identifier="incorrect_fb")
is exported as the GIFT general question comment (####).
"""

import sys
import os
import re
import zipfile
import xml.etree.ElementTree as ET

QTI_NS = "http://www.imsglobal.org/xsd/imsqti_v2p1"


# --------------------------------------------------------------------------- #
# XML helpers
# --------------------------------------------------------------------------- #
def local(tag):
    """Tag name without the namespace prefix."""
    return tag.split("}")[-1]


def extract_text(el):
    """Text of an element, keeping paragraph breaks (<p>, <div>, <br>)."""
    out = []
    if el.text:
        out.append(el.text)
    for child in el:
        if local(child.tag) == "br":
            out.append("\n")
        out.append(extract_text(child))
        if child.tail:
            out.append(child.tail)
    text = "".join(out)
    if local(el.tag) in ("p", "div"):
        text += "\n"
    return text


def clean_multiline(text):
    """Collapse per-line whitespace and drop empty lines (no blank lines)."""
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.splitlines()]
    lines = [ln for ln in lines if ln]
    return "\n".join(lines)


def clean_inline(text):
    """Text on a single line."""
    return re.sub(r"\s+", " ", text).strip()


# --------------------------------------------------------------------------- #
# GIFT
# --------------------------------------------------------------------------- #
def gift_escape(text, inline=False):
    """Escape the GIFT special characters."""
    text = text.replace("\\", "\\\\")
    for ch in "~=#{}:":
        text = text.replace(ch, "\\" + ch)
    if inline:
        text = text.replace("\n", " ")
    return text


def fmt_num(x):
    s = ("%.5f" % x).rstrip("0").rstrip(".")
    return s if s and s != "-0" else "0"


# --------------------------------------------------------------------------- #
# Parsing a single assessmentItem
# --------------------------------------------------------------------------- #
def parse_item(root):
    """Return a dict describing the question."""
    q = {
        "id": root.get("identifier", ""),
        "prompt": "",
        "type": None,          # 'tf' | 'mc' | 'ma' | 'essay'
        "choices": [],         # list of (id, text, is_correct)
        "tf_true": None,       # bool for true/false
        "feedback": None,      # incorrect_fb text
    }

    # -- correct answer ------------------------------------------------------
    correct_ids = []
    for rd in root.iter("{%s}responseDeclaration" % QTI_NS):
        for val in rd.iter("{%s}value" % QTI_NS):
            if val.text:
                correct_ids.append(val.text.strip())

    # -- item body / prompt --------------------------------------------------
    body = root.find("{%s}itemBody" % QTI_NS)
    interactions = ("choiceInteraction", "extendedTextInteraction",
                    "textEntryInteraction", "inlineChoiceInteraction")
    prompt_parts = []
    choice_inter = None
    essay = False
    if body is not None:
        for child in body:
            lt = local(child.tag)
            if lt == "choiceInteraction":
                choice_inter = child
            elif lt == "extendedTextInteraction":
                essay = True
            elif lt not in interactions:
                prompt_parts.append(extract_text(child))
    q["prompt"] = clean_multiline("".join(prompt_parts))

    # -- incorrect-answer feedback ------------------------------------------
    for mf in root.iter("{%s}modalFeedback" % QTI_NS):
        if mf.get("identifier") == "incorrect_fb":
            q["feedback"] = clean_multiline(extract_text(mf))

    # -- type and choices ----------------------------------------------------
    if essay:
        q["type"] = "essay"
        return q

    if choice_inter is None:
        q["type"] = "essay"        # no recognizable interaction -> treat as essay
        return q

    max_choices = choice_inter.get("maxChoices", "1")
    choices = []
    for sc in choice_inter.findall("{%s}simpleChoice" % QTI_NS):
        cid = sc.get("identifier", "")
        ctext = clean_inline(extract_text(sc))
        choices.append((cid, ctext, cid in correct_ids))
    q["choices"] = choices

    ids = [c[0] for c in choices]
    is_tf = (len(choices) == 2
             and any(i.endswith("_true") for i in ids)
             and any(i.endswith("_false") for i in ids))

    if is_tf:
        q["type"] = "tf"
        q["tf_true"] = any(cid.endswith("_true") and corr
                           for cid, _, corr in choices)
    elif max_choices == "1" and len(correct_ids) <= 1:
        # single selection: student picks exactly one answer (radio buttons)
        q["type"] = "mc"
    else:
        # multiple selection: student may pick several answers (checkboxes)
        q["type"] = "ma"
    return q


# --------------------------------------------------------------------------- #
# GIFT rendering
# --------------------------------------------------------------------------- #
def render_gift(q):
    title = gift_escape(q["id"], inline=True)
    prompt = gift_escape(q["prompt"] or "", inline=False)

    if q["type"] == "essay":
        return "::%s::%s{}" % (title, prompt)

    lines = ["::%s::%s{" % (title, prompt)]

    if q["type"] == "tf":
        lines.append("T" if q["tf_true"] else "F")

    elif q["type"] == "mc":
        # single selection: '=' correct, '~' wrong
        for _, text, corr in q["choices"]:
            mark = "=" if corr else "~"
            lines.append("%s%s" % (mark, gift_escape(text, inline=True)))

    elif q["type"] == "ma":
        # multiple selection: percentage-weighted answers (checkboxes)
        ncorrect = sum(1 for c in q["choices"] if c[2]) or 1
        pos = fmt_num(100.0 / ncorrect)
        neg = fmt_num(-100.0 / ncorrect)
        for _, text, corr in q["choices"]:
            w = pos if corr else neg
            lines.append("~%%%s%%%s" % (w, gift_escape(text, inline=True)))

    if q["feedback"]:
        lines.append("####" + gift_escape(q["feedback"], inline=False))

    lines.append("}")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Package loading
# --------------------------------------------------------------------------- #
def load_items(source):
    """
    Return (test_title, [xml_bytes, ...]) in assessmentTest order.
    'source' can be a .zip file or a folder.
    """
    files = {}          # base name -> bytes
    test_xml = None

    if os.path.isdir(source):
        for dp, _, names in os.walk(source):
            for n in names:
                if n.lower().endswith(".xml"):
                    with open(os.path.join(dp, n), "rb") as f:
                        files[n] = f.read()
    else:
        with zipfile.ZipFile(source) as z:
            for info in z.infolist():
                if info.filename.lower().endswith(".xml"):
                    files[os.path.basename(info.filename)] = z.read(info.filename)

    # locate the assessmentTest (question bank) and the assessmentItems
    item_files = {}
    for name, data in files.items():
        head = data[:400].decode("utf-8", "ignore")
        if "assessmentTest" in head:
            test_xml = data
        elif "assessmentItem" in head:
            item_files[name] = data

    test_title = "Exam"
    order = []
    if test_xml is not None:
        troot = ET.fromstring(test_xml)
        test_title = troot.get("title", test_title)
        for ref in troot.iter("{%s}assessmentItemRef" % QTI_NS):
            href = ref.get("href", "")
            base = os.path.basename(href)
            if base in item_files:
                order.append(base)

    # append any items not referenced by the test
    for name in sorted(item_files):
        if name not in order:
            order.append(name)

    return test_title, [item_files[n] for n in order]


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def convert(source, out_path=None):
    test_title, items = load_items(source)
    blocks = []
    for data in items:
        root = ET.fromstring(data)
        q = parse_item(root)
        blocks.append(render_gift(q))

    # first comment line = exam title (read back by gift2qti)
    header = "// %s\n" \
             "// Converted from QTI 2.1 (Blackboard Ultra) to Moodle GIFT\n" \
             % test_title
    text = header + "\n" + "\n\n".join(blocks) + "\n"

    if out_path is None:
        base = os.path.splitext(os.path.basename(source.rstrip("/\\")))[0]
        out_path = base + ".gift"
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return out_path


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 1
    source = argv[1]
    out = argv[2] if len(argv) > 2 else None
    if not os.path.exists(source):
        print("Input not found: %s" % source, file=sys.stderr)
        return 1
    out_path = convert(source, out)
    print("GIFT written to: %s" % out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
