const form = document.querySelector("#search-form");
const keywordInput = document.querySelector("#keyword");
const resultList = document.querySelector("#result-list");
const statusNode = document.querySelector("#status");
const suggestionList = document.querySelector("#suggestion-list");
const resultCountBadge = document.querySelector("#result-count-badge");
const detailModal = document.querySelector("#detail-modal");
const detailContent = document.querySelector("#detail-content");
const detailTitleNode = document.querySelector("#detail-title");
const detailCloseButton = document.querySelector("#detail-close");
const exportsModal = document.querySelector("#exports-modal");
const exportsContent = document.querySelector("#exports-content");
const exportsButton = document.querySelector("#exports-button");
const exportsBadge = document.querySelector("#exports-badge");
const exportsCloseButton = document.querySelector("#exports-close");
const authOverlay = document.querySelector("#auth-overlay");
const authForm = document.querySelector("#auth-form");
const accessKeyInput = document.querySelector("#access-key");
const authErrorNode = document.querySelector("#auth-error");
const authBar = document.querySelector("#auth-bar");
const authStateNode = document.querySelector("#auth-state");
const logoutButton = document.querySelector("#logout-button");

const downloadStates = new Map();
const downloadTasks = new Map();

let currentResults = [];
let authEnabled = false;
let authorized = true;

function setStatus(message) {
  statusNode.textContent = message;
}

function setAuthUi(nextAuthorized) {
  authorized = nextAuthorized;
  authStateNode.textContent = nextAuthorized ? "已登录" : "未登录";
  authBar.classList.toggle("hidden", !authEnabled);
  authOverlay.classList.toggle("hidden", !authEnabled || nextAuthorized);
  authOverlay.setAttribute("aria-hidden", authEnabled && !nextAuthorized ? "false" : "true");
  if (!nextAuthorized) {
    setResultCount(0);
    resultList.innerHTML = '<li class="empty">请先输入访问密钥。</li>';
  }
}

function setResultCount(count) {
  resultCountBadge.textContent = String(count);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[char] || char;
  });
}

