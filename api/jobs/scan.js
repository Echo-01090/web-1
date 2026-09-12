const { validatePublicUrl } = require("../scrape");

const MAX_URLS = 5;
const MAX_JOBS_PER_SOURCE = 8;
const MAX_RECOMMENDATIONS = 5;

const EXTRACTION_PROMPT = [
  "Extract up to 8 job opportunities visibly listed on this exact page.",
  "Focus on actual job postings, not navigation, filters, or promotional content.",
  "For each job return only facts visible on the page: title, employer, location, direct job URL if visible, date, employment type, a short factual description, evidence that it is junior/graduate/entry-level, transferable skills, future-relevant technology/digital/data/policy/innovation signals, learning or training signals, and evidence that the role is actually senior.",
  "Use empty strings or arrays when evidence is unavailable. Do not infer unsupported facts."
].join(" ");

const stringField = { type: "string" };
const stringList = { type: "array", items: { type: "string" } };
const JOB_SCHEMA = {
  type: "object",
  properties: {
    jobs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: stringField,
          employer: stringField,
          location: stringField,
          jobUrl: stringField,
          postedDate: stringField,
          employmentType: stringField,
          description: stringField,
          juniorEvidence: stringList,
          transferableSkills: stringList,
          futureRelevantSignals: stringList,
          learningSignals: stringList,
          seniorityWarnings: stringList
        },
        required: [
          "title", "employer", "location", "jobUrl", "postedDate", "employmentType",
          "description", "juniorEvidence", "transferableSkills", "futureRelevantSignals",
          "learningSignals", "seniorityWarnings"
        ]
      }
    }
  },
  required: ["jobs"]
};

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Use POST to scan job pages." });
  }

  const body = typeof request.body === "string" ? parseBody(request.body) : request.body;
  if (!body || !Array.isArray(body.urls)) {
    return response.status(400).json({ error: "Send an array containing 1 to 5 public job-page URLs." });
  }

  if (body.urls.length < 1 || body.urls.length > MAX_URLS) {
    return response.status(400).json({ error: "Enter between 1 and 5 job-page URLs." });
  }

  const validated = [];
  for (const value of body.urls) {
    const url = validatePublicUrl(typeof value === "string" ? value.trim() : value);
    if (!url) {
      return response.status(400).json({ error: "Every job source must be a valid public http:// or https:// URL." });
    }
    if (!validated.includes(url)) validated.push(url);
  }

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    return response.status(503).json({ error: "Junior Job Scout is not configured yet. Add the Firecrawl API key and retry." });
  }

  const sourceResults = await Promise.all(validated.map((url) => scanSource(url, apiKey)));
  const successfulSources = sourceResults.filter((source) => source.status !== "could_not_extract");
  const mergedJobs = deduplicateJobs(sourceResults.flatMap((source) => source.jobs));
  const jobs = rankJobs(mergedJobs).slice(0, MAX_RECOMMENDATIONS).map((job, index) => ({
    ...job,
    rank: index + 1,
    reasons: buildReasons(job)
  }));

  const sources = sourceResults.map(({ jobs: _jobs, ...source }) => source);
  if (successfulSources.length === 0) {
    return response.status(502).json({
      error: "None of the supplied pages could be cleanly extracted. Try another public job page.",
      jobs: [],
      sources
    });
  }

  return response.status(200).json({ jobs, sources });
};

