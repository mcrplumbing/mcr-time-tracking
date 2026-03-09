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
  if (d.startsWith("SAT")) return "SATURDAY";
  if (d.startsWith("SUN")) return "SUNDAY";
  return d;
}

function getWeekEnd(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getDay();
  const diff = 7 - day;
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

async function findTab(accessToken: string, tabTitle: string): Promise<{ sheetId: number; title: string } | null> {
  const meta = await sheetsApi(accessToken, "?fields=sheets.properties");
  for (const s of meta.sheets || []) {
    if (s.properties.title === tabTitle) {
      return { sheetId: s.properties.sheetId, title: s.properties.title };
    }
  }
  for (const s of meta.sheets || []) {
    if (s.properties.title.toUpperCase().includes("WE") && s.properties.title.includes(tabTitle.replace("WE ", ""))) {
      return { sheetId: s.properties.sheetId, title: s.properties.title };
    }
  }
  return null;
}

interface DaySection {
  employeeRow: number;
  employees: string[];
  dataStartRow: number; // first row after employee header where data goes
  dataEndRow: number;   // last data row (exclusive) - either TOTAL row or first empty row
  existingTotalRow: number | null;
  existingDataRows: { jobNumber: string; cells: any[][] }[]; // preserved row data
}

// Read the day section and return all existing data
async function findDaySection(
  accessToken: string,
  tabTitle: string,
  dayName: string
): Promise<DaySection> {
  const range = encodeURIComponent(`${tabTitle}!A1:Z200`);
  const data = await sheetsApi(accessToken, `/values/${range}`);
  const rows: string[][] = data.values || [];

  let headerRow = -1;
  for (let i = 0; i < rows.length; i++) {
    const cellA = (rows[i]?.[0] || "").toUpperCase().trim();
    if (cellA.includes(dayName)) {
      headerRow = i;
      break;
    }
  }
  if (headerRow === -1) throw new Error(`Day "${dayName}" not found in sheet "${tabTitle}"`);

  let employees: string[] = [];
  let employeeRow = headerRow;

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

  const dataStartRow = employeeRow + 1;
  let existingTotalRow: number | null = null;
  const existingDataRows: { jobNumber: string; cells: any[][] }[] = [];

  for (let i = dataStartRow; i < rows.length; i++) {
    const cellB = (rows[i]?.[1] || "").trim().toUpperCase();
    if (cellB === "TOTAL") {
      existingTotalRow = i;
      break;
    }
    if (!cellB) {
      break;
    }
    // Store the full row data for potential preservation
    existingDataRows.push({
      jobNumber: (rows[i]?.[1] || "").trim(),
      cells: [rows[i] || []],
    });
  }

  const dataEndRow = existingTotalRow ?? (dataStartRow + existingDataRows.length);

  return { employeeRow, employees, dataStartRow, dataEndRow, existingTotalRow, existingDataRows };
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
    const matched = employees.find(e => e.toUpperCase() === entry.employee_name.toUpperCase());
    if (matched) {
      group.hoursByEmployee.set(matched, (group.hoursByEmployee.get(matched) || 0) + entry.hours);
    }
  }

  const rows = Array.from(groups.values());
  rows.sort((a, b) => {
    if (a.job_number !== b.job_number) return a.job_number.localeCompare(b.job_number);
    return a.isOffHours ? 1 : -1;
  });
  return rows;
}

/**
 * Clear-and-rewrite approach:
 * 1. Delete ALL existing data rows + TOTAL row for this day section
 * 2. Merge: keep non-matching existing rows, replace matching with new pivot rows
 * 3. Insert merged rows + fresh TOTAL row with correct SUM formulas
 */
