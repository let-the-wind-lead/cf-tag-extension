// Codeforces Tag Stats – Bubbles + Difficulty Graph + Snapshot/Caching
// ====================================================================
// NEW in this version:
// - Bubble view (one bubble per tag) with log sizing.
// - Toggle Table <-> Bubbles.
// - Click / multi-select bubbles (same intersection logic).
// - Difficulty graph (canvas) replaces table drill for bubble selections:
//   * Single tag: its difficulty buckets.
//   * Multi tags: intersection difficulty buckets.
// - Graph: up = solves (contest green + practice-only blue), down = failures red + untouched gray.
// - Existing features (snapshot caching, FailBand, sorting, refresh) retained.
//
// No external libs. Pure JS + SVG for bubbles + Canvas for difficulty chart.
//
// SCHEMA version stays at 2 (since we already bumped).

/* ---------------- CONFIG ---------------- */
const MAX_ROWS = 50;
const CACHE_TTL_HOURS = 6;
const SNAPSHOT_SCHEMA_VERSION = 2;

const RECOMMEND_WEIGHT_COVERAGE_GAP = 0.55;
const RECOMMEND_WEIGHT_NEXT_DIFF    = 0.30;
const RECOMMEND_WEIGHT_SOLVED       = 0.15;

const BUBBLE_PADDING = 4;
const BUBBLE_ITERATIONS = 500;
const BUBBLE_WIDTH = 1000;
const BUBBLE_HEIGHT = 600;

/* Graph constants */
const GRAPH_HEIGHT = 340;
const GRAPH_WIDTH  = 900;
const GRAPH_MARGIN = { top: 30, right: 40, bottom: 40, left: 50 };
const GRAPH_FONT   = "12px sans-serif";

/* Color helpers */
function coverageColor(c) {
  // c in [0,1]
  // simple 3-stop gradient: low red (#d54), mid amber (#f5b642), high green (#2e8b57)
  if (c <= 0.5) {
    // interpolate red (#d54) -> amber (#f5b642)
    const t = c / 0.5;
    return lerpColor("#d55454", "#f5b642", t);
  } else {
    const t = (c - 0.5) / 0.5;
    return lerpColor("#f5b642", "#2e8b57", t);
  }
}
function lerpColor(a, b, t) {
  const ca = hexToRgb(a), cb = hexToRgb(b);
  const r = Math.round(ca.r + (cb.r - ca.r)*t);
  const g = Math.round(ca.g + (cb.g - ca.g)*t);
  const b_ = Math.round(ca.b + (cb.b - ca.b)*t);
  return `rgb(${r},${g},${b_})`;
}
function hexToRgb(h) {
  h = h.replace("#","");
  if (h.length===3) h = h.split("").map(c=>c+c).join("");
  const n = parseInt(h,16);
  return { r:(n>>16)&255, g:(n>>8)&255, b:n&255 };
}

/* --------------- ENTRY ------------------ */
(function init() {
  if (!/^\/profile\/[^/?#]+$/.test(location.pathname)) return;
  if (document.getElementById("cf-tag-stats-block")) return;
  const handle = decodeURIComponent(location.pathname.split("/")[2]);
  boot(handle, false);
})();

/* --------------- BOOT / CACHE ------------ */
async function boot(handle, forceRefresh) {
  injectStyles();
  const anchor = document.querySelector(".info") || document.querySelector(".userbox");
  if (!anchor) return;

  const existing = document.getElementById("cf-tag-stats-block");
  if (!existing) {
    const placeholder = document.createElement("div");
    placeholder.id = "cf-tag-stats-block";
    placeholder.style.marginTop = "24px";
    placeholder.innerHTML = `<div style="font-size:13px;opacity:.7;">Loading Tag Stats...</div>`;
    anchor.parentNode.insertBefore(placeholder, anchor.nextSibling);
  }

  const cacheKey = "cfTagStats:" + handle;
  let snapshot = null;
  if (!forceRefresh) snapshot = loadSnapshot(cacheKey);

  if (snapshot) {
    console.log("[TagStats] Using cached snapshot");
    window.__CF_SNAPSHOT__ = snapshot;
    renderFromSnapshot(snapshot);
  } else {
    console.log("[TagStats] Fetching fresh data...");
    const fresh = await fetchAndBuildSnapshot(handle);
    if (fresh) {
      saveSnapshot(cacheKey, fresh);
      window.__CF_SNAPSHOT__ = fresh;
      renderFromSnapshot(fresh);
    } else {
      const blk = document.getElementById("cf-tag-stats-block");
      if (blk) blk.innerHTML = `<div style="color:#b00;">Failed to load Codeforces data.</div>`;
    }
  }
}

/* -------------- SNAPSHOT STORAGE ---------- */
function loadSnapshot(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) return null;
    const ageMs = Date.now() - new Date(obj.generatedAt).getTime();
    if (ageMs > CACHE_TTL_HOURS * 3600 * 1000) return null;
    return obj;
  } catch { return null; }
}
function saveSnapshot(key, snap) {
  try { localStorage.setItem(key, JSON.stringify(snap)); } catch {}
}

/* -------------- FETCH + BUILD ------------- */
async function fetchAndBuildSnapshot(handle) {
  try {
    const [subsData, psData] = await Promise.all([
      fetchJSON(`https://codeforces.com/api/user.status?handle=${handle}`),
      fetchJSON("https://codeforces.com/api/problemset.problems")
    ]);
    if (!subsData || !psData) return null;

    const submissions = subsData.result;
    const problemset  = psData.result;

    const agg = aggregate(submissions, problemset);
    computeRecommendationScores(agg.tagArray, agg.tagRatingsAll);
    computeFailedDifficultyBand(agg);
    const tagDifficultyBuckets = buildAllTagDifficultyBuckets(agg);

    const snapshot = buildSnapshot({
      handle,
      submissions,
      problemset,
      agg,
      tagDifficultyBuckets
    });

    // store tag->problem sets
    snapshot.tagProblemKeys = {};
    for (const [t,set] of agg.perTagProblemList.entries()) {
      snapshot.tagProblemKeys[t] = [...set];
    }
    return snapshot;
  } catch(e) {
    console.error("[TagStats] fetchAndBuildSnapshot error", e);
    return null;
  }
}

