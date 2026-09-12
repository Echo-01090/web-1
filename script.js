const loadButton = document.querySelector("#load-news");
const filterInput = document.querySelector("#news-filter");
const statusMessage = document.querySelector("#news-status");
const articleList = document.querySelector("#article-list");
const deepReadContent = document.querySelector("#deep-read-content");
const explorerForm = document.querySelector("#explorer-form");
const explorerUrl = document.querySelector("#explorer-url");
const exploreDepth = document.querySelector("#explore-depth");
const scrapeButton = document.querySelector("#scrape-page");
const explorerStatus = document.querySelector("#explorer-status");
const explorerResult = document.querySelector("#explorer-result");
const jobScoutForm = document.querySelector("#job-scout-form");
const jobSourceInputs = [...document.querySelectorAll(".job-source-url")];
const jobSourceStatuses = [...document.querySelectorAll("[data-source-status]")];
const findJobsButton = document.querySelector("#find-jobs");
const clearJobsButton = document.querySelector("#clear-jobs");
const jobScoutStatus = document.querySelector("#job-scout-status");
const jobResultsList = document.querySelector("#job-results-list");

let loadedArticles = [];
let deepReadController = null;
let explorerController = null;
let jobScoutController = null;

loadButton.addEventListener("click", loadLatestNews);
filterInput.addEventListener("input", renderFilteredArticles);
explorerForm.addEventListener("submit", explorePage);
jobScoutForm.addEventListener("submit", scanJobPages);
clearJobsButton.addEventListener("click", clearJobScout);

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
  const depth = Number(exploreDepth.value);

  if (!url) {
    renderExplorerMessage("A webpage URL is required.", "Enter one public http:// or https:// address, then try again.", true);
    explorerUrl.focus();
    return;
  }

  if (!isPublicWebUrl(url)) {
    renderExplorerMessage("A valid public webpage URL is required.", "Use a complete http:// or https:// address, then try again.", true);
    explorerUrl.focus();
    return;
  }

  if (explorerController) explorerController.abort();
  explorerController = new AbortController();
  scrapeButton.disabled = true;
  exploreDepth.disabled = true;
  scrapeButton.textContent = depth === 0 ? "Reading…" : "Starting…";

  try {
    if (depth === 0) {
      renderExplorerMessage("Retrieving one webpage…", "Firecrawl is processing only the URL you entered.");
      const result = await postJson("/api/scrape", { url }, explorerController.signal);
      renderExplorerResult(result);
      return;
    }

    renderExplorerMessage("Starting crawl…", `Preparing a same-domain crawl to depth ${depth}.`);
    const crawl = await postJson("/api/crawl", { url, depth }, explorerController.signal);
    const result = await pollCrawl(crawl.id, explorerController.signal);
    renderCrawlResult(result, url, depth);
  } catch (error) {
    if (error.name !== "AbortError") {
      renderExplorerMessage("Web Explorer could not finish.", `${error.message} You can correct the URL or retry.`, true);
    }
  } finally {
    scrapeButton.disabled = false;
    exploreDepth.disabled = false;
    scrapeButton.textContent = "Explore Site";
  }
}

async function postJson(path, body, signal) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  const result = await readJson(response);

  if (!response.ok) throw new Error(result.error || "The request could not be completed.");
  return result;
}

async function pollCrawl(id, signal) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (attempt > 0) await abortableDelay(2000, signal);

    const response = await fetch(`/api/crawl/status?id=${encodeURIComponent(id)}`, { signal });
    const result = await readJson(response);
    if (!response.ok) throw new Error(result.error || "The crawl status could not be retrieved.");

    if (result.status === "failed") {
      throw new Error(result.error || "Firecrawl could not complete this site crawl.");
    }
    if (result.status === "completed") return result;

    const pageCount = Number(result.pagesRetrieved || 0);
    const pageLabel = pageCount === 1 ? "page" : "pages";
    setExplorerStatus(pageCount > 0 ? `Exploring site… ${pageCount} ${pageLabel} retrieved.` : "Exploring site…");
  }

  throw new Error("The crawl is taking longer than expected. Please retry in a moment.");
}

function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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

