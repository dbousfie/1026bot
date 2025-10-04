import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const QUALTRICS_API_TOKEN = Deno.env.get("QUALTRICS_API_TOKEN");
const QUALTRICS_SURVEY_ID = Deno.env.get("QUALTRICS_SURVEY_ID");
const QUALTRICS_DATACENTER = Deno.env.get("QUALTRICS_DATACENTER");
const SYLLABUS_LINK = Deno.env.get("SYLLABUS_LINK") || "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";

// Destination for EBO/Essay instructions
const EBO_ESSAY_LINK =
  Deno.env.get("EBO_ESSAY_LINK") ||
  "https://westernu.brightspace.com/d2l/le/lessons/130641/topics/3411596";

// Optional content file for this bot (kept for general context)
const CONTENT_FILE = Deno.env.get("CONTENT_FILE") || "syllabus.md";

// ---------- Intent routing ----------

function hasEboEssayMention(q: string): boolean {
  const s = q.toLowerCase();
  // EBO variants + essay
  return (
    /\b(e\.?\s*b\.?\s*o\.?|exploratory\b.*\bbibliograph)/.test(s) ||
    /\bessay|essays\b/.test(s)
  );
}

function hasInstructionIntent(q: string): boolean {
  const s = q.toLowerCase();
  // Words that strongly indicate "how to complete/do/format/submit"
  const patterns = [
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
  ];
  return patterns.some((re) => re.test(s));
}

function hasLogisticsOnlyIntent(q: string): boolean {
  const s = q.toLowerCase();
  // “Syllabus-okay” topics: due dates, deadlines, weighting, availability windows
  const patterns = [
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
  return patterns.some((re) => re.test(s));
}

/**
 * Route only when:
 *  - EBO/essay is mentioned, AND
 *  - Instructional intent detected, AND
 *  - Not clearly a logistics-only query.
 */
function shouldRouteToEboEssay(query: string): boolean {
  if (!hasEboEssayMention(query)) return false;
  if (hasLogisticsOnlyIntent(query)) return false;
  return hasInstructionIntent(query);
}

// ---------- Utilities ----------

async function readFileSafe(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return "";
  }
}

// ---------- Server ----------

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
  if (!query) {
    return new Response("Missing query", { status: 400 });
  }

  // --- Route instructional EBO/Essay questions away from this bot ---
  if (shouldRouteToEboEssay(query)) {
    const routed = `This looks like an EBO/Essay instruction question. Please use the EBO/Essay assistant:\n${EBO_ESSAY_LINK}`;

    // Optional analytics
    let qualtricsStatus = "Qualtrics not called";
    if (QUALTRICS_API_TOKEN && QUALTRICS_SURVEY_ID && QUALTRICS_DATACENTER) {
      try {
        const qualtricsPayload = {
          values: {
            responseText: routed,
            queryText: query,
            routedTo: "EBO_ESSAY_ASSISTANT",
          },
        };
        const qt = await fetch(
          `https://${QUALTRICS_DATACENTER}.qualtrics.com/API/v3/surveys/${QUALTRICS_SURVEY_ID}/responses`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-TOKEN": QUALTRICS_API_TOKEN,
            },
            body: JSON.stringify(qualtricsPayload),
          },
        );
        qualtricsStatus = `Qualtrics status: ${qt.status}`;
      } catch {
        qualtricsStatus = "Qualtrics error";
      }
    }

    return new Response(`${routed}\n<!-- ${qualtricsStatus} -->`, {
      headers: {
        "Content-Type": "text/plain",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // --- Otherwise, normal flow for syllabus-ish questions ---

  if (!OPENAI_API_KEY) {
    return new Response("Missing OpenAI API key", { status: 500 });
  }

  const materials = await readFileSafe(CONTENT_FILE);

  const messages = [
    {
      role: "system",
      content: `
You are an accurate assistant for a university course.
You have course materials below (loaded at runtime).

When answering:
- If relevant text exists, quote it verbatim (quoted or in a blockquote). It is acceptable to introduce quotations with phrases like "According to the syllabus".
- Do not include Brightspace lesson/unit URLs in your body; external links may be appended by the system if needed.

Materials:
${materials}
      `.trim(),
    },
    { role: "user", content: query },
  ];

  const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
    }),
  });

  const openaiJson = await openaiResponse.json();
  const baseResponse =
    openaiJson?.choices?.[0]?.message?.content || "No response from the assistant.";

  const result =
    `${baseResponse}\n\nThere may be errors in my responses; always refer to the course page: ${SYLLABUS_LINK}`;

  // Optional Qualtrics logging
  let qualtricsStatus = "Qualtrics not called";
  if (QUALTRICS_API_TOKEN && QUALTRICS_SURVEY_ID && QUALTRICS_DATACENTER) {
    try {
      const qualtricsPayload = {
        values: {
          responseText: result,
          queryText: query,
          routedTo: "GENERAL_ASSISTANT",
        },
      };
      const qt = await fetch(
        `https://${QUALTRICS_DATACENTER}.qualtrics.com/API/v3/surveys/${QUALTRICS_SURVEY_ID}/responses`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-TOKEN": QUALTRICS_API_TOKEN,
          },
          body: JSON.stringify(qualtricsPayload),
        },
      );
      qualtricsStatus = `Qualtrics status: ${qt.status}`;
    } catch {
      qualtricsStatus = "Qualtrics error";
    }
  }

  return new Response(`${result}\n<!-- ${qualtricsStatus} -->`, {
    headers: {
      "Content-Type": "text/plain",
      "Access-Control-Allow-Origin": "*",
    },
  });
});