/* -------------- SNAPSHOT SCHEMA ----------- */
function buildSnapshot({ handle, submissions, problemset, agg, tagDifficultyBuckets }) {
  const {
    tagArray,
    perTagProblemList,
    perProblemMeta,
    solvedProblems,
    perProblemOrigin,
    perProblemStatus
  } = agg;

  const problems = {};
  for (const [key, meta] of perProblemMeta.entries()) {
    const status = perProblemStatus.get(key);
    const origin = perProblemOrigin.get(key);
    problems[key] = {
      rating: meta.rating,
      name: meta.name,
      tags: meta.tags,
      solved: !!status?.solved,
      contest: !!origin?.contest && !!status?.solved,
      practice: !!origin?.practice && !!status?.solved,
      failedContest: !!status?.failedContest && !status?.solved,
      failedPractice: !!status?.failedPractice && !status?.solved
    };
  }

  const tagsObj = {};
  for (const stat of tagArray) {
    const diffBuckets = tagDifficultyBuckets.get(stat.tag) || new Map();
    const bucketObj = {};
    for (const [diff, b] of diffBuckets.entries()) {
      bucketObj[diff] = {
        solvedContest: b.solvedContest,
        solvedPractice: b.solvedPractice,
        failedContest: b.failedContest,
        unsolved: b.unsolved,
        total: b.total
      };
    }
    tagsObj[stat.tag] = {
      totalAvailable: stat.totalAvailable,
      solved: stat.solved,
      solvedContest: stat.solvedContest,
      solvedPractice: stat.solvedPractice,
      solvePercent: stat.solvePercent,
      maxSolved: stat.maxSolved,
      nextTargetDifficulty: stat.nextTargetDifficulty ?? null,
      minFailedDifficulty: stat.minFailedDifficulty ?? null,
      maxFailedDifficulty: stat.maxFailedDifficulty ?? null,
      failSpan: stat.failSpan ?? null,
      recommendScore: stat.recommendScore,
      difficultyBuckets: bucketObj
    };
  }

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    handle,
    source: {
      userStatusCount: submissions.length,
      problemsetCount: problemset.problems.length
    },
    problems,
    tags: tagsObj,
    intermediate: { cacheTTLHours: CACHE_TTL_HOURS }
  };
}

/* -------------- AGGREGATION --------------- */
function aggregate(submissions, problemset) {
  const probIndex = new Map();
  const perProblemMeta = new Map();
  for (const p of problemset.problems) {
    const key = probKey(p);
    perProblemMeta.set(key, {
      tags: p.tags || [],
      rating: p.rating || null,
      name: p.name || (`${p.contestId || p.problemsetName || "PS"}-${p.index}`)
    });
    probIndex.set(key, true);
  }

  const solvedProblems = new Set();
  const perProblemOrigin  = new Map();
  const perProblemStatus  = new Map();
  const contestFailVerdicts = new Set([
    "WRONG_ANSWER","TIME_LIMIT_EXCEEDED","RUNTIME_ERROR","MEMORY_LIMIT_EXCEEDED",
    "IDLENESS_LIMIT_EXCEEDED","REJECTED","FAILED","PRESENTATION_ERROR","CHALLENGED",
    "PARTIAL","COMPILATION_ERROR","CRASHED","SKIPPED"
  ]);

  for (const sub of submissions) {
    const pr = sub.problem;
    if (!pr) continue;
    const key = probKey(pr);
    if (!probIndex.has(key)) continue;

    let origin = perProblemOrigin.get(key);
    if (!origin) { origin = { contest:false, practice:false }; perProblemOrigin.set(key, origin); }
    let status = perProblemStatus.get(key);
    if (!status) { status = { solved:false, failedContest:false, failedPractice:false }; perProblemStatus.set(key, status); }

    const isContest = !!sub.contestId;
    const verdict = sub.verdict;
    if (verdict === "OK") {
      status.solved = true;
      if (isContest) origin.contest = true; else origin.practice = true;
      solvedProblems.add(key);
    } else {
      if (!status.solved && contestFailVerdicts.has(verdict)) {
        if (isContest) status.failedContest = true;
        else status.failedPractice = true;
      }
    }
  }

  const tagStats = new Map();
  const tagRatingsAll = new Map();
  const perTagProblemList = new Map();

  function ensure(tag) {
    let s = tagStats.get(tag);
    if (!s) {
      s = {
        tag,
        solved: 0,
        solvedContest: 0,
        solvedPractice: 0,
        totalAvailable: 0,
        maxSolved: null,
        solvePercent: 0,
        nextTargetDifficulty: null,
        solvedDiffs: new Set(),
        recommendScore: 0,
        minFailedDifficulty: null,
        maxFailedDifficulty: null,
        failSpan: null
      };
      tagStats.set(tag, s);
    }
    return s;
  }

  for (const [key, meta] of perProblemMeta.entries()) {
    const { tags, rating } = meta;
    const status = perProblemStatus.get(key);
    const origin = perProblemOrigin.get(key);
    const isSolved = status?.solved;

    for (const t of tags) {
      const stat = ensure(t);
      stat.totalAvailable++;
      if (!perTagProblemList.has(t)) perTagProblemList.set(t, new Set());
      perTagProblemList.get(t).add(key);
      if (rating) {
        let set = tagRatingsAll.get(t);
        if (!set) { set = new Set(); tagRatingsAll.set(t, set); }
        set.add(rating);
      }
      if (isSolved) {
        stat.solved++;
        if (origin?.contest) stat.solvedContest++; else if (origin?.practice) stat.solvedPractice++;
        if (rating) {
          stat.solvedDiffs.add(rating);
          if (stat.maxSolved == null || rating > stat.maxSolved) stat.maxSolved = rating;
        }
      }
    }
  }

  for (const stat of tagStats.values()) {
    stat.solvePercent = stat.totalAvailable ? stat.solved / stat.totalAvailable : 0;
    if (stat.maxSolved != null) {
      const allR = tagRatingsAll.get(stat.tag);
      if (allR) {
        const ordered = [...allR].sort((a,b)=>a-b);
        for (const r of ordered) {
          if (r > stat.maxSolved) { stat.nextTargetDifficulty = r; break; }
        }
      }
    }
  }

  const tagArray = [...tagStats.values()].sort((a,b)=> b.solved - a.solved);

  return {
    tagArray,
    perTagProblemList,
    perProblemMeta,
    solvedProblems,
    perProblemOrigin,
    tagRatingsAll,
    perProblemStatus
  };
}

