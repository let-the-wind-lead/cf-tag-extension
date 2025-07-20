// content.js
console.log("[content.js] loaded");

function extractHandle() {
  // 1) Try the ".rated-user" element
  const el = document.querySelector(".rated-user");
  if (el && el.textContent) {
    return el.textContent.trim();
  }
  // 2) Fallback: look at /profile/<handle> URL
  const m = location.pathname.match(/^\/profile\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

const handle = extractHandle();
if (!handle) {
  console.warn("[content.js] no handle found, giving up");
} else {
  // Expose it for cf.js to pick up
  window.__CF_HANDLE__ = handle;
  console.log("[content.js] handle →", handle);

  // Inject cf.js into the page context
  const s = document.createElement("script");
  s.src = chrome.runtime.getURL("cf.js");
  s.onload = () => s.remove();  // clean up
  document.body.appendChild(s);
}