function renderCrawlResult(result, startUrl, depth) {
  explorerResult.replaceChildren();

  const summary = document.createElement("section");
  summary.className = "crawl-summary";
  const heading = document.createElement("h3");
  heading.textContent = "Site exploration complete";
  const facts = document.createElement("dl");
  [
    ["Start URL", startUrl],
    ["Explore depth", String(depth)],
    ["Pages retrieved", String(result.pagesRetrieved)],
    ["25-page cap", result.capReached ? "Reached" : "Not reached"]
  ].forEach(([label, value]) => {
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = value;
    facts.append(term, detail);
  });
  summary.append(heading, facts);

  const cards = document.createElement("div");
  cards.className = "crawl-page-list";
  if (result.pages.length === 0) {
    const message = document.createElement("div");
    message.className = "empty-state";
    const title = document.createElement("p");
    title.textContent = "No readable pages were returned.";
    const detail = document.createElement("span");
    detail.textContent = "The crawl completed, but Firecrawl did not return page excerpts.";
    message.append(title, detail);
    cards.append(message);
  }
  result.pages.forEach((page) => {
    const card = document.createElement("article");
    card.className = "crawl-page-card";
    const title = document.createElement("h4");
    title.textContent = page.title;
    const url = document.createElement("p");
    url.className = "result-url";
    url.textContent = page.url;
    const excerpt = document.createElement("p");
    excerpt.className = "crawl-excerpt";
    excerpt.textContent = page.excerpt || "No readable excerpt was returned for this page.";
    const link = document.createElement("a");
    link.href = page.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open Page ↗";
    card.append(title, url, excerpt, link);
    cards.append(card);
  });

  explorerResult.append(summary, cards);
  const capMessage = result.capReached ? " The 25-page safety cap was reached." : "";
  const pageLabel = Number(result.pagesRetrieved) === 1 ? "page" : "pages";
  setExplorerStatus(`Completed — ${result.pagesRetrieved} ${pageLabel} retrieved.${capMessage}`);
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

async function scanJobPages(event) {
  event.preventDefault();
  const values = jobSourceInputs.map((input) => input.value.trim());

  resetJobSourceStatuses();
  if (!values[0]) {
    setJobScoutStatus("Job Source 1 URL is required.", true);
    setJobSourceStatus(0, "Invalid URL", "error");
    jobSourceInputs[0].focus();
    return;
  }

  const invalidIndex = values.findIndex((value) => value && !isPublicWebUrl(value));
  if (invalidIndex >= 0) {
    setJobScoutStatus(`Job Source ${invalidIndex + 1} must be a public http:// or https:// URL.`, true);
    setJobSourceStatus(invalidIndex, "Invalid URL", "error");
    jobSourceInputs[invalidIndex].focus();
    return;
  }

  const urls = values.filter(Boolean);
  if (jobScoutController) jobScoutController.abort();
  jobScoutController = new AbortController();
  findJobsButton.disabled = true;
  findJobsButton.textContent = "Scanning…";
  values.forEach((value, index) => {
    if (value) setJobSourceStatus(index, "Scanning", "scanning");
  });
  renderJobScoutMessage("Comparing supplied job pages…", "Each exact page is being extracted independently. One failed source will not cancel the others.");

  try {
    const response = await fetch("/api/jobs/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
      signal: jobScoutController.signal
    });
    const result = await readJson(response);
    updateJobSourceStatuses(values, result.sources || []);

    if (!response.ok) {
      throw new Error(result.error || "The supplied job pages could not be scanned.");
    }

    renderJobResults(result.jobs || []);
    const failed = (result.sources || []).filter((source) => source.status === "could_not_extract").length;
    const partial = failed ? ` ${failed} source${failed === 1 ? "" : "s"} could not be extracted; successful sources were still ranked.` : "";
    const jobCount = result.jobs?.length || 0;
    const summary = jobCount
      ? `Found ${jobCount} recommended junior opportunit${jobCount === 1 ? "y" : "ies"}.`
      : "No qualifying junior opportunities were found.";
    setJobScoutStatus(`${summary}${partial}`);
  } catch (error) {
    if (error.name !== "AbortError") {
      renderJobScoutMessage("Junior Job Scout could not finish.", error.message, true);
    }
  } finally {
    findJobsButton.disabled = false;
    findJobsButton.textContent = "Find Junior Opportunities";
  }
}