function computeFailedDifficultyBand(agg) {
  const { tagArray, perTagProblemList, perProblemMeta, perProblemStatus } = agg;
  for (const stat of tagArray) {
    const set = perTagProblemList.get(stat.tag);
    if (!set) continue;
    let minFail = null, maxFail = null;
    for (const key of set) {
      const meta = perProblemMeta.get(key);
      const status = perProblemStatus.get(key);
      if (!meta || !status) continue;
      if (!status.solved && status.failedContest && meta.rating) {
        if (minFail == null || meta.rating < minFail) minFail = meta.rating;
        if (maxFail == null || meta.rating > maxFail) maxFail = meta.rating;
      }
    }
    stat.minFailedDifficulty = minFail;
    stat.maxFailedDifficulty = maxFail;
    stat.failSpan = (minFail != null && maxFail != null) ? (maxFail - minFail) : null;
  }
}

function buildAllTagDifficultyBuckets(agg) {
  const map = new Map();
  const {
    tagArray,
    perTagProblemList,
    perProblemMeta,
    perProblemOrigin,
    perProblemStatus
  } = agg;

  for (const stat of tagArray) {
    const tag = stat.tag;
    const set = perTagProblemList.get(tag);
    if (!set) continue;
    const diffMap = new Map();
    for (const key of set) {
      const meta = perProblemMeta.get(key);
      if (!meta) continue;
      const rating = meta.rating || 0;
      let b = diffMap.get(rating);
      if (!b) {
        b = { solvedContest:0, solvedPractice:0, failedContest:0, unsolved:0, total:0 };
        diffMap.set(rating, b);
      }
      b.total++;
      const status = perProblemStatus.get(key);
      const origin = perProblemOrigin.get(key);
      if (status?.solved) {
        if (origin?.contest) b.solvedContest++; else b.solvedPractice++;
      } else {
        if (status?.failedContest) b.failedContest++; else b.unsolved++;
      }
    }
    map.set(tag, diffMap);
  }
  return map;
}

function probKey(p) {
  if (!p) return "PS-?";
  if (!p.contestId && !p.problemsetName) return `PS-${p.index}`;
  return `${p.contestId || p.problemsetName}-${p.index}`;
}

/* -------------- RECOMMENDATION ------------- */
function computeRecommendationScores(tags, tagRatingsAll) {
  if (!tags.length) return;
  const maxSolved = Math.max(...tags.map(t => t.solved), 1);
  const maxMaxDiff = Math.max(...tags.map(t => t.maxSolved || 0), 1);
  for (const t of tags) {
    const coverageGap = 1 - t.solvePercent;
    const diffDelta = t.nextTargetDifficulty != null
      ? (t.nextTargetDifficulty - (t.maxSolved || 0))
      : 500;
    const normNext = 1 / (1 + diffDelta / 300);
    const normSolved = t.solved / maxSolved;
    const normMax    = (t.maxSolved || 0) / maxMaxDiff;
    t.recommendScore =
      RECOMMEND_WEIGHT_COVERAGE_GAP * coverageGap +
      RECOMMEND_WEIGHT_NEXT_DIFF    * normNext +
      RECOMMEND_WEIGHT_SOLVED       * (0.5 * normSolved + 0.5 * normMax);
  }
}

/* -------------- RENDER FROM SNAPSHOT -------- */
function renderFromSnapshot(snapshot) {
  const perProblemMeta    = new Map();
  const perProblemOrigin  = new Map();
  const perProblemStatus  = new Map();
  const solvedProblems    = new Set();
  const perTagProblemList = new Map();
  const tagArray          = [];

  for (const [key, p] of Object.entries(snapshot.problems)) {
    perProblemMeta.set(key, { rating: p.rating, name: p.name, tags: p.tags });
    if (p.solved) solvedProblems.add(key);
    perProblemOrigin.set(key, { contest: p.contest, practice: p.practice });
    perProblemStatus.set(key, {
      solved: p.solved,
      failedContest: p.failedContest,
      failedPractice: p.failedPractice
    });
  }

  for (const [tag, tObj] of Object.entries(snapshot.tags)) {
    tagArray.push({
      tag,
      totalAvailable: tObj.totalAvailable,
      solved: tObj.solved,
      solvedContest: tObj.solvedContest,
      solvedPractice: tObj.solvedPractice,
      solvePercent: tObj.solvePercent,
      maxSolved: tObj.maxSolved,
      nextTargetDifficulty: tObj.nextTargetDifficulty,
      minFailedDifficulty: tObj.minFailedDifficulty,
      maxFailedDifficulty: tObj.maxFailedDifficulty,
      failSpan: tObj.failSpan,
      recommendScore: tObj.recommendScore
    });
  }
  if (snapshot.tagProblemKeys) {
    for (const [tag, arr] of Object.entries(snapshot.tagProblemKeys)) {
      perTagProblemList.set(tag, new Set(arr));
    }
  }

  const agg = {
    tagArray,
    perTagProblemList,
    perProblemMeta,
    perProblemOrigin,
    perProblemStatus,
    solvedProblems,
    tagRatingsAll: new Map()
  };

  const existing = document.getElementById("cf-tag-stats-block");
  if (existing) existing.remove();
  injectSection(agg, snapshot);
}

