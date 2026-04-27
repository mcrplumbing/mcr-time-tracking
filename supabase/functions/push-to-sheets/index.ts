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
  customer?: string;
}

const SPREADSHEET_ID = "1ucmQlW-X8uU6SEu0wSY2xEXynVQwgxho_uK3lpEk304";

// Column layout (new):
// A = R/OH marker (or day label/date)
// B = Customer
// C = Job #
// D+ = Employee names
// Recap: C=Name, D=Total, E=Reg, F=Off, G=Total

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
  dataStartRow: number;
  dataEndRow: number;
  existingTotalRow: number | null;
  existingDataRows: { jobNumber: string; cells: any[][] }[];
}

// NEW LAYOUT: A=marker/date, B=customer, C=job#, D+=employees
// Employee names start at column index 3 (D)
// TOTAL is in column C (index 2)
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
    // Employee names start at column D (index 3)
    for (let c = 3; c < candidateCells.length; c++) {
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
    // TOTAL is now in column C (index 2)
    const cellC = (rows[i]?.[2] || "").trim().toUpperCase();
    if (cellC === "TOTAL") {
      existingTotalRow = i;
      break;
    }
    // Job number is in column C (index 2)
    const jobNum = (rows[i]?.[2] || "").trim();
    if (!jobNum) {
      break;
    }
    existingDataRows.push({
      jobNumber: jobNum,
      cells: [rows[i] || []],
    });
  }

  const dataEndRow = existingTotalRow ?? (dataStartRow + existingDataRows.length);

  return { employeeRow, employees, dataStartRow, dataEndRow, existingTotalRow, existingDataRows };
}

interface PivotRow {
  job_number: string;
  customer: string;
  entryType: string; // "Regular", "Off Hours", "Vacation", "Sick"
  hoursByEmployee: Map<string, number>;
}

function typeToMarker(type: string): string {
  switch (type) {
    case "Off Hours": return "OH";
    case "Vacation": return "V";
    case "Sick": return "S";
    default: return "R";
  }
}

function pivotEntries(entries: LaborEntry[], employees: string[]): PivotRow[] {
  const groups = new Map<string, PivotRow>();

  for (const entry of entries) {
    const key = `${entry.job_number}|${entry.type}`;
    if (!groups.has(key)) {
      groups.set(key, {
        job_number: entry.job_number,
        customer: entry.customer || "",
        entryType: entry.type,
        hoursByEmployee: new Map(),
      });
    }
    const group = groups.get(key)!;
    if (!group.customer && entry.customer) group.customer = entry.customer;
    const matched = employees.find(e => e.toUpperCase() === entry.employee_name.toUpperCase());
    if (matched) {
      group.hoursByEmployee.set(matched, (group.hoursByEmployee.get(matched) || 0) + entry.hours);
    }
  }

  const rows = Array.from(groups.values());
  rows.sort((a, b) => {
    if (a.job_number !== b.job_number) return a.job_number.localeCompare(b.job_number);
    return a.entryType.localeCompare(b.entryType);
  });
  return rows;
}

interface Conflict {
  day: string;
  job_number: string;
  type: string;
  employee: string;
  existing_hours: number;
  new_hours: number;
}