function sanitizeName(value) {
  return String(value || "drama")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function joinValues(values) {
  if (!Array.isArray(values) || !values.length) {
    return "暂无";
  }
  return values.filter(Boolean).join(" / ");
}

function normalizeClarityLabel(key) {
  const map = {
    super: "超清",
    high: "高清",
    normal: "流畅",
    low: "低清",
  };
  return map[key] || key;
}

function buildDownloadUrl(remoteUrl, filename) {
  const params = new URLSearchParams({
    url: remoteUrl,
    filename,
  });
  return `/api/download?${params.toString()}`;
}

function saveBlob(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function parsePlaySetting(playSetting) {
  if (!playSetting) {
    return [];
  }
  let parsed = playSetting;
  if (typeof playSetting === "string") {
    try {
      parsed = JSON.parse(playSetting);
    } catch (error) {
      return [];
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  return Object.entries(parsed)
    .filter(([, url]) => typeof url === "string" && url.startsWith("http"))
    .map(([key, url]) => ({ key, label: normalizeClarityLabel(key), url }));
}

function isFreeEpisode(episode) {
  return episode?.payStatus === 0 || episode?.freeUnlock === true;
}

function pickPreferredClarity(clarities) {
  if (!clarities.length) {
    return null;
  }
  const fallbackOrder = ["super", "high", "normal", "low"];
  for (const key of fallbackOrder) {
    const match = clarities.find((item) => item.key === key);
    if (match) {
      return match;
    }
  }
  return clarities[0];
}

function getFreeEpisodes(payload) {
  const episodes = Array.isArray(payload?.data) ? payload.data : [];
  return episodes
    .map((episode) => ({
      episode,
      clarity: pickPreferredClarity(parsePlaySetting(episode.playSetting)),
    }))
    .filter(({ episode, clarity }) => isFreeEpisode(episode) && clarity);
}

function buildEpisodeFilename(title, playOrder, clarityKey) {
  const safeTitle = sanitizeName(title);
  return `${safeTitle}_EP${String(playOrder ?? "0").padStart(2, "0")}_${clarityKey}.mp4`;
}

function pickPoster(item) {
  return (
    item?.vertPoster ||
    item?.poster ||
    item?.coverUrl ||
    item?.cover ||
    item?.horiPoster ||
    item?.imageUrl ||
    ""
  );
}

function summarizeItem(item) {
  const parts = [
    item?.channelName ? `${item.channelName}` : "未知渠道",
    item?.episodeCount != null ? `${item.episodeCount} 集` : "集数未知",
  ];
  if (item?.publishedYear) {
    parts.push(String(item.publishedYear));
  }
  return parts.join(" · ");
}

function ensureDownloadTask(item) {
  const oneId = String(item?.oneId || "");
  if (!oneId) {
    return null;
  }
  const existing = downloadTasks.get(oneId) || {};
  const nextTask = {
    oneId,
    title: item?.title || existing.title || "未命名短剧",
    channelName: item?.channelName || existing.channelName || "未知渠道",
    episodeCount: item?.episodeCount ?? existing.episodeCount ?? "未知",
    publishedYear: item?.publishedYear || existing.publishedYear || "",
    poster: pickPoster(item) || existing.poster || "",
  };
  downloadTasks.set(oneId, nextTask);
  return nextTask;
}

function getDownloadState(oneId) {
  return (
    downloadStates.get(oneId) || {
      phase: "idle",
      completed: 0,
      total: 0,
      note: "等待打包",
    }
  );
}

function setDownloadState(oneId, nextState) {
  const merged = {
    ...getDownloadState(oneId),
    ...nextState,
  };
  downloadStates.set(oneId, merged);
  renderExportsPanel();
  renderResults(currentResults);
}

function clearDownloadStates() {
  downloadStates.clear();
  downloadTasks.clear();
  renderExportsPanel();
}

function getProgressPercent(state) {
  if (!state.total) {
    return state.phase === "done" ? 100 : 0;
  }
  return Math.max(0, Math.min(100, Math.round((state.completed / state.total) * 100)));
}

function getProgressDashoffset(percent) {
  const circumference = 2 * Math.PI * 16;
  return circumference - (circumference * percent) / 100;
}

function renderProgressRing(oneId) {
  const state = getDownloadState(oneId);
  const percent = getProgressPercent(state);
  const completedText = state.total ? `${state.completed}/${state.total}` : "0/0";
  const dashoffset = getProgressDashoffset(percent);
  return `
    <div class="progress-ring" aria-label="ZIP 打包进度">
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <circle class="progress-track" cx="20" cy="20" r="16"></circle>
        <circle
          class="progress-value"
          cx="20"
          cy="20"
          r="16"
          stroke-dasharray="${(2 * Math.PI * 16).toFixed(2)}"
          stroke-dashoffset="${dashoffset.toFixed(2)}"
        ></circle>
      </svg>
      <div class="progress-core">
        <strong>${completedText}</strong>
        <span>${percent}%</span>
      </div>
    </div>
  `;
}

function getActiveExportCount() {
  let count = 0;
  for (const state of downloadStates.values()) {
    if (state.phase !== "idle") {
      count += 1;
    }
  }
  return count;
}

function renderExportsPanel() {
  const tasks = Array.from(downloadTasks.values())
    .filter((item) => downloadStates.has(item.oneId))
    .map((item) => ({
      item,
      state: getDownloadState(item.oneId),
    }))
    .sort((left, right) => {
      const leftDone = left.state.phase === "done" ? 1 : 0;
      const rightDone = right.state.phase === "done" ? 1 : 0;
      return leftDone - rightDone;
    });

  exportsBadge.textContent = String(getActiveExportCount());

  if (!tasks.length) {
    exportsContent.innerHTML = '<div class="empty">当前还没有导出任务。</div>';
    return;
  }

  exportsContent.innerHTML = `
    <div class="exports-list">
      ${tasks
        .map(({ item, state }) => {
          const summary = summarizeItem(item);
          return `
            <article class="export-task">
              <div>
                <h3>${escapeHtml(item.title || "未命名短剧")}</h3>
                <p class="export-meta">${escapeHtml(summary)}</p>
                <p class="export-status">${escapeHtml(state.note || "等待打包")}</p>
              </div>
              ${renderProgressRing(item.oneId)}
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderResults(items) {
  currentResults = Array.isArray(items) ? items : [];
  resultList.innerHTML = "";

  if (!currentResults.length) {
    setResultCount(0);
    resultList.innerHTML = '<li class="empty">没有匹配结果。</li>';
    return;
  }

  setResultCount(currentResults.length);

  currentResults.forEach((item) => {
    ensureDownloadTask(item);
    const state = getDownloadState(item.oneId);
    const li = document.createElement("li");
    li.className = "result-row";
    li.dataset.oneId = item.oneId || "";

    const poster = pickPoster(item);
    const isBusy = state.phase === "preparing" || state.phase === "packing" || state.phase === "zipping";

    li.innerHTML = `
      <div>
        ${
          poster
            ? `<img class="poster-thumb" src="${escapeHtml(poster)}" alt="${escapeHtml(item.title || "海报")}" />`
            : `<div class="poster-fallback">海报<br />缺失</div>`
        }
      </div>
      <div class="result-main">
        <div class="result-title">${escapeHtml(item.title || "未命名短剧")}</div>
        <p class="result-summary">${escapeHtml(summarizeItem(item))}</p>
        <p class="result-id">oneId：${escapeHtml(item.oneId || "")}</p>
      </div>
      <div class="result-actions">
        <div class="action-stack">
          <button class="action-button" type="button" data-action="detail" data-oneid="${escapeHtml(item.oneId || "")}">
            查看详情
          </button>
          <button class="zip-button" type="button" data-action="zip" data-oneid="${escapeHtml(item.oneId || "")}" ${isBusy ? "disabled" : ""}>
            一键打包下载
          </button>
          <p class="progress-note">${escapeHtml(state.note || "等待打包")}</p>
        </div>
        ${renderProgressRing(item.oneId)}
      </div>
    `;

    resultList.appendChild(li);
  });
}

function renderSuggestions(items) {
  suggestionList.innerHTML = "";
  items.slice(0, 12).forEach((keyword) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion-chip";
    button.textContent = keyword;
    button.addEventListener("click", async () => {
      keywordInput.value = keyword;
      await search(keyword);
    });
    suggestionList.appendChild(button);
  });
}

async function proxyJson(url, init = {}) {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (response.status === 401 || payload.code === 401) {
    setAuthUi(false);
    throw new Error("请先登录");
  }
  if (!response.ok || payload.code !== 200) {
    throw new Error(payload.msg || `HTTP ${response.status}`);
  }
  return payload;
}

async function fetchEpisodeBlob(url, filename) {
  const response = await fetch(buildDownloadUrl(url, filename));
  if (!response.ok) {
    if (response.status === 401) {
      setAuthUi(false);
      throw new Error("请先登录");
    }
    const message = await response.text().catch(() => "");
    throw new Error(message || `HTTP ${response.status}`);
  }
  return response.blob();
}

async function loadAuthStatus() {
  const response = await fetch("/api/auth/status");
  const payload = await response.json();
  authEnabled = Boolean(payload?.data?.authEnabled);
  setAuthUi(Boolean(payload?.data?.authorized));
}

async function performLogin(key) {
  const payload = await proxyJson("/api/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ key }),
  });
  authEnabled = Boolean(payload?.data?.authEnabled);
  authErrorNode.textContent = "";
  accessKeyInput.value = "";
  setAuthUi(true);
  await loadSuggestions();
  await search(keywordInput.value.trim());
}

async function performLogout() {
  try {
    await proxyJson("/api/auth/logout", {
      method: "POST",
    });
  } catch (error) {
    console.error("logout failed", error);
  }
  clearDownloadStates();
  currentResults = [];
  authErrorNode.textContent = "";
  setAuthUi(false);
  setStatus("已退出，需要重新输入访问密钥。");
}

function openDetailModal() {
  detailModal.classList.remove("hidden");
  detailModal.setAttribute("aria-hidden", "false");
}

function closeDetailModal() {
  detailModal.classList.add("hidden");
  detailModal.setAttribute("aria-hidden", "true");
}

function openExportsModal() {
  renderExportsPanel();
  exportsModal.classList.remove("hidden");
  exportsModal.setAttribute("aria-hidden", "false");
}

function closeExportsModal() {
  exportsModal.classList.add("hidden");
  exportsModal.setAttribute("aria-hidden", "true");
}

function renderDetailModal(detail, episodePayload) {
  const tags = [
    ...(Array.isArray(detail?.contentTags) ? detail.contentTags : []),
    ...(Array.isArray(detail?.subjectTags) ? detail.subjectTags : []),
  ];
  const poster = pickPoster(detail);
  const freeEpisodes = getFreeEpisodes(episodePayload);
  detailTitleNode.textContent = detail?.title || "详情信息";
  detailContent.innerHTML = `
    <div class="detail-layout">
      <div>
        ${
          poster
            ? `<img class="detail-poster" src="${escapeHtml(poster)}" alt="${escapeHtml(detail?.title || "详情海报")}" />`
            : `<div class="poster-fallback">海报<br />缺失</div>`
        }
      </div>
      <div class="detail-main">
        <h3>${escapeHtml(detail?.title || "未命名短剧")}</h3>
        <p class="detail-meta">
          ${escapeHtml(detail?.cpName || "未知渠道")} ·
          ${escapeHtml(String(detail?.episodeCount ?? "未知"))} 集 ·
          ${escapeHtml(String(detail?.playLength ?? "未知"))} 秒
        </p>
        <p class="detail-copy">${escapeHtml(detail?.description || "暂无简介")}</p>

        <div class="detail-grid">
          <div class="detail-card">
            <p class="detail-meta-label">免费分集</p>
            <strong>${escapeHtml(String(freeEpisodes.length))}</strong>
          </div>
          <div class="detail-card">
            <p class="detail-meta-label">年份 / 评级</p>
            <strong>${escapeHtml(String(detail?.publishedYear || "未知"))} / ${escapeHtml(detail?.xiaomiGrade || "未知")}</strong>
          </div>
          <div class="detail-card">
            <p class="detail-meta-label">关注 / 评论</p>
            <strong>${escapeHtml(String(detail?.followCount ?? 0))} / ${escapeHtml(String(detail?.commentCount ?? 0))}</strong>
          </div>
          <div class="detail-card">
            <p class="detail-meta-label">分享链接</p>
            <strong class="detail-link">
              ${
                detail?.shareUrl
                  ? `<a href="${escapeHtml(detail.shareUrl)}" target="_blank" rel="noreferrer">打开分享页</a>`
                  : "暂无"
              }
            </strong>
          </div>
        </div>

        <div class="detail-tags">
          ${
            tags.length
              ? tags.map((tag) => `<span class="tag-chip">${escapeHtml(tag)}</span>`).join("")
              : '<span class="tag-chip">暂无标签</span>'
          }
        </div>
      </div>
    </div>
  `;
}

async function openDetail(oneId) {
  try {
    openDetailModal();
    detailTitleNode.textContent = "详情信息";
    detailContent.textContent = "正在加载详情...";
    const [detailPayload, episodePayload] = await Promise.all([
      proxyJson(`/api/detail/${encodeURIComponent(oneId)}`),
      proxyJson(`/api/episodes/${encodeURIComponent(oneId)}?page=1&pageSize=120&queryAll=false`),
    ]);
    renderDetailModal(detailPayload.data || {}, episodePayload);
    setStatus(`详情加载完成：${detailPayload.data?.title || oneId}`);
  } catch (error) {
    detailContent.textContent = `详情加载失败：${error.message || error}`;
    setStatus(`详情获取失败：${oneId}`);
  }
}

async function downloadZipBundle(item) {
  const oneId = item?.oneId || "";
  if (!oneId) {
    return;
  }
  ensureDownloadTask(item);
  if (!window.JSZip) {
    setDownloadState(oneId, {
      phase: "error",
      note: "JSZip 加载失败",
    });
    setStatus("JSZip 加载失败，请刷新页面后重试");
    return;
  }

  try {
    setDownloadState(oneId, {
      phase: "preparing",
      completed: 0,
      total: 0,
      note: "正在获取分集...",
    });
    setStatus(`正在准备打包：${item.title || oneId}`);

    const episodePayload = await proxyJson(
      `/api/episodes/${encodeURIComponent(oneId)}?page=1&pageSize=120&queryAll=false`
    );
    const freeEpisodes = getFreeEpisodes(episodePayload);

    if (!freeEpisodes.length) {
      setDownloadState(oneId, {
        phase: "error",
        completed: 0,
        total: 0,
        note: "没有可打包的免费分集",
      });
      setStatus(`没有可打包的免费分集：${item.title || oneId}`);
      return;
    }

    const zip = new window.JSZip();
    const folderName = sanitizeName(item.title || "drama");
    const zipFolder = zip.folder(folderName);
    setDownloadState(oneId, {
      phase: "packing",
      completed: 0,
      total: freeEpisodes.length,
      note: `已完成 0/${freeEpisodes.length}`,
    });

    for (const { episode, clarity } of freeEpisodes) {
      const filename = buildEpisodeFilename(item.title || "drama", episode.playOrder, clarity.key);
      setStatus(`正在打包第 ${episode.playOrder} 集：${item.title || oneId}`);
      const blob = await fetchEpisodeBlob(clarity.url, filename);
      zipFolder.file(filename, blob);
      const nextCompleted = getDownloadState(oneId).completed + 1;
      setDownloadState(oneId, {
        phase: "packing",
        completed: nextCompleted,
        total: freeEpisodes.length,
        note: `已完成 ${nextCompleted}/${freeEpisodes.length}`,
      });
    }

    setDownloadState(oneId, {
      phase: "zipping",
      completed: freeEpisodes.length,
      total: freeEpisodes.length,
      note: "正在生成 ZIP...",
    });
    setStatus(`正在生成 ZIP：${item.title || oneId}`);

    const zipBlob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 3 },
    });

    const zipName = `${folderName}_free_episodes.zip`;
    saveBlob(zipBlob, zipName);
    setDownloadState(oneId, {
      phase: "done",
      completed: freeEpisodes.length,
      total: freeEpisodes.length,
      note: "ZIP 已下载",
    });
    setStatus(`ZIP 下载完成：${zipName}`);
  } catch (error) {
    setDownloadState(oneId, {
      phase: "error",
      note: `打包失败：${error.message || error}`,
    });
    setStatus(`ZIP 打包失败：${item.title || oneId}`);
  }
}