/* -------------- MAIN SECTION --------------- */
function injectSection(agg, snapshot) {
  const anchor = document.querySelector(".info") || document.querySelector(".userbox");
  if (!anchor) return;

  const block = document.createElement("div");
  block.id = "cf-tag-stats-block";
  block.style.marginTop = "24px";
  block.innerHTML = buildOverviewHTML(snapshot.generatedAt);
  anchor.parentNode.insertBefore(block, anchor.nextSibling);

  bindOverview(block, agg, snapshot);
  // default view: table
}

/* -------------- OVERVIEW HTML -------------- */
function buildOverviewHTML(generatedAt) {
  const timeString = new Date(generatedAt).toLocaleString();
  return `
    <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:6px;">
      <h3 style="margin:0; font-size:16px;">Tag Stats</h3>
      <div class="cf-tag-sort-group cf-table-controls">
        ${["solved","coverage","max","next","recommend","failmax","failspan"].map(m =>
          `<button class="cf-tag-sort-btn" data-sort="${m}">${labelForMode(m)}</button>`
        ).join("")}
      </div>
      <div style="font-size:12px; opacity:.7;">(<span id="cf-tag-current-mode">solved</span>)</div>
      <button id="cf-tag-refresh" class="cf-tag-refresh-btn" title="Force refetch">Refresh</button>
      <div style="font-size:11px; opacity:.55; margin-left:4px;">Cached: ${timeString}</div>

      <div style="margin-left:auto; display:flex; gap:4px;">
        <button id="cf-view-table" class="cf-view-toggle cf-active-view">Table</button>
        <button id="cf-view-bubbles" class="cf-view-toggle">Bubbles</button>
      </div>
    </div>

    <div id="cf-table-view">
      <div style="overflow-x:auto;">
        <table class="cf-tag-stats-table" style="border-collapse:collapse; width:100%; min-width:1000px;">
          <thead>${headerRow()}</thead>
          <tbody id="cf-tag-tbody"></tbody>
        </table>
      </div>
      <div id="cf-tag-drill-container" style="margin-top:18px;"></div>
    </div>

    <div id="cf-bubble-view" style="display:none;">
      <div id="cf-bubble-wrapper" style="position:relative; width:${BUBBLE_WIDTH}px; height:${BUBBLE_HEIGHT}px; border:1px solid #ccc; background:#fff; border-radius:6px; overflow:hidden;"></div>
      <div id="cf-bubble-legend" style="font-size:11px; opacity:.7; margin-top:6px;">
        Bubble size ∝ log(total problems). Color = coverage. Click to select; multiple = intersection.
      </div>
      <div id="cf-graph-container" style="margin-top:16px;"></div>
    </div>

    <div style="font-size:11px; margin-top:8px; line-height:1.35; opacity:.7;">
      FailBand = min–max unresolved contest fail difficulties. Bubble graph: up next for visual targeting.
    </div>
  `;
}

/* -------------- BIND LOGIC ---------------- */
function bindOverview(block, agg, snapshot) {
  // Table components
  const tbody = block.querySelector("#cf-tag-tbody");
  const modeLabel = block.querySelector("#cf-tag-current-mode");
  const drillContainer = block.querySelector("#cf-tag-drill-container");
  const refreshBtn = block.querySelector("#cf-tag-refresh");

  // Views
  const tableView = block.querySelector("#cf-table-view");
  const bubbleView = block.querySelector("#cf-bubble-view");
  const bubbleWrapper = block.querySelector("#cf-bubble-wrapper");
  const graphContainer = block.querySelector("#cf-graph-container");

  const handle = snapshot.handle;
  let currentSort = "solved";
  let currentRows = agg.tagArray.slice(0, MAX_ROWS);
  const selectedTags = new Set();

  /* Table rendering */
  function renderTable() {
    const sorted = sortTags(currentRows, currentSort);
    tbody.innerHTML = sorted.map(stat => {
      const selClass = selectedTags.has(stat.tag) ? "cf-selected-row" : "";
      return rowHTML(stat, selClass);
    }).join("");
    modeLabel.textContent = currentSort;
    block.querySelectorAll(".cf-tag-sort-btn").forEach(b =>
      b.classList.toggle("cf-active", b.dataset.sort === currentSort)
    );
    tbody.querySelectorAll("tr[data-tag]").forEach(tr => {
      tr.addEventListener("click", () => {
        const tag = tr.getAttribute("data-tag");
        if (selectedTags.has(tag)) selectedTags.delete(tag); else selectedTags.add(tag);
        renderTable();
        renderDrill();
        // reflect in bubble view if open
        syncBubbleSelection();
      });
    });
  }

  function renderDrill() {
    const size = selectedTags.size;
    if (size === 0) { drillContainer.innerHTML = ""; return; }
    if (size === 1) {
      const tag = [...selectedTags][0];
      const tagObj = snapshot.tags[tag];
      if (!tagObj) { drillContainer.innerHTML = ""; return; }
      const diffMap = rebuildDiffMapFromSnapshot(tagObj.difficultyBuckets);
      drillContainer.innerHTML = renderDiffTable({
        title: `Tag: ${escapeHTML(tag)}`,
        diffMap
      });
    } else {
      openDiffDrillIntersection([...selectedTags], agg, drillContainer, snapshot);
    }
  }

  /* Sorting buttons */
  block.querySelectorAll(".cf-tag-sort-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      currentSort = btn.dataset.sort;
      renderTable();
      renderDrill();
    });
  });

  /* Refresh */
  refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshing...";
    await boot(handle, true);
  });

  renderTable();

  /* View toggles */
  const btnTable = block.querySelector("#cf-view-table");
  const btnBubbles = block.querySelector("#cf-view-bubbles");
  btnTable.addEventListener("click", () => {
    btnTable.classList.add("cf-active-view");
    btnBubbles.classList.remove("cf-active-view");
    tableView.style.display = "";
    bubbleView.style.display = "none";
  });
  btnBubbles.addEventListener("click", () => {
    btnBubbles.classList.add("cf-active-view");
    btnTable.classList.remove("cf-active-view");
    tableView.style.display = "none";
    bubbleView.style.display = "";
    if (!bubbleWrapper.dataset.init) {
      initBubbleChart(bubbleWrapper, agg, snapshot, selectedTags, graphContainer, () => {
        // after selection change in bubble view sync table
        renderTable();
        renderDrill();
      });
      bubbleWrapper.dataset.init = "1";
    } else {
      drawDifficultyGraph(selectedTags, agg, snapshot, graphContainer);
      syncBubbleSelection();
    }
  });

  /* Bubble helpers sync */
  function syncBubbleSelection() {
    const nodes = bubbleWrapper.querySelectorAll(".cf-bubble");
    nodes.forEach(n => {
      const t = n.getAttribute("data-tag");
      if (selectedTags.has(t)) n.classList.add("cf-bubble-selected");
      else n.classList.remove("cf-bubble-selected");
    });
    drawDifficultyGraph(selectedTags, agg, snapshot, graphContainer);
  }
}

