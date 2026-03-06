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

function getWeekStart(dateStr?: string): string {
  const d = dateStr ? new Date(dateStr) : new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().split("T")[0];
}

async function getAccessToken(serviceAccountKey: string): Promise<string> {
  const sa = JSON.parse(serviceAccountKey);
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

// Check Drive storage quota
async function checkDriveQuota(accessToken: string): Promise<void> {
  const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=storageQuota", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  console.log("Drive storage quota:", JSON.stringify(data));
}

// Delete ALL files from service account's Drive to free quota
async function purgeAllDriveFiles(accessToken: string): Promise<number> {
  let deleted = 0;

  // First, empty the trash
  try {
    const trashRes = await fetch("https://www.googleapis.com/drive/v3/files/emptyTrash", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    console.log("Empty trash response:", trashRes.status, await trashRes.text());
  } catch (e) {
    console.error("Failed to empty trash:", e);
  }

  // Then list and delete all remaining files (including trashed ones)
  let pageToken: string | undefined;
  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("fields", "nextPageToken,files(id,name,trashed)");
    url.searchParams.set("q", "trashed=true or trashed=false");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("List files failed:", err);
      break;
    }

    const data = await res.json();
    const files = data.files || [];
    pageToken = data.nextPageToken;
    console.log(`Found ${files.length} files to delete`);

    for (const file of files) {
      try {
        const delRes = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        await delRes.text(); // consume body
        if (delRes.ok) {
          deleted++;
          console.log(`Deleted: ${file.name} (${file.id})`);
        }
      } catch (e) {
        console.error(`Failed to delete ${file.id}:`, e);
      }
    }
  } while (pageToken);

  return deleted;
}

const DRIVE_FOLDER_ID = "1YqpqvrEDQ9MkoMljaaB8VAIF4nvPwGMX";

async function createSpreadsheet(
  accessToken: string,
  title: string
): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> {
  const driveRes = await fetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: title,
      mimeType: "application/vnd.google-apps.spreadsheet",
      parents: [DRIVE_FOLDER_ID],
    }),
  });

  if (!driveRes.ok) {
    const err = await driveRes.text();
    throw new Error(`Create spreadsheet failed [${driveRes.status}]: ${err}`);
  }

  const driveData = await driveRes.json();
  const spreadsheetId = driveData.id;
  const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

  // Add headers
  try {
    const headerRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Sheet1!A1:F1?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          values: [["Job #", "Date", "Day", "Employee", "Hours", "Type"]],
        }),
      }
    );
    if (!headerRes.ok) {
      const err = await headerRes.text();
      console.error("Failed to add headers:", err);
    }
  } catch (e) {
    console.error("Header write error:", e);
  }

  return { spreadsheetId, spreadsheetUrl };
}

async function appendRows(
  accessToken: string,
  spreadsheetId: string,
  rows: string[][]
): Promise<void> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Sheet1!A:F:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
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

    const accessToken = await getAccessToken(GOOGLE_SERVICE_ACCOUNT_KEY);

    // Check quota
    await checkDriveQuota(accessToken);

    // Purge all old Drive files to free quota
    console.log("Purging old Drive files to free storage quota...");
    const deletedCount = await purgeAllDriveFiles(accessToken);
    console.log(`Purged ${deletedCount} old files`);

    // Also clear old weekly_sheets records from DB
    await supabase.from("weekly_sheets").delete().neq("id", "00000000-0000-0000-0000-000000000000");

    const weekStart = getWeekStart(entries[0]?.date);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const title = `MCR Payroll - Week of ${weekStart} to ${weekEnd.toISOString().split("T")[0]}`;

    const result = await createSpreadsheet(accessToken, title);
    const { spreadsheetId, spreadsheetUrl } = result;

    // Save to DB
    await supabase.from("weekly_sheets").insert({
      week_start: weekStart,
      spreadsheet_id: spreadsheetId,
      spreadsheet_url: spreadsheetUrl,
    });

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

    return new Response(
      JSON.stringify({
        success: true,
        spreadsheet_url: spreadsheetUrl,
        entries_added: entries.length,
        is_new_sheet: true,
        files_purged: deletedCount,
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
