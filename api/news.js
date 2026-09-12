const crypto = require("node:crypto");
const { XMLParser } = require("fast-xml-parser");

const FEEDS = [
  { source: "WIRED", url: "https://www.wired.com/feed/tag/ai/latest/rss" },
  { source: "TechCrunch", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { source: "VentureBeat", url: "https://venturebeat.com/category/ai/feed/" }
];

const ITEMS_PER_SOURCE = 6;
const MAX_ARTICLES = 18;
const parser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  processEntities: true
});

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Use GET to load the news feeds." });
  }

  const feedResults = await Promise.all(FEEDS.map(loadFeed));
  const successfulFeeds = feedResults.filter((result) => result.ok);
  const errors = feedResults
    .filter((result) => !result.ok)
    .map(({ source, error }) => ({ source, error }));

  const seenUrls = new Set();
  const articles = successfulFeeds
    .flatMap((result) => result.articles)
    .filter((article) => {
      if (seenUrls.has(article.url)) return false;
      seenUrls.add(article.url);
      return true;
    })
    .sort(sortNewestFirst)
    .slice(0, MAX_ARTICLES);

  response.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  if (successfulFeeds.length === 0) {
    return response.status(502).json({
      error: "All three news sources are temporarily unavailable.",
      articles: [],
      sources: { requested: FEEDS.length, successful: 0 },
      errors
    });
  }

  return response.status(200).json({
    articles,
    sources: { requested: FEEDS.length, successful: successfulFeeds.length },
    errors
  });
};

async function loadFeed(feed) {
  try {
    const feedResponse = await fetch(feed.url, {
      headers: {
        Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
        "User-Agent": "AI-News-Briefing/1.0"
      },
      signal: AbortSignal.timeout(12000)
    });

    if (!feedResponse.ok) {
      throw new Error(`Feed returned HTTP ${feedResponse.status}.`);
    }

    const xml = await feedResponse.text();
    const document = parser.parse(xml);
    const rawItems = getItems(document);

    if (rawItems.length === 0) {
      throw new Error("Feed contained no readable items.");
    }

    const articles = rawItems
      .map((item) => normalizeItem(item, feed.source))
      .filter(Boolean)
      .slice(0, ITEMS_PER_SOURCE);

    if (articles.length === 0) {
      throw new Error("Feed items did not contain valid article links.");
    }

    return { ok: true, source: feed.source, articles };
  } catch (error) {
    return {
      ok: false,
      source: feed.source,
      error: error.name === "TimeoutError" ? "Feed request timed out." : error.message
    };
  }
}

function getItems(document) {
  const rssItems = document?.rss?.channel?.item;
  const atomItems = document?.feed?.entry;
  const items = rssItems ?? atomItems ?? [];
  return Array.isArray(items) ? items : [items];
}

function normalizeItem(item, source) {
  const title = cleanText(readValue(item.title)) || "Untitled story";
  const url = readLink(item.link) || readValue(item.guid);

  if (!isWebUrl(url)) return null;

  const publishedValue = readValue(item.pubDate) || readValue(item.published) || readValue(item.updated) || readValue(item["dc:date"]);
  const publishedDate = new Date(publishedValue);
  const publishedAt = Number.isNaN(publishedDate.getTime()) ? "" : publishedDate.toISOString();
  const summaryValue = readValue(item.description) || readValue(item.summary) || readValue(item["content:encoded"]);
  const summary = cleanText(summaryValue).slice(0, 520);

  return {
    id: crypto.createHash("sha1").update(`${source}:${url}`).digest("hex").slice(0, 16),
    source,
    title,
    url,
    publishedAt,
    summary
  };
}

function readLink(link) {
  if (Array.isArray(link)) {
    const alternate = link.find((entry) => !entry?.["@_rel"] || entry["@_rel"] === "alternate");
    return readLink(alternate);
  }
  if (typeof link === "object" && link !== null) {
    return link["@_href"] || readValue(link);
  }
  return readValue(link);
}

function readValue(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (typeof value === "object") return readValue(value["#text"] ?? value["__cdata"] ?? "");
  return "";
}

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function isWebUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function sortNewestFirst(a, b) {
  const aTime = Date.parse(a.publishedAt) || 0;
  const bTime = Date.parse(b.publishedAt) || 0;
  return bTime - aTime;
}

module.exports.FEEDS = FEEDS;
module.exports.normalizeItem = normalizeItem;
