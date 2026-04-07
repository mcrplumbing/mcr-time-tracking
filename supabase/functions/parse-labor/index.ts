import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface ValidationFlag {
  level: "error" | "warning" | "info";
  message: string;
  woIndex?: number;
  entryIndex?: number;
}

function matchEmployee(
  parsed: string,
  roster: { first_name: string; full_name: string | null }[]
): { matched: string; confidence: "high" | "medium" | "low"; original: string } {
  const lower = parsed.trim().toLowerCase();

  const exact = roster.find((e) => e.first_name.toLowerCase() === lower);
  if (exact) return { matched: exact.first_name, confidence: "high", original: parsed };

  for (const emp of roster) {
    if (emp.full_name) {
      const parts = emp.full_name.toLowerCase().split(/\s+/);
      if (parts.some((p) => p === lower)) {
        return { matched: emp.first_name, confidence: "high", original: parsed };
      }
    }
  }

  const prefix = roster.filter((e) => e.first_name.toLowerCase().startsWith(lower));
  if (prefix.length === 1) {
    return { matched: prefix[0].first_name, confidence: "medium", original: parsed };
  }

  const partial = roster.filter(
    (e) =>
      e.first_name.toLowerCase().includes(lower) ||
      lower.includes(e.first_name.toLowerCase())
  );
  if (partial.length === 1) {
    return { matched: partial[0].first_name, confidence: "medium", original: parsed };
  }

  return { matched: parsed, confidence: "low", original: parsed };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { workOrders } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);
    const { data: employees } = await sb.from("employees").select("first_name, full_name");
    const roster = employees || [];

    // Fetch customer mappings for AI prompt
    const { data: customerMappings } = await sb.from("customer_mappings").select("keyword, customer_name");
    const mappings = customerMappings || [];

    let customerNotes = "";
    if (mappings.length > 0) {
      customerNotes = "\n\nKNOWN CUSTOMER MAPPINGS (use these to normalize customer names):\n" +
        mappings.map(m => `"${m.keyword}" → "${m.customer_name}"`).join("\n");
    }

    const systemPrompt = `You are a labor data parser for MCR Plumbing work orders. Extract labor information from work order text.

For each work order, extract:
- job_number: The job number (e.g., "25757")
- date: The date in YYYY-MM-DD format
- day_of_week: The day name (Monday, Tuesday, etc.)
- customer: The customer/client name (e.g., "USC", "CSMC", "LCS", "City of Hope"). If not explicitly stated, use the site or location name. If truly unknown, use "UNKNOWN".
- entries: An array of labor entries, each with:
  - employee_name: The name as written in the source text (preserve original spelling)
  - hours: Number of hours (decimal)
  - type: "Regular", "Off Hours", "Vacation", or "Sick"

Return a JSON array of parsed work orders. Be flexible with formatting - hours might appear as "8hr", "8 hrs", "8 hours", "8". Time type might be "Regular", "Reg", "OT", "Off Hours", "Off hours", "Overtime", "Vacation", "PTO", "V", "Sick", "S". Map OT/Overtime to "Off Hours". Map PTO/V to "Vacation". Map S to "Sick".

CRITICAL RULES:
- Only extract from the "Labor:" section of each work order. Ignore materials and description sections.
- Preserve the EXACT employee name as written in the source text. Do NOT correct spelling or guess names.
- If a name is ambiguous or hard to read, output it exactly as it appears.
- Extract hours as-is from the text — do not invent or calculate hours that are not explicitly stated.
- The customer field should be the abbreviated client name (e.g., "USC", "CSMC", "LCS") when available.`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Parse labor data from these work orders:\n\n${workOrders}` },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "extract_labor",
              description: "Extract labor entries from work orders",
              parameters: {
                type: "object",
                properties: {
                  work_orders: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        job_number: { type: "string" },
                        date: { type: "string" },
                        day_of_week: { type: "string" },
                        customer: { type: "string", description: "Customer/client name abbreviation" },
                        entries: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              employee_name: { type: "string" },
                              hours: { type: "number" },
                              type: { type: "string", enum: ["Regular", "Off Hours", "Vacation", "Sick"] },
                            },
                            required: ["employee_name", "hours", "type"],
                            additionalProperties: false,
                          },
                        },
                      },
                      required: ["job_number", "date", "day_of_week", "customer", "entries"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["work_orders"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "extract_labor" } },
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again shortly." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Please add credits in workspace settings." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const t = await response.text();
      console.error("AI gateway error:", response.status, t);
      throw new Error(`AI gateway error: ${response.status}`);
    }

    const data = await response.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) throw new Error("No tool call in AI response");

    const parsed = JSON.parse(toolCall.function.arguments);
    const workOrdersArr = parsed.work_orders || [];

    const flags: ValidationFlag[] = [];
    let needsReview = false;

    for (let woIdx = 0; woIdx < workOrdersArr.length; woIdx++) {
      const wo = workOrdersArr[woIdx];

      if (wo.date && !/^\d{4}-\d{2}-\d{2}$/.test(wo.date)) {
        flags.push({
          level: "warning",
          message: `Work order ${wo.job_number}: Date "${wo.date}" may not be in YYYY-MM-DD format`,
          woIndex: woIdx,
        });
      }

      for (let eIdx = 0; eIdx < wo.entries.length; eIdx++) {
        const entry = wo.entries[eIdx];

        const nameResult = matchEmployee(entry.employee_name, roster);
        entry.original_name = nameResult.original;
        entry.matched_name = nameResult.matched;
        entry.confidence = nameResult.confidence;

        if (nameResult.confidence === "low") {
          flags.push({
            level: "error",
            message: `"${nameResult.original}" not found in employee roster`,
            woIndex: woIdx,
            entryIndex: eIdx,
          });
          needsReview = true;
        } else if (nameResult.confidence === "medium") {
          flags.push({
            level: "warning",
            message: `"${nameResult.original}" partially matched to "${nameResult.matched}" — please verify`,
            woIndex: woIdx,
            entryIndex: eIdx,
          });
        }

        entry.employee_name = nameResult.matched;

        if (entry.hours > 16) {
          flags.push({
            level: "warning",
            message: `${entry.employee_name}: ${entry.hours} hours seems high (>16). Please verify.`,
            woIndex: woIdx,
            entryIndex: eIdx,
          });
        }
        if (entry.hours <= 0) {
          flags.push({
            level: "error",
            message: `${entry.employee_name}: ${entry.hours} hours is invalid`,
            woIndex: woIdx,
            entryIndex: eIdx,
          });
          needsReview = true;
        }
        if (entry.hours % 0.5 !== 0) {
          flags.push({
            level: "info",
            message: `${entry.employee_name}: ${entry.hours} hours is not a standard half-hour increment`,
            woIndex: woIdx,
            entryIndex: eIdx,
          });
        }
      }

      const seen = new Set<string>();
      for (let eIdx = 0; eIdx < wo.entries.length; eIdx++) {
        const entry = wo.entries[eIdx];
        const key = `${entry.employee_name.toLowerCase()}|${entry.type}`;
        if (seen.has(key)) {
          flags.push({
            level: "warning",
            message: `${entry.employee_name} has duplicate "${entry.type}" entry in job ${wo.job_number}`,
            woIndex: woIdx,
            entryIndex: eIdx,
          });
        }
        seen.add(key);
      }
    }

    const errorCount = flags.filter((f) => f.level === "error").length;
    const warningCount = flags.filter((f) => f.level === "warning").length;

    return new Response(
      JSON.stringify({
        work_orders: workOrdersArr,
        flags,
        needsReview,
        summary: {
          totalFlags: flags.length,
          errors: errorCount,
          warnings: warningCount,
        },
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (e) {
    console.error("parse-labor error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
