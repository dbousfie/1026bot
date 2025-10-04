import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const QUALTRICS_API_TOKEN = Deno.env.get("QUALTRICS_API_TOKEN");
const QUALTRICS_SURVEY_ID = Deno.env.get("QUALTRICS_SURVEY_ID");
const QUALTRICS_DATACENTER = Deno.env.get("QUALTRICS_DATACENTER");

const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
const COURSE_PAGE = Deno.env.get("COURSE_PAGE") || "https://westernu.brightspace.com/d2l/home/130641";
const CONTENT_FILE = Deno.env.get("CONTENT_FILE") || "syllabus.md";

const LESSON_RE =
  /https:\/\/westernu\.brightspace\.com\/d2l\/le\/lessons\/\d+\/(?:lessons|units|topics)\/\d+/g;

type Section = {
  heading: string;
  body: string;
  lessonUrls: string[];
};

function norm(s: string) { return (s || "").toLowerCase(); }
function mentionsEBO(q: string) {
  const s = norm(q);
  return /\b(e\.?\s*b\.?\s*o\.?|exploratory\b.*\bbibliograph)/.test(s);
}
function mentionsEssayOnly(q: string) {
  const s = norm(q);
  return /\bessay|essays\b/.test(s) && !mentionsEBO(q);
}
function hasDueIntent(q: string) {
  const s = norm(q);
  const pats = [
    /\bwhen\b.*\bdue\b/,
    /\bdue\s*date\b/,
    /\bdeadline\b/,
    /\bdue\b/,
    /\blate\b/,
    /\bpenalt(y|ies)\b/,
    /\bsubmission\s+window\b/,
    /\bsubmit\b/,
  ];
  return pats.some((re) => re.test(s));
}

// ----------------- File helpers -----------------
async function readFileSafe(path: string): Promise<string> {
  try { return await Deno.readTextFile(path); } catch { return ""; }
}

