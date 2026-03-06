import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { workOrders } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    const systemPrompt = `You are a labor data parser for MCR Plumbing work orders. Extract labor information from work order text.

For each work order, extract:
- job_number: The job number (e.g., "25757")
- date: The date in YYYY-MM-DD format
- day_of_week: The day name (Monday, Tuesday, etc.)
- entries: An array of labor entries, each with:
  - employee_name: First name only (e.g., "Bryan")
  - hours: Number of hours (decimal)
  - type: "Regular" or "Off Hours"

Return a JSON array of parsed work orders. Be flexible with formatting - hours might appear as "8hr", "8 hrs", "8 hours", "8". Time type might be "Regular", "Reg", "OT", "Off Hours", "Off hours", "Overtime". Map OT/Overtime to "Off Hours".

Important: Only extract from the "Labor:" section of each work order. Ignore materials and description sections.`;

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
                        entries: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              employee_name: { type: "string" },
                              hours: { type: "number" },
                              type: { type: "string", enum: ["Regular", "Off Hours"] },
                            },
                            required: ["employee_name", "hours", "type"],
                            additionalProperties: false,
                          },
                        },
                      },
                      required: ["job_number", "date", "day_of_week", "entries"],
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
    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("parse-labor error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
