# BB Ultra — Assisted grading (ITBA)

Chrome extension (Manifest V3, unpacked) to assist with grading exams in
Blackboard Ultra (`campus.itba.edu.ar`). It activates **only** in a student's
grading view (URL containing `/flexible-attempt-grading`).

**It does not use the internal REST API** (a WAF returns 403) nor React's native
setters. Everything is done by reading the rendered DOM, calling `click()` on
real buttons, and "typing/pasting" like a person (`document.execCommand` on the
focused element, which fires the events React actually listens to; and a real
`paste` event for the Quill comment editor).

Selectors are **language-independent**: they rely on `data-testid` /
`data-analytics-id` / `analytics-id` / element ids / stable component classes,
never on UI text. Only the students' own content (prompts and answers) stays in
whatever language the exam is written in.

## Install (developer mode)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. **Load unpacked** → pick this folder (`chrome-extension/`).
4. Open an exam in Blackboard Ultra and go to a student's grading view. Once the
   URL contains `/flexible-attempt-grading`, a floating panel appears at the
   bottom right with two buttons.

> There are no icons or popup: the UI is a panel injected into the page. If you
> change files, hit **Reload** (⟳) in `chrome://extensions` and refresh the tab.

## Usage

- **Download exam**: walks the student side panel, opens each one, **scrolls to
  force all lazily-loaded questions to mount**, and per question **expands the
  collapsible panel** (clicks the chevron) so the answer mounts, then extracts
  the visual number, type, prompt, answer, current grade and max points.
  **Auto-graded questions (multiple choice / multiple answer / true-false) are
  excluded**. Downloads a `.md` named `{exam title}_{YYYYMMDD_HHMM}.md`.
- **Upload grades/comments**: opens a file picker. Choose the completed `.md`.
  Per student, per question, interleaved: **(1)** write the grade into its pill
  input (with read-back + retry), **(2)** set the comment in the **Quill** editor
  and click **"Save"**. After each student a **final pass** re-reads the grades
  and rewrites any that got reverted. It **never** clicks **"Publish grades"** —
  that's left for the professor to review and publish.

> ⚠ **Keep the window focused while uploading.** Grades only persist to the
> server while the browser window has OS focus (Blackboard ignores programmatic
> edits otherwise). The upload **gates on focus**: if you click away it **pauses**
> (the panel turns yellow and blinks "PAUSED") and **resumes** automatically when
> the window regains focus. So it's safe to leave running — just don't take focus
> away, or it will wait. Comments are not affected (see below).

Students with no submission are detected and skipped. If a question ends up with
**no grade and no comment**, nothing is touched for that question.

### Why comments need a MAIN-world helper (`main_world.js`)

Inserting a comment with `execCommand`/paste from the content script puts the
text on screen but Blackboard does **not** mark the field as edited, so its
**"Guardar"** button stays disabled and the comment is never saved — unless the
edit comes from a *genuine* user interaction. To get a real "user" edit without
depending on focus, `main_world.js` runs in the page's **MAIN world**, reaches
the editor's own **Quill instance** (`ed.__quill`, invisible to the isolated
content script), and applies the comment via `quill.setContents(delta, "user")`.
That emits the `text-change` event Blackboard listens to, which enables "Guardar".
It uses only the editor's public API — no REST API, no React state setters. The
content script talks to it over `window.postMessage`. Grades have no equivalent
JS API we can reach, which is why they fall back to the focus requirement above.

> **Important — collapsible:** in this view each question is an accordion and the
> **answer is unmounted from the DOM while collapsed**. That's why *export*
> expands each question before reading (it's slower). *Import* does not need to
> expand: the grade goes to the pill (always mounted) and the comment to the
> feedback region, which mounts when the "Comments" button is clicked.

## `.md` format (Markdown) — organized **by question**

```markdown
# Algebra Midterm — Section 3

## Question q1261248

Which of the following statements is correct?

### Ines Angeles Welsh (65258)

> Ines's answer

8

Well done, but:
- Step 2 wasn't justified.

### Agustina Jang (66259)

> Agustina's answer

7
```

Each question appears once (`##`), with its prompt, followed by every student's
answer (`###`). This mirrors Blackboard's "Questions" view: you grade one
question across all students together. (Export/import still drive Blackboard's
per-student view under the hood; only the file layout is by question.)

Import parsing rules (everything else is read-only context):

- **Question**: `##` heading, `## Question q{contentId}` — Blackboard's stable
  question content id (same for every student), read from the prompt editor's DOM
  id. Matched by that id (falls back to `Question {N}` visual number for old
  files).
- **Student**: `###` heading, `### {name} ({legajo})`. Matched by **legajo
  first** (disambiguates same-name students), then by name.
- **Grade**: the **first non-empty line after the answer blockquote**, and
  **only if it is a number** (`8`, `8.5`, `8,5`). If that line is not a number,
  no grade is assumed and the line counts as comment.
- **Comment**: **everything that follows** the grade, up to the next heading. No
  closing marker: the `###`/`##`/`#` headings delimit it.
- If a student's answer has neither grade nor comment, it is skipped (nothing
  written).

