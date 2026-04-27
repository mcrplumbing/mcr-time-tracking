import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SPREADSHEET_ID = "1ucmQlW-X8uU6SEu0wSY2xEXynVQwgxho_uK3lpEk304";

// Column layout (new):
// A = R/OH marker, B = Customer, C = Job #, D+ = Employees
// Recap: C = Name (index 2), D = Total, E = Reg, F = Off, G = Total

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

serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response(null, { headers: corsHeaders });

  try {
    const GOOGLE_SERVICE_ACCOUNT_KEY = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");
    if (!GOOGLE_SERVICE_ACCOUNT_KEY) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not configured");

    const { tab_name } = (await req.json()) as { tab_name: string };
    if (!tab_name) throw new Error("tab_name is required");

    const accessToken = await getAccessToken(GOOGLE_SERVICE_ACCOUNT_KEY);

    const tab = await findTab(accessToken, tab_name);
    if (!tab) throw new Error(`Tab "${tab_name}" not found`);
    console.log(`Recalculating recap for tab: ${tab.title}`);

    const range = encodeURIComponent(`${tab.title}!A1:Z200`);
    const data = await sheetsApi(accessToken, `/values/${range}`);
    const rows: string[][] = data.values || [];

    const dayNames = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];

    // Find all TOTAL rows — TOTAL is now in column C (index 2)
    const totalRows: { rowIndex: number; values: string[] }[] = [];
    for (let i = 0; i < rows.length; i++) {
      const cellC = (rows[i]?.[2] || "").toUpperCase().trim();
      if (cellC === "TOTAL" && i > 20) {
        totalRows.push({ rowIndex: i, values: rows[i] || [] });
      }
    }

    console.log(`Found ${totalRows.length} TOTAL rows`);

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

    // Recap: C=Name, D=Total, E=Reg, F=Off, G=Vacation, H=Sick, I=Total (verification)
    const requests: any[] = [];
    let updatedCount = 0;

    // Header labels in row 1 cols D-I
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
        start: { sheetId: tab.sheetId, rowIndex: 0, columnIndex: 3 },
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
                { userEnteredValue: { numberValue: total } },
                { userEnteredValue: { numberValue: regular } },
                { userEnteredValue: { numberValue: offHours } },
                { userEnteredValue: { numberValue: vacation } },
                { userEnteredValue: { numberValue: sick } },
                { userEnteredValue: { numberValue: total } },
              ],
            }],
            start: { sheetId: tab.sheetId, rowIndex: i, columnIndex: 3 },
            fields: "userEnteredValue",
          },
        });
        updatedCount++;
      }
    }

    if (requests.length > 0) {
      await sheetsApi(accessToken, ":batchUpdate", "POST", { requests });
    }

    return new Response(
      JSON.stringify({
        success: true,
        employees_updated: updatedCount,
        tab: tab.title,
        spreadsheet_url: `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("recalc-recap error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
