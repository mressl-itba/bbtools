#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gift2qti  -  Convert a Moodle GIFT file to a QTI 2.1 package (Blackboard Ultra).

Usage:
    python gift2qti.py <input.gift> [output.zip]

Produces a .zip importable into Blackboard Ultra, with the same layout as the
original package:
    imsmanifest.xml
    qti21/question_bank00001.xml
    qti21/assessmentItem0000N.xml

The GIFT general comment (####) is exported as the QTI incorrect-answer
feedback (modalFeedback identifier="incorrect_fb").
"""

import sys
import os
import re
import zipfile
from xml.sax.saxutils import escape as xml_escape


# --------------------------------------------------------------------------- #
# QTI templates
# --------------------------------------------------------------------------- #
ITEM_HEADER = (
    "<?xml version='1.0' encoding='UTF-8'?>"
    "<assessmentItem xmlns=\"http://www.imsglobal.org/xsd/imsqti_v2p1\" "
    "xmlns:ns9=\"http://www.imsglobal.org/xsd/apip/apipv1p0/imsapip_qtiv1p0\" "
    "xmlns:ns8=\"http://www.w3.org/1999/xlink\" "
    "xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" "
    "xsi:schemaLocation=\"http://www.imsglobal.org/xsd/imsqti_v2p1 "
    "http://www.imsglobal.org/xsd/qti/qtiv2p1/imsqti_v2p1.xsd\" "
    "adaptive=\"false\" timeDependent=\"false\" identifier=\"%s\">"
)

OUTCOMES = (
    "<outcomeDeclaration identifier=\"SCORE\" cardinality=\"single\" baseType=\"float\">"
    "<defaultValue><value>0</value></defaultValue></outcomeDeclaration>"
    "<outcomeDeclaration identifier=\"FEEDBACKBASIC\" cardinality=\"single\" baseType=\"identifier\"/>"
    "<outcomeDeclaration identifier=\"MAXSCORE\" cardinality=\"single\" baseType=\"float\">"
    "<defaultValue><value>0</value></defaultValue></outcomeDeclaration>"
)

RESPONSE_PROCESSING = (
    "<responseProcessing><responseCondition><responseIf>"
    "<match><variable identifier=\"RESPONSE\"/><correct identifier=\"RESPONSE\"/></match>"
    "<setOutcomeValue identifier=\"SCORE\"><variable identifier=\"MAXSCORE\"/></setOutcomeValue>"
    "<setOutcomeValue identifier=\"FEEDBACKBASIC\">"
    "<baseValue baseType=\"identifier\">correct_fb</baseValue></setOutcomeValue>"
    "</responseIf><responseElse>"
    "<setOutcomeValue identifier=\"FEEDBACKBASIC\">"
    "<baseValue baseType=\"identifier\">incorrect_fb</baseValue></setOutcomeValue>"
    "</responseElse></responseCondition></responseProcessing>"
)


# --------------------------------------------------------------------------- #
# GIFT helpers
# --------------------------------------------------------------------------- #
def gift_unescape(text):
    return re.sub(r"\\(.)", r"\1", text)


def find_unescaped(s, sub, start=0):
    """Index of the first occurrence of 'sub' not preceded by '\\'."""
    i = start
    while True:
        i = s.find(sub, i)
        if i == -1:
            return -1
        bs = 0
        j = i - 1
        while j >= 0 and s[j] == "\\":
            bs += 1
            j -= 1
        if bs % 2 == 0:
            return i
        i += 1


def split_records(text):
    """Split GIFT into records separated by blank lines, stripping comments."""
    lines = text.splitlines()
    records, cur = [], []
    for ln in lines:
        stripped = ln.strip()
        if stripped == "":
            if cur:
                records.append("\n".join(cur))
                cur = []
            continue
        if stripped.startswith("//") or stripped.startswith("$CATEGORY:"):
            continue
        cur.append(ln)
    if cur:
        records.append("\n".join(cur))
    return records


def split_answers(s):
    """Split choices respecting escapes; each token starts with = or ~."""
    parts, cur, i = [], None, 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            if cur is not None:
                cur += s[i:i + 2]
            i += 2
            continue
        if c in "=~":
            if cur is not None:
                parts.append(cur)
            cur = c
        elif cur is not None:
            cur += c
        i += 1
    if cur is not None:
        parts.append(cur)
    return parts


# --------------------------------------------------------------------------- #
# Parsing a single GIFT question
# --------------------------------------------------------------------------- #
def parse_question(record):
    q = {"id": None, "prompt": "", "type": None,
         "choices": [], "tf_true": None, "feedback": None}

    rest = record

    # -- title ::id:: --------------------------------------------------------
    if rest.lstrip().startswith("::"):
        rest = rest.lstrip()
        end = find_unescaped(rest, "::", 2)
        if end != -1:
            q["id"] = gift_unescape(rest[2:end]).strip()
            rest = rest[end + 2:]

    # -- answer block { ... } ------------------------------------------------
    ob = find_unescaped(rest, "{")
    if ob == -1:
        return None
    cb = rest.rfind("}")
    if cb == -1 or cb < ob:
        return None

    q["prompt"] = gift_unescape(rest[:ob]).strip()
    inside = rest[ob + 1:cb]

    # -- general comment #### -> incorrect feedback -------------------------
    fb_idx = find_unescaped(inside, "####")
    if fb_idx != -1:
        q["feedback"] = gift_unescape(inside[fb_idx + 4:]).strip()
        inside = inside[:fb_idx]

    body = inside.strip()

    # -- essay ---------------------------------------------------------------
    if body == "":
        q["type"] = "essay"
        return q

    # -- true / false --------------------------------------------------------
    if body.upper() in ("T", "TRUE", "F", "FALSE"):
        q["type"] = "tf"
        q["tf_true"] = body.upper() in ("T", "TRUE")
        return q

    # -- choices -------------------------------------------------------------
    # 'is_multiple' becomes True when percentage weights (~%..%) are present,
    # meaning multiple selection (checkboxes); otherwise single selection.
    is_multiple = False
    choices = []
    for tok in split_answers(inside):
        tok = tok.strip()
        if not tok:
            continue
        m = re.match(r"^([=~])\s*(?:%(-?\d+(?:\.\d+)?)%)?\s*(.*)$", tok, re.S)
        if not m:
            continue
        sign, weight, ctext = m.group(1), m.group(2), m.group(3)

        # per-answer feedback (#) -> ignored (we use the general one)
        h = find_unescaped(ctext, "#")
        if h != -1:
            ctext = ctext[:h]

        ctext = gift_unescape(ctext).strip()
        if weight is not None:
            is_multiple = True
            correct = float(weight) > 0
        else:
            correct = (sign == "=")
        choices.append((ctext, correct))

    q["choices"] = choices
    q["type"] = "ma" if is_multiple else "mc"
    return q


# --------------------------------------------------------------------------- #
# QTI rendering
# --------------------------------------------------------------------------- #
def prompt_html(prompt):
    paras = [p for p in prompt.splitlines() if p.strip() != ""]
    if not paras:
        paras = [""]
    return "".join("<p>%s</p>" % xml_escape(p) for p in paras)


def build_item(q, index):
    qid = q["id"] or ("QUE__%d_1" % (1000000 + index))
    modal = ""
    if q["feedback"]:
        modal = (
            "<modalFeedback showHide=\"show\" outcomeIdentifier=\"FEEDBACKBASIC\" "
            "identifier=\"incorrect_fb\"><div>%s</div></modalFeedback>"
            % prompt_html(q["feedback"])
        )

    # ----- essay ------------------------------------------------------------
    if q["type"] == "essay":
        rd = ("<responseDeclaration cardinality=\"single\" baseType=\"string\" "
              "identifier=\"RESPONSE\"/>")
        item_body = ("<itemBody><div>%s</div>"
                     "<extendedTextInteraction responseIdentifier=\"RESPONSE\"/>"
                     "</itemBody>" % prompt_html(q["prompt"]))
        return ITEM_HEADER % qid + rd + OUTCOMES + item_body + "</assessmentItem>"

    # ----- true / false -----------------------------------------------------
    # NOTE: GIFT's {T}/{F} does not store the option labels, so we rebuild the
    # Spanish "Verdadero"/"Falso" choices to match the Blackboard source exam.
    if q["type"] == "tf":
        correct = "%s_true" % qid if q["tf_true"] else "%s_false" % qid
        rd = ("<responseDeclaration cardinality=\"single\" baseType=\"identifier\" "
              "identifier=\"RESPONSE\"><correctResponse><value>%s</value>"
              "</correctResponse></responseDeclaration>" % correct)
        choices = ("<simpleChoice identifier=\"%s_true\" fixed=\"true\">Verdadero</simpleChoice>"
                   "<simpleChoice identifier=\"%s_false\" fixed=\"true\">Falso</simpleChoice>"
                   % (qid, qid))
        item_body = ("<itemBody><div>%s</div>"
                     "<choiceInteraction responseIdentifier=\"RESPONSE\" maxChoices=\"1\" "
                     "shuffle=\"false\">%s</choiceInteraction></itemBody>"
                     % (prompt_html(q["prompt"]), choices))
        return (ITEM_HEADER % qid + rd + OUTCOMES + item_body
                + RESPONSE_PROCESSING + modal + "</assessmentItem>")

    # ----- multiple choice / multiple answer --------------------------------
    values, choices_xml = [], []
    for i, (text, correct) in enumerate(q["choices"], start=1):
        cid = "answer_%d" % i
        if correct:
            values.append("<value>%s</value>" % cid)
        choices_xml.append(
            "<simpleChoice identifier=\"%s\" fixed=\"true\"><p>%s</p></simpleChoice>"
            % (cid, xml_escape(text))
        )
    rd = ("<responseDeclaration cardinality=\"multiple\" baseType=\"identifier\" "
          "identifier=\"RESPONSE\"><correctResponse>%s</correctResponse>"
          "</responseDeclaration>" % "".join(values))
    # maxChoices=1 -> single selection (radio); otherwise multiple (checkboxes)
    max_choices = "1" if q["type"] == "mc" else str(len(q["choices"]))
    item_body = ("<itemBody><div>%s</div>"
                 "<choiceInteraction responseIdentifier=\"RESPONSE\" maxChoices=\"%s\" "
                 "shuffle=\"false\">%s</choiceInteraction></itemBody>"
                 % (prompt_html(q["prompt"]), max_choices, "".join(choices_xml)))
    return (ITEM_HEADER % qid + rd + OUTCOMES + item_body
            + RESPONSE_PROCESSING + modal + "</assessmentItem>")


def build_test(test_title, n):
    refs = "".join(
        "<assessmentItemRef identifier=\"assessmentItem%05d\" "
        "href=\"assessmentItem%05d.xml\" />" % (i, i)
        for i in range(1, n + 1)
    )
    return (
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        "<assessmentTest xmlns=\"http://www.imsglobal.org/xsd/imsqti_v2p1\"\n"
        "    xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"\n"
        "    xsi:schemaLocation=\"http://www.imsglobal.org/xsd/imsqti_v2p1 "
        "http://www.imsglobal.org/xsd/qti/qtiv2p1/imsqti_v2p1.xsd\"  "
        "identifier=\"question_bank00001\" title=\"%s\">"
        "<testPart identifier=\"question_bank00001_1\" navigationMode=\"nonlinear\" "
        "submissionMode=\"simultaneous\">"
        "<assessmentSection identifier=\"question_bank00001_1_1\" visible=\"false\" "
        "title=\"Section 1\">%s</assessmentSection></testPart></assessmentTest>"
        % (xml_escape(test_title), refs)
    )


def build_manifest(n):
    deps = "".join(
        "<dependency identifierref=\"assessmentItem%05d\"/>" % i
        for i in range(1, n + 1)
    )
    item_resources = "".join(
        "<resource href=\"qti21/assessmentItem%05d.xml\" "
        "identifier=\"assessmentItem%05d\" type=\"imsqti_item_xmlv2p1\">"
        "<file href=\"qti21/assessmentItem%05d.xml\"/></resource>" % (i, i, i)
        for i in range(1, n + 1)
    )
    return (
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        "<manifest identifier=\"man00001\" xmlns=\"http://www.imsglobal.org/xsd/imscp_v1p1\"\n"
        " xmlns:csm=\"http://www.imsglobal.org/xsd/imsccv1p2/imscsmd_v1p0\" "
        "xmlns:imsmd=\"http://ltsc.ieee.org/xsd/LOM\"\n"
        " xmlns:imsqti=\"http://www.imsglobal.org/xsd/imsqti_metadata_v2p1\" "
        "xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"\n"
        "   xsi:schemaLocation=\"http://www.imsglobal.org/xsd/imscp_v1p1 "
        "http://www.imsglobal.org/xsd/imscp_v1p2.xsd http://ltsc.ieee.org/xsd/LOM "
        "imsmd_loose_v1p3.xsd http://www.imsglobal.org/xsd/imsqti_metadata_v2p1 "
        "http://www.imsglobal.org/xsd/qti/qtiv2p1/imsqti_metadata_v2p1.xsd "
        "http://www.imsglobal.org/xsd/imsccv1p2/imscsmd_v1p0 "
        "http://www.imsglobal.org/profile/cc/ccv1p2/ccv1p2_imscsmd_v1p0.xsd\">"
        "<metadata><schema>QTIv2.1</schema><schemaversion>2.0</schemaversion></metadata>"
        "<organizations/><resources>"
        "<resource href=\"qti21/question_bank00001.xml\" identifier=\"question_bank00001\" "
        "type=\"imsqti_test_xmlv2p1\"><file href=\"qti21/question_bank00001.xml\"/>%s</resource>"
        "%s</resources></manifest>" % (deps, item_resources)
    )


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def convert(gift_path, out_path=None):
    with open(gift_path, "r", encoding="utf-8") as f:
        text = f.read()

    # test title from the first comment line (written by qti2gift)
    m = re.search(r"^\s*//\s*(.+)$", text, re.M)
    test_title = m.group(1).strip() if m else "Exam"

    questions = []
    for rec in split_records(text):
        q = parse_question(rec)
        if q:
            questions.append(q)

    if not questions:
        raise ValueError("No questions found in the GIFT file.")

    items = [build_item(q, i) for i, q in enumerate(questions, start=1)]

    if out_path is None:
        base = os.path.splitext(os.path.basename(gift_path))[0]
        out_path = base + ".zip"

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("csfiles/home_dir/", "")
        z.writestr("qti21/question_bank00001.xml", build_test(test_title, len(items)))
        for i, item_xml in enumerate(items, start=1):
            z.writestr("qti21/assessmentItem%05d.xml" % i, item_xml)
        z.writestr("imsmanifest.xml", build_manifest(len(items)))

    return out_path


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 1
    gift_path = argv[1]
    out = argv[2] if len(argv) > 2 else None
    if not os.path.exists(gift_path):
        print("Input not found: %s" % gift_path, file=sys.stderr)
        return 1
    out_path = convert(gift_path, out)
    print("QTI package written to: %s" % out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