const HEADING_RX = /^(#{1,6})\s+(.+)$/gm;

function parseSections(md: string): Section[] {
  const out: Section[] = [];
  const matches = [...md.matchAll(HEADING_RX)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const next = matches[i + 1];
    const start = m.index! + m[0].length;
    const end = next ? next.index! : md.length;
    const heading = m[2].trim();
    const body = md.slice(start, end);
    const headingLinks = heading.match(LESSON_RE) || [];
    const bodyLinks = body.match(LESSON_RE) || [];
    const lessonUrls = Array.from(new Set([...headingLinks, ...bodyLinks]));
    out.push({ heading, body, lessonUrls });
  }
  return out;
}

function pickSectionsForEntity(sections: Section[], entity: "ebo" | "essay"): Section[] {
  return sections.filter(s => {
    const hay = norm(s.heading + "\n" + s.body);
    const hasEBO = /\b(e\.?\s*b\.?\s*o\.?|exploratory\b.*\bbibliograph)/.test(hay);
    const hasEssay = /\bessay|essays\b/.test(hay);
    return entity === "ebo" ? hasEBO : (hasEssay && !hasEBO);
  });
}

// Extract the lines that actually state due/late/penalty windows (verbatim)
function extractDueBlockFrom(text: string): string | null {
  // Keep up to the next blank line to capture late-penalty details that follow.
  const lines = text.split(/\r?\n/);
  const picked: string[] = [];
  let capturing = false;
  let buffer: string[] = [];

  const dueLike = (l: string) =>
    /\bdue\b|\bdeadline\b|\bsubmit\b|\blate\b|\bpenalt(y|ies)\b/i.test(l);

  for (const raw of lines) {
    const l = raw.trimEnd();
    if (!capturing && dueLike(l)) {
      capturing = true;
      buffer.push(l);
      continue;
    }
    if (capturing) {
      if (l.trim() === "") {
        // end of block
        break;
      } else {
        buffer.push(l);
      }
    }
  }
  if (buffer.length) {
    // Clean trailing whitespace lines
    while (buffer.length && buffer[buffer.length - 1].trim() === "") buffer.pop();
    picked.push(...buffer);
  }

  if (!picked.length) return null;
  return picked.join("\n");
}

function stripInlineLessonLinks(s: string): string {
  const mdLesson = /\[([^\]]+)\]\((https:\/\/westernu\.brightspace\.com\/d2l\/le\/lessons\/\d+\/(?:lessons|units|topics)\/\d+)\)/g;
  let out = s.replace(mdLesson, "$1");
  out = out.replace(LESSON_RE, ""); // raw urls
  out = out.replace(/[ \t]+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ").trim();
  return out;
}

// Deterministic answer for due/deadline questions
function answerDueDeterministically(query: string, md: string): { text: string, urls: string[] } | null {
  const sections = parseSections(md);
  const entity: "ebo" | "essay" = mentionsEBO(query) ? "ebo" : "essay";
  const pool = pickSectionsForEntity(sections, entity);

  // Search sections in order; return the first that yields a block.
  for (const s of pool) {
    const combined = `${s.heading}\n${s.body}`;
    const block = extractDueBlockFrom(combined);
    if (block) {
      const urls = Array.from(new Set(s.lessonUrls));
      const header = entity === "ebo" ? "EBO" : "essay";
      const text =
`According to the syllabus, the ${header} details are:

${block}`;
      return { text, urls };
    }
  }
  return null;
}

// ----------------- Server -----------------
serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  let body: { query: string };
  try { body = await req.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
  const query = (body?.query || "").trim();
  if (!query) return new Response("Missing query", { status: 400 });

  const materials = await readFileSafe(CONTENT_FILE);

  // 1) If it's clearly a due/deadline/late/submit question → deterministic path
  if (hasDueIntent(query) && (mentionsEBO(query) || mentionsEssayOnly(query))) {
    const det = answerDueDeterministically(query, materials);
    if (det) {
      const urlsBlock = det.urls.length
        ? `\n\nRelevant course page(s):\n${det.urls.map(u => `- ${u}`).join("\n")}`
        : "";
      const result =
`${det.text}${urlsBlock}

There may be errors in my responses; always refer to the course page: ${COURSE_PAGE}`;
      // Optional analytics
      let qualtricsStatus = "Qualtrics not called";
      if (QUALTRICS_API_TOKEN && QUALTRICS_SURVEY_ID && QUALTRICS_DATACENTER) {
        try {
          const payload = { values: { responseText: result, queryText: query, routedTo: "DETERMINISTIC_DUE" } };
          const qt = await fetch(
            `https://${QUALTRICS_DATACENTER}.qualtrics.com/API/v3/surveys/${QUALTRICS_SURVEY_ID}/responses`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-API-TOKEN": QUALTRICS_API_TOKEN },
              body: JSON.stringify(payload),
            },
          );
          qualtricsStatus = `Qualtrics status: ${qt.status}`;
        } catch { qualtricsStatus = "Qualtrics error"; }
      }
      return new Response(`${result}\n<!-- ${qualtricsStatus} -->`, {
        headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" },
      });
    }
    // If no deterministic block found, fall through to model (rare).
  }

  // 2) Otherwise call the model (kept strict and short)
  if (!OPENAI_API_KEY) return new Response("Missing OpenAI API key", { status: 500 });

  const entityHint = mentionsEBO(query) ? "EBO" : (mentionsEssayOnly(query) ? "Essay" : "EBO and Essay");
  const messages = [
    {
      role: "system",
      content: `
You answer questions exclusively about the ${entityHint}.
Use ONLY the text in the materials below. If relevant text exists, quote it verbatim (blockquote or quoted). It's acceptable to say "According to the syllabus".
Do not invent dates or deadlines. If unsure, say you cannot find it in the provided materials.

Materials:
${materials}
      `.trim(),
    },
    { role: "user", content: query },
  ];

  const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: OPENAI_MODEL, messages }),
  });

  const openaiJson = await openaiResp.json();
  const raw = openaiJson?.choices?.[0]?.message?.content || "No response from the assistant.";
  const sanitized = stripInlineLessonLinks(raw);

  // Try to attach Brightspace links from the best matching entity sections
  const secs = parseSections(materials);
  const pool = pickSectionsForEntity(secs, mentionsEBO(query) ? "ebo" : "essay");
  const urls = Array.from(new Set(pool.flatMap(s => s.lessonUrls)));
  const urlsBlock = urls.length
    ? `\n\nRelevant course page(s):\n${urls.map(u => `- ${u}`).join("\n")}`
    : "";

  const result =
`${sanitized}${urlsBlock}

There may be errors in my responses; always refer to the course page: ${COURSE_PAGE}`;

  // Optional analytics
  let qualtricsStatus = "Qualtrics not called";
  if (QUALTRICS_API_TOKEN && QUALTRICS_SURVEY_ID && QUALTRICS_DATACENTER) {
    try {
      const payload = { values: { responseText: result, queryText: query, routedTo: "MODEL" } };
      const qt = await fetch(
        `https://${QUALTRICS_DATACENTER}.qualtrics.com/API/v3/surveys/${QUALTRICS_SURVEY_ID}/responses`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-TOKEN": QUALTRICS_API_TOKEN },
          body: JSON.stringify(payload),
        },
      );
      qualtricsStatus = `Qualtrics status: ${qt.status}`;
    } catch { qualtricsStatus = "Qualtrics error"; }
  }

  return new Response(`${result}\n<!-- ${qualtricsStatus} -->`, {
    headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" },
  });
});
