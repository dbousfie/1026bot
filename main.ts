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

/* ----------------- Query classification ----------------- */

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

/* ----------------- File helpers ----------------- */

async function readFileSafe(path: string): Promise<string> {
  try { return await Deno.readTextFile(path); } catch { return ""; }
}

type Section = { heading: string; body: string; lessonUrls: string[] };
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
    const hasEBO = /\b(e\.?\s*b\.?\s*o\.?|exploratory\b.*\bbibliograph)\b/.test(hay);
    const hasEssay = /\bessay|essays\b/.test(hay);
    return entity === "ebo" ? hasEBO : (hasEssay && !hasEBO);
  });
}

/* ----------------- Deterministic due/penalty extractor ----------------- */

/** Looks like a real date/time, not just a heading. */
const DATEISH =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b|\b\d{1,2}(st|nd|rd|th)?\b|\b\d{4}\b|\b\d{1,2}:\d{2}\s*(am|pm)\b/i;

function looksLikeDueLine(s: string): boolean {
  return /\b(due|deadline)\b/i.test(s) && DATEISH.test(s);
}

/** Convert markdown superscripts like 8^th^ → 8th; remove any other ^...^ safely. */
function cleanupSuperscripts(s: string): string {
  let out = s.replace(/(\d+)\^([a-z]{1,4})\^/gi, "$1$2");
  out = out.replace(/\^([^^\s]{1,10})\^/g, "$1");
  return out;
}

/** Extract a block: the first line that looks like a real due/deadline line,
 * then include every following non-blank line until the next blank line or 12 lines total.
 * This reliably pulls in the “no penalty / late penalty / final cutoff” lines.
 */
function extractDueBlockFrom(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (looksLikeDueLine(l)) { start = i; break; }
  }
  if (start === -1) return null;

  const buf: string[] = [];
  // include due line
  buf.push(cleanupSuperscripts(lines[start].trim()));

  // include subsequent non-blank lines (no filters) to capture penalties
  for (let j = start + 1; j < lines.length && buf.length < 12; j++) {
    const raw = lines[j];
    if (!raw.trim()) break;
    buf.push(cleanupSuperscripts(raw.trimEnd()));
  }

  // Trim trailing empty strings if any sneaked in
  while (buf.length && buf[buf.length - 1].trim() === "") buf.pop();

  return buf.join("\n");
}

function answerDueDeterministically(query: string, md: string): { text: string, urls: string[] } | null {
  const sections = parseSections(md);
  const entity: "ebo" | "essay" = mentionsEBO(query) ? "ebo" : "essay";
  const pool = pickSectionsForEntity(sections, entity);

  // Prefer sections whose headings mention "due"/"deadline" first
  const prioritized = [
    ...pool.filter(s => /\bdue|deadline\b/i.test(s.heading)),
    ...pool.filter(s => !/\bdue|deadline\b/i.test(s.heading)),
  ];

  for (const s of prioritized) {
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

/* ----------------- Server ----------------- */

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

  // Deterministic path for due/deadline/late/submit questions about EBO or Essay
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
    // If no block found, fall through to model.
  }

  // Model path (for other questions)
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
  const baseResponse = openaiJson?.choices?.[0]?.message?.content || "No response from the assistant.";

  const result =
`${baseResponse}

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
