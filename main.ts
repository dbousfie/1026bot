import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// --- ENV ---
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o"; // set to "gpt-4o" if you prefer
const SYLLABUS_LINK = Deno.env.get("SYLLABUS_LINK") || "https://westernu.brightspace.com/d2l/home/130641";
const CONTENT_FILE = Deno.env.get("CONTENT_FILE") || "syllabus.md";

// Route target for how-to EBO/Essay questions
const EBO_ESSAY_LINK =
  Deno.env.get("EBO_ESSAY_LINK") ||
  "https://westernu.brightspace.com/d2l/le/lessons/130641/topics/3411596";

// Optional Qualtrics logging (kept simple)
const QUALTRICS_API_TOKEN = Deno.env.get("QUALTRICS_API_TOKEN");
const QUALTRICS_SURVEY_ID = Deno.env.get("QUALTRICS_SURVEY_ID");
const QUALTRICS_DATACENTER = Deno.env.get("QUALTRICS_DATACENTER");

// --- Helpers (only routing; no fancy extractors) ---
function norm(s: string) { return (s || "").toLowerCase(); }

function mentionsEBOorEssay(q: string): boolean {
  const s = norm(q);
  return /\b(e\.?\s*b\.?\s*o\.?|exploratory\b.*\bbibliograph|essay|essays)\b/.test(s);
}

// Only reroute “how-to/instructions” type questions; logistics (due date, worth, etc.) stay here
function isInstructionIntent(q: string): boolean {
  const s = norm(q);
  const pats = [
    /\bhow\s+to\b/, /\bhow\s+do\s+i\b/, /\binstructions?\b/, /\bsteps?\b/,
    /\bformat(ting)?\b/, /\bcitations?\b/, /\breferences?\b/,
    /\bmla\b/, /\bchicago\b/, /\bturabian\b/, /\brubric\b/,
    /\brequirements?\b/, /\bword\s*count\b/, /\bstructure\b/,
    /\boutlines?\b/, /\btemplate\b/, /\bscaffold(ing)?\b/,
    /\bsubmit(ting)?\b/, /\bsubmission\b/, /\bchecklist\b/,
    /\bexamples?\b/, /\bmodel\s+paper\b/,
    /\bcan\s+i\s+use\b/, /\bis\s+it\s+okay\s+to\b/, /\bshould\s+i\b/,
  ];
  return pats.some(re => re.test(s));
}

function isLogisticsIntent(q: string): boolean {
  const s = norm(q);
  const pats = [
    /\bwhen\b.*\bdue\b/, /\bdue\s*date\b/, /\bdeadline\b/, /\bdue\b/,
    /\bworth\b/, /\bweight(ing)?\b/, /\bpercent(age)?\b/, /\bmarks?\b/,
    /\bopen(s|ing)?\b/, /\bclose(s|ing)?\b/, /\bavailability\b/, /\bwindow\b/,
    /\bdate\b/, /\btime\b/, /\bschedule\b/,
  ];
  return pats.some(re => re.test(s));
}

function shouldRouteToEboEssayBot(q: string): boolean {
  return mentionsEBOorEssay(q) && isInstructionIntent(q) && !isLogisticsIntent(q);
}

async function readFileSafe(path: string): Promise<string> {
  try { return await Deno.readTextFile(path); } catch { return ""; }
}

// --- Server ---
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

  // Simple routing: send how-to EBO/Essay questions to the dedicated bot/page
  if (shouldRouteToEboEssayBot(query)) {
    const routed = `This looks like an EBO/Essay instruction question. Please use the EBO/Essay assistant:\n${EBO_ESSAY_LINK}`;
    // Optional Qualtrics ping
    if (QUALTRICS_API_TOKEN && QUALTRICS_SURVEY_ID && QUALTRICS_DATACENTER) {
      try {
        await fetch(
          `https://${QUALTRICS_DATACENTER}.qualtrics.com/API/v3/surveys/${QUALTRICS_SURVEY_ID}/responses`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-API-TOKEN": QUALTRICS_API_TOKEN },
            body: JSON.stringify({ values: { responseText: routed, queryText: query, routedTo: "EBO_ESSAY_ASSISTANT" } }),
          },
        );
      } catch { /* ignore analytics errors */ }
    }
    return new Response(routed, { headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" } });
  }

  // Original behavior: load materials and ask the model (no extra post-processing)
  if (!OPENAI_API_KEY) return new Response("Missing OpenAI API key", { status: 500 });
  const materials = await readFileSafe(CONTENT_FILE);

  const messages = [
    {
      role: "system",
      content: `
You are an accurate assistant for a university course.
You have the course materials below (loaded at runtime).
When relevant, quote the text verbatim (blockquote or quoted). It is acceptable to introduce with "According to the syllabus".
Here are the materials:
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

  const result = `${baseResponse}\n\nThere may be errors in my responses; always refer to the course page: ${SYLLABUS_LINK}`;

  // Optional Qualtrics ping
  if (QUALTRICS_API_TOKEN && QUALTRICS_SURVEY_ID && QUALTRICS_DATACENTER) {
    try {
      await fetch(
        `https://${QUALTRICS_DATACENTER}.qualtrics.com/API/v3/surveys/${QUALTRICS_SURVEY_ID}/responses`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-TOKEN": QUALTRICS_API_TOKEN },
          body: JSON.stringify({ values: { responseText: result, queryText: query, routedTo: "GENERAL_ASSISTANT" } }),
        },
      );
    } catch { /* ignore analytics errors */ }
  }

  return new Response(result, {
    headers: { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" },
  });
});
