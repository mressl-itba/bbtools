// background.js — service worker (MV3)
// Sole job: receive the text from the content script and trigger the download
// via chrome.downloads (not available in content scripts). We use a data URL
// because in an MV3 service worker there is no URL.createObjectURL for blobs.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "BBTOOLS_DOWNLOAD") {
    const url =
      "data:text/markdown;charset=utf-8," + encodeURIComponent(msg.text || "");
    chrome.downloads.download(
      {
        url,
        filename: msg.filename || "exam.md",
        saveAs: true,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, downloadId });
        }
      }
    );
    return true; // async response
  }
});
