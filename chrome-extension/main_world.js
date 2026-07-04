// main_world.js — runs in the PAGE's MAIN world (not the isolated content-script
// world), so it can reach the Quill editor instance that Blackboard stores as an
// expando on the DOM node (`ed.__quill`). The isolated content script cannot see
// that property.
//
// Why this exists: inserting the comment via execCommand/paste from the isolated
// world puts the text on screen but Blackboard does NOT mark the field as edited
// (the "Guardar" button stays disabled), because that only happens on a genuine
// *user-sourced* change. Calling Quill's own API with source "user" emits the
// text-change event Blackboard listens to, which enables "Guardar" reliably —
// with no dependency on focus or browser user-activation. This uses the editor's
// public API only: no REST API, no React state setters.

(() => {
  // Locate the Quill instance for an editable editor inside a given region.
  function findQuill(regionId) {
    const region = regionId ? document.getElementById(regionId) : null;
    const scope = region || document;
    const editors = Array.from(
      scope.querySelectorAll('div.ql-editor[contenteditable="true"]')
    );
    for (const ed of editors) {
      const container = ed.closest(".ql-container");
      const q =
        ed.__quill ||
        (container && container.__quill) ||
        (window.Quill &&
          window.Quill.find &&
          (window.Quill.find(ed) || window.Quill.find(container)));
      if (q && typeof q.setContents === "function") return q;
    }
    return null;
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.type !== "BBTOOLS_SET_COMMENT") return;

    const { id, regionId, ops } = msg;
    let ok = false;
    let err = "";
    try {
      const quill = findQuill(regionId);
      if (!quill) throw new Error("no quill instance in region");

      // Build a Delta with the editor's own Delta constructor (version-safe),
      // then replace the whole content as a USER edit so Blackboard enables Save.
      const Delta = quill.constructor.import("delta");
      const delta = new Delta(Array.isArray(ops) ? ops : [{ insert: "\n" }]);
      quill.setContents(delta, "user");
      // Nudge any listeners that reconcile on the next update tick.
      if (typeof quill.update === "function") quill.update("user");
      ok = true;
    } catch (e) {
      err = (e && e.message) || String(e);
    }

    window.postMessage(
      { type: "BBTOOLS_SET_COMMENT_RESULT", id, ok, err },
      "*"
    );
  });
})();
