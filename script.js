const loadButton = document.querySelector("#load-news");
const filterInput = document.querySelector("#news-filter");
const statusMessage = document.querySelector("#news-status");
const articleList = document.querySelector("#article-list");
const deepReadContent = document.querySelector("#deep-read-content");
const explorerForm = document.querySelector("#explorer-form");
const explorerUrl = document.querySelector("#explorer-url");
const scrapeButton = document.querySelector("#scrape-page");
const explorerStatus = document.querySelector("#explorer-status");
const explorerResult = document.querySelector("#explorer-result");

let loadedArticles = [];
let deepReadController = null;
let explorerController = null;

loadButton.addEventListener("click", loadLatestNews);
filterInput.addEventListener("input", renderFilteredArticles);
explorerForm.addEventListener("submit", explorePage);

async function loadLatestNews() {
  loadButton.disabled = true;
  loadButton.textContent = "Loading…";
  filterInput.disabled = true;
  setStatus("Contacting all three RSS sources…");

  try {
    const response = await fetch("/api/news", { cache: "no-store" });
    const result = await readJson(response);

    if (!response.ok) {
      throw new Error(result.error || "The news feeds could not be loaded.");
    }

    loadedArticles = Array.isArray(result.articles) ? result.articles : [];
    filterInput.disabled = loadedArticles.length === 0;
    renderFilteredArticles();

    const successful = result.sources?.successful ?? 0;
    const requested = result.sources?.requested ?? 3;
    const failedNames = (result.errors || []).map((item) => item.source).join(", ");
    const partialNote = failedNames ? ` ${failedNames} could not be reached; the other feeds still loaded.` : "";
    setStatus(`Loaded ${loadedArticles.length} stories from ${successful} of ${requested} sources.${partialNote}`);
  } catch (error) {
    loadedArticles = [];
    renderEmptyState("News is temporarily unavailable.", `${error.message} Please try again.`);
    setStatus(error.message, true);
  } finally {
    loadButton.disabled = false;
    loadButton.textContent = "Load Latest News";
  }
}

function renderFilteredArticles() {
  const term = filterInput.value.trim().toLocaleLowerCase();
  const visibleArticles = loadedArticles.filter((article) => {
    const searchableText = `${article.title} ${article.summary}`.toLocaleLowerCase();
    return searchableText.includes(term);
  });

  articleList.replaceChildren();

  if (visibleArticles.length === 0) {
    const title = loadedArticles.length ? "No matching stories." : "No stories loaded yet.";
    const detail = loadedArticles.length ? "Clear the filter to restore the loaded set." : "Use “Load Latest News” to begin.";
    renderEmptyState(title, detail);
    return;
  }

  const fragment = document.createDocumentFragment();
  visibleArticles.forEach((article) => fragment.append(createArticleCard(article)));
  articleList.append(fragment);
}

function createArticleCard(article) {
  const card = document.createElement("article");
  card.className = "article-card";

  const meta = document.createElement("div");
  meta.className = "article-meta";

  const source = document.createElement("span");
  source.className = "source-label";
  source.textContent = article.source;

  const date = document.createElement("time");
  date.textContent = formatDate(article.publishedAt);
  if (article.publishedAt) date.dateTime = article.publishedAt;
  meta.append(source, date);

  const title = document.createElement("h3");
  title.textContent = article.title;

  const summary = document.createElement("p");
  summary.className = "article-summary";
  summary.textContent = article.summary || "No RSS summary was provided for this story.";

  const actions = document.createElement("div");
  actions.className = "article-actions";

  const originalLink = document.createElement("a");
  originalLink.href = article.url;
  originalLink.target = "_blank";
  originalLink.rel = "noopener noreferrer";
  originalLink.textContent = "Read Original Article ↗";

  const deepReadButton = document.createElement("button");
  deepReadButton.className = "deep-read-button";
  deepReadButton.type = "button";
  deepReadButton.textContent = "Deep Read";
  deepReadButton.addEventListener("click", () => loadDeepRead(article));

  actions.append(originalLink, deepReadButton);
  card.append(meta, title, summary, actions);
  return card;
}

