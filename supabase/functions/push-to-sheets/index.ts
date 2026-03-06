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

// Day sections: each day gets 25 rows in the sheet
const DAY_NAMES = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "WEEKEND"];
const HEADER_ROWS = 4; // Title rows at top
const ROWS_PER_DAY = 25;
const JOB_ROWS_PER_DAY = 18; // Max job rows before totals

// Map day_of_week from parsed data to our day names
function normalizeDayName(day: string): string {
  const d = day.toUpperCase().trim();
  if (d.startsWith("MON")) return "MONDAY";
  if (d.startsWith("TUE")) return "TUESDAY";
  if (d.startsWith("WED")) return "WEDNESDAY";
  if (d.startsWith("THU")) return "THURSDAY";
  if (d.startsWith("FRI")) return "FRIDAY";
  if (d.startsWith("SAT") || d.startsWith("SUN")) return "WEEKEND";
  return "MONDAY";
}

function getDayIndex(dayName: string): number {
  return DAY_NAMES.indexOf(dayName);
}

// Row where a day's header starts (0-indexed)
function dayHeaderRow(dayIndex: number): number {
  return HEADER_ROWS + dayIndex * ROWS_PER_DAY;
}

function getWeekStart(dateStr?: string): string {
  const d = dateStr ? new Date(dateStr) : new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().split("T")[0];
}

function getWeekEnd(weekStart: string): string {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + 6);
  return d.toISOString().split("T")[0];
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
}

