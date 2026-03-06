import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface LaborEntry {
  job_number: string;
  date: string;
  day_of_week: string;
  employee_name: string;
  hours: number;
  type: string;
}

// Get Monday of the current week
function getWeekStart(dateStr?: string): string {
  const d = dateStr ? new Date(dateStr) : new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().split("T")[0];
}

async function getAccessToken(serviceAccountKey: string): Promise<string> {
  const sa = JSON.parse(serviceAccountKey);

  // Create JWT header and claim set
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

  const unsignedToken = `${encode(header)}.${encode(claim)}`;

  // Import the private key and sign
  const pemContent = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\n/g, "");
  const binaryKey = Uint8Array.from(atob(pemContent), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsignedToken)
  );

  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const jwt = `${unsignedToken}.${sig}`;

  // Exchange JWT for access token
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

async function createSpreadsheet(
  accessToken: string,
  title: string
): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> {
  // Try minimal request first
  console.log("Creating spreadsheet with minimal payload...");
  const res = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: { title },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Full Google API error response:", err);
    console.error("Response headers:", JSON.stringify(Object.fromEntries(res.headers.entries())));
    throw new Error(`Create spreadsheet failed [${res.status}]: ${err}`);
  }

  const data = await res.json();
  return {
    spreadsheetId: data.spreadsheetId,
    spreadsheetUrl: data.spreadsheetUrl,
  };
}

async function appendRows(
  accessToken: string,
  spreadsheetId: string,
  rows: string[][]
): Promise<void> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Labor Data!A:F:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: rows }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Append rows failed [${res.status}]: ${err}`);
  }
}

async function deleteSpreadsheet(
  accessToken: string,
  fileId: string
): Promise<void> {
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response(null, { headers: corsHeaders });

  try {
    const GOOGLE_SERVICE_ACCOUNT_KEY = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");
    if (!GOOGLE_SERVICE_ACCOUNT_KEY) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not configured");

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { entries } = (await req.json()) as { entries: LaborEntry[] };
    if (!entries || entries.length === 0) throw new Error("No entries provided");

    // Get access token
    console.log("Attempting to get access token...");
    const accessToken = await getAccessToken(GOOGLE_SERVICE_ACCOUNT_KEY);
    console.log("Access token obtained, length:", accessToken?.length);

    // Quick test: check token info
    const tokenInfoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    const tokenInfo = await tokenInfoRes.json();
    console.log("Token info:", JSON.stringify(tokenInfo));

    // Test Drive API access first
    const driveTestRes = await fetch("https://www.googleapis.com/drive/v3/about?fields=user", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const driveTestBody = await driveTestRes.text();
    console.log("Drive API test:", driveTestRes.status, driveTestBody);

    // Determine week start from first entry's date
    const weekStart = getWeekStart(entries[0]?.date);

    // Check if we already have a sheet for this week
    const { data: existing } = await supabase
      .from("weekly_sheets")
      .select("*")
      .eq("week_start", weekStart)
      .maybeSingle();

    let spreadsheetId: string;
    let spreadsheetUrl: string;

    if (existing) {
      spreadsheetId = existing.spreadsheet_id;
      spreadsheetUrl = existing.spreadsheet_url;
    } else {
      // Create new spreadsheet
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      const title = `MCR Payroll - Week of ${weekStart} to ${weekEnd.toISOString().split("T")[0]}`;

      const result = await createSpreadsheet(accessToken, title);
      spreadsheetId = result.spreadsheetId;
      spreadsheetUrl = result.spreadsheetUrl;

      // Save to DB
      await supabase.from("weekly_sheets").insert({
        week_start: weekStart,
        spreadsheet_id: spreadsheetId,
        spreadsheet_url: spreadsheetUrl,
      });
    }

    // Append rows
    const rows = entries.map((e) => [
      e.job_number,
      e.date,
      e.day_of_week,
      e.employee_name,
      String(e.hours),
      e.type,
    ]);

    await appendRows(accessToken, spreadsheetId, rows);

    // Cleanup: delete sheets older than 2 months
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
    const cutoff = twoMonthsAgo.toISOString().split("T")[0];

    const { data: oldSheets } = await supabase
      .from("weekly_sheets")
      .select("*")
      .lt("week_start", cutoff);

    if (oldSheets && oldSheets.length > 0) {
      for (const sheet of oldSheets) {
        try {
          await deleteSpreadsheet(accessToken, sheet.spreadsheet_id);
        } catch (e) {
          console.error(`Failed to delete old sheet ${sheet.spreadsheet_id}:`, e);
        }
      }
      await supabase
        .from("weekly_sheets")
        .delete()
        .lt("week_start", cutoff);
    }

    return new Response(
      JSON.stringify({
        success: true,
        spreadsheet_url: spreadsheetUrl,
        entries_added: entries.length,
        is_new_sheet: !existing,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("push-to-sheets error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