**Bullets in the comment:** lines starting with `-`, `*` or `•` are inserted as a
`<ul><li>…</li></ul>` list (via the paste `text/html`), matching the real
feedback style; the rest goes as plain text. The comment **overwrites** any prior
feedback. Bold/italics are left for a possible v2.

> **Known caveat:** since headings delimit, if you write a comment line starting
> with `# ` (hash + space) it is read as a heading and cuts the comment there.
> Unlikely; avoid starting comment lines with `# `.

## Selectors

Centralized in the `SEL` object at the top of `content.js`. All are
language-independent (`data-testid` / `data-analytics-id` / `analytics-id` / ids
/ stable component classes) rather than Material-UI's dynamic classes or the
`aria-label` text:

| What | Selector |
|---|---|
| Exam title | `document.title`, format `{student} \| {exam}` → text after the first `\|` |
| Student list item | `[analytics-id="attemptGrading.attemptNavigationPane.student.list"]` (each `li[role=menuitem]`) |
| Student name | `[data-testid="user-name"]` (inside the list item) |
| Student id (legajo) | card subtitle element whose text is `ID: {n}` |
| **Visual** question number | `[data-testid="question-number"]` — matches the feedback button id |
| Question content id | prompt editor id `[id^="bb-editorquestion-instructions-"]` → `…_{ID}_1` |
| Prompt | `[data-testid="question-header.questionPrompt"]` |
| Question type | text of `.MuiTypography-h4` (verbatim, any language) |
| Has a comment already? | icon `feedback-icon` (yes) vs `add-feedback-icon` (no) |
| Grade input | `input[analytics-id="…gradePill…gradableContent.input"]` |
| Comment button + visual number | `[id^="question-feedback-"][id$="-button"]` → `question-feedback-{N}-button` |
| Max points | `.pill-points-possible` |
| Collapsible root | class `js-collapsible-question-container-root` |
| Expand chevron | `[data-analytics-id="attemptGrading.question.expandToggle.button"]` |
| Answer block (mounted) | `.readonly-question-component-react` |
| Answer text (essay) | `.readonly-question-component-react__question-text` |
| Comment editor | Quill: `div.ql-editor[contenteditable="true"]` (`id="bb-editor-textbox"`) |

**Matching and flow:**

- Question ↔ prompt / grade / button: anchored on `question-number` (**visual**),
  climbing to the container that also holds the prompt; the grade input and
  comment button are found inside it.
- Answer: from there it climbs to the collapsible root, clicks the chevron to
  mount the block, and reads `…__question-text` (essay) or, for other types, the
  block text minus the inner label element.
- Comment editor: it's **Quill**. The ~21 read-only `.ql-editor` have
  `contenteditable="false"`, so the only real editable is the comment one; the
  auxiliary `.ql-clipboard` are also excluded. The comment is inserted with a
  `paste` event (`text/html`) that Quill converts into its model (incl. `<ul>`).
- Student list: iterates the side-panel `li[role=menuitem]` (by `analytics-id`);
  each `li` is the clickable element.
- Student (import): matched by **legajo first** (disambiguates same-name
  students), then by name. Questions matched by content id, then visual number.

> **Auto-graded questions are excluded from the `.md`:** multiple choice /
> multiple answer (`[data-testid="multiple-answer-question-testing-id"]`) and
> true-false (`[data-testid="testing-id-for-true-false-question"]`) are detected
> and skipped, since Blackboard grades them automatically. Only manually-graded
> questions (essay, etc.) end up in the file. To keep a type, remove its check in
> `isAutoGraded`.

## Security / scope

- Runs only on `https://campus.itba.edu.ar/*` and acts only in the
  `/flexible-attempt-grading` view.
- Single permission: `downloads` (for the `.md`).
- No API requests; never touches "Publish grades".