async function writeJobRows(
  accessToken: string,
  sheetId: number,
  tabTitle: string,
  section: DaySection,
  pivotRows: PivotRow[],
) {
  const { employeeRow, employees, dataStartRow, existingTotalRow, existingDataRows } = section;

  // Step 1: Determine how many rows to delete (all data rows + TOTAL if exists)
  const rowsToDelete = existingDataRows.length + (existingTotalRow !== null ? 1 : 0);

  const requests: any[] = [];

  // Delete all existing data rows and TOTAL row in one operation
  if (rowsToDelete > 0) {
    requests.push({
      deleteDimension: {
        range: {
          sheetId,
          dimension: "ROWS",
          startIndex: dataStartRow,
          endIndex: dataStartRow + rowsToDelete,
        },
      },
    });
    console.log(`Deleting ${rowsToDelete} rows starting at ${dataStartRow}`);
  }

  // Step 2: Merge existing rows (non-matching) with new pivot rows
  const incomingJobs = new Set(pivotRows.map(pr => pr.job_number.toUpperCase()));

  // Preserve existing rows that don't match incoming job numbers
  const preservedRows: { jobNumber: string; rawCells: string[] }[] = [];
  for (const existing of existingDataRows) {
    if (!incomingJobs.has(existing.jobNumber.toUpperCase())) {
      preservedRows.push({ jobNumber: existing.jobNumber, rawCells: existing.cells[0] });
    }
  }

  console.log(`Preserving ${preservedRows.length} existing rows, adding ${pivotRows.length} new rows`);

  // Step 3: Build all rows to insert (preserved + new + TOTAL)
  const totalDataRows = preservedRows.length + pivotRows.length;
  const totalInsertRows = totalDataRows + 1; // +1 for TOTAL row

  // Insert blank rows at the data start position
  requests.push({
    insertDimension: {
      range: {
        sheetId,
        dimension: "ROWS",
        startIndex: dataStartRow,
        endIndex: dataStartRow + totalInsertRows,
      },
      inheritFromBefore: true,
    },
  });

  // Build cell data for all rows
  const rowData: any[] = [];

  // First: preserved existing rows (re-written from raw cell data)
  for (const preserved of preservedRows) {
    const cells: any[] = [];
    for (let c = 0; c < Math.max(preserved.rawCells.length, employees.length + 2); c++) {
      const val = (preserved.rawCells[c] || "").trim();
      if (!val) {
        cells.push({});
      } else {
        const num = parseFloat(val);
        if (c >= 2 && !isNaN(num)) {
          cells.push({ userEnteredValue: { numberValue: num } });
        } else {
          cells.push({ userEnteredValue: { stringValue: val } });
        }
      }
    }
    rowData.push({ values: cells });
  }

  // Then: new pivot rows
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

    const marker = pr.isOffHours ? "OH" : "R";
    const cells: any[] = [
      { userEnteredValue: { stringValue: marker }, userEnteredFormat: fmt }, // Column A: R or OH
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

  // TOTAL row with SUM formulas
  const firstDataRow = dataStartRow + 1; // 1-indexed for formulas
  const lastDataRow = dataStartRow + totalDataRows; // 1-indexed
  console.log(`TOTAL SUM range: row ${firstDataRow} to ${lastDataRow} (${totalDataRows} data rows)`);

  const boldFmt = {
    textFormat: { bold: true, fontSize: 12 },
  };
  const totalsCells: any[] = [
    {}, // Column A
    { userEnteredValue: { stringValue: "TOTAL" }, userEnteredFormat: boldFmt },
  ];
  for (let c = 0; c < employees.length; c++) {
    const colLetter = String.fromCharCode(67 + c); // C, D, E, ...
    const formula = `=SUM(${colLetter}${firstDataRow}:${colLetter}${lastDataRow})`;
    totalsCells.push({
      userEnteredValue: { formulaValue: formula },
      userEnteredFormat: boldFmt,
    });
  }
  rowData.push({ values: totalsCells });

  // Write all cells
  requests.push({
    updateCells: {
      rows: rowData,
      start: { sheetId, rowIndex: dataStartRow, columnIndex: 0 },
      fields: "userEnteredValue,userEnteredFormat.textFormat",
    },
  });

  await sheetsApi(accessToken, ":batchUpdate", "POST", { requests });
}

/**
 * Recalculate recap section from scratch using only the current submission's entries.
 * Reads existing recap values, subtracts any previously-pushed values for the same days,
 * then adds the new values.
 *
 * Simplified approach: just replace the recap values with totals computed from
 * ALL daily TOTAL rows in the sheet (reading the actual sheet state).
 */
async function updateRecapSection(
  accessToken: string,
  sheetId: number,
  tabTitle: string,
) {
  // Read the full sheet to compute recap from daily TOTAL rows
  const range = encodeURIComponent(`${tabTitle}!A1:Z200`);
  const data = await sheetsApi(accessToken, `/values/${range}`);
  const rows: string[][] = data.values || [];

  // Find recap section: employee names in column A (rows ~1-20)
  // Find all TOTAL rows and their values
  // Build per-employee totals from all daily TOTAL rows

  // First, find employee names from any day section (column C onwards in employee header rows)
  // and find all TOTAL rows
  const totalRows: { rowIndex: number; values: string[] }[] = [];
  const dayHeaderRows: number[] = [];
  const dayNames = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];

  for (let i = 0; i < rows.length; i++) {
    const cellA = (rows[i]?.[0] || "").toUpperCase().trim();
    const cellB = (rows[i]?.[1] || "").toUpperCase().trim();
    
    // Check if this is a day header
    if (dayNames.some(d => cellA.includes(d))) {
      dayHeaderRows.push(i);
    }
    
    if (cellB === "TOTAL" && i > 20) { // TOTAL rows are in the daily sections, not recap
      totalRows.push({ rowIndex: i, values: rows[i] || [] });
    }
  }

  console.log(`Found ${totalRows.length} TOTAL rows in daily sections`);

  // For each TOTAL row, find its corresponding employee header to map columns to names
  // Sum up regular and off-hours per employee across all days
  const totalByEmployee = new Map<string, number>();
  const regularByEmployee = new Map<string, number>();
  const offHoursByEmployee = new Map<string, number>();

  for (const totalRow of totalRows) {
    // Find the employee header for this TOTAL row (search backwards for a day header)
    let employeeHeaderRow = -1;
    for (let j = totalRow.rowIndex - 1; j >= 0; j--) {
      const cellA = (rows[j]?.[0] || "").toUpperCase().trim();
      if (dayNames.some(d => cellA.includes(d))) {
        // Check this row and the next for employee names
        for (const candidate of [j, j + 1]) {
          const candidateCells = rows[candidate] || [];
          if ((candidateCells[2] || "").trim()) {
            employeeHeaderRow = candidate;
            break;
          }
        }
        break;
      }
    }

    if (employeeHeaderRow === -1) continue;

    const employeeCells = rows[employeeHeaderRow] || [];
    const employees: string[] = [];
    for (let c = 2; c < employeeCells.length; c++) {
      const name = (employeeCells[c] || "").trim();
      if (name) employees.push(name);
      else break;
    }

    // Now read data rows between employee header and TOTAL to distinguish regular vs off-hours
    for (let dataRow = employeeHeaderRow + 1; dataRow < totalRow.rowIndex; dataRow++) {
      const rowCells = rows[dataRow] || [];
      const jobNumber = (rowCells[1] || "").trim();
      if (!jobNumber) continue;

      // Check if this row is off-hours by checking text color... 
      // We can't read formatting via values API, so we need another approach.
      // For now, sum from TOTAL rows only (which include both types)
    }

    // Sum TOTAL row values per employee
    for (let c = 0; c < employees.length; c++) {
      const empName = employees[c].toUpperCase();
      const val = parseFloat(totalRow.values[c + 2] || "0") || 0;
      if (val > 0) {
        totalByEmployee.set(empName, (totalByEmployee.get(empName) || 0) + val);
      }
    }
  }

  console.log("Recap recalculated totals:", Object.fromEntries(totalByEmployee));

  // Now update the recap section (rows 1-20)
  // Column A = employee name, Column B = total hours
  const requests: any[] = [];

  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const nameInA = (rows[i]?.[0] || "").trim();
    if (!nameInA) continue;

    const nameUpper = nameInA.toUpperCase();
    const total = totalByEmployee.get(nameUpper);

    if (total !== undefined) {
      // Column B (index 1) = total hours from all daily TOTALs
      requests.push({
        updateCells: {
          rows: [{ values: [{ userEnteredValue: { numberValue: total } }] }],
          start: { sheetId, rowIndex: i, columnIndex: 1 },
          fields: "userEnteredValue",
        },
      });
      console.log(`Recap: ${nameInA} = ${total}`);
    }
  }

  if (requests.length > 0) {
    await sheetsApi(accessToken, ":batchUpdate", "POST", { requests });
    console.log(`Updated recap for ${requests.length} cells`);
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

      const section = await findDaySection(accessToken, tab.title, dayName);
      console.log(`${dayName}: employeeRow=${section.employeeRow}, dataStart=${section.dataStartRow}, existing=${section.existingDataRows.length} rows`);

      const pivotRows = pivotEntries(dayEntries, section.employees);

      await writeJobRows(accessToken, tab.sheetId, tab.title, section, pivotRows);
      totalAdded += pivotRows.length;
      console.log(`Wrote ${pivotRows.length} rows into ${dayName}`);
    }

    // Recalculate recap from all daily TOTAL rows
    await updateRecapSection(accessToken, tab.sheetId, tab.title);

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