/* -------------- BUBBLE CHART --------------- */
function initBubbleChart(container, agg, snapshot, selectedTags, graphContainer, onSelectionChange) {
  const tags = agg.tagArray;
  if (!tags.length) return;

  // Build nodes
  const totals = tags.map(t => t.totalAvailable);
  const maxTotal = Math.max(...totals);
  const maxLog = Math.log(1 + maxTotal);
  const minR = 10;
  const maxR = 50;

  const nodes = tags.map(t => {
    const ln = Math.log(1 + t.totalAvailable);
    const r = minR + (maxR - minR) * (ln / maxLog);
    return {
      tag: t.tag,
      r,
      x: Math.random()* (BUBBLE_WIDTH - 2*r) + r,
      y: Math.random()* (BUBBLE_HEIGHT - 2*r) + r,
      coverage: t.solvePercent
    };
  });

  // Simple collision relaxation
  for (let iter=0; iter < BUBBLE_ITERATIONS; iter++) {
    for (let i=0;i<nodes.length;i++) {
      for (let j=i+1;j<nodes.length;j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx*dx + dy*dy) || 0.001;
        const minDist = a.r + b.r + BUBBLE_PADDING;
        if (dist < minDist) {
          const overlap = (minDist - dist)/2;
            dx /= dist; dy /= dist;
            a.x -= dx*overlap; a.y -= dy*overlap;
            b.x += dx*overlap; b.y += dy*overlap;
          // clamp to bounds
          [a,b].forEach(n=>{
            if (n.x < n.r) n.x = n.r;
            if (n.x > BUBBLE_WIDTH - n.r) n.x = BUBBLE_WIDTH - n.r;
            if (n.y < n.r) n.y = n.r;
            if (n.y > BUBBLE_HEIGHT - n.r) n.y = BUBBLE_HEIGHT - n.r;
          });
        }
      }
    }
  }

  // Render (SVG)
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", BUBBLE_WIDTH);
  svg.setAttribute("height", BUBBLE_HEIGHT);
  svg.style.display = "block";
  svg.style.fontFamily = "sans-serif";
  svg.style.fontSize = "11px";

  nodes.forEach(node => {
    const g = document.createElementNS(svgNS, "g");
    g.setAttribute("transform", `translate(${node.x},${node.y})`);
    g.classList.add("cf-bubble-group");

    const circle = document.createElementNS(svgNS, "circle");
    circle.setAttribute("r", node.r);
    circle.setAttribute("data-tag", node.tag);
    circle.classList.add("cf-bubble");
    circle.setAttribute("fill", coverageColor(node.coverage));
    circle.setAttribute("stroke", "#444");
    circle.setAttribute("stroke-width", "1");

    const text = document.createElementNS(svgNS, "text");
    text.setAttribute("text-anchor","middle");
    text.setAttribute("dy",".35em");
    text.setAttribute("pointer-events","none");
    text.textContent = node.tag.length > Math.max(3, Math.floor(node.r/4)) 
      ? node.tag.slice(0, Math.max(3, Math.floor(node.r/4)))+"…" 
      : node.tag;

    g.appendChild(circle);
    g.appendChild(text);
    svg.appendChild(g);

    circle.addEventListener("click", (e) => {
      const t = circle.getAttribute("data-tag");
      if (selectedTags.has(t)) selectedTags.delete(t); else selectedTags.add(t);
      if (selectedTags.has(t)) circle.classList.add("cf-bubble-selected");
      else circle.classList.remove("cf-bubble-selected");
      drawDifficultyGraph(selectedTags, agg, snapshot, graphContainer);
      onSelectionChange();
    });

    // Tooltip (simple title)
    const title = document.createElementNS(svgNS,"title");
    const tagStat = snapshot.tags[node.tag];
    const covPct = (tagStat.solvePercent*100).toFixed(1);
    title.textContent =
      `${node.tag}\nSolved ${tagStat.solved}/${tagStat.totalAvailable} (${covPct}%)\nMaxSolved: ${tagStat.maxSolved ?? "-"}\nFailBand: ${failBandCell(tagStat)}`;
    circle.appendChild(title);
  });

  container.appendChild(svg);

  // Initial graph (none selected)
  drawDifficultyGraph(selectedTags, agg, snapshot, graphContainer);
}

