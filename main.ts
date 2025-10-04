import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const QUALTRICS_API_TOKEN = Deno.env.get("QUALTRICS_API_TOKEN");
const QUALTRICS_SURVEY_ID = Deno.env.get("QUALTRICS_SURVEY_ID");
const QUALTRICS_DATACENTER = Deno.env.get("QUALTRICS_DATACENTER");
const SYLLABUS_LINK = Deno.env.get("SYLLABUS_LINK") || "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";

const CONTENT_FILE = Deno.env.get("CONTENT_FILE") || "syllabus.md";
const EBO_ESSAY_LINK =
  Deno.env.get("EBO_ESSAY_LINK") ||
  "https://westernu.brightspace.com/d2l/le/lessons/130641/topics/3411596";

/* ----------------- Query classification ----------------- */

function norm(s: string) {
  return (s || "").toLowerCase();
}

function mentionsEBO(q: string): boolean {
  const s = norm(q);
  return /\b(e\.?\s*b\.?\s*o\.?|exploratory\b.*\bbibliograph)/.test(s);
}

function mentionsEssayOnly(q: string): boolean {
  const s = norm(q);
  return /\bessay|essays\b/.test(s) && !mentionsEBO(q);
}

function hasLogisticsIntent(q: string): boolean {
  const s = norm(q);
  const pats = [
    /\bdue\s*date\b/,
    /\bdeadline\b/,
    /\bdue\b/,
    /\bwhen\b.*\bdue\b/,
    /\bweight(ing)?\b/,
    /\bworth\b/,
    /\bpercent(age)?\b/,
    /\bhow\s+many\s+marks\b/,
    /\bmarks?\b/,
    /\bopen(s|ing)?\b/,
    /\bclose(s|ing)?\b/,
    /\bavailability\b/,
    /\bwindow\b/,
    /\bdate\b/,
    /\btime\b/,
    /\bschedule\b/,
  ];
  return pats.some((re) => re.test(s));
}

function hasInstructionIntent(q: string): boolean {
  const s = norm(q);
  const generic = [
    /\bhow\s+to\b/,
    /\bhow\s+do\s+i\b/,
    /\binstructions?\b/,
    /\bsteps?\b/,
    /\bformat(ting)?\b/,
    /\bcitations?\b/,
    /\breferences?\b/,
    /\bmla\b/,
    /\bchicago\b/,
    /\bturabian\b/,
    /\brubric\b/,
    /\brequirements?\b/,
    /\bword\s*count\b/,
    /\bstructure\b/,
    /\boutlines?\b/,
    /\btemplate\b/,
    /\bscaffold(ing)?\b/,
    /\bsubmit(ting)?\b/,
    /\bsubmission\b/,
    /\bchecklist\b/,
    /\bexamples?\b/,
    /\bmodel\s+paper\b/,
    /\bcan\s+i\s+use\b/,
    /\bis\s+it\s+okay\s+to\b/,
    /\bshould\s+i\b/,
  ];
  return generic.some((re) => re.test(s));
}

/** Route only when:
 *  - mentions EBO or Essay, AND
 *  - instruction/how-to intent, AND
 *  - NOT a logistics query
 */
function shouldRouteToEboEssayBot(q: string): boolean {
  if (!(mentionsEBO(q) || mentionsEssayOnly(q))) return false;
  if (hasLogisticsIntent(q)) return false;
  return hasInstructionIntent(q);
}

/* ----------------- Context filtering ----------------- */

type Section = { heading: string; body: string };
const HEADING_RX = /^(#{1,6})\s+(.+)$/gm;

async function readFileSafe(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return "";
  }
}

function splitSections(md: string): Section[] {
  const matches = [...md.matchAll(HEADING_RX)];
  const sections: Section[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const next = matches[i + 1];
    const start = m.index! + m[0].length;
    const end = next ? next.index! : md.length;
    sections.push({
      heading: m[2].trim(),
      body: md.slice(start, end),
    });
  }
  return sections;
}

