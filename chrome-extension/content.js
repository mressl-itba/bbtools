/* =============================================================================
 * BB Ultra - Assisted grading (ITBA)  —  content.js
 *
 * Design principle: NO internal REST API and NO native React setters. Everything
 * is done by reading the already-rendered DOM, calling click() on real buttons,
 * and "typing/pasting" the way a person would (execCommand on the focused
 * element, which fires the native beforeinput/input events that React listens to
 * on its controlled inputs).
 *
 * Only activates when the URL contains "/flexible-attempt-grading".
 *
 * Selectors are LANGUAGE-INDEPENDENT: they rely on data-testid /
 * data-analytics-id / analytics-id / element ids / stable component classes,
 * never on Spanish (or any language) UI text. Only the students' own content
 * (prompts and answers) stays in whatever language the exam is written in.
 * ========================================================================== */

(() => {
  "use strict";

  const URL_TRIGGER = "/flexible-attempt-grading";

  /* ---------------------------------------------------------------------------
   * SELECTORS (all language-independent)
   * ------------------------------------------------------------------------- */
  const SEL = {
    // Student list cards.
    userName: '[data-testid="user-name"]', // student name in the card
    gradePill: '[data-testid="attempt-grade-pill"]', // grade like "39/60" (header card only)
    studentListItem: '[analytics-id="attemptGrading.attemptNavigationPane.student.list"]', // each student in the side panel (role=menuitem)

    // Question header.
    questionNumber: '[data-testid="question-number"]', // VISUAL number (matches the feedback button id)
    questionPrompt: '[data-testid="question-header.questionPrompt"]', // prompt
    questionIdSource: '[id^="bb-editorquestion-instructions-"]', // e.g. bb-editorquestion-instructions-_1187627_1 -> question content id
    typeLabel: ".MuiTypography-h4", // question type text, verbatim from the DOM
    feedbackIconFull: '[data-testid="feedback-icon"]', // already has a comment
    feedbackIconEmpty: '[data-testid="add-feedback-icon"]', // no comment yet

    // Grade input (readonly pill; language-independent via analytics-id).
    gradeInput:
      'input[analytics-id="attemptGrading.question.questionHeader.gradePill.gradePill.gradableContent.input"]',
    pointsPossible: ".pill-points-possible", // max points span

    // Feedback (comment) button: id is stable in any language and in any
    // expanded/collapsed state (the data-analytics-id flips expand<->collapse).
    commentButton: '[id^="question-feedback-"][id$="-button"]',

    // Collapsible question (the answer is UNMOUNTED while collapsed).
    collapsibleRootClass: "js-collapsible-question-container-root",
    expandToggle: '[data-analytics-id="attemptGrading.question.expandToggle.button"]',
    answerComponent: ".readonly-question-component-react", // mounted answer block
    essayText: ".readonly-question-component-react__question-text", // essay free text
    answerInnerLabel: ".MuiTypography-h3", // "Answer" label inside the block (stripped structurally)

    // Auto-graded answer types (excluded from the export — nothing to grade by hand).
    mcAnswer: '[data-testid="multiple-answer-question-testing-id"]', // multiple choice / multiple answer
    tfAnswer: '[data-testid="testing-id-for-true-false-question"]', // true / false

    // Comment editor (Quill: div.ql-editor, id="bb-editor-textbox").
    contentEditable: '[contenteditable="true"]',
    tinymceIframe: 'iframe.tox-edit-area__iframe, iframe[id$="_ifr"]', // legacy fallback
  };

  // Visual number lives in the feedback button id: "question-feedback-{N}-button".
  const RE_FEEDBACK_BTN_ID = /question-feedback-(\d+)-button/;
  // Question content id lives in the prompt editor id: "...instructions-_{ID}_1".
  const RE_QUESTION_ID = /instructions-_(\d+)_/;
  // Visible student id shown in the card subtitle: "ID: 65258".
  const RE_STUDENT_ID = /\bID:\s*(\S+)/i;

  /* ---------------------------------------------------------------------------
   * UTILITIES
   * ------------------------------------------------------------------------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const PAUSE = 400; // base pause between actions so React can re-render

  function log(msg) {
    console.log("[bbtools]", msg);
    const box = document.getElementById("bbtools-status");
    if (box) {
      const time = new Date().toLocaleTimeString();
      box.textContent = `[${time}] ${msg}\n` + box.textContent;
    }
  }

  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

  // Wait until predicate() is truthy or the timeout elapses.
  async function waitFor(predicate, { timeout = 8000, interval = 150 } = {}) {
    const start = Date.now();
    for (;;) {
      let val;
      try {
        val = predicate();
      } catch (_) {
        val = null;
      }
      if (val) return val;
      if (Date.now() - start > timeout) return null;
      await sleep(interval);
    }
  }

  /* ---------------------------------------------------------------------------
   * "HUMAN-LIKE" TYPING
   *
   * We do NOT assign .value directly on React-controlled inputs. Instead:
   * click -> focus -> select all -> execCommand('insertText'). insertText fires
   * native beforeinput/input events, which is what React observes. The click is
   * important: the grade pill input is readonly until it enters edit mode.
   * ------------------------------------------------------------------------- */
  async function typeLikeHuman(el, text) {
    if (!el) return false;
    el.click(); // enter edit mode (pill input is readonly otherwise)
    await sleep(60);
    el.focus();
    el.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    await sleep(60);

    // Select current content so it gets replaced.
    try {
      if (typeof el.select === "function") {
        el.select();
      } else {
        document.execCommand("selectAll", false, null);
      }
    } catch (_) {}

    // A "decorative" keydown so any keyboard handler runs.
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));

    // Real insertion: fires native beforeinput + input.
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, String(text));
    } catch (_) {
      ok = false;
    }

    // Very conservative fallback if execCommand is unavailable: a generic
    // input event (without touching the native setter).
    if (!ok) {
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: String(text),
        })
      );
    }

    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    await sleep(120);
    return true;
  }

  // Bullet marker at the start of a line: "- ", "* " or "• ".
  const RE_BULLET = /^\s*([-*•])\s+(.*)$/;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Split the comment into blocks: bullet groups -> <ul>, the rest -> plain
  // text. Simple, low-risk rule (no bold/italic in v1).
  function commentToChunks(text) {
    const lines = String(text).split(/\r?\n/);
    const chunks = [];
    let ul = null;
    let txt = null;
    for (const line of lines) {
      const m = RE_BULLET.exec(line);
      if (m) {
        txt = null;
        if (!ul) {
          ul = { type: "ul", items: [] };
          chunks.push(ul);
        }
        ul.items.push(m[2]);
      } else {
        ul = null;
        if (!txt) {
          txt = { type: "text", lines: [] };
          chunks.push(txt);
        }
        txt.lines.push(line);
      }
    }
    return chunks;
  }

  // Build the comment HTML: text lines -> <p>, bullet groups -> <ul>.
  function commentToHtml(text) {
    const chunks = commentToChunks(text);
    const parts = [];
    for (const ch of chunks) {
      if (ch.type === "ul") {
        parts.push(
          "<ul>" + ch.items.map((t) => `<li>${escapeHtml(t)}</li>`).join("") + "</ul>"
        );
      } else {
        for (const line of ch.lines) {
          const s = line.trim();
          parts.push(s ? `<p>${escapeHtml(s)}</p>` : "<p><br></p>");
        }
      }
    }
    return parts.join("") || "<p><br></p>";
  }

  // Paste the comment into the comment editor (Quill: div.ql-editor
  // contenteditable, id="bb-editor-textbox"), REPLACING whatever was there.
  // Quill keeps its own model (delta): touching the DOM directly desyncs it, so
  // the reliable "user-like" path is a real paste event with text/html — Quill's
  // clipboard module parses it into its model (including <ul><li>).
  async function pasteIntoEditor(editableEl, text) {
    if (!editableEl) return false;
    const doc = editableEl.ownerDocument || document;
    const plain = String(text);

    const selectAll = () => {
      editableEl.focus();
      try {
        const range = doc.createRange();
        range.selectNodeContents(editableEl);
        const sel = doc.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (_) {}
    };
    const current = () => norm(editableEl.innerText);

    await sleep(60);

    // 1) execCommand insertText: fires native beforeinput/input, which Quill's
    //    MutationObserver reconciles into its model. Most reliable (plain text).
    selectAll();
    try {
      doc.execCommand("insertText", false, plain);
    } catch (_) {}
    editableEl.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(120);
    if (current()) return true;

    // 2) Synthetic paste with text/html + text/plain (some Quill builds accept it).
    selectAll();
    try {
      const dt = new DataTransfer();
      dt.setData("text/html", commentToHtml(text));
      dt.setData("text/plain", plain);
      editableEl.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        })
      );
    } catch (_) {}
    await sleep(120);
    if (current()) return true;

    // 3) Last resort: insertHTML (Quill's observer may reconcile it).
    selectAll();
    try {
      doc.execCommand("insertHTML", false, commentToHtml(text));
    } catch (_) {}
    editableEl.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(120);
    return !!current();
  }

  /* ---------------------------------------------------------------------------
   * LOCATING ELEMENTS IN THE GRADING VIEW
   * ------------------------------------------------------------------------- */

  // All grade inputs, in DOM order.
  function getGradeInputs() {
    return Array.from(document.querySelectorAll(SEL.gradeInput));
  }

  // All comment buttons, with their VISUAL number (from the button id).
  // Returns [{ btn, visual }].
  function getCommentButtons() {
    const out = [];
    document.querySelectorAll(SEL.commentButton).forEach((btn) => {
      const m = RE_FEEDBACK_BTN_ID.exec(btn.id || "");
      if (m) out.push({ btn, visual: parseInt(m[1], 10) });
    });
    return out;
  }

  // Anchors on [data-testid="question-number"] (VISUAL number, which matches the
  // feedback button id). From there it climbs to the question container and
  // locates the prompt, grade input, etc.
  // Returns [{ visual, container, gradeInput, commentBtn, root, expandBtn }].
  function getQuestions() {
    const numNodes = Array.from(document.querySelectorAll(SEL.questionNumber));
    const commentsByVisual = new Map();
    getCommentButtons().forEach((c) => commentsByVisual.set(c.visual, c.btn));

    const questions = [];
    numNodes.forEach((numNode) => {
      const visual = parseInt(norm(numNode.textContent), 10);
      const container = findQuestionContainer(numNode);
      const gradeInput = findGradeInput(container);
      const commentBtn =
        commentsByVisual.get(visual) || findCommentButtonIn(container);
      const root = findCollapsibleRoot(container);
      const expandBtn = root ? root.querySelector(SEL.expandToggle) : null;
      const questionId = readQuestionId(container);
      questions.push({ visual, questionId, container, gradeInput, commentBtn, root, expandBtn });
    });

    // Warn if something doesn't line up (useful for diagnosing DOM changes).
    const withGrade = questions.filter((q) => q.gradeInput).length;
    if (withGrade !== questions.length) {
      log(
        `Notice: ${questions.length} questions detected, ${withGrade} with a grade input located.`
      );
    }
    return questions;
  }

  // Climb from question-number up to the ancestor that also contains the prompt
  // (question-header.questionPrompt). This avoids depending on "N levels".
  function findQuestionContainer(numNode) {
    let el = numNode;
    for (let i = 0; i < 12 && el; i++) {
      if (el.querySelector && el.querySelector(SEL.questionPrompt)) return el;
      el = el.parentElement;
    }
    // Fallback: climb a fixed handful of levels.
    let f = numNode;
    for (let i = 0; i < 6 && f.parentElement; i++) f = f.parentElement;
    return f;
  }

  function findGradeInput(container) {
    if (!container) return null;
    return container.querySelector(SEL.gradeInput) || null;
  }

  function findCommentButtonIn(container) {
    if (!container) return null;
    return container.querySelector(SEL.commentButton) || null;
  }

  // Climb to the question's collapsible root (holds the header and, once
  // expanded, the answer section).
  function findCollapsibleRoot(el) {
    let x = el;
    while (x) {
      if (x.classList && x.classList.contains(SEL.collapsibleRootClass)) return x;
      x = x.parentElement;
    }
    return null;
  }

  // Extract type / prompt / answer / points / feedback from a question.
  // ASYNC: the answer lives in a collapsible section that gets UNMOUNTED; we
  // must expand the question (click the chevron), wait for it to mount, and read.
  async function extractQuestionContent(question) {
    const c = question.container;
    const type = readQuestionType(c);

    // Prompt: div[data-testid="question-header.questionPrompt"].
    const promptEl = c ? c.querySelector(SEL.questionPrompt) : null;
    const prompt = promptEl ? norm(promptEl.innerText) : "";

    // Current grade + max points.
    const currentGrade = question.gradeInput ? readValue(question.gradeInput) : "";
    const maxPoints = extractMaxPoints(c);

    // Already has feedback? (from the button icon, without opening the panel).
    const hasFeedback = question.commentBtn
      ? !!question.commentBtn.querySelector(SEL.feedbackIconFull)
      : false;

    // Student answer: expand the question and read the mounted section.
    const region = await expandAndGetAnswer(question);

    // Auto-graded questions (multiple choice / true-false) are excluded from the
    // export — there's nothing to grade by hand. Detected via the answer block's
    // data-testid (language-independent).
    const autoGraded = isAutoGraded(region);
    const answer = autoGraded ? "" : extractAnswer(region);

    return {
      visual: question.visual,
      questionId: question.questionId,
      type,
      prompt,
      answer,
      currentGrade,
      maxPoints,
      hasFeedback,
      autoGraded,
    };
  }

  // True if the mounted answer block is an auto-graded type (multiple
  // choice/answer or true/false), by its language-independent data-testid.
  function isAutoGraded(comp) {
    if (!comp) return false;
    return !!(comp.querySelector(SEL.mcAnswer) || comp.querySelector(SEL.tfAnswer));
  }

  // Click the expand chevron (if needed) and wait for the answer block to mount.
  // Returns the .readonly-question-component-react element, or null. Leaves the
  // question expanded (does not re-collapse, to save clicks).
  async function expandAndGetAnswer(question) {
    const btn = question.expandBtn;
    const root = question.root;
    if (!btn || !root) return null;
    if (btn.getAttribute("aria-expanded") !== "true") {
      btn.click();
      await sleep(PAUSE);
    }
    return waitFor(() => root.querySelector(SEL.answerComponent), {
      timeout: 6000,
    });
  }

  // From the mounted answer block, extract the student's text.
  //  - Essay: the ...__question-text div.
  //  - Other types (multiple choice, T/F): fallback to the block text minus the
  //    inner "Answer" label (may include all options; refine if needed).
  function extractAnswer(comp) {
    if (!comp) return "";
    const essay = comp.querySelector(SEL.essayText);
    if (essay) return norm(essay.innerText);
    // Generic: block text minus the inner label element (structural, not by word).
    const clone = comp.cloneNode(true);
    clone.querySelectorAll(SEL.answerInnerLabel).forEach((e) => e.remove());
    return norm(clone.innerText);
  }

  // Max points for the question. Prefer the language-independent
  // .pill-points-possible span; fall back to a number followed by "point/punt".
  function extractMaxPoints(container) {
    if (!container) return "";
    const pill = container.querySelector(SEL.pointsPossible);
    if (pill && norm(pill.textContent)) return norm(pill.textContent);
    const t = norm(container.innerText);
    const m = t.match(/(\d+(?:[.,]\d+)?)\s+(?:point|punt)/i);
    return m ? m[1] : "";
  }

  // Question type, read verbatim from the DOM (language-independent: whatever the
  // exam is in). e.g. "Essay", "Ensayo", "Multiple Choice", "Opción Múltiple".
  function readQuestionType(container) {
    if (!container) return "";
    const el = container.querySelector(SEL.typeLabel);
    return el ? norm(el.textContent) : "";
  }

  // Stable question content id (same for every student), from the prompt editor
  // id "...instructions-_{ID}_1". Not invented — real Blackboard metadata.
  function readQuestionId(container) {
    if (!container) return "";
    const el = container.querySelector(SEL.questionIdSource);
    const m = el && el.id.match(RE_QUESTION_ID);
    return m ? m[1] : "";
  }

  function readValue(el) {
    if (el == null) return "";
    if (typeof el.value === "string" && el.value !== "") return el.value.trim();
    if (el.getAttribute && el.getAttribute("aria-valuenow"))
      return el.getAttribute("aria-valuenow");
    return norm(el.textContent);
  }

  /* ---------------------------------------------------------------------------
   * STUDENT SIDE PANEL
   * ------------------------------------------------------------------------- */
  // Students come from the side-panel list: <li role="menuitem"> tagged with
  // analytics-id="…attemptNavigationPane.student.list". Each has a
  // [data-testid="user-name"] and a subtitle "ID: {legajo}". We read the id from
  // textContent (robust even if the subtitle is visually hidden).
  // Returns [{ el, name, id }].
  function getStudents() {
    const lis = Array.from(document.querySelectorAll(SEL.studentListItem));
    if (lis.length) {
      return lis.map((li) => {
        const nameNode = li.querySelector(SEL.userName);
        return {
          el: li,
          name: nameNode ? norm(nameNode.textContent) : norm(li.textContent),
          id: readStudentId(li),
        };
      });
    }
    // Fallback: derive from user-name cards (older/compact layouts).
    return Array.from(document.querySelectorAll(SEL.userName)).map((nameNode) => {
      const scope = findStudentCard(nameNode) || nameNode;
      return { el: scope, name: norm(nameNode.textContent), id: readStudentId(scope) };
    });
  }

  // Read the visible student id (legajo). The subtitle renders as a standalone
  // "ID: {n}" element; reading that element avoids textContent concatenation
  // (e.g. "JangID: 66259") that breaks a \bID: regex.
  function readStudentId(scope) {
    if (!scope) return "";
    const els = scope.querySelectorAll("h6, .MuiTypography-subtitle2, span, div");
    for (const e of els) {
      const m = (e.textContent || "").trim().match(/^ID:\s*(\S+)$/i);
      if (m) return m[1];
    }
    const im = (scope.innerText || "").match(RE_STUDENT_ID);
    return im ? im[1] : "";
  }

  // Climb from user-name up to the ancestor that also contains the grade pill
  // (that's the clickable card wrapper). If there's no pill (no attempt), climb
  // a fixed few levels.
  function findStudentCard(nameNode) {
    let el = nameNode;
    for (let i = 0; i < 10 && el; i++) {
      if (el.querySelector && el.querySelector(SEL.gradePill)) return el;
      el = el.parentElement;
    }
    let f = nameNode;
    for (let i = 0; i < 4 && f.parentElement; i++) f = f.parentElement;
    return f;
  }

  async function selectStudent(studentEl) {
    // Look for a clickable element (the item itself or a button/link inside).
    const clickable =
      studentEl.querySelector('a, button, [role="button"], [role="option"]') ||
      studentEl;
    clickable.click();
    await sleep(PAUSE);
    // Wait for the questions to render (or time out -> treat as no submission).
    await waitFor(() => getQuestions().length > 0, { timeout: 8000 });
    await sleep(PAUSE);
  }

  /* ---------------------------------------------------------------------------
   * .md FILE FORMAT (Markdown; deterministic serialize / parse)
   *
   *   #   -> exam title
   *   ##  -> student  (+ <!-- id: ... -->)
   *   ### -> question (Question N · Type · out of M points)
   * Student answer as a blockquote. Below it: the GRADE (bare number, prefilled
   * with the current one) and then the COMMENT (everything that follows).
   * On import only GRADE and COMMENT are read; the rest is context.
   * ------------------------------------------------------------------------- */

  // Exam title from document.title, which Blackboard sets as "{student} | {exam}"
  // (e.g. "Agustina Jang | Final 2026-07-03"). Take everything after the first
  // "|" (the exam, which may itself contain "|"), and drop a trailing
  // "| Blackboard Learn" suffix if present.
  function getExamTitle() {
    const raw = (document.title || "").trim();
    if (raw.includes("|")) {
      let exam = raw.slice(raw.indexOf("|") + 1).trim();
      exam = exam.replace(/\s*\|\s*blackboard.*$/i, "").trim();
      if (exam) return exam;
    }
    return raw || "Exam";
  }

  // Quote each line of the answer with "> ". If empty, a lone ">" as an anchor.
  function blockquote(text) {
    const t = String(text || "").trim();
    if (!t) return ">";
    return t
      .split(/\r?\n/)
      .map((l) => "> " + l)
      .join("\n");
  }

  // Question key used to group across students (content id if any, else visual).
  const qKey = (q) => q.questionId || `v${q.visual}`;

  // Serialize BY QUESTION:
  //   #   -> exam title
  //   ##  -> question  ("Question q{contentId}")
  //   ### -> a student's answer to that question ("{name} · id: {legajo}")
  // The prompt is printed once under the question; each student's answer follows
  // as a blockquote, then the GRADE (bare number) and the COMMENT.
  function serialize(students) {
    const L = [];
    L.push(`# ${getExamTitle()}`);
    L.push("");
    L.push(
      "<!-- BBTOOLS-MD v2 (by question) · Grade = first bare number under a student's answer. Comment = what follows. Do not edit the #/##/### headings. -->"
    );
    L.push("");

    // Collect questions in first-seen order, with their prompt.
    const order = [];
    const meta = new Map(); // key -> { label, prompt }
    students.forEach((s) =>
      (s.questions || []).forEach((q) => {
        const k = qKey(q);
        if (!meta.has(k)) {
          meta.set(k, {
            label: q.questionId ? `Question q${q.questionId}` : `Question ${q.visual}`,
            prompt: q.prompt || "",
          });
          order.push(k);
        }
      })
    );

    order.forEach((k) => {
      const m = meta.get(k);
      L.push(`## ${m.label}`);
      L.push("");
      L.push(m.prompt || "_(no prompt)_");
      L.push("");
      students.forEach((s) => {
        const q = (s.questions || []).find((qq) => qKey(qq) === k);
        if (!q) return; // student has no submission / not this question
        L.push(s.id ? `### ${s.name} (${s.id})` : `### ${s.name}`);
        L.push("");
        L.push(blockquote(q.answer));
        L.push("");
        L.push(q.currentGrade || ""); // GRADE (bare number; prefilled if any)
        L.push("");
        L.push(""); // COMMENT: blank space to fill in
      });
    });

    // Collapse runs of 2+ blank lines into one, so missing grade/comment
    // placeholders leave exactly one blank line.
    let out = L.join("\n").replace(/\n{3,}/g, "\n\n");
    return out.replace(/\s+$/, "") + "\n";
  }

  // Real ATX headings: hash(es) + space at the start of the line.
  const RE_H1 = /^#\s+(.*)$/;
  const RE_H2 = /^##\s+(.*)$/;
  const RE_H3 = /^###\s+(.*)$/;
  const RE_NUM = /^-?\d+([.,]\d+)?$/; // "8", "8.5", "8,5"
  const RE_Q_CONTENT_ID = /\bq(\d+)/i; // "Question q1261248" -> 1261248
  const RE_Q_VISUAL = /(?:Question|Pregunta)\s+(\d+)/i; // legacy visual number
  const RE_STUDENT_ID_PAREN = /\(([^)]+)\)\s*$/; // "Name (66259)" -> 66259

  // Question id from a "## Question q{id}" heading (falls back to visual number).
  function questionKeyFromHeading(head) {
    let m = head.match(RE_Q_CONTENT_ID);
    if (m) return m[1];
    m = head.match(RE_Q_VISUAL);
    return m ? `v${m[1]}` : "";
  }

  // Name + id from a "### {name} ({legajo})" heading.
  function studentFromHeading(head) {
    let name = head.trim();
    let id = "";
    const m = name.match(RE_STUDENT_ID_PAREN);
    if (m) {
      id = m[1].trim();
      name = name.slice(0, m.index).trim();
    }
    return { name, id };
  }

  // Parse the BY-QUESTION .md filled in by the professor -> per-student structure.
  //   ##  -> question (sets the current question key)
  //   ### -> a student's answer block (grade + comment)
  // Returns [{ name, id, questions: [{ questionKey, grade, comment }] }].
  function parse(text) {
    const lines = text.split(/\r?\n/);
    const byKey = new Map(); // student key -> record
    const order = [];
    let currentQuestionKey = null;
    let curStudent = null; // { name, id }
    let qbuf = [];

    const flushBlock = () => {
      if (curStudent && currentQuestionKey) {
        const { grade, comment } = parseQuestionBlock(qbuf);
        const key = (curStudent.id || curStudent.name || "").toLowerCase();
        let st = byKey.get(key);
        if (!st) {
          st = { name: curStudent.name, id: curStudent.id, questions: [] };
          byKey.set(key, st);
          order.push(st);
        }
        st.questions.push({ questionKey: currentQuestionKey, grade, comment });
      }
      qbuf = [];
      curStudent = null;
    };

    for (const line of lines) {
      // Check ### before ## (## regex won't match ### anyway, but be explicit).
      const mh3 = line.match(RE_H3);
      if (mh3) {
        flushBlock();
        curStudent = studentFromHeading(mh3[1]);
        continue;
      }
      const mh2 = line.match(RE_H2);
      if (mh2) {
        flushBlock();
        currentQuestionKey = questionKeyFromHeading(mh2[1]);
        continue;
      }
      if (RE_H1.test(line)) continue; // title: ignored
      if (curStudent) qbuf.push(line); // prompt lines (before any ###) are ignored
    }
    flushBlock();
    return order;
  }

  // From a question's lines: locate the answer blockquote (the first group of
  // lines starting with ">"), take the first non-empty line after it as GRADE
  // ONLY if it's a number, and the rest as COMMENT.
  function parseQuestionBlock(lines) {
    let j = 0;

    // Advance to the first blockquote (the answer) and consume it.
    while (j < lines.length && !/^\s*>/.test(lines[j])) j++;
    while (j < lines.length && /^\s*>/.test(lines[j])) j++;

    // First non-empty line after it.
    while (j < lines.length && lines[j].trim() === "") j++;

    let grade = "";
    if (j < lines.length && RE_NUM.test(lines[j].trim())) {
      grade = lines[j].trim();
      j++; // that line was the grade; the comment starts after it
    }
    // Everything after = comment (if the first line wasn't a number, it stays in).
    const comment = lines.slice(j).join("\n").replace(/^\n+|\n+$/g, "").trim();
    return { grade, comment };
  }

  /* ---------------------------------------------------------------------------
   * FEATURE 1 — EXPORT
   * ------------------------------------------------------------------------- */
  async function exportExam(btn) {
    btn.disabled = true;
    try {
      const items = getStudents();
      if (items.length === 0) {
        log(
          'Could not locate the student side panel ([data-testid="user-name"]). Check the SEL object (see README).'
        );
        return;
      }
      log(`Found ${items.length} students in the side panel.`);
      const result = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        log(`(${i + 1}/${items.length}) ${item.name}...`);
        await selectStudent(item.el);

        const questions = [];
        const live = getQuestions();
        const noSubmission = live.length === 0;
        if (!noSubmission) {
          for (const q of live) {
            const content = await extractQuestionContent(q);
            if (content.autoGraded) {
              log(`  Q${content.visual}: auto-graded, excluded from the file.`);
              continue; // multiple choice / true-false: not in the .md
            }
            questions.push(content);
          }
        } else {
          log(`  ${item.name}: no submission, skipped.`);
        }
        result.push({
          name: item.name,
          id: item.id,
          noSubmission,
          questions,
        });
      }

      const txt = serialize(result);
      const filename = `exam_export_${stamp()}.md`;
      triggerDownload(txt, filename);
    } catch (e) {
      log("Export error: " + (e && e.message));
      console.error(e);
    } finally {
      btn.disabled = false;
    }
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(
      d.getHours()
    )}${p(d.getMinutes())}`;
  }

  // Download the file. Primary path: chrome.downloads via the background worker,
  // which guarantees the "Save As" dialog. If the extension bridge is broken
  // (typically an orphaned content script after reloading the extension without
  // refreshing the tab), fall back to a Blob + <a download> from the page.
  function triggerDownload(txt, filename) {
    let handled = false;
    try {
      chrome.runtime.sendMessage(
        { type: "BBTOOLS_DOWNLOAD", text: txt, filename },
        (resp) => {
          if (chrome.runtime.lastError) {
            log(
              "Extension bridge unavailable (" +
                chrome.runtime.lastError.message +
                "). Using fallback download — reload the tab to restore the Save dialog."
            );
            fallbackDownload(txt, filename);
          } else if (resp && resp.ok) {
            log(`Download started: ${filename}`);
          } else {
            log("Download failed: " + (resp && resp.error) + ". Using fallback.");
            fallbackDownload(txt, filename);
          }
        }
      );
      handled = true;
    } catch (e) {
      // chrome.runtime.sendMessage can throw synchronously if the content script
      // is orphaned ("Extension context invalidated").
      log(
        "Extension context lost (" +
          (e && e.message) +
          "). Reload the tab. Using fallback download."
      );
      fallbackDownload(txt, filename);
    }
    return handled;
  }

  // Fallback download straight from the page (no service worker). Whether a
  // "Save As" dialog appears depends on Chrome's "Ask where to save" setting.
  function fallbackDownload(txt, filename) {
    try {
      const blob = new Blob([txt], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 1500);
      log(`Fallback download triggered: ${filename}`);
    } catch (e) {
      log("Fallback download failed: " + (e && e.message));
    }
  }

  /* ---------------------------------------------------------------------------
   * FEATURE 2 — IMPORT
   * ------------------------------------------------------------------------- */
  async function importGrades(fileStudents) {
    const items = getStudents();
    if (items.length === 0) {
      log("Could not locate the student side panel (import).");
      return;
    }

    // Index live students by name (normalized) and by id.
    const byName = new Map();
    const byId = new Map();
    items.forEach((it) => {
      if (it.name) byName.set(it.name.toLowerCase(), it);
      if (it.id) byId.set(it.id.toLowerCase(), it);
    });

    for (let i = 0; i < fileStudents.length; i++) {
      const fs = fileStudents[i];
      // Match by ID first (disambiguates same-name students), then by name.
      const match =
        (fs.id && byId.get(fs.id.toLowerCase())) ||
        (fs.name && byName.get(fs.name.toLowerCase()));
      if (!match) {
        log(`Student "${fs.name}" (${fs.id}) not found in the list. Skipping.`);
        continue;
      }
      log(`(${i + 1}/${fileStudents.length}) Loading ${fs.name}...`);
      await selectStudent(match.el);

      // Live questions, keyed the same way as the file (content id, else visual).
      const live = getQuestions();
      if (live.length === 0) {
        log(`  ${fs.name}: no submission, skipped.`);
        continue;
      }
      const byKey = new Map();
      live.forEach((lq) => byKey.set(qKey(lq), lq));

      for (const fq of fs.questions) {
        const lq = byKey.get(fq.questionKey);
        if (!lq) {
          log(`  Question ${fq.questionKey}: not on screen, skipped.`);
          continue;
        }

        // 1) Grade (if the professor filled it in).
        if (fq.grade !== "" && fq.grade != null) {
          await typeLikeHuman(lq.gradeInput, fq.grade);
          log(`  Q${lq.visual} (q${lq.questionId}): grade ${fq.grade} written.`);
          await sleep(PAUSE);
        }

        // 2) Comment (if filled in).
        if (fq.comment && fq.comment.trim() !== "") {
          await loadComment(lq, fq.comment);
          await sleep(PAUSE);
        }
      }
      log(`  ${fs.name}: done. Review and save manually.`);
    }
    log("Import finished. Nothing was saved or published automatically.");
  }

  async function loadComment(question, comment) {
    const btn = question.commentBtn;
    if (!btn) {
      log(`  Q${question.visual}: no comment button.`);
      return;
    }
    // Open the comment panel (only if it's currently collapsed — clicking an
    // already-open one would close it).
    if (btn.getAttribute("aria-expanded") !== "true") {
      btn.click();
      await sleep(PAUSE);
    }

    // Scope the editor search to THIS question's feedback region, so we never
    // pick another question's editor that may still be open.
    const regionId =
      btn.getAttribute("aria-controls") ||
      (btn.id || "").replace(/-button$/, "-region");
    const region = regionId ? document.getElementById(regionId) : null;

    // Find the real editable. NOTE: the page has ~31 ".ql-clipboard" divs
    // (Quill helpers, aria-hidden, tabindex=-1) that are also contenteditable —
    // they must be excluded, along with the read-only editors.
    const editable = await waitFor(() => {
      const scope = region || document;
      return (
        Array.from(scope.querySelectorAll(SEL.contentEditable)).find((el) =>
          isValidCommentEditor(el)
        ) || null
      );
    }, { timeout: 6000 });

    if (!editable) {
      log(`  Q${question.visual}: comment editor not found.`);
      return;
    }
    const ok = await pasteIntoEditor(editable, comment);
    if (!ok) {
      log(`  Q${question.visual}: editor found but comment insert failed.`);
      return;
    }

    // Click "Save" so the comment PERSISTS. Without it, navigating to the next
    // student discards the draft. (This only saves the feedback; it never
    // clicks "Publish grades".)
    const saveBtn = findSaveButton(region);
    if (saveBtn) {
      saveBtn.click();
      await sleep(PAUSE);
      log(`  Q${question.visual}: comment saved.`);
    } else {
      log(`  Q${question.visual}: comment inserted but "Save" not found — NOT saved.`);
    }
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // A contenteditable that is the real comment editor: visible, and NOT an
  // auxiliary ".ql-clipboard", not aria-hidden, and not a read-only editor.
  function isValidCommentEditor(el) {
    if (!el || !isVisible(el)) return false;
    if (el.classList.contains("ql-clipboard")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (el.closest(".is-read-only, .ql-disabled")) return false;
    return true;
  }

  // The "Save" button of the comment editor (Guardar / Save), searched inside the
  // question's feedback region first, then in the document. Must be enabled and
  // visible. This is NOT "Publish grades" — it only persists the feedback draft.
  const RE_SAVE = /^\s*(guardar|save)\s*$/i;
  function findSaveButton(scope) {
    for (const root of [scope, document]) {
      if (!root) continue;
      const b = Array.from(
        root.querySelectorAll('button, [role="button"]')
      ).find(
        (el) => RE_SAVE.test(el.textContent || "") && !el.disabled && isVisible(el)
      );
      if (b) return b;
    }
    return null;
  }

  /* ---------------------------------------------------------------------------
   * FLOATING PANEL
   * ------------------------------------------------------------------------- */
  function buildPanel() {
    if (document.getElementById("bbtools-panel")) return;

    const panel = document.createElement("div");
    panel.id = "bbtools-panel";
    panel.innerHTML = `
      <div class="bbtools-header">
        <span class="bbtools-title">Assisted grading</span>
        <button class="bbtools-min" id="bbtools-min" title="Minimize">–</button>
      </div>
      <div class="bbtools-body">
        <button class="bbtools-btn" id="bbtools-export">Download responses</button>
        <button class="bbtools-btn secondary" id="bbtools-import">Upload grades/comments</button>
        <input type="file" id="bbtools-file-input" accept=".md,.txt,text/markdown,text/plain" />
        <div class="bbtools-status" id="bbtools-status">Ready.</div>
      </div>
    `;
    document.body.appendChild(panel);

    document
      .getElementById("bbtools-export")
      .addEventListener("click", (e) => exportExam(e.currentTarget));

    const fileInput = document.getElementById("bbtools-file-input");
    document
      .getElementById("bbtools-import")
      .addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const text = await file.text();
      fileInput.value = ""; // allow re-selecting the same file
      try {
        const students = parse(text);
        log(`File parsed: ${students.length} students.`);
        await importGrades(students);
      } catch (err) {
        log("Import error: " + (err && err.message));
        console.error(err);
      }
    });

    document.getElementById("bbtools-min").addEventListener("click", () => {
      panel.classList.toggle("bbtools-collapsed");
    });
  }

  function removePanel() {
    const p = document.getElementById("bbtools-panel");
    if (p) p.remove();
  }

  /* ---------------------------------------------------------------------------
   * URL ACTIVATION (SPA-aware)
   * ------------------------------------------------------------------------- */
  function inGradingView() {
    return location.href.includes(URL_TRIGGER);
  }

  function sync() {
    if (inGradingView()) buildPanel();
    else removePanel();
  }

  // The app is an SPA: the URL changes without a reload. Watch history + DOM.
  (function watchUrl() {
    let last = location.href;
    const check = () => {
      if (location.href !== last) {
        last = location.href;
        sync();
      }
    };
    ["pushState", "replaceState"].forEach((m) => {
      const orig = history[m];
      history[m] = function () {
        const r = orig.apply(this, arguments);
        setTimeout(check, 0);
        return r;
      };
    });
    window.addEventListener("popstate", check);
    setInterval(check, 1000); // safety net
  })();

  sync();
})();