async function scanSource(url, apiKey) {
  const domain = new URL(url).hostname.replace(/^www\./, "");

  try {
    const firecrawlResponse = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        url,
        formats: ["markdown", { type: "json", prompt: EXTRACTION_PROMPT, schema: JOB_SCHEMA }],
        onlyMainContent: true,
        removeBase64Images: true,
        blockAds: true,
        timeout: 45000
      }),
      signal: AbortSignal.timeout(50000)
    });

    const payload = await parseJsonResponse(firecrawlResponse);
    if (!firecrawlResponse.ok || payload.success === false) {
      return failedSource(url, domain, readableFirecrawlError(firecrawlResponse.status));
    }

    const page = payload.data || payload;
    const extracted = page.json && typeof page.json === "object" ? page.json : {};
    const rawJobs = Array.isArray(extracted.jobs) ? extracted.jobs.slice(0, MAX_JOBS_PER_SOURCE) : [];
    const sourceText = String(page.markdown || "").slice(0, 120000);
    if (!sourceText.trim()) {
      return failedSource(url, domain, "This page could not be cleanly extracted. Try another public job page.");
    }
    const jobs = rawJobs
      .map((job) => normalizeJob(job, url, domain, sourceText))
      .filter((job) => job.title);

    if (jobs.length === 0) {
      return {
        url,
        domain,
        status: "no_jobs",
        jobCount: 0,
        message: "No usable job listings were found on this page.",
        jobs: []
      };
    }

    return {
      url,
      domain,
      status: "extracted",
      jobCount: jobs.length,
      message: `Extracted ${jobs.length} visible job${jobs.length === 1 ? "" : "s"}.`,
      jobs
    };
  } catch {
    return failedSource(url, domain, "This page could not be cleanly extracted. Try another public job page.");
  }
}

function normalizeJob(value, sourceUrl, sourceDomain, sourceText = "") {
  const raw = value && typeof value === "object" ? value : {};
  const title = cleanString(raw.title, 180);
  if (!title || !containsExactEvidence(sourceText, title)) return emptyJob(sourceDomain);

  return {
    title,
    employer: groundedString(raw.employer, 160, sourceText),
    location: groundedString(raw.location, 160, sourceText),
    jobUrl: normalizeJobUrl(raw.jobUrl, sourceUrl, sourceText),
    postedDate: groundedString(raw.postedDate, 80, sourceText),
    employmentType: groundedString(raw.employmentType, 100, sourceText),
    description: groundedString(raw.description, 700, sourceText),
    juniorEvidence: groundedList(raw.juniorEvidence, sourceText),
    transferableSkills: groundedList(raw.transferableSkills, sourceText),
    futureRelevantSignals: groundedList(raw.futureRelevantSignals, sourceText),
    learningSignals: groundedList(raw.learningSignals, sourceText),
    seniorityWarnings: groundedList(raw.seniorityWarnings, sourceText),
    sourceDomain
  };
}

function rankJobs(jobs) {
  return jobs
    .map((job) => ({ ...job, score: scoreJob(job) }))
    .filter((job) => hasEarlyCareerSignal(job) && job.score > 0)
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
}

function scoreJob(job) {
  const text = jobText(job);
  const earlySignals = matchSignals(text, [
    /\bjunior\b/i, /\bgraduate\b/i, /\bentry[ -]?level\b/i, /\btrainee\b/i,
    /\bintern(?:ship)?\b/i, /\bassistant\b/i, /\bassociate\b/i,
    /\bcoordinator\b/i, /\banalyst\b/i, /\b0\s*[–-]\s*2 years?\b/i,
    /\bno (?:prior )?experience required\b/i
  ]);
  const seniorSignals = matchSignals(text, [
    /\bsenior\b/i, /\blead\b/i, /\bprincipal\b/i, /\bhead\b/i,
    /\bdirector\b/i, /\bexecutive\b/i, /\b(?:[5-9]|\d{2,})\+? years?\b/i
  ]);

  const accessibility = Math.min(40, (earlySignals.length * 10) + (job.juniorEvidence.length * 6));
  const skills = Math.min(30, job.transferableSkills.length * 7.5);
  const future = Math.min(20, job.futureRelevantSignals.length * 5);
  const learning = Math.min(10, job.learningSignals.length * 2.5);
  const titleIsSenior = /\b(?:senior|lead|principal|head|director|executive)\b/i.test(job.title);
  const penalty = (titleIsSenior ? 70 : 0) + Math.min(50, (seniorSignals.length + job.seniorityWarnings.length) * 15);

  return Math.round((accessibility + skills + future + learning - penalty) * 10) / 10;
}

function hasEarlyCareerSignal(job) {
  return job.juniorEvidence.length > 0 || /\b(?:junior|graduate|entry[ -]?level|trainee|intern(?:ship)?|assistant|associate|coordinator|analyst)\b/i.test(jobText(job));
}