async function search(keyword) {
  if (authEnabled && !authorized) {
    setStatus("请先输入访问密钥。");
    return;
  }
  try {
    setStatus(`正在搜索：${keyword || "全部"}`);
    const payload = await proxyJson(`/api/search?keyword=${encodeURIComponent(keyword)}`);
    renderResults(Array.isArray(payload.data) ? payload.data : []);
    setStatus(`共找到 ${Array.isArray(payload.data) ? payload.data.length : 0} 条结果`);
  } catch (error) {
    renderResults([]);
    setStatus(`搜索失败：${error.message || error}`);
  }
}

async function loadSuggestions() {
  if (authEnabled && !authorized) {
    return;
  }
  try {
    const payload = await proxyJson("/api/suggest");
    renderSuggestions(payload.data || []);
  } catch (error) {
    console.error("loadSuggestions failed", error);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await search(keywordInput.value.trim());
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const key = accessKeyInput.value.trim();
  if (!key) {
    authErrorNode.textContent = "请输入访问密钥";
    return;
  }
  authErrorNode.textContent = "";
  try {
    await performLogin(key);
    setStatus("密钥验证成功，已进入系统。");
  } catch (error) {
    authErrorNode.textContent = error.message || "登录失败";
  }
});

logoutButton.addEventListener("click", async () => {
  await performLogout();
});