function renderJobResults(jobs) {
  jobResultsList.replaceChildren();
  const usableJobs = jobs.slice(0, 5).filter((job) => Array.isArray(job.reasons) && job.reasons.length === 3);

  if (usableJobs.length === 0) {
    renderJobScoutMessage("No qualifying junior opportunities were found.", "Try another public page with visible entry-level, graduate, trainee, assistant, coordinator, or analyst roles.");
    return;
  }

  const fragment = document.createDocumentFragment();
  usableJobs.forEach((job) => fragment.append(createJobCard(job)));
  jobResultsList.append(fragment);
}

function createJobCard(job) {
  const card = document.createElement("article");
  card.className = "job-card";

  const rank = document.createElement("p");
  rank.className = "job-rank";
  rank.textContent = `#${job.rank}`;

  const source = document.createElement("p");
  source.className = "retrieved-from";
  source.textContent = job.sourceDomain;

  const title = document.createElement("h4");
  title.textContent = job.title;

  const facts = document.createElement("dl");
  facts.className = "job-facts";
  appendJobFact(facts, "Employer", job.employer);
  appendJobFact(facts, "Location", job.location);
  appendJobFact(facts, "Type", job.employmentType);
  appendJobFact(facts, "Published", job.postedDate);

  const reasons = document.createElement("ul");
  reasons.className = "job-reasons";
  job.reasons.forEach((reason) => {
    const item = document.createElement("li");
    const heading = document.createElement("strong");
    heading.textContent = `${reason.heading}: `;
    item.append(heading, document.createTextNode(reason.text));
    reasons.append(item);
  });

  card.append(rank, source, title);
  if (facts.children.length) card.append(facts);
  card.append(reasons);

  if (job.jobUrl) {
    const link = document.createElement("a");
    link.href = job.jobUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open Job Posting ↗";
    card.append(link);
  }

  return card;
}

function appendJobFact(list, labelText, value) {
  if (!value) return;
  const wrapper = document.createElement("div");
  const label = document.createElement("dt");
  label.textContent = labelText;
  const detail = document.createElement("dd");
  detail.textContent = value;
  wrapper.append(label, detail);
  list.append(wrapper);
}

function updateJobSourceStatuses(values, sources) {
  values.forEach((value, index) => {
    if (!value) return;
    const normalized = normalizeComparableUrl(value);
    const source = sources.find((item) => item.url === normalized);
    if (!source) {
      setJobSourceStatus(index, "Could not extract", "error");
      return;
    }

    if (source.status === "extracted") setJobSourceStatus(index, "Extracted", "success");
    else if (source.status === "no_jobs") setJobSourceStatus(index, "No jobs found", "empty");
    else setJobSourceStatus(index, "Could not extract", "error");
  });
}

function setJobSourceStatus(index, text, state = "") {
  const status = jobSourceStatuses[index];
  if (!status) return;
  status.textContent = text;
  status.dataset.state = state;
}

function resetJobSourceStatuses() {
  jobSourceStatuses.forEach((_, index) => setJobSourceStatus(index, "Waiting"));
}

function clearJobScout() {
  if (jobScoutController) jobScoutController.abort();
  jobScoutController = null;
  jobScoutForm.reset();
  resetJobSourceStatuses();
  renderJobScoutMessage("No job pages scanned yet.", "Results from successful sources will be merged into one ranked view.");
  setJobScoutStatus("Add at least one public job-listing page to begin.");
}

function renderJobScoutMessage(titleText, detailText, isError = false) {
  jobResultsList.replaceChildren();
  const message = document.createElement("div");
  message.className = "empty-state";

  const title = document.createElement("p");
  title.textContent = titleText;
  const detail = document.createElement("span");
  detail.textContent = detailText;

  message.append(title, detail);
  jobResultsList.append(message);
  setJobScoutStatus(titleText, isError);
}

function setJobScoutStatus(message, isError = false) {
  jobScoutStatus.textContent = message;
  jobScoutStatus.classList.toggle("error", isError);
}

function isPublicWebUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function normalizeComparableUrl(value) {
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
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
