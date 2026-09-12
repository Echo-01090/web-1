const { validatePublicUrl } = require("./scrape");

const PAGE_LIMIT = 25;

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Use POST to start a site exploration." });
  }

  const body = typeof request.body === "string" ? parseBody(request.body) : request.body;
  const suppliedKeys = body && typeof body === "object" ? Object.keys(body).sort() : [];
  if (suppliedKeys.join(",") !== "depth,url") {
    return response.status(400).json({ error: "Send exactly one URL and an explore depth from 1 to 3." });
  }

  const targetUrl = validatePublicUrl(body.url);
  const depth = Number(body.depth);
  if (!targetUrl || !Number.isInteger(depth) || depth < 1 || depth > 3) {
    return response.status(400).json({ error: "Enter a public http:// or https:// URL and choose depth 1, 2, or 3." });
  }

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    return response.status(503).json({ error: "Site exploration is not configured yet. Add the Firecrawl API key and retry." });
  }

  try {
    const firecrawlResponse = await fetch("https://api.firecrawl.dev/v2/crawl", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url: targetUrl,
        maxDiscoveryDepth: depth,
        sitemap: "skip",
        crawlEntireDomain: true,
        allowExternalLinks: false,
        allowSubdomains: false,
        ignoreQueryParameters: true,
        limit: PAGE_LIMIT,
        scrapeOptions: {
          formats: ["markdown"],
          onlyMainContent: true,
          removeBase64Images: true
        }
      }),
      signal: AbortSignal.timeout(20000)
    });
    const payload = await parseJsonResponse(firecrawlResponse);
    if (!firecrawlResponse.ok || payload.success === false || !payload.id) {
      return response.status(mapFirecrawlStatus(firecrawlResponse.status)).json({
        error: readableFirecrawlError(firecrawlResponse.status)
      });
    }

    return response.status(202).json({ id: String(payload.id), url: targetUrl, depth, limit: PAGE_LIMIT });
  } catch (error) {
    const message = error.name === "TimeoutError"
      ? "Starting the crawl timed out. Please retry."
      : "Firecrawl is temporarily unavailable. Please retry.";
    return response.status(502).json({ error: message });
  }
};

function parseBody(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function parseJsonResponse(apiResponse) {
  try {
    return await apiResponse.json();
  } catch {
    return {};
  }
}

function mapFirecrawlStatus(status) {
  if (status === 400 || status === 422) return 400;
  if (status === 429) return 429;
  if (status === 401 || status === 403) return 502;
  if (status === 402) return 402;
  return 502;
}

function readableFirecrawlError(status) {
  if (status === 429) return "Firecrawl is busy or has reached its usage limit. Please retry later.";
  if (status === 401 || status === 403) return "Site exploration authentication failed. Check the server-side Firecrawl key.";
  if (status === 402) return "The Firecrawl account has no remaining credits.";
  if (status === 400 || status === 422) return "Firecrawl could not start this crawl. Check the URL and try again.";
  return "Firecrawl could not start this crawl. Please retry.";
}

module.exports.PAGE_LIMIT = PAGE_LIMIT;