function filterContext(md: string, q: string): string {
  const secs = splitSections(md);
  const qIsEBO = mentionsEBO(q);
  const qIsEssayOnly = mentionsEssayOnly(q);

  if (!hasLogisticsIntent(q)) return md; // only filter for logistics

  // Build predicate based on which entity user asked about
  const want = qIsEBO ? "ebo" : qIsEssayOnly ? "essay" : null;
  if (!want) return md;

  const filtered: string[] = [];
  for (const s of secs) {
    const hay = (s.heading + "\n" + s.body).toLowerCase();
    if (want === "ebo") {
      // Keep EBO-specific sections; try to avoid generic "essay" only sections.
      if (/\b(e\.?\s*b\.?\s*o\.?|exploratory\b.*\bbibliograph)\b/.test(hay)) {
        filtered.push(`# ${s.heading}\n${s.body}`);
      }
    } else if (want === "essay") {
      if (/\bessay|essays\b/.test(hay) && !/\b(e\.?\s*b\.?\s*o\.?|exploratory\b.*\bbibliograph)\b/.test(hay)) {
        filtered.push(`# ${s.heading}\n${s.body}`);
      }
    }
  }

  // Fallback to full md if nothing matched (safer than empty)
  return filtered.length ? filtered.join("\n") : md;
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

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: { query: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const query = (body?.query || "").trim();
  if (!query) return new Response("Missing query", { status: 400 });

  // 1) Route instruction/how-to questions about EBO/Essay
  if (shouldRouteToEboEssayBot(query)) {
    const routed = `This looks like an EBO/Essay instruction question. Please use the EBO/Essay assistant:\n${EBO_ESSAY_LINK}`;

    // Optional analytics
    let qualtricsStatus = "Qualtrics not called";
    if (QUALTRICS_API_TOKEN && QUALTRICS_SURVEY_ID && QUALTRICS_DATACENTER) {
      try {
        const payload = {
          values: { responseText: routed, queryText: query, routedTo: "EBO_ESSAY_ASSISTANT" },
        };
        const qt = await fetch(
          `https://${QUALTRICS_DATACENTER}.qualtrics.com/API/v3/surveys/${QUALTRICS_SURVEY_ID}/responses`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-API-TOKEN": QUALTRICS_API_TOKEN },
            body: JSON.stringify(payload),
          },
        );
        qualtricsStatus = `Qualtrics status: ${qt.status}`;
      } catch {
        qualtricsStatus = "Qualtrics error";
      }
    }
    return new Response(`${routed}\n<!-- ${qualtricsStatus} -->`, {
      headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" },
    });
  }

  // 2) Otherwise, syllabus/logistics flow with context filtered to the right entity (EBO vs Essay)
  if (!OPENAI_API_KEY) return new Response("Missing OpenAI API key", { status: 500 });

  const fullMaterials = await readFileSafe(CONTENT_FILE);
  const materials = filterContext(fullMaterials, query);

  const messages = [
    {
      role: "system",
      content: `
You are an accurate assistant for a university course.
You have course materials below (loaded at runtime).
When answering:
- Quote relevant text verbatim (quoted or in a blockquote). It's acceptable to say "According to the syllabus."
- Answer only about the entity present in the provided materials (if the context is EBO-only, do not discuss Essay sections, and vice versa).
Materials:
${materials}
      `.trim(),
    },
    { role: "user", content: query },
  ];

  const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: OPENAI_MODEL, messages }),
  });

  const openaiJson = await openaiResponse.json();
  const baseResponse = openaiJson?.choices?.[0]?.message?.content || "No response from the assistant.";

  const result = `${baseResponse}\n\nThere may be errors in my responses; always refer to the course page: ${SYLLABUS_LINK}`;

  // Optional Qualtrics logging
  let qualtricsStatus = "Qualtrics not called";
  if (QUALTRICS_API_TOKEN && QUALTRICS_SURVEY_ID && QUALTRICS_DATACENTER) {
    try {
      const payload = { values: { responseText: result, queryText: query, routedTo: "GENERAL_ASSISTANT" } };
      const qt = await fetch(
        `https://${QUALTRICS_DATACENTER}.qualtrics.com/API/v3/surveys/${QUALTRICS_SURVEY_ID}/responses`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-TOKEN": QUALTRICS_API_TOKEN },
          body: JSON.stringify(payload),
        },
      );
      qualtricsStatus = `Qualtrics status: ${qt.status}`;
    } catch {
      qualtricsStatus = "Qualtrics error";
    }
  }

  return new Response(`${result}\n<!-- ${qualtricsStatus} -->`, {
    headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" },
  });
});