async function writeJobRows(
  accessToken: string,
  sheetId: number,
  tabTitle: string,
  section: DaySection,
  pivotRows: PivotRow[],
  dayName: string,
  dryRun = false,
): Promise<Conflict[]> {
  const { employeeRow, employees, dataStartRow, existingTotalRow, existingDataRows } = section;

  // Detect conflicts: existing rows that match incoming (job_number + marker)
  // Flags ANY overlap on the same employee — even if hours match — so the user is warned about overwrites.
  const conflicts: Conflict[] = [];
  const markerToType: Record<string, string> = { R: "Regular", OH: "Off Hours", V: "Vacation", S: "Sick" };
  for (const pr of pivotRows) {
    const incomingMarker = typeToMarker(pr.entryType);
    for (const existing of existingDataRows) {
      const exCells = existing.cells[0] || [];
      const exMarker = (exCells[0] || "").trim().toUpperCase();
      const exJob = (exCells[2] || "").trim();
      if (exJob.toUpperCase() !== pr.job_number.toUpperCase()) continue;
      if (exMarker !== incomingMarker) continue;
      // Same job + same type → compare per-employee hours
      for (let c = 0; c < employees.length; c++) {
        const emp = employees[c];
        const exVal = parseFloat(exCells[c + 3] || "0") || 0;
        const newVal = pr.hoursByEmployee.get(emp) || 0;
        // Flag if the sheet already has a value for this employee on this job/type
        // (whether hours match, differ, or the new push leaves it blank/zero).
        if (exVal > 0) {
          conflicts.push({
            day: dayName,
            job_number: pr.job_number,
            type: markerToType[incomingMarker] || incomingMarker,
            employee: emp,
            existing_hours: exVal,
            new_hours: newVal,
          });
        }
      }
    }
  }

  if (dryRun) {
    // Detection-only mode: don't write anything, just report conflicts
    return conflicts;
  }

  const rowsToDelete = existingDataRows.length + (existingTotalRow !== null ? 1 : 0);

  const requests: any[] = [];

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

  const incomingJobs = new Set(pivotRows.map(pr => pr.job_number.toUpperCase()));

  const preservedRows: { jobNumber: string; rawCells: string[] }[] = [];
  for (const existing of existingDataRows) {
    if (!incomingJobs.has(existing.jobNumber.toUpperCase())) {
      preservedRows.push({ jobNumber: existing.jobNumber, rawCells: existing.cells[0] });
    }
  }

  console.log(`Preserving ${preservedRows.length} existing rows, adding ${pivotRows.length} new rows`);

  const totalDataRows = preservedRows.length + pivotRows.length;
  const totalInsertRows = totalDataRows + 1;

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

  const rowData: any[] = [];

  // Preserved rows (re-written from raw cell data with correct color formatting)
  for (const preserved of preservedRows) {
    const marker = (preserved.rawCells[0] || "").trim().toUpperCase();
    const textColor = marker === "OH"
      ? { red: 1, green: 0, blue: 0 }
      : (marker === "V" || marker === "S")
        ? { red: 0, green: 0, blue: 1 }
        : { red: 0, green: 0, blue: 0 };
    const fmt = {
      textFormat: {
        foregroundColorStyle: { rgbColor: textColor },
        fontSize: 12,
      },
    };

    const cells: any[] = [];
    // New layout: A=marker, B=customer, C=job#, D+=employees → need employees.length + 3 columns
    for (let c = 0; c < Math.max(preserved.rawCells.length, employees.length + 3); c++) {
      const val = (preserved.rawCells[c] || "").trim();
      if (!val) {
        cells.push({});
      } else {
        const num = parseFloat(val);
        // Employee data starts at column D (index 3)
        if (c >= 3 && !isNaN(num)) {
          cells.push({ userEnteredValue: { numberValue: num }, userEnteredFormat: fmt });
        } else {
          cells.push({ userEnteredValue: { stringValue: val }, userEnteredFormat: fmt });
        }
      }
    }
    rowData.push({ values: cells });
  }

  // New pivot rows: A=marker, B=customer, C=job#, D+=employee hours
  for (const pr of pivotRows) {
    // Off Hours = red, Vacation/Sick = blue, Regular = black
    const textColor = pr.entryType === "Off Hours"
      ? { red: 1, green: 0, blue: 0 }
      : (pr.entryType === "Vacation" || pr.entryType === "Sick")
        ? { red: 0, green: 0, blue: 1 }
        : { red: 0, green: 0, blue: 0 };
    const fmt = {
      textFormat: {
        foregroundColorStyle: { rgbColor: textColor },
        fontSize: 12,
      },
    };

    const marker = typeToMarker(pr.entryType);
    const cells: any[] = [
      { userEnteredValue: { stringValue: marker }, userEnteredFormat: fmt },      // A: R/OH/V/S
      { userEnteredValue: { stringValue: pr.customer }, userEnteredFormat: fmt },  // B: Customer
      { userEnteredValue: { stringValue: pr.job_number }, userEnteredFormat: fmt },// C: Job #
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

  // TOTAL row: A=empty, B=empty, C="TOTAL", D+=SUM formulas
  const firstDataRow = dataStartRow + 1;
  const lastDataRow = dataStartRow + totalDataRows;
  console.log(`TOTAL SUM range: row ${firstDataRow} to ${lastDataRow} (${totalDataRows} data rows)`);

  const boldFmt = {
    textFormat: { bold: true, fontSize: 12 },
  };
  const totalsCells: any[] = [
    {},  // A
    {},  // B
    { userEnteredValue: { stringValue: "TOTAL" }, userEnteredFormat: boldFmt }, // C
  ];
  for (let c = 0; c < employees.length; c++) {
    // Employee columns start at D (column index 3), so D=68 in ASCII
    const colLetter = String.fromCharCode(68 + c); // D, E, F, ...
    const formula = `=SUM(${colLetter}${firstDataRow}:${colLetter}${lastDataRow})`;
    totalsCells.push({
      userEnteredValue: { formulaValue: formula },
      userEnteredFormat: boldFmt,
    });
  }
  rowData.push({ values: totalsCells });

  requests.push({
    updateCells: {
      rows: rowData,
      start: { sheetId, rowIndex: dataStartRow, columnIndex: 0 },
      fields: "userEnteredValue,userEnteredFormat.textFormat",
    },
  });

  await sheetsApi(accessToken, ":batchUpdate", "POST", { requests });
  return conflicts;
}

// Recap section: C=Name, D=Total, E=Reg, F=Off, G=Total
async function updateRecapSection(
  accessToken: string,
  sheetId: number,
  tabTitle: string,
) {
  const range = encodeURIComponent(`${tabTitle}!A1:Z200`);
  const data = await sheetsApi(accessToken, `/values/${range}`);
  const rows: string[][] = data.values || [];

  const totalRows: { rowIndex: number; values: string[] }[] = [];
  const dayNames = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];

  for (let i = 0; i < rows.length; i++) {
    const cellA = (rows[i]?.[0] || "").toUpperCase().trim();
    // TOTAL is now in column C (index 2)
    const cellC = (rows[i]?.[2] || "").toUpperCase().trim();

    if (cellC === "TOTAL" && i > 20) {
      totalRows.push({ rowIndex: i, values: rows[i] || [] });
    }
  }

  console.log(`Found ${totalRows.length} TOTAL rows in daily sections`);

  const totalByEmployee = new Map<string, number>();
  const regularByEmployee = new Map<string, number>();
  const offHoursByEmployee = new Map<string, number>();
  const vacationByEmployee = new Map<string, number>();
  const sickByEmployee = new Map<string, number>();

  for (const totalRow of totalRows) {
    let employeeHeaderRow = -1;
    for (let j = totalRow.rowIndex - 1; j >= 0; j--) {
      const cellA = (rows[j]?.[0] || "").toUpperCase().trim();
      if (dayNames.some(d => cellA.includes(d))) {
        for (const candidate of [j, j + 1]) {
          const candidateCells = rows[candidate] || [];
          if ((candidateCells[3] || "").trim()) {
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
    for (let c = 3; c < employeeCells.length; c++) {
      const name = (employeeCells[c] || "").trim();
      if (name) employees.push(name);
      else break;
    }

    for (let dataRow = employeeHeaderRow + 1; dataRow < totalRow.rowIndex; dataRow++) {
      const rowCells = rows[dataRow] || [];
      const marker = (rowCells[0] || "").trim().toUpperCase();
      const jobNumber = (rowCells[2] || "").trim();
      if (!jobNumber) continue;

      const isOffHours = marker === "OH";
      const isRegular = marker === "R";
      const isVacation = marker === "V";
      const isSick = marker === "S";

      for (let c = 0; c < employees.length; c++) {
        const empName = employees[c].toUpperCase();
        const val = parseFloat(rowCells[c + 3] || "0") || 0;
        if (val > 0) {
          totalByEmployee.set(empName, (totalByEmployee.get(empName) || 0) + val);
          if (isOffHours) offHoursByEmployee.set(empName, (offHoursByEmployee.get(empName) || 0) + val);
          else if (isRegular) regularByEmployee.set(empName, (regularByEmployee.get(empName) || 0) + val);
          else if (isVacation) vacationByEmployee.set(empName, (vacationByEmployee.get(empName) || 0) + val);
          else if (isSick) sickByEmployee.set(empName, (sickByEmployee.get(empName) || 0) + val);
        }
      }
    }
  }

  console.log("Recap totals:", Object.fromEntries(totalByEmployee));

  // Recap layout: C=Name, D=Total, E=Regular, F=Off-Hours, G=Vacation, H=Sick, I=Total (verification)
  const requests: any[] = [];

  // Write header labels in row 1 (rowIndex 0) for cols D-I if not already correct
  requests.push({
    updateCells: {
      rows: [{
        values: [
          { userEnteredValue: { stringValue: "Total" }, userEnteredFormat: { textFormat: { bold: true } } },
          { userEnteredValue: { stringValue: "Regular" }, userEnteredFormat: { textFormat: { bold: true } } },
          { userEnteredValue: { stringValue: "Off-Hours" }, userEnteredFormat: { textFormat: { bold: true } } },
          { userEnteredValue: { stringValue: "Vacation" }, userEnteredFormat: { textFormat: { bold: true } } },
          { userEnteredValue: { stringValue: "Sick" }, userEnteredFormat: { textFormat: { bold: true } } },
          { userEnteredValue: { stringValue: "Total" }, userEnteredFormat: { textFormat: { bold: true } } },
        ],
      }],
      start: { sheetId, rowIndex: 0, columnIndex: 3 },
      fields: "userEnteredValue,userEnteredFormat.textFormat",
    },
  });

  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const nameInC = (rows[i]?.[2] || "").trim();
    if (!nameInC) continue;

    const nameUpper = nameInC.toUpperCase();
    const total = totalByEmployee.get(nameUpper);

    if (total !== undefined) {
      const regular = regularByEmployee.get(nameUpper) || 0;
      const offHours = offHoursByEmployee.get(nameUpper) || 0;
      const vacation = vacationByEmployee.get(nameUpper) || 0;
      const sick = sickByEmployee.get(nameUpper) || 0;

      requests.push({
        updateCells: {
          rows: [{
            values: [
              { userEnteredValue: { numberValue: total } },     // D: Total
              { userEnteredValue: { numberValue: regular } },   // E: Regular
              { userEnteredValue: { numberValue: offHours } },  // F: Off-Hours
              { userEnteredValue: { numberValue: vacation } },  // G: Vacation
              { userEnteredValue: { numberValue: sick } },      // H: Sick
              { userEnteredValue: { numberValue: total } },     // I: Total (verification)
            ],
          }],
          start: { sheetId, rowIndex: i, columnIndex: 3 },
          fields: "userEnteredValue",
        },
      });
      console.log(`Recap: ${nameInC} = total:${total}, reg:${regular}, oh:${offHours}, vac:${vacation}, sick:${sick}`);
    }
  }

  if (requests.length > 0) {
    await sheetsApi(accessToken, ":batchUpdate", "POST", { requests });
    console.log(`Updated recap for ${requests.length - 1} employees`);
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

    const { entries, dryRun = false } = (await req.json()) as { entries: LaborEntry[]; dryRun?: boolean };
    if (!entries || entries.length === 0) throw new Error("No entries provided");

    const accessToken = await getAccessToken(GOOGLE_SERVICE_ACCOUNT_KEY);

    const weekEnd = getWeekEnd(entries[0].date);
    const tabTitle = `WE ${formatDateShort(weekEnd)}`;
    console.log(`Looking for tab: ${tabTitle}`);

    const tab = await findTab(accessToken, tabTitle);
    if (!tab) throw new Error(`Tab "${tabTitle}" not found. Please create the weekly sheet first.`);
    console.log(`Found tab: ${tab.title} (sheetId: ${tab.sheetId})`);

    const entriesByDay = new Map<string, LaborEntry[]>();
    for (const entry of entries) {
      const day = normalizeDayName(entry.day_of_week);
      if (!entriesByDay.has(day)) entriesByDay.set(day, []);
      entriesByDay.get(day)!.push(entry);
    }

    let totalAdded = 0;
    const allConflicts: any[] = [];
    for (const [dayName, dayEntries] of entriesByDay) {
      console.log(`Processing ${dayName}: ${dayEntries.length} entries${dryRun ? " (DRY RUN)" : ""}`);

      const section = await findDaySection(accessToken, tab.title, dayName);
      console.log(`${dayName}: employeeRow=${section.employeeRow}, dataStart=${section.dataStartRow}, existing=${section.existingDataRows.length} rows`);

      const pivotRows = pivotEntries(dayEntries, section.employees);

      const conflicts = await writeJobRows(accessToken, tab.sheetId, tab.title, section, pivotRows, dayName, dryRun);
      if (conflicts.length > 0) {
        console.log(`⚠️  ${conflicts.length} conflict(s) in ${dayName}`);
        allConflicts.push(...conflicts);
      }
      if (!dryRun) {
        totalAdded += pivotRows.length;
        console.log(`Wrote ${pivotRows.length} rows into ${dayName}`);
      }
    }

    if (!dryRun) {
      await updateRecapSection(accessToken, tab.sheetId, tab.title);
    }

    return new Response(
      JSON.stringify({
        success: true,
        dryRun,
        spreadsheet_url: `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`,
        entries_added: totalAdded,
        tab: tab.title,
        conflicts: allConflicts,
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
