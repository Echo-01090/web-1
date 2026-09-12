const MAX_CONTENT_LENGTH = 4500;
const MAX_DESCRIPTION_LENGTH = 500;

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Use POST to request a Deep Read." });
  }

  const body = typeof request.body === "string" ? parseBody(request.body) : request.body;
  const suppliedKeys = body && typeof body === "object" ? Object.keys(body) : [];

  if (suppliedKeys.length !== 1 || suppliedKeys[0] !== "url") {
    return response.status(400).json({ error: "Send exactly one webpage URL." });
  }

  const targetUrl = validatePublicUrl(body.url);
  if (!targetUrl) {
    return response.status(400).json({ error: "Enter a valid public http:// or https:// webpage URL." });
  }

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    return response.status(503).json({ error: "Deep Read is not configured yet. Add the Firecrawl API key and retry." });
  }

  try {
    const firecrawlResponse = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url: targetUrl,
        formats: ["markdown"],
        onlyMainContent: true,
        removeBase64Images: true,
        timeout: 30000
      }),
      signal: AbortSignal.timeout(35000)
    });

    const payload = await parseJsonResponse(firecrawlResponse);
    if (!firecrawlResponse.ok || payload.success === false) {
      return response.status(mapFirecrawlStatus(firecrawlResponse.status)).json({
        error: readableFirecrawlError(firecrawlResponse.status, payload.error)
      });
    }

    const page = payload.data || payload;
    const metadata = page.metadata || {};
    const content = cleanMarkdown(page.markdown).slice(0, MAX_CONTENT_LENGTH);

    if (!content) {
      return response.status(502).json({ error: "Firecrawl reached the page but returned no readable content. You can retry." });
    }

    const url = metadata.sourceURL || metadata.url || targetUrl;
    return response.status(200).json({
      title: String(metadata.title || new URL(url).hostname).slice(0, 240),
      domain: new URL(url).hostname.replace(/^www\./, ""),
      url,
      description: String(metadata.description || "").slice(0, MAX_DESCRIPTION_LENGTH),
      content
    });
  } catch (error) {
    const message = error.name === "TimeoutError"
      ? "Deep Read timed out. Please retry the selected story."
      : "Firecrawl is temporarily unavailable. Please retry the selected story.";
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

function cleanMarkdown(value) {
  let lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
  const articleHeading = lines.findIndex((line) => /^#\s+\S/.test(line.trim()));

  // Firecrawl can occasionally include an anti-bot interstitial before the
  // article. When a primary heading is present, start immediately after it.
  if (articleHeading >= 0) lines = lines.slice(articleHeading + 1);

  const unwantedLine = /^(?:Checking your Browser…?|Verifying\.\.\.|Stuck\?|Success!|Verification (?:failed|expired)|Refresh|Close)$/i;
  const unwantedLink = /^\[(?:Share on|Share over|Copy Share Link|Troubleshoot|Refresh|Privacy)\b/i;

  lines = lines.filter((line) => {
    const trimmed = line.trim();
    if (unwantedLine.test(trimmed) || unwantedLink.test(trimmed)) return false;
    if (/^!\[.*\]\(.+\)(?:\*\*Image Credits:.*)?$/.test(trimmed)) return false;
    return true;
  });

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function validatePublicUrl(value) {
  if (typeof value !== "string") return null;

  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;

    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (hostname === "localhost" || hostname.endsWith(".local") || hostname === "::1") return null;
    if (!hostname.includes(".") && !hostname.includes(":")) return null;
    if (/^(?:0|10|127|169\.254|192\.168)\./.test(hostname)) return null;
    if (/^(?:fc|fd|fe[89ab])[0-9a-f]*:/i.test(hostname)) return null;

    const private172 = hostname.match(/^172\.(\d{1,3})\./);
    if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return null;

    const carrierGradeNat = hostname.match(/^100\.(\d{1,3})\./);
    if (carrierGradeNat && Number(carrierGradeNat[1]) >= 64 && Number(carrierGradeNat[1]) <= 127) return null;

    const firstOctet = hostname.match(/^(\d{1,3})\./);
    if (firstOctet && Number(firstOctet[1]) >= 224) return null;

    return url.toString();
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
  return 502;
}

function readableFirecrawlError(status, detail) {
  if (status === 429) return "Firecrawl is busy or has reached its usage limit. Please retry later.";
  if (status === 401 || status === 403) return "Deep Read authentication failed. Check the server-side Firecrawl key.";
  if (status === 402) return "The Firecrawl account has no remaining credits.";
  if (status === 400 || status === 422) return "Firecrawl could not read this page. Try another article or retry later.";
  const safeDetail = typeof detail === "string" ? detail.slice(0, 160) : "";
  return safeDetail || "Firecrawl could not retrieve this page. Please retry.";
}

module.exports.validatePublicUrl = validatePublicUrl;
module.exports.cleanMarkdown = cleanMarkdown;
