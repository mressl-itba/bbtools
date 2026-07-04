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

  // Grades only persist to the server while the window has OS focus (Blackboard
  // ignores our edits otherwise). So before any grade write we GATE on focus:
  // if the window isn't focused, pause and wait until it is again. This makes the
  // import safe to leave running as long as the window stays focused — the moment
  // you click away it pauses, and it resumes when you come back.
  async function ensureFocused() {
    if (document.hasFocus()) return;
    log("⏸ PAUSED — click back on this window to resume (grades need focus).");
    setPaused(true);
    for (;;) {
      if (document.hasFocus()) break;
      await sleep(200);
    }
    setPaused(false);
    log("▶ Resumed.");
  }

  // Toggle the panel's "paused / lost focus" visual state.
  function setPaused(on) {
    const panel = document.getElementById("bbtools-panel");
    if (panel) panel.classList.toggle("bbtools-paused", !!on);
  }

  // Toggle the panel's "upload in progress" state (shows the focus warning only
  // while an import is actually running).
  function setUploading(on) {
    const panel = document.getElementById("bbtools-panel");
    if (panel) panel.classList.toggle("bbtools-uploading", !!on);
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
    // Release focus from any previously-focused editor (e.g. an unsaved comment
    // Quill editor) so it can't trap focus and block this pill's blur/autosave.
    const prev = document.activeElement;
    if (prev && prev !== el && typeof prev.blur === "function") {
      try {
        prev.blur();
      } catch (_) {}
    }
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
    // We do NOT blur here. The MUI pill input only exposes the typed value in
    // its `.value` WHILE it is in edit mode; if we blurred first, the readback
    // in writeGrade would see an empty value and burn the full retry timeouts
    // (~5 s). The caller (commitGrade) blurs once the value is verified, which
    // is what actually triggers the autosave.
    await sleep(30);
    return true;
  }

  // Blur the pill for REAL to trigger its autosave. A dispatched blur *event*
  // alone does not remove focus (caret stays, next navigation blocked), so we
  // must call el.blur().
  async function commitGrade(el) {
    // Blur to trigger the pill's autosave. This only persists while the window is
    // focused (see ensureFocused), which the import gates on before every grade.
    el.dispatchEvent(new Event("change", { bubbles: true }));
    try {
      el.blur();
    } catch (_) {}
    el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    // If focus didn't actually leave, force whatever is still focused to blur.
    const ae = document.activeElement;
    if (ae && typeof ae.blur === "function") {
      try {
        ae.blur();
      } catch (_) {}
    }
    await sleep(120);
  }

  // Compare two grade strings numerically ("8" == "8.0" == "8,0").
  function sameNumber(a, b) {
    const na = parseFloat(String(a).replace(",", "."));
    const nb = parseFloat(String(b).replace(",", "."));
    if (!isNaN(na) && !isNaN(nb)) return na === nb;
    return String(a).trim() === String(b).trim();
  }

  // Write a grade and VERIFY it stuck: after typing, wait for the value to settle
  // (the pill autosaves on blur; a slow save can otherwise be reverted by a later
  // re-render), then read the input back. Retry a few times. Returns { ok, got }.
  async function writeGrade(input, grade) {
    const target = String(grade).trim();
    let got = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      await typeLikeHuman(input, target);
      // Verify WHILE the input is still focused (edit mode): the value is there
      // immediately, so this matches on the first poll. Reading after the blur
      // is unreliable — the pill clears `.value` out of edit mode — which is
      // what used to make this burn ~5 s of timeouts.
      await waitFor(() => sameNumber(readValue(input), target), {
        timeout: 600,
        interval: 60,
      });
      got = readValue(input).trim();
      if (sameNumber(got, target)) {
        await commitGrade(input); // blur -> autosave
        return { ok: true, got, attempts: attempt };
      }
    }
    await commitGrade(input); // don't leave the pill stuck in edit mode
    return { ok: false, got, attempts: 3 };
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

  // Build a Quill Delta (ops array) from the comment text: bullet lines become
  // list items, the rest plain paragraphs. This is what we hand to the MAIN-world
  // script to apply via Quill's API with source "user" (see setCommentViaPage).
  function commentToDelta(text) {
    const lines = String(text).split(/\r?\n/);
    const ops = [];
    for (const line of lines) {
      const m = RE_BULLET.exec(line);
      if (m) {
        ops.push({ insert: m[2] });
        ops.push({ insert: "\n", attributes: { list: "bullet" } });
      } else {
        ops.push({ insert: line });
        ops.push({ insert: "\n" });
      }
    }
    if (ops.length === 0) ops.push({ insert: "\n" });
    return ops;
  }

  // Ask the MAIN-world helper (main_world.js) to set the comment via Quill's own
  // API with source "user" — the only reliable way to make Blackboard mark the
  // field as edited and enable "Guardar". Returns { ok, err }. The isolated world
  // can't reach the Quill instance itself, hence the postMessage bridge.
  function setCommentViaPage(regionId, ops, timeout = 3000) {
    return new Promise((resolve) => {
      const id = "bbt" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
      let done = false;
      const onMsg = (ev) => {
        if (ev.source !== window) return;
        const m = ev.data;
        if (!m || m.type !== "BBTOOLS_SET_COMMENT_RESULT" || m.id !== id) return;
        done = true;
        window.removeEventListener("message", onMsg);
        resolve(m);
      };
      window.addEventListener("message", onMsg);
      window.postMessage(
        { type: "BBTOOLS_SET_COMMENT", id, regionId, ops },
        "*"
      );
      setTimeout(() => {
        if (!done) {
          window.removeEventListener("message", onMsg);
          resolve({ ok: false, err: "timeout (no MAIN-world reply)" });
        }
      }, timeout);
    });
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

  // Dispatch a full pointer/mouse sequence (some React menu items react to
  // mousedown/pointerdown, not just a bare click()).
  function realClick(el) {
    if (!el) return;
    const o = { bubbles: true, cancelable: true, view: window };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      try {
        el.dispatchEvent(
          type.startsWith("pointer")
            ? new PointerEvent(type, o)
            : new MouseEvent(type, o)
        );
      } catch (_) {
        try {
          el.dispatchEvent(new MouseEvent(type.replace("pointer", "mouse"), o));
        } catch (_2) {}
      }
    }
    if (typeof el.click === "function") {
      try {
        el.click();
      } catch (_) {}
    }
  }

  function headerStudentName() {
    const h = document.querySelector('h1[data-testid="user-name"]');
    return h ? norm(h.textContent) : "";
  }

  // Header prev/next student navigation (NOT virtualized — always present).
  const NAV_NEXT = '[data-analytics-id="attemptGrading.studentNavigation.nextStudent"]';
  const NAV_PREV = '[data-analytics-id="attemptGrading.studentNavigation.previousStudent"]';

  function isNavDisabled(el) {
    return (
      !el ||
      el.getAttribute("aria-disabled") === "true" ||
      el.hasAttribute("disabled") ||
      el.disabled === true
    );
  }

  // Current student shown in the header: name + legajo (read from the header,
  // which reflects the selected student regardless of the list's virtualization).
  function currentHeaderStudent() {
    const h1 = document.querySelector('h1[data-testid="user-name"]');
    if (!h1) return { name: "", id: "" };
    let c = h1;
    let id = "";
    for (let k = 0; k < 6 && c; k++) {
      id = readStudentId(c);
      if (id) break;
      c = c.parentElement;
    }
    return { name: norm(h1.textContent), id };
  }

  // Walk to the first student (click "previous" until it's disabled).
  async function goToFirstStudent() {
    for (let i = 0; i < 1000; i++) {
      const btn = document.querySelector(NAV_PREV);
      if (isNavDisabled(btn)) return;
      const before = headerStudentName();
      realClick(btn);
      const ok = await waitFor(() => headerStudentName() !== before, { timeout: 6000 });
      await sleep(150);
      if (!ok) return; // couldn't move — stop trying
    }
  }

  // Go to the next student. Returns false if already at the last one.
  async function goToNextStudent() {
    const btn = document.querySelector(NAV_NEXT);
    if (isNavDisabled(btn)) return false;
    const before = headerStudentName();
    realClick(btn);
    await waitFor(() => headerStudentName() !== before, { timeout: 8000 });
    await sleep(PAUSE);
    return true;
  }

  // Find the scrollable ancestor of the student list (the side panel is
  // lazy-loaded: only ~15 items mount until you scroll).
  function findStudentScroller() {
    const first = document.querySelector(SEL.studentListItem);
    let el = first ? first.parentElement : null;
    while (el && el !== document.body) {
      const oy = getComputedStyle(el).overflowY;
      if (/(auto|scroll)/.test(oy) && el.scrollHeight > el.clientHeight + 20) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  // Scroll the student list until its item count stops growing, so every student
  // mounts. Then scroll back to the top. Returns the final count.
  async function loadAllStudents() {
    const scroller = findStudentScroller();
    let prev = -1;
    let stable = 0;
    for (let i = 0; i < 80 && stable < 2; i++) {
      const count = document.querySelectorAll(SEL.studentListItem).length;
      if (count === prev) stable++;
      else stable = 0;
      prev = count;

      const items = document.querySelectorAll(SEL.studentListItem);
      const last = items[items.length - 1];
      if (last) last.scrollIntoView({ block: "end" });
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      await sleep(400);
    }
    if (scroller) scroller.scrollTop = 0;
    await sleep(300);
    const total = document.querySelectorAll(SEL.studentListItem).length;
    log(`${total} students loaded.`);
    return total;
  }

  async function selectStudent(studentEl, expectedName) {
    // Remove focus from any field still in edit mode (e.g. a grade pill) — the
    // navigation click can be swallowed otherwise.
    if (document.activeElement && document.activeElement.blur) {
      try {
        document.activeElement.blur();
      } catch (_) {}
    }

    const before = headerStudentName();
    const clickable =
      studentEl.querySelector('a, button, [role="button"], [role="option"]') ||
      studentEl;
    const want = norm(expectedName || "").toLowerCase();

    // "Navigated" = this student's item is now current, or the header shows them.
    // NOTE: do NOT use getQuestions().length here — questions from the PREVIOUS
    // student are still on screen, so it would report success without navigating.
    const confirmed = () => {
      if (studentEl.getAttribute && studentEl.getAttribute("aria-current") === "page")
        return true;
      if (want && headerStudentName().toLowerCase() === want) return true;
      return false;
    };

    // Click and confirm navigation; retry a few times if the first click gets
    // swallowed (e.g. by a transient post-write state).
    let navigated = confirmed();
    for (let attempt = 1; attempt <= 4 && !navigated; attempt++) {
      realClick(clickable);
      navigated = await waitFor(confirmed, { timeout: 3000 });
      if (!navigated) {
        log(
          `  selectStudent: attempt ${attempt} not confirmed (wanted "${expectedName}", header "${headerStudentName()}").`
        );
      }
    }
    await sleep(PAUSE);
    // Blackboard lazy-loads questions on scroll: force them all to mount.
    await loadAllQuestions();
  }

  // Find the scrollable ancestor that holds the question list.
  function findQuestionScroller() {
    const first = document.querySelector(SEL.questionNumber);
    let el = first ? first.parentElement : null;
    while (el && el !== document.body) {
      const oy = getComputedStyle(el).overflowY;
      if (/(auto|scroll)/.test(oy) && el.scrollHeight > el.clientHeight + 20) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  // Scroll down in steps until the question count stops growing, so that
  // lazily-loaded questions all mount. Then scroll back to the top.
  async function loadAllQuestions() {
    const scroller = findQuestionScroller();
    let prev = -1;
    let stable = 0;
    for (let i = 0; i < 40 && stable < 2; i++) {
      const count = document.querySelectorAll(SEL.questionNumber).length;
      if (count === prev) stable++;
      else stable = 0;
      prev = count;

      // Nudge the last question into view + push the scroller to the bottom.
      const nums = document.querySelectorAll(SEL.questionNumber);
      const last = nums[nums.length - 1];
      if (last) last.scrollIntoView({ block: "end" });
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(450);
    }
    if (scroller) scroller.scrollTop = 0;
    window.scrollTo(0, 0);
    await sleep(300);
    log(`  ${document.querySelectorAll(SEL.questionNumber).length} questions loaded.`);
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
      if (!document.querySelector('h1[data-testid="user-name"]')) {
        log("Student header not found. Open a student's grading view first.");
        return;
      }

      // Walk students via the header "next" navigation (the side list is
      // virtualized — only ~15 items ever mount — so we don't rely on it).
      await goToFirstStudent();
      const result = [];
      const seen = new Set();
      let guard = 0;
      do {
        const stu = currentHeaderStudent();
        const key = (stu.id || stu.name || "").toLowerCase();
        if (key && seen.has(key)) break; // safety: looped back
        if (key) seen.add(key);

        log(`(${result.length + 1}) ${stu.name}${stu.id ? ` (${stu.id})` : ""}...`);
        await loadAllQuestions();

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
          log(`  ${stu.name}: no submission.`);
        }
        result.push({ name: stu.name, id: stu.id, noSubmission, questions });
        guard++;
      } while (guard < 1000 && (await goToNextStudent()));

      const txt = serialize(result);
      const filename = `${sanitizeFilename(getExamTitle())}_${stamp()}.md`;
      triggerDownload(txt, filename);
      log(`Exported ${result.length} students.`);
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

  // Strip characters that are invalid in file names (Windows/macOS/Linux).
  function sanitizeFilename(s) {
    return (
      String(s || "")
        .replace(/[\\/:*?"<>|]+/g, "")
        .replace(/\s+/g, " ")
        .trim() || "exam"
    );
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
    if (!document.querySelector('h1[data-testid="user-name"]')) {
      log("Student header not found. Open a student's grading view first.");
      return;
    }

    // Index the file's students by legajo (primary) and name (fallback).
    const byId = new Map();
    const byName = new Map();
    fileStudents.forEach((fs) => {
      if (fs.id) byId.set(fs.id.toLowerCase(), fs);
      if (fs.name) byName.set(fs.name.toLowerCase(), fs);
    });

    // Walk ALL students via the header "next" navigation (the side list is
    // virtualized), applying grades/comments to the ones present in the file.
    await goToFirstStudent();
    const seen = new Set();
    let processed = 0;
    let guard = 0;
    do {
      const stu = currentHeaderStudent();
      const navKey = (stu.id || stu.name || "").toLowerCase();
      if (navKey && seen.has(navKey)) break; // safety: looped back
      if (navKey) seen.add(navKey);

      const fs =
        (stu.id && byId.get(stu.id.toLowerCase())) ||
        (stu.name && byName.get(stu.name.toLowerCase()));
      if (fs) {
        log(`Loading ${stu.name}${stu.id ? ` (${stu.id})` : ""}...`);
        await loadAllQuestions();
        await applyStudent(fs);
        processed++;
      }
      guard++;
    } while (guard < 1000 && (await goToNextStudent()));

    log(
      `Import finished: ${processed} students updated. 'Publish grades' NOT clicked.`
    );
  }

  // Apply one file student's grades + comments to the CURRENT screen.
  // Interleaved: per question, grade then comment (the comment button ref is used
  // fresh, right after its grade). A final verification pass rewrites any grade
  // reverted by a comment "Save".
  // Live questions keyed the same way as the file (content id, else visual).
  function questionsByKey() {
    const m = new Map();
    getQuestions().forEach((lq) => m.set(qKey(lq), lq));
    return m;
  }

  async function applyStudent(fs) {
    let byKey = questionsByKey();
    if (byKey.size === 0) {
      log(`  no submission, skipped.`);
      return;
    }

    for (const fq of fs.questions) {
      const hasGrade = fq.grade !== "" && fq.grade != null;
      const hasComment = fq.comment && fq.comment.trim() !== "";
      if (!hasGrade && !hasComment) continue;

      const lq = byKey.get(fq.questionKey);
      if (!lq) {
        log(`  Question ${fq.questionKey}: not on screen, skipped.`);
        continue;
      }

      // 1) Grade (write + verify + retry). Gate on focus: grades only persist to
      // the server while the window is focused, so pause here if it isn't.
      if (hasGrade) {
        await ensureFocused();
        const res = await writeGrade(lq.gradeInput, fq.grade);
        log(
          res.ok
            ? `  Q${lq.visual}: grade ${fq.grade} set (readback ${res.got}).`
            : `  Q${lq.visual}: grade ${fq.grade} did NOT stick (readback "${res.got}").`
        );
        // Short settle only: the pill needs to leave edit mode and re-render.
        // No long blind wait here — the final verification pass below rewrites
        // any grade a later comment "Save" reverts, so this doesn't need to be
        // the safety margin.
        await sleep(120);
      }

      // 2) Comment (paste + "Save").
      if (hasComment) {
        await loadComment(lq, fq.comment);
        await sleep(150);
      }
    }

    // Final verification: re-check grades, rewrite any reverted by a comment Save.
    await sleep(400);
    byKey = questionsByKey();
    for (const fq of fs.questions) {
      if (fq.grade === "" || fq.grade == null) continue;
      const lq = byKey.get(fq.questionKey);
      if (!lq || !lq.gradeInput) continue;
      const cur = readValue(lq.gradeInput).trim();
      if (!sameNumber(cur, fq.grade)) {
        log(`  Q${lq.visual}: grade reverted (now "${cur}") — rewriting.`);
        await ensureFocused();
        const res = await writeGrade(lq.gradeInput, fq.grade);
        log(
          res.ok
            ? `  Q${lq.visual}: grade re-set (${res.got}).`
            : `  Q${lq.visual}: grade STILL not set ("${res.got}").`
        );
        await sleep(PAUSE);
      }
    }
    await sleep(500);
  }

  async function loadComment(question, comment) {
    const btn = question.commentBtn;
    if (!btn) {
      log(`  Q${question.visual}: no comment button.`);
      return;
    }
    // Open the comment panel (only if it's currently collapsed — clicking an
    // already-open one would close it). No fixed wait: the waitFor(findEditable)
    // below polls until the editor mounts.
    if (btn.getAttribute("aria-expanded") !== "true") {
      btn.click();
    }

    // Scope the editor search to THIS question's feedback region, so we never
    // pick another question's editor that may still be open.
    const regionId =
      btn.getAttribute("aria-controls") ||
      (btn.id || "").replace(/-button$/, "-region");
    const region = regionId ? document.getElementById(regionId) : null;

    // Find the real editable. NOTE: the page has many ".ql-clipboard" divs
    // (Quill helpers) and read-only editors that must be excluded.
    const findEditable = () => {
      const scope = region || document;
      return (
        Array.from(scope.querySelectorAll(SEL.contentEditable)).find((el) =>
          isValidCommentEditor(el)
        ) || null
      );
    };
    // Short probe first. If the question already has feedback from a previous
    // run, the region shows it READ-ONLY with an "Edit"/"Editar" button and NO
    // editable — so instead of burning the full 4 s timeout waiting for an
    // editable that isn't there, probe briefly and, if there's an Edit button,
    // click it right away.
    let editable = await waitFor(findEditable, { timeout: 800, interval: 60 });
    if (!editable) {
      const editBtn = findEditButton(region);
      if (editBtn) editBtn.click();
      editable = await waitFor(findEditable, { timeout: 4000, interval: 80 });
    }

    if (!editable) {
      const total = region
        ? region.querySelectorAll(SEL.contentEditable).length
        : -1;
      const ro = region
        ? region.querySelectorAll(".is-read-only, .ql-disabled").length
        : -1;
      log(
        `  Q${question.visual}: comment editor not found (region=${!!region}, contenteditable=${total}, readonly=${ro}, expanded=${btn.getAttribute(
          "aria-expanded"
        )}).`
      );
      return;
    }
    // Preferred path: set the comment through Quill's own API in the MAIN world
    // (source "user"), which is what actually enables "Guardar". Fall back to the
    // execCommand/paste path if the bridge can't reach a Quill instance.
    let inserted = false;
    if (regionId) {
      const res = await setCommentViaPage(regionId, commentToDelta(comment));
      if (res.ok) {
        inserted = true;
      } else {
        log(`  Q${question.visual}: Quill bridge failed (${res.err}) — falling back.`);
      }
    }
    if (!inserted) {
      const ok = await pasteIntoEditor(editable, comment);
      if (!ok) {
        log(`  Q${question.visual}: editor found but comment insert failed.`);
        return;
      }
    }

    // Click "Save" so the comment PERSISTS. Without it, navigating to the next
    // student discards the draft. (This only saves the feedback; it never
    // clicks "Publish grades".) The button can be briefly disabled right after
    // the edit until it registers, so poll a moment for it.
    const saveBtn = await waitFor(() => findSaveButton(region), {
      timeout: 1500,
      interval: 80,
    });
    if (saveBtn) {
      saveBtn.click();
      await sleep(150);
      log(`  Q${question.visual}: comment saved.`);
    } else {
      // Diagnose: is a "Guardar"/"Save" button present but disabled (the edit
      // wasn't registered as a user change), or genuinely absent?
      const scope = region || document;
      const cands = Array.from(
        scope.querySelectorAll('button, [role="button"]')
      ).filter((b) => RE_SAVE.test(b.textContent || ""));
      const desc =
        cands
          .map(
            (b) =>
              `disabled=${b.disabled}|aria=${b.getAttribute(
                "aria-disabled"
              )}|vis=${isVisible(b)}`
          )
          .join("; ") || "none in region";
      log(
        `  Q${question.visual}: comment inserted but "Save" not clicked — [${desc}] (hasFocus=${document.hasFocus()}).`
      );
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
  // The "Edit"/"Editar" button shown when a question already has (read-only)
  // feedback from a previous run. Clicking it re-mounts the editable.
  const RE_EDIT = /editar|edit/i;
  function findEditButton(region) {
    if (!region) return null;
    return (
      Array.from(region.querySelectorAll('button, [role="button"]')).find(
        (b) =>
          RE_EDIT.test(
            (b.getAttribute("aria-label") || "") + " " + (b.textContent || "")
          ) && isVisible(b)
      ) || null
    );
  }

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
        <div class="bbtools-focus-warning">
          ⚠ KEEP THIS WINDOW FOCUSED<br />
          <span>Grades are only saved while this window is in focus. If you
          click away, the upload PAUSES and resumes when you return.</span>
        </div>
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
        setUploading(true);
        const students = parse(text);
        log(`File parsed: ${students.length} students.`);
        await importGrades(students);
      } catch (err) {
        log("Import error: " + (err && err.message));
        console.error(err);
      } finally {
        setUploading(false);
        setPaused(false);
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