function buildReasons(job) {
  const titleSignal = job.title.match(/\b(?:junior|graduate|entry[ -]?level|trainee|intern(?:ship)?|assistant|associate|coordinator|analyst)\b/i)?.[0];
  const accessible = job.juniorEvidence[0]
    || (titleSignal ? `The visible job title includes the early-career signal “${titleSignal}”.` : "The listing presents an early-career signal without stating a senior requirement.");
  const skills = job.transferableSkills.length
    ? `The listing names ${joinEvidence(job.transferableSkills)}.`
    : "The listing does not name specific transferable skills; review its responsibilities before applying.";
  const exposureEvidence = [...job.futureRelevantSignals, ...job.learningSignals];
  const exposure = exposureEvidence.length
    ? `The role offers exposure to ${joinEvidence(exposureEvidence)}.`
    : "The listing does not state a specific future-facing or training opportunity; review the full posting for details.";

  return [
    { heading: "Accessible start", text: accessible },
    { heading: "Skills you can build", text: skills },
    { heading: "Career exposure", text: exposure }
  ];
}

function deduplicateJobs(jobs) {
  const seen = new Set();
  return jobs.filter((job) => {
    const key = job.jobUrl || `${job.title}|${job.employer}|${job.location}`.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeJobUrl(value, sourceUrl, sourceText) {
  if (typeof value !== "string" || !value.trim()) return sourceUrl;
  try {
    const resolved = new URL(value.trim(), sourceUrl).toString();
    const validated = validatePublicUrl(resolved);
    if (!validated) return sourceUrl;
    return sourceText.includes(validated) || validated === sourceUrl ? validated : sourceUrl;
  } catch {
    return sourceUrl;
  }
}

function cleanString(value, maximum) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanString(item, 220)).filter(Boolean))].slice(0, 8);
}

function groundedString(value, maximum, sourceText) {
  const cleaned = cleanString(value, maximum);
  return cleaned && containsSupportedEvidence(sourceText, cleaned) ? cleaned : "";
}

function groundedList(value, sourceText) {
  return cleanList(value).filter((item) => containsSupportedEvidence(sourceText, item));
}

function containsExactEvidence(sourceText, evidence) {
  const page = normalizeEvidence(sourceText);
  const candidate = normalizeEvidence(evidence);
  return candidate.length >= 3 && page.includes(candidate);
}

function containsSupportedEvidence(sourceText, evidence) {
  if (containsExactEvidence(sourceText, evidence)) return true;
  const pageWords = new Set(evidenceWords(sourceText));
  const candidateWords = evidenceWords(evidence);
  if (candidateWords.length === 0) return false;
  const supported = candidateWords.filter((word) => pageWords.has(word)).length;
  return supported >= Math.ceil(candidateWords.length * 0.7);
}

function normalizeEvidence(value) {
  return String(value || "").toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function evidenceWords(value) {
  const ignored = new Set(["and", "are", "for", "from", "into", "of", "on", "or", "the", "this", "to", "with"]);
  return normalizeEvidence(value).split(" ").filter((word) => word.length > 2 && !ignored.has(word));
}

function emptyJob(sourceDomain) {
  return {
    title: "", employer: "", location: "", jobUrl: "", postedDate: "",
    employmentType: "", description: "", juniorEvidence: [], transferableSkills: [],
    futureRelevantSignals: [], learningSignals: [], seniorityWarnings: [], sourceDomain
  };
}

function jobText(job) {
  return [job.title, ...job.juniorEvidence, ...job.seniorityWarnings].join(" ");
}

function matchSignals(text, patterns) {
  return patterns.filter((pattern) => pattern.test(text));
}

function joinEvidence(items) {
  return items.slice(0, 3).join(", ");
}

function failedSource(url, domain, message) {
  return { url, domain, status: "could_not_extract", jobCount: 0, message, jobs: [] };
}

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

function readableFirecrawlError(status) {
  if (status === 429) return "Firecrawl is busy or has reached its usage limit. Try this source later.";
  if (status === 401 || status === 403) return "Job Scout authentication failed. Check the server-side Firecrawl key.";
  if (status === 402) return "The Firecrawl account has no remaining credits.";
  return "This page could not be cleanly extracted. Try another public job page.";
}

module.exports.config = { maxDuration: 60 };
module.exports.rankJobs = rankJobs;
module.exports.scoreJob = scoreJob;
module.exports.buildReasons = buildReasons;
module.exports.normalizeJob = normalizeJob;