async function loadDeepRead(article) {
  if (deepReadController) deepReadController.abort();
  deepReadController = new AbortController();
  setDeepReadButtonsDisabled(true);
  renderDeepReadMessage(`Retrieving “${article.title}”…`, "Firecrawl is reading only this selected article.");

  try {
    const response = await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: article.url }),
      signal: deepReadController.signal
    });
    const result = await readJson(response);

    if (!response.ok) {
      throw new Error(result.error || "This page could not be retrieved.");
    }

    renderDeepReadResult(result, article.source);
  } catch (error) {
    if (error.name !== "AbortError") {
      renderDeepReadMessage("Deep Read could not finish.", `${error.message} You can retry this story.`);
    }
  } finally {
    setDeepReadButtonsDisabled(false);
  }
}

function renderDeepReadResult(result, sourceName) {
  deepReadContent.replaceChildren();

  const source = document.createElement("p");
  source.className = "retrieved-from";
  source.textContent = `${sourceName} · ${result.domain}`;

  const title = document.createElement("h3");
  title.id = "deep-read-title";
  title.textContent = result.title;

  const description = document.createElement("p");
  description.className = "retrieved-description";
  description.textContent = result.description || "Firecrawl returned a clean excerpt from the selected page.";

  const content = document.createElement("p");
  content.className = "content-excerpt";
  content.textContent = result.content;

  const link = document.createElement("a");
  link.href = result.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Open Original Article ↗";

  deepReadContent.append(source, title, description, content, link);
}

function renderDeepReadMessage(titleText, detailText) {
  deepReadContent.replaceChildren();

  const title = document.createElement("h3");
  title.id = "deep-read-title";
  title.textContent = titleText;

  const detail = document.createElement("p");
  detail.textContent = detailText;
  deepReadContent.append(title, detail);
}

async function explorePage(event) {
  event.preventDefault();
  const url = explorerUrl.value.trim();

  if (!url) {
    renderExplorerMessage("A webpage URL is required.", "Enter one public http:// or https:// address, then try again.", true);
    explorerUrl.focus();
    return;
  }

  if (explorerController) explorerController.abort();
  explorerController = new AbortController();
  scrapeButton.disabled = true;
  scrapeButton.textContent = "Scraping…";
  renderExplorerMessage("Retrieving one webpage…", "Firecrawl is processing only the URL you entered.");

  try {
    const response = await fetch("/api/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal: explorerController.signal
    });
    const result = await readJson(response);

    if (!response.ok) {
      throw new Error(result.error || "This webpage could not be retrieved.");
    }

    renderExplorerResult(result);
  } catch (error) {
    if (error.name !== "AbortError") {
      renderExplorerMessage("Web Explorer could not finish.", `${error.message} You can correct the URL or retry.`, true);
    }
  } finally {
    scrapeButton.disabled = false;
    scrapeButton.textContent = "Scrape Page";
  }
}

function renderExplorerResult(result) {
  explorerResult.replaceChildren();

  const resultCard = document.createElement("article");
  resultCard.className = "page-result";

  const source = document.createElement("p");
  source.className = "retrieved-from";
  source.textContent = `Firecrawl · ${result.domain}`;

  const title = document.createElement("h3");
  title.textContent = result.title;

  const url = document.createElement("p");
  url.className = "result-url";
  url.textContent = result.url;

  const description = document.createElement("p");
  description.className = "retrieved-description";
  description.textContent = result.description || "No page description was available.";

  const content = document.createElement("p");
  content.className = "content-excerpt";
  content.textContent = result.content;

  const link = document.createElement("a");
  link.href = result.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Open Original Page ↗";

  resultCard.append(source, title, url, description, content, link);
  explorerResult.append(resultCard);
  setExplorerStatus(`Retrieved one page from ${result.domain}.`);
}

function renderExplorerMessage(titleText, detailText, isError = false) {
  explorerResult.replaceChildren();
  const message = document.createElement("div");
  message.className = "empty-state";

  const title = document.createElement("p");
  title.textContent = titleText;
  const detail = document.createElement("span");
  detail.textContent = detailText;

  message.append(title, detail);
  explorerResult.append(message);
  setExplorerStatus(titleText, isError);
}

function setExplorerStatus(message, isError = false) {
  explorerStatus.textContent = message;
  explorerStatus.classList.toggle("error", isError);
}

function renderEmptyState(titleText, detailText) {
  articleList.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty-state";

  const title = document.createElement("p");
  title.textContent = titleText;
  const detail = document.createElement("span");
  detail.textContent = detailText;

  empty.append(title, detail);
  articleList.append(empty);
}

function setDeepReadButtonsDisabled(disabled) {
  document.querySelectorAll(".deep-read-button").forEach((button) => {
    button.disabled = disabled;
  });
}

function setStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle("error", isError);
}

function formatDate(value) {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}
