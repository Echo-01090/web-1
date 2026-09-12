const { cleanMarkdown } = require("../scrape");

const PAGE_LIMIT = 25;
const EXCERPT_LENGTH = 650;

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Use GET to check site exploration status." });
  }

  const id = typeof request.query?.id === "string" ? request.query.id : "";
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
    return response.status(400).json({ error: "A valid crawl ID is required." });
  }

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    return response.status(503).json({ error: "Site exploration is not configured yet. Add the Firecrawl API key and retry." });
  }

  try {
    const firecrawlResponse = await fetch(`https://api.firecrawl.dev/v2/crawl/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20000)
    });
    const payload = await parseJsonResponse(firecrawlResponse);
    if (!firecrawlResponse.ok || payload.success === false) {
      return response.status(mapFirecrawlStatus(firecrawlResponse.status)).json({
        error: readableFirecrawlError(firecrawlResponse.status)
      });
    }

    const pages = normalizePages(payload.data);
    const completed = boundedCount(payload.completed, pages.length);
    const total = boundedCount(payload.total, completed);
    const status = normalizeStatus(payload.status);
    const capReached = completed >= PAGE_LIMIT || total >= PAGE_LIMIT || pages.length >= PAGE_LIMIT;

    return response.status(200).json({
      status,
      pagesRetrieved: Math.max(completed, pages.length),
      totalPages: total,
      capReached,
      pages,
      ...(status === "failed" ? { error: "Firecrawl could not complete this site crawl." } : {})
    });
  } catch (error) {
    const message = error.name === "TimeoutError"
      ? "Checking crawl progress timed out. Please retry."
      : "Firecrawl status is temporarily unavailable. Please retry.";
    return response.status(502).json({ error: message });
  }
};

function normalizePages(value) {
  const rawPages = Array.isArray(value) ? value : [];
  const candidates = rawPages.map(normalizePage).filter(Boolean);
  const startHost = candidates[0] ? new URL(candidates[0].url).hostname.toLowerCase() : "";
  return candidates
    .filter((page) => new URL(page.url).hostname.toLowerCase() === startHost)
    .slice(0, PAGE_LIMIT);
}

function normalizePage(page) {
  if (!page || typeof page !== "object") return null;
  const metadata = page.metadata && typeof page.metadata === "object" ? page.metadata : {};
  const url = safeWebUrl(metadata.sourceURL || metadata.url);
  if (!url) return null;

  const excerpt = cleanMarkdown(page.markdown)
    .replace(/^#+\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, EXCERPT_LENGTH);
  return {
    title: String(metadata.title || new URL(url).hostname).trim().slice(0, 240),
    url,
    excerpt
  };
}

function safeWebUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function boundedCount(value, fallback) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.min(Math.floor(count), PAGE_LIMIT) : fallback;
}

function normalizeStatus(value) {
  if (value === "completed" || value === "failed") return value;
  return "scraping";
}

async function parseJsonResponse(apiResponse) {
  try {
    return await apiResponse.json();
  } catch {
    return {};
  }
}

function mapFirecrawlStatus(status) {
  if (status === 404) return 404;
  if (status === 429) return 429;
  return 502;
}

function readableFirecrawlError(status) {
  if (status === 404) return "This crawl could not be found. Start a new site exploration.";
  if (status === 429) return "Firecrawl is busy or has reached its usage limit. Please retry later.";
  if (status === 401 || status === 403) return "Site exploration authentication failed. Check the server-side Firecrawl key.";
  if (status === 402) return "The Firecrawl account has no remaining credits.";
  return "Firecrawl could not report this crawl's status. Please retry.";
}

module.exports.normalizePages = normalizePages;