exportsButton.addEventListener("click", openExportsModal);
exportsCloseButton.addEventListener("click", closeExportsModal);

resultList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  const oneId = button.dataset.oneid || "";
  const item = currentResults.find((entry) => String(entry.oneId || "") === oneId);
  if (!item) {
    return;
  }

  if (button.dataset.action === "detail") {
    await openDetail(oneId);
    return;
  }

  if (button.dataset.action === "zip") {
    await downloadZipBundle(item);
  }
});

detailCloseButton.addEventListener("click", closeDetailModal);
detailModal.addEventListener("click", (event) => {
  if (event.target instanceof HTMLElement && event.target.dataset.closeDetail === "true") {
    closeDetailModal();
  }
});

exportsModal.addEventListener("click", (event) => {
  if (event.target instanceof HTMLElement && event.target.dataset.closeExports === "true") {
    closeExportsModal();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !detailModal.classList.contains("hidden")) {
    closeDetailModal();
  }
  if (event.key === "Escape" && !exportsModal.classList.contains("hidden")) {
    closeExportsModal();
  }
});

async function bootstrap() {
  try {
    renderExportsPanel();
    await loadAuthStatus();
    if (!authEnabled || authorized) {
      await loadSuggestions();
      await search("");
    } else {
      setStatus("请输入访问密钥后继续。");
      accessKeyInput.focus();
    }
  } catch (error) {
    setStatus(`初始化失败：${error.message || error}`);
  }
}

bootstrap();