/* -------------- DIFFICULTY GRAPH ----------- */
function drawDifficultyGraph(selectedTags, agg, snapshot, container) {
  container.innerHTML = ""; // clear
  const size = selectedTags.size;
  if (size === 0) {
    container.innerHTML = `<div style="font-size:12px; opacity:.6;">Select a bubble to see difficulty breakdown.</div>`;
    return;
  }

  // Build diff buckets
  let diffMap;
  if (size === 1) {
    const tag = [...selectedTags][0];
    const tagObj = snapshot.tags[tag];
    if (!tagObj) return;
    diffMap = rebuildDiffMapFromSnapshot(tagObj.difficultyBuckets);
  } else {
    diffMap = buildIntersectionBuckets([...selectedTags], agg);
  }

  const ordered = [...diffMap.entries()].sort((a,b)=> (a[0]-b[0]));
  if (!ordered.length) {
    container.innerHTML = `<div style="font-size:12px; opacity:.6;">No intersection problems.</div>`;
    return;
  }

  // Data extents
  let maxPos = 0, maxNeg = 0;
  for (const [_,b] of ordered) {
    const pos = b.solvedContest + b.solvedPractice;
    const neg = b.failedContest + b.unsolved;
    if (pos > maxPos) maxPos = pos;
    if (neg > maxNeg) maxNeg = neg;
  }
  if (maxPos === 0) maxPos = 1;
  if (maxNeg === 0) maxNeg = 1;

  const canvas = document.createElement("canvas");
  canvas.width = GRAPH_WIDTH;
  canvas.height = GRAPH_HEIGHT;
  canvas.style.border = "1px solid #ccc";
  canvas.style.background = "#fff";
  container.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  ctx.font = GRAPH_FONT;
  ctx.textBaseline = "middle";

  const innerW = GRAPH_WIDTH - GRAPH_MARGIN.left - GRAPH_MARGIN.right;
  const innerH = GRAPH_HEIGHT - GRAPH_MARGIN.top - GRAPH_MARGIN.bottom;
  const zeroY = GRAPH_MARGIN.top + innerH/2;

  // Determine difficulty values for scale
  const diffs = ordered.map(d => d[0]);
  const minDiff = Math.min(...diffs);
  const maxDiff = Math.max(...diffs);
  const diffSpan = maxDiff - minDiff || 1;

  function xScale(d) {
    return GRAPH_MARGIN.left + ( (d - minDiff) / diffSpan ) * innerW;
  }
  function yPosValue(v) { // positive solves
    return zeroY - (v / maxPos) * (innerH/2 - 10);
  }
  function yNegValue(v) { // negative (fail+unsolved)
    return zeroY + (v / maxNeg) * (innerH/2 - 10);
  }

  // Axes lines
  ctx.strokeStyle="#333";
  ctx.lineWidth=1;
  ctx.beginPath();
  ctx.moveTo(GRAPH_MARGIN.left, zeroY);
  ctx.lineTo(GRAPH_WIDTH - GRAPH_MARGIN.right, zeroY);
  ctx.stroke();

  // Y axis (center vertical)
  ctx.beginPath();
  ctx.moveTo(GRAPH_MARGIN.left, GRAPH_MARGIN.top);
  ctx.lineTo(GRAPH_MARGIN.left, GRAPH_HEIGHT - GRAPH_MARGIN.bottom);
  ctx.stroke();

  // Y ticks (positive & negative)
  ctx.fillStyle="#333";
  const yTicksPos = 3;
  for (let i=1;i<=yTicksPos;i++){
    const val = Math.round(maxPos * i / yTicksPos);
    const y = yPosValue(val);
    ctx.strokeStyle="#ddd"; ctx.beginPath(); ctx.moveTo(GRAPH_MARGIN.left, y); ctx.lineTo(GRAPH_WIDTH-GRAPH_MARGIN.right, y); ctx.stroke();
    ctx.fillStyle="#333"; ctx.fillText(val, GRAPH_MARGIN.left - 30, y);
  }
  const yTicksNeg = 3;
  for (let i=1;i<=yTicksNeg;i++){
    const val = Math.round(maxNeg * i / yTicksNeg);
    const y = yNegValue(val);
    ctx.strokeStyle="#eee"; ctx.beginPath(); ctx.moveTo(GRAPH_MARGIN.left, y); ctx.lineTo(GRAPH_WIDTH-GRAPH_MARGIN.right, y); ctx.stroke();
    ctx.fillStyle="#333"; ctx.fillText(val, GRAPH_MARGIN.left - 30, y);
  }

  // X ticks
  ctx.textBaseline = "top";
  const xTickCount = Math.min(8, diffs.length);
  for (let i=0;i<xTickCount;i++) {
    const idx = Math.round( (diffs.length - 1) * i / (xTickCount - 1) );
    const d = diffs[idx];
    const x = xScale(d);
    ctx.strokeStyle="#ddd"; ctx.beginPath(); ctx.moveTo(x, GRAPH_MARGIN.top); ctx.lineTo(x, GRAPH_HEIGHT - GRAPH_MARGIN.bottom); ctx.stroke();
    ctx.fillStyle="#333"; ctx.fillText(d, x-10, GRAPH_HEIGHT - GRAPH_MARGIN.bottom + 2);
  }

  // Bars
  const barHalf = Math.max(2, Math.min(12, innerW / (diffs.length*3)));
  for (const [d, b] of ordered) {
    const x = xScale(d);
    const solvedC = b.solvedContest;
    const solvedP = b.solvedPractice;
    const fails   = b.failedContest;
    const uns     = b.unsolved;

    // Upwards: contest (green) then practice (blue) stacked
    let currentY = zeroY;
    if (solvedC > 0) {
      const yTop = yPosValue(solvedC);
      ctx.fillStyle="#2e8b57";
      ctx.fillRect(x - barHalf, yTop, barHalf*2, currentY - yTop);
      currentY = yTop;
    }
    if (solvedP > 0) {
      const yTop = yPosValue(solvedC + solvedP);
      ctx.fillStyle="#1976d2";
      ctx.fillRect(x - barHalf, yTop, barHalf*2, currentY - yTop);
    }

    // Downwards: failed (red) then unsolved (gray)
    let currentNegY = zeroY;
    if (fails > 0) {
      const yBottom = yNegValue(fails);
      ctx.fillStyle="#b00";
      ctx.fillRect(x - barHalf, currentNegY, barHalf*2, yBottom - currentNegY);
      currentNegY = yBottom;
    }
    if (uns > 0) {
      const yBottom = yNegValue(fails + uns);
      ctx.fillStyle="#bbb";
      ctx.fillRect(x - barHalf, currentNegY, barHalf*2, yBottom - currentNegY);
    }
  }

  // Title
  ctx.fillStyle="#111";
  ctx.textBaseline="alphabetic";
  ctx.font="14px sans-serif";
  if (size === 1) {
    const tag = [...selectedTags][0];
    ctx.fillText(`Difficulty Distribution: ${tag}`, GRAPH_MARGIN.left, GRAPH_MARGIN.top - 10);
  } else {
    ctx.fillText(`Difficulty Distribution (Intersection of ${size} tags)`, GRAPH_MARGIN.left, GRAPH_MARGIN.top - 10);
  }

  // Legend
  const legend = [
    ["#2e8b57","Contest Solved"],
    ["#1976d2","Practice-only Solved"],
    ["#b00","Failed (Contest, unsolved)"],
    ["#bbb","Remaining Unsolved"]
  ];
  let lx = GRAPH_WIDTH - GRAPH_MARGIN.right - 160;
  let ly = GRAPH_MARGIN.top + 4;
  ctx.font="11px sans-serif";
  for (const [color,label] of legend) {
    ctx.fillStyle=color;
    ctx.fillRect(lx, ly, 12,12);
    ctx.fillStyle="#222";
    ctx.fillText(label, lx+16, ly+10);
    ly += 16;
  }
}