// Column index to A1 notation letter
function colLetter(col: number): string {
  let s = "";
  let c = col;
  while (c >= 0) {
    s = String.fromCharCode(65 + (c % 26)) + s;
    c = Math.floor(c / 26) - 1;
  }
  return s;
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

async function sheetsApi(
  accessToken: string,
  path: string,
  method = "GET",
  body?: unknown
): Promise<any> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Sheets API [${res.status}]: ${err}`);
  }
  return res.json();
}

async function getSheetId(accessToken: string, tabTitle: string): Promise<number | null> {
  const meta = await sheetsApi(accessToken, "?fields=sheets.properties");
  const sheet = meta.sheets?.find((s: any) => s.properties.title === tabTitle);
  return sheet ? sheet.properties.sheetId : null;
}

async function createWeekTab(
  accessToken: string,
  tabTitle: string,
  weekStart: string,
  employees: string[]
): Promise<number> {
  // Create the tab
  const addRes = await sheetsApi(accessToken, ":batchUpdate", "POST", {
    requests: [{ addSheet: { properties: { title: tabTitle, index: 0 } } }],
  });

  const sheetId = addRes.replies[0].addSheet.properties.sheetId;
  const weekEnd = getWeekEnd(weekStart);
  const numCols = 2 + employees.length; // A=day, B=job#, C+=employees
  const recapCol = numCols + 1; // One gap column

  // Build all the cell data for the template
  const requests: any[] = [];

  // --- Title rows ---
  // Row 0: DAILY TIME TRACKING
  // Row 1: WE | date | legends
  // Row 2: blank
  const titleData = [
    [{ userEnteredValue: { stringValue: "DAILY TIME TRACKING" }, userEnteredFormat: { textFormat: { bold: true, fontSize: 12 } } }],
    [
      { userEnteredValue: { stringValue: "WE" }, userEnteredFormat: { textFormat: { bold: true } } },
      { userEnteredValue: { stringValue: formatDate(weekEnd) } },
      {},
      { userEnteredValue: { stringValue: "BLACK = REGULAR HOURS" }, userEnteredFormat: { textFormat: { bold: true } } },
      {},
      { userEnteredValue: { stringValue: "RED = OFF HOURS" }, userEnteredFormat: { textFormat: { bold: true, foregroundColorStyle: { rgbColor: { red: 1, green: 0, blue: 0 } } } } },
    ],
    [], // blank row
  ];

  // --- Day sections ---
  for (let di = 0; di < DAY_NAMES.length; di++) {
    const dayName = DAY_NAMES[di];
    const startRow = dayHeaderRow(di);

    // Calculate date for this day
    const dayDate = new Date(weekStart);
    dayDate.setDate(dayDate.getDate() + (di < 5 ? di : 5));
    const dateStr = formatDate(dayDate.toISOString().split("T")[0]);

    // Header row: DAY date | JOB# | employee names
    const headerCells: any[] = [
      { userEnteredValue: { stringValue: `${dayName}` }, userEnteredFormat: { textFormat: { bold: true, fontSize: 10 } } },
      { userEnteredValue: { stringValue: "JOB#" }, userEnteredFormat: { textFormat: { bold: true } } },
    ];
    for (const emp of employees) {
      headerCells.push({
        userEnteredValue: { stringValue: emp.toUpperCase() },
        userEnteredFormat: { textFormat: { bold: true, fontSize: 8 } },
      });
    }

    // Date under day name
    const dateRow: any[] = [
      { userEnteredValue: { stringValue: dateStr }, userEnteredFormat: { textFormat: { fontSize: 8 } } },
    ];

    // Totals row (with SUM formulas)
    const totalsRow = dayHeaderRow(di) + JOB_ROWS_PER_DAY + 2;
    const totalsRowNum = totalsRow + 1; // 1-indexed for formulas
    const jobStartRowNum = startRow + 2 + 1; // 1-indexed
    const jobEndRowNum = startRow + JOB_ROWS_PER_DAY + 1 + 1;

    const totalsCells: any[] = [
      {},
      {},
    ];
    for (let ei = 0; ei < employees.length; ei++) {
      const col = colLetter(2 + ei);
      totalsCells.push({
        userEnteredValue: { formulaValue: `=SUM(${col}${jobStartRowNum}:${col}${jobEndRowNum})` },
        userEnteredFormat: { textFormat: { bold: true } },
      });
    }

    // TIME CLOCK row
    const timeClockRow = totalsRow + 1;
    const timeClockCells: any[] = [
      { userEnteredValue: { stringValue: "TIME CLOCK" }, userEnteredFormat: { textFormat: { bold: true } } },
    ];

    // Write header
    requests.push({
      updateCells: {
        rows: [{ values: headerCells }],
        start: { sheetId, rowIndex: startRow, columnIndex: 0 },
        fields: "userEnteredValue,userEnteredFormat",
      },
    });

    // Write date row
    requests.push({
      updateCells: {
        rows: [{ values: dateRow }],
        start: { sheetId, rowIndex: startRow + 1, columnIndex: 0 },
        fields: "userEnteredValue,userEnteredFormat",
      },
    });

    // Write totals
    requests.push({
      updateCells: {
        rows: [{ values: totalsCells }],
        start: { sheetId, rowIndex: totalsRow, columnIndex: 0 },
        fields: "userEnteredValue,userEnteredFormat",
      },
    });

    // Write TIME CLOCK
    requests.push({
      updateCells: {
        rows: [{ values: timeClockCells }],
        start: { sheetId, rowIndex: timeClockRow, columnIndex: 0 },
        fields: "userEnteredValue,userEnteredFormat",
      },
    });
  }

  // --- TIME RECAP section (right side, at Monday's level) ---
  const recapStartRow = dayHeaderRow(0);
  const recapHeaders: any[] = [
    { userEnteredValue: { stringValue: "TIME RECAP" }, userEnteredFormat: { textFormat: { bold: true, fontSize: 10 } } },
  ];
  const recapSubHeaders: any[] = [
    { userEnteredValue: { stringValue: "NAME" }, userEnteredFormat: { textFormat: { bold: true } } },
    { userEnteredValue: { stringValue: "TOTAL HOURS" }, userEnteredFormat: { textFormat: { bold: true } } },
    { userEnteredValue: { stringValue: "REG HOURS" }, userEnteredFormat: { textFormat: { bold: true } } },
    { userEnteredValue: { stringValue: "OFF HOURS" }, userEnteredFormat: { textFormat: { bold: true } } },
  ];

  requests.push({
    updateCells: {
      rows: [{ values: recapHeaders }],
      start: { sheetId, rowIndex: recapStartRow, columnIndex: recapCol },
      fields: "userEnteredValue,userEnteredFormat",
    },
  });

  requests.push({
    updateCells: {
      rows: [{ values: recapSubHeaders }],
      start: { sheetId, rowIndex: recapStartRow + 1, columnIndex: recapCol },
      fields: "userEnteredValue,userEnteredFormat",
    },
  });

  // Employee rows in recap - with formulas summing across all day sections
  const recapRows: any[] = [];
  for (let ei = 0; ei < employees.length; ei++) {
    const empCol = colLetter(2 + ei);
    // Sum all daily totals for this employee
    const totalParts: string[] = [];
    for (let di = 0; di < DAY_NAMES.length; di++) {
      const totalsRow = dayHeaderRow(di) + JOB_ROWS_PER_DAY + 2 + 1; // 1-indexed
      totalParts.push(`${empCol}${totalsRow}`);
    }
    const totalFormula = `=${totalParts.join("+")}`;

    recapRows.push({
      values: [
        { userEnteredValue: { stringValue: employees[ei].toUpperCase() } },
        { userEnteredValue: { formulaValue: totalFormula }, userEnteredFormat: { textFormat: { bold: true } } },
        { userEnteredValue: { stringValue: "" } }, // REG HOURS - filled manually or with more complex formula
        { userEnteredValue: { stringValue: "" } }, // OFF HOURS
      ],
    });
  }

  requests.push({
    updateCells: {
      rows: recapRows,
      start: { sheetId, rowIndex: recapStartRow + 2, columnIndex: recapCol },
      fields: "userEnteredValue,userEnteredFormat",
    },
  });

  // Write title rows
  requests.push({
    updateCells: {
      rows: titleData.map((row) => ({ values: row })),
      start: { sheetId, rowIndex: 0, columnIndex: 0 },
      fields: "userEnteredValue,userEnteredFormat",
    },
  });

  await sheetsApi(accessToken, ":batchUpdate", "POST", { requests });

  return sheetId;
}

interface PivotRow {
  job_number: string;
  isOffHours: boolean;
  hoursByEmployee: Map<string, number>;
}

function pivotEntries(entries: LaborEntry[], employees: string[]): PivotRow[] {
  // Group by (job_number, type) → pivot employees into columns
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
    // Match employee by first name (case-insensitive)
    const empName = entry.employee_name.trim();
    const matchedEmp = employees.find(
      (e) => e.toLowerCase() === empName.toLowerCase()
    );
    if (matchedEmp) {
      group.hoursByEmployee.set(matchedEmp, (group.hoursByEmployee.get(matchedEmp) || 0) + entry.hours);
    }
  }

  // Sort: regular rows first, then off-hours, grouped by job
  const rows = Array.from(groups.values());
  rows.sort((a, b) => {
    if (a.job_number !== b.job_number) return a.job_number.localeCompare(b.job_number);
    return a.isOffHours ? 1 : -1;
  });

  return rows;
}

async function appendJobRows(
  accessToken: string,
  sheetId: number,
  tabTitle: string,
  dayName: string,
  pivotRows: PivotRow[],
  employees: string[]
) {
  const dayIndex = getDayIndex(dayName);
  if (dayIndex === -1) throw new Error(`Unknown day: ${dayName}`);

  const sectionStart = dayHeaderRow(dayIndex);
  const jobStartRow = sectionStart + 2; // After header + date row
  const maxJobRow = sectionStart + JOB_ROWS_PER_DAY + 1;

  // Read existing data in job area to find first empty row
  const range = `${tabTitle}!B${jobStartRow + 1}:B${maxJobRow + 1}`;
  const existing = await sheetsApi(accessToken, `/values/${encodeURIComponent(range)}`);
  const existingValues = existing.values || [];
  const firstEmptyOffset = existingValues.findIndex((row: any[]) => !row[0] || row[0] === "");
  const insertRow = firstEmptyOffset === -1
    ? jobStartRow + existingValues.length
    : jobStartRow + firstEmptyOffset;

  if (insertRow + pivotRows.length > maxJobRow) {
    console.warn(`Not enough space in ${dayName} section. Some rows may overflow.`);
  }

  // Build cell data and formatting requests
  const requests: any[] = [];
  const rowData: any[] = [];

  for (let ri = 0; ri < pivotRows.length; ri++) {
    const pr = pivotRows[ri];
    const textColor = pr.isOffHours
      ? { red: 1, green: 0, blue: 0 }
      : { red: 0, green: 0, blue: 0 };

    const cells: any[] = [
      {}, // Column A (day label area, leave blank)
      {
        userEnteredValue: pr.isOffHours
          ? { stringValue: pr.job_number }
          : { numberValue: Number(pr.job_number) || undefined, stringValue: pr.job_number },
        userEnteredFormat: { textFormat: { foregroundColorStyle: { rgbColor: textColor } } },
      },
    ];

    for (const emp of employees) {
      const hrs = pr.hoursByEmployee.get(emp);
      cells.push({
        ...(hrs ? { userEnteredValue: { numberValue: hrs } } : {}),
        userEnteredFormat: { textFormat: { foregroundColorStyle: { rgbColor: textColor } } },
      });
    }

    rowData.push({ values: cells });
  }

  requests.push({
    updateCells: {
      rows: rowData,
      start: { sheetId, rowIndex: insertRow, columnIndex: 0 },
      fields: "userEnteredValue,userEnteredFormat",
    },
  });

  await sheetsApi(accessToken, ":batchUpdate", "POST", { requests });

  return pivotRows.length;
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

    // Get employee list from DB
    const { data: empData } = await supabase
      .from("employees")
      .select("first_name")
      .order("created_at");
    const employees = (empData || []).map((e: any) => e.first_name);
    if (employees.length === 0) throw new Error("No employees found in database");

    const accessToken = await getAccessToken(GOOGLE_SERVICE_ACCOUNT_KEY);
    const weekStart = getWeekStart(entries[0]?.date);
    const tabTitle = `WE ${formatDate(getWeekEnd(weekStart))}`;

    // Ensure week tab exists
    let sheetId = await getSheetId(accessToken, tabTitle);
    const isNewTab = sheetId === null;

    if (isNewTab) {
      console.log(`Creating new tab: ${tabTitle}`);
      sheetId = await createWeekTab(accessToken, tabTitle, weekStart, employees);
    }

    // Group entries by day
    const entriesByDay = new Map<string, LaborEntry[]>();
    for (const entry of entries) {
      const day = normalizeDayName(entry.day_of_week);
      if (!entriesByDay.has(day)) entriesByDay.set(day, []);
      entriesByDay.get(day)!.push(entry);
    }

    // Write each day's data
    let totalAdded = 0;
    for (const [dayName, dayEntries] of entriesByDay) {
      const pivotRows = pivotEntries(dayEntries, employees);
      const added = await appendJobRows(accessToken, sheetId!, tabTitle, dayName, pivotRows, employees);
      totalAdded += added;
      console.log(`Added ${added} rows to ${dayName}`);
    }

    const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`;

    return new Response(
      JSON.stringify({
        success: true,
        spreadsheet_url: spreadsheetUrl,
        entries_added: totalAdded,
        is_new_sheet: isNewTab,
        week: weekStart,
        tab: tabTitle,
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
