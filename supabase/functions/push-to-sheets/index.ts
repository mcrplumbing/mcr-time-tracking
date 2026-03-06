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

const SPREADSHEET_ID = "1ucmQlW-X8uU6SEu0wSY2xEXynVQwgxho_uK3lpEk304";

function normalizeDayName(day: string): string {
  const d = day.toUpperCase().trim();
  if (d.startsWith("MON")) return "MONDAY";
  if (d.startsWith("TUE")) return "TUESDAY";
  if (d.startsWith("WED")) return "WEDNESDAY";
  if (d.startsWith("THU")) return "THURSDAY";
  if (d.startsWith("FRI")) return "FRIDAY";
  if (d.startsWith("SAT") || d.startsWith("SUN")) return "WEEKEND";
  return d;
}

function getWeekEnd(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getDay();
  const diff = 7 - day; // days until Sunday
  const sunday = new Date(d);
  sunday.setDate(d.getDate() + (day === 0 ? 0 : diff));
  return sunday.toISOString().split("T")[0];
}

function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
}

async function getAccessToken(serviceAccountKey: string): Promise<string> {
  const sa = JSON.parse(serviceAccountKey);
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
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
    "pkcs8", binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(unsignedToken)
  );
  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwt = `${unsignedToken}.${sig}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  if (!tokenRes.ok) throw new Error(`Token exchange failed: ${await tokenRes.text()}`);
  return (await tokenRes.json()).access_token;
}

async function sheetsApi(accessToken: string, path: string, method = "GET", body?: unknown): Promise<any> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}${path}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`Sheets API [${res.status}]: ${await res.text()}`);
  return res.json();
}

// Find the tab and its sheetId
async function findTab(accessToken: string, tabTitle: string): Promise<{ sheetId: number; title: string } | null> {
  const meta = await sheetsApi(accessToken, "?fields=sheets.properties");
  // Try exact match first, then partial match on "WE"
  for (const s of meta.sheets || []) {
    if (s.properties.title === tabTitle) {
      return { sheetId: s.properties.sheetId, title: s.properties.title };
    }
  }
  // Partial match: find tab containing the date
  for (const s of meta.sheets || []) {
    if (s.properties.title.toUpperCase().includes("WE") && s.properties.title.includes(tabTitle.replace("WE ", ""))) {
      return { sheetId: s.properties.sheetId, title: s.properties.title };
    }
  }
  return null;
}

// Read column A to find day sections and employee header row
async function findDaySection(
  accessToken: string,
  tabTitle: string,
  dayName: string
): Promise<{ headerRow: number; employees: string[]; insertRow: number }> {
  const range = encodeURIComponent(`${tabTitle}!A1:Z200`);
  const data = await sheetsApi(accessToken, `/values/${range}`);
  const rows: string[][] = data.values || [];

  let headerRow = -1;

  // Find the row with this day name in column A
  for (let i = 0; i < rows.length; i++) {
    const cellA = (rows[i]?.[0] || "").toUpperCase().trim();
    if (cellA.includes(dayName)) {
      headerRow = i;
      break;
    }
  }

  if (headerRow === -1) throw new Error(`Day "${dayName}" not found in sheet "${tabTitle}"`);

  // Employee names might be in the day row itself or the row below it
  // Check both rows and use whichever has names starting from column C
  let employeeRow = headerRow;
  let employees: string[] = [];

  for (const candidateRow of [headerRow, headerRow + 1]) {
    const candidateCells = rows[candidateRow] || [];
    const candidateNames: string[] = [];
    for (let c = 2; c < candidateCells.length; c++) {
      const name = (candidateCells[c] || "").trim();
      if (name) candidateNames.push(name);
      else break;
    }
    if (candidateNames.length > 0) {
      employees = candidateNames;
      employeeRow = candidateRow;
      break;
    }
  }

  console.log(`Employee names found in row ${employeeRow}: ${employees.join(",")}`);

  // Find where to insert: right after employee header row, or after existing job entries.
  let insertRow = employeeRow + 1;

  // Now find the first empty row in column B (job number column)
  for (let i = insertRow; i < rows.length; i++) {
    const cellB = (rows[i]?.[1] || "").trim();
    if (!cellB) {
      insertRow = i;
      break;
    }
    insertRow = i + 1;
  }

  return { headerRow, employees, insertRow };
}

interface PivotRow {
  job_number: string;
  isOffHours: boolean;
  hoursByEmployee: Map<string, number>;
}

function pivotEntries(entries: LaborEntry[], employees: string[]): PivotRow[] {
  const groups = new Map<string, PivotRow>();

  for (const entry of entries) {
    const key = `${entry.job_number}|${entry.type}`;
    if (!groups.has(key)) {
      groups.set(key, {
        job_number: entry.job_number,
        isOffHours: entry.type === "Off Hours",
        hoursByEmployee: new Map(),
      });
    }
    const group = groups.get(key)!;
    // Match employee name case-insensitively
    const matched = employees.find(e => e.toUpperCase() === entry.employee_name.toUpperCase());
    if (matched) {
      group.hoursByEmployee.set(matched, (group.hoursByEmployee.get(matched) || 0) + entry.hours);
    }
  }

  const rows = Array.from(groups.values());
  rows.sort((a, b) => {
    if (a.job_number !== b.job_number) return a.job_number.localeCompare(b.job_number);
    return a.isOffHours ? 1 : -1; // Regular first, then off-hours
  });
  return rows;
}

async function writeJobRows(
  accessToken: string,
  sheetId: number,
  tabTitle: string,
  insertRow: number,
  pivotRows: PivotRow[],
  employees: string[]
) {
  const requests: any[] = [];

  // Insert new rows below the header for data
  requests.push({
    insertDimension: {
      range: {
        sheetId,
        dimension: "ROWS",
        startIndex: insertRow,
        endIndex: insertRow + pivotRows.length,
      },
      inheritFromBefore: true,
    },
  });

  // Build cell data
  const rowData: any[] = [];
  for (const pr of pivotRows) {
    const textColor = pr.isOffHours
      ? { red: 1, green: 0, blue: 0 }
      : { red: 0, green: 0, blue: 0 };
    const fmt = {
      textFormat: {
        foregroundColorStyle: { rgbColor: textColor },
        fontSize: 12,
      },
    };

    const cells: any[] = [
      {}, // Column A - leave blank
      { userEnteredValue: { stringValue: pr.job_number }, userEnteredFormat: fmt },
    ];

    for (const emp of employees) {
      const hrs = pr.hoursByEmployee.get(emp);
      cells.push(hrs
        ? { userEnteredValue: { numberValue: hrs }, userEnteredFormat: fmt }
        : {}
      );
    }
    rowData.push({ values: cells });
  }

  // Only update values and text format, NOT borders
  requests.push({
    updateCells: {
      rows: rowData,
      start: { sheetId, rowIndex: insertRow, columnIndex: 0 },
      fields: "userEnteredValue,userEnteredFormat.textFormat",
    },
  });

  await sheetsApi(accessToken, ":batchUpdate", "POST", { requests });
}

// Update the recap section (columns O-R) with weekly totals per employee
async function updateRecapSection(
  accessToken: string,
  sheetId: number,
  tabTitle: string,
  allEntries: LaborEntry[]
) {
  // Read columns O-R to find employee names and where to write
  const range = encodeURIComponent(`${tabTitle}!O1:R200`);
  const data = await sheetsApi(accessToken, `/values/${range}`);
  const rows: string[][] = data.values || [];

  // Sum hours per employee across all entries
  const regularByEmployee = new Map<string, number>();
  const offHoursByEmployee = new Map<string, number>();

  for (const entry of allEntries) {
    const name = entry.employee_name.toUpperCase().trim();
    if (entry.type === "Off Hours") {
      offHoursByEmployee.set(name, (offHoursByEmployee.get(name) || 0) + entry.hours);
    } else {
      regularByEmployee.set(name, (regularByEmployee.get(name) || 0) + entry.hours);
    }
  }

  console.log("Recap - Regular hours:", Object.fromEntries(regularByEmployee));
  console.log("Recap - Off hours:", Object.fromEntries(offHoursByEmployee));

  // Find employee names in column O and write totals to Q and R
  const requests: any[] = [];

  for (let i = 0; i < rows.length; i++) {
    const nameInO = (rows[i]?.[0] || "").trim();
    if (!nameInO) continue;

    const nameUpper = nameInO.toUpperCase();
    const regular = regularByEmployee.get(nameUpper);
    const offHours = offHoursByEmployee.get(nameUpper);

    if (regular !== undefined || offHours !== undefined) {
      const cells: any[] = [
        {}, // Column O - skip (name already there)
        {}, // Column P - skip (formula)
        regular !== undefined
          ? { userEnteredValue: { numberValue: regular } }
          : {}, // Column Q - Regular
        offHours !== undefined
          ? { userEnteredValue: { numberValue: offHours } }
          : {}, // Column R - Off Hours
      ];

      requests.push({
        updateCells: {
          rows: [{ values: cells }],
          start: { sheetId, rowIndex: i, columnIndex: 14 }, // Column O = index 14
          fields: "userEnteredValue",
        },
      });

      console.log(`Recap: ${nameInO} -> Regular: ${regular || 0}, Off Hours: ${offHours || 0}`);
    }
  }

  if (requests.length > 0) {
    await sheetsApi(accessToken, ":batchUpdate", "POST", { requests });
    console.log(`Updated recap for ${requests.length} employees`);
  } else {
    console.log("No matching employees found in recap section");
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

    // Determine week ending date and tab name
    const weekEnd = getWeekEnd(entries[0].date);
    const tabTitle = `WE ${formatDateShort(weekEnd)}`;
    console.log(`Looking for tab: ${tabTitle}`);

    const tab = await findTab(accessToken, tabTitle);
    if (!tab) throw new Error(`Tab "${tabTitle}" not found. Please create the weekly sheet first.`);
    console.log(`Found tab: ${tab.title} (sheetId: ${tab.sheetId})`);

    // Group entries by day
    const entriesByDay = new Map<string, LaborEntry[]>();
    for (const entry of entries) {
      const day = normalizeDayName(entry.day_of_week);
      if (!entriesByDay.has(day)) entriesByDay.set(day, []);
      entriesByDay.get(day)!.push(entry);
    }

    let totalAdded = 0;
    for (const [dayName, dayEntries] of entriesByDay) {
      console.log(`Processing ${dayName}: ${dayEntries.length} entries`);

      // Find the day section in the sheet
      const section = await findDaySection(accessToken, tab.title, dayName);
      console.log(`${dayName}: headerRow=${section.headerRow}, insertRow=${section.insertRow}, employees=${section.employees.join(",")}`);

      // Pivot flat entries into job rows with employee columns
      const pivotRows = pivotEntries(dayEntries, section.employees);

      // Write rows
      await writeJobRows(accessToken, tab.sheetId, tab.title, section.insertRow, pivotRows, section.employees);
      totalAdded += pivotRows.length;
      console.log(`Inserted ${pivotRows.length} rows into ${dayName}`);
    }

    // Update recap section with weekly totals
    await updateRecapSection(accessToken, tab.sheetId, tab.title, entries);

    return new Response(
      JSON.stringify({
        success: true,
        spreadsheet_url: `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`,
        entries_added: totalAdded,
        tab: tab.title,
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