function buildIntersectionBuckets(tags, agg) {
  const { perTagProblemList, perProblemMeta, perProblemOrigin, perProblemStatus } = agg;
  let inter = null;
  for (const t of tags) {
    const set = perTagProblemList.get(t);
    if (!set) { inter = new Set(); break; }
    if (inter == null) inter = new Set(set);
    else for (const val of [...inter]) if (!set.has(val)) inter.delete(val);
    if (inter.size === 0) break;
  }
  const diffMap = new Map();
  if (!inter || inter.size === 0) return diffMap;
  for (const key of inter) {
    const meta = perProblemMeta.get(key);
    if (!meta) continue;
    const rating = meta.rating || 0;
    let b = diffMap.get(rating);
    if (!b) {
      b = { solvedContest:0, solvedPractice:0, failedContest:0, unsolved:0, total:0 };
      diffMap.set(rating, b);
    }
    b.total++;
    const status = perProblemStatus.get(key);
    const origin = perProblemOrigin.get(key);
    if (status?.solved) {
      if (origin?.contest) b.solvedContest++; else b.solvedPractice++;
    } else {
      if (status?.failedContest) b.failedContest++; else b.unsolved++;
    }
  }
  return diffMap;
}

/* -------------- DRILL TABLE (TABLE VIEW) --- */
function openDiffDrillIntersection(tags, agg, container, snapshot) {
  const diffMap = buildIntersectionBuckets(tags, agg);
  if (diffMap.size === 0) {
    container.innerHTML = `<div class="cf-drill"><h4 style="margin:0;">Intersection (${tags.length}): ${tags.map(escapeHTML).join(", ")}</h4><div style="font-size:12px;margin-top:6px;">No common problems.</div></div>`;
    return;
  }
  container.innerHTML = renderDiffTable({
    title: `Intersection (${tags.length}): ${tags.map(escapeHTML).join(", ")} (Problems: ??)`,
    diffMap
  });
}

function rebuildDiffMapFromSnapshot(bucketsObj) {
  const diffMap = new Map();
  for (const [diff, b] of Object.entries(bucketsObj)) {
    diffMap.set(diff === "0" ? 0 : parseInt(diff,10), {
      solvedContest: b.solvedContest,
      solvedPractice: b.solvedPractice,
      failedContest: b.failedContest,
      unsolved: b.unsolved,
      total: b.total
    });
  }
  return diffMap;
}

function renderDiffTable({ title, diffMap }) {
  const ordered = [...diffMap.entries()].sort((a,b)=> (a[0]-b[0]));
  const maxSolved = Math.max(...ordered.map(([_,b]) => b.solvedContest + b.solvedPractice), 1);
  const rows = ordered.map(([rating, b]) => {
    const solved = b.solvedContest + b.solvedPractice;
    const width = Math.round((solved / maxSolved) * 180);
    const contestWidth  = solved ? Math.round(width * (b.solvedContest / solved)) : 0;
    const practiceWidth = width - contestWidth;
    const barHTML = solved ? `
      <div style="display:inline-block;height:10px;background:#2e8b57;width:${contestWidth}px;"></div>
      <div style="display:inline-block;height:10px;background:#1976d2;width:${practiceWidth}px;"></div>
    ` : "";
    return `
      <tr>
        <td class="cf-td">${rating || "-"}</td>
        <td class="cf-td num">${solved}</td>
        <td class="cf-td num">${b.failedContest}</td>
        <td class="cf-td num">${b.unsolved}</td>
        <td class="cf-td num">${b.total}</td>
        <td class="cf-td">
          ${barHTML}
          ${b.solvedContest ? `<span class="cf-mini">C${b.solvedContest}</span>`:""}
          ${b.solvedPractice ? `<span class="cf-mini">P${b.solvedPractice}</span>`:""}
          ${b.failedContest ? `<span class="cf-mini" style="color:#b00;">F${b.failedContest}</span>`:""}
        </td>
      </tr>
    `;
  }).join("");
  return `
    <div class="cf-drill">
      <div class="cf-drill-head"><h4 style="margin:0;">${title}</h4></div>
      <table class="cf-drill-table">
        <thead>
          <tr>
            <th>Difficulty</th><th>Solved</th><th>Failed(C)</th><th>Unsolved</th><th>Total</th><th>Bar (C vs P)</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="cf-foot-note">
        Green = contest solves, Blue = practice-only solves. Failed(C) = unsolved with ≥1 non-OK contest submission.
      </div>
    </div>
  `;
}

/* -------------- TABLE / SORT --------------- */
function headerRow() {
  const cols = [
    ["Tag","left"],
    ["Solved","right"],
    ["Total","right"],
    ["Cov%","right"],
    ["Contest","right"],
    ["Practice","right"],
    ["Max","right"],
    ["FailBand","right"],
    ["Next","right"]
  ];
  return `<tr>${cols.map(([h,a]) =>
    `<th style="border:1px solid #ddd;padding:4px 6px;text-align:${a};background:#f2f2f2;">${h}</th>`
  ).join("")}</tr>`;
}
function rowHTML(stat, selClass) {
  const cov = stat.solvePercent * 100;
  return `
    <tr data-tag="${escapeHTML(stat.tag)}" class="cf-tag-row ${selClass}">
      <td class="cf-td">${escapeHTML(stat.tag)}</td>
      <td class="cf-td num">${stat.solved}</td>
      <td class="cf-td num">${formatCount(stat.totalAvailable)}</td>
      <td class="cf-td num">${cov.toFixed(cov >= 10 ? 1 : 2)}</td>
      <td class="cf-td num">${stat.solvedContest}</td>
      <td class="cf-td num">${stat.solvedPractice}</td>
      <td class="cf-td num">${stat.maxSolved ?? "-"}</td>
      <td class="cf-td num">${failBandCell(stat)}</td>
      <td class="cf-td num">${stat.nextTargetDifficulty ?? "-"}</td>
    </tr>
  `;
}
function failBandCell(stat) {
  const a = stat.minFailedDifficulty, b = stat.maxFailedDifficulty;
  if (a == null || b == null) return "-";
  if (a === b) return String(a);
  return a + "–" + b;
}
function sortTags(arr, mode) {
  if (mode === "coverage")
    return [...arr].sort((a,b)=> b.solvePercent - a.solvePercent || b.solved - a.solved);
  if (mode === "max")
    return [...arr].sort((a,b)=> (b.maxSolved||0) - (a.maxSolved||0) || b.solved - a.solved);
  if (mode === "next")
    return [...arr].sort((a,b)=>{
      const an = a.nextTargetDifficulty ?? Infinity;
      const bn = b.nextTargetDifficulty ?? Infinity;
      if (an !== bn) return an - bn;
      return b.solved - a.solved;
    });
  if (mode === "recommend")
    return [...arr].sort((a,b)=> b.recommendScore - a.recommendScore || b.solved - a.solved);
  if (mode === "failmax")
    return [...arr].sort((a,b)=> (b.maxFailedDifficulty||0) - (a.maxFailedDifficulty||0) || (b.failSpan||0) - (a.failSpan||0));
  if (mode === "failspan")
    return [...arr].sort((a,b)=> (b.failSpan||-1) - (a.failSpan||-1) || (b.maxFailedDifficulty||0) - (a.maxFailedDifficulty||0));
  return [...arr].sort((a,b)=> b.solved - a.solved);
}
function labelForMode(m) {
  switch(m) {
    case "solved": return "Solved";
    case "coverage": return "Coverage%";
    case "max": return "MaxDiff";
    case "next": return "Next";
    case "recommend": return "Recommend";
    case "failmax": return "FailMax";
    case "failspan": return "FailSpan";
    default: return m;
  }
}

/* -------------- FETCH UTILS ---------------- */
async function fetchJSON(url) {
  const r = await fetch(url);
  const j = await r.json();
  if (j.status !== "OK") {
    console.warn("[TagStats] API error", url, j);
    return null;
  }
  return j;
}

/* -------------- UTIL / STYLES -------------- */
function formatCount(n) {
  if (n >= 1000) {
    const k = n / 1000;
    return k >= 10 ? Math.round(k) + "k" : k.toFixed(1) + "k";
  }
  return String(n);
}
function escapeHTML(s) {
  return s.replace(/[<>&"]/g, c => ({ "<":"&lt;","&":"&amp;",">":"&gt;","&":"&amp;","\"":"&quot;" }[c] || c));
}

function injectStyles() {
  if (document.getElementById("cf-tag-stats-style")) return;
  const st = document.createElement("style");
  st.id = "cf-tag-stats-style";
  st.textContent = `
    .cf-tag-sort-btn, .cf-tag-refresh-btn, .cf-view-toggle {
      background:#fafafa;
      border:1px solid #bbb;
      padding:3px 8px;
      font-size:12px;
      cursor:pointer;
      border-radius:4px;
      font-family:inherit;
    }
    .cf-view-toggle { font-weight:600; }
    .cf-active-view { background:#dce9f9; border-color:#88a; }
    .cf-tag-sort-btn.cf-active { background:#e0e0e0; font-weight:600; border-color:#888; }
    .cf-tag-sort-btn:hover, .cf-tag-refresh-btn:hover, .cf-view-toggle:hover { background:#e9e9e9; }
    .cf-tag-stats-table tbody tr.cf-tag-row:hover { background:#f5f5f5; }
    .cf-td { border:1px solid #ddd; padding:4px 6px; }
    .cf-td.num { text-align:right; }
    .cf-selected-row { background:#d9ecff !important; }
    .cf-drill {
      border:1px solid #ccc; padding:10px 12px; border-radius:4px; background:#fafafa;
    }
    .cf-drill-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
    .cf-drill-table { border-collapse:collapse; width:100%; font-size:13px; }
    .cf-drill-table th, .cf-drill-table td { border:1px solid #ddd; padding:4px 6px; }
    .cf-mini { font-size:10px; margin-left:4px; }
    .cf-foot-note { font-size:11px; opacity:.7; margin-top:6px; line-height:1.3; }
    .cf-tag-row { cursor:pointer; }

    /* Bubbles */
    .cf-bubble { transition: stroke-width .15s, transform .15s; }
    .cf-bubble-selected { stroke:#222 !important; stroke-width:3 !important; filter:drop-shadow(0 0 4px rgba(0,0,0,0.35)); }
    .cf-bubble-group:hover .cf-bubble:not(.cf-bubble-selected) { stroke-width:2; }
  `;
  document.head.appendChild(st);
}
