export interface LaborEntry {
  employee_name: string;
  hours: number;
  type: "Regular" | "Off Hours";
  // Added for confidence-gated parsing
  original_name?: string;
  matched_name?: string;
  confidence?: "high" | "medium" | "low";
}

export interface ParsedWorkOrder {
  job_number: string;
  date: string;
  day_of_week: string;
  entries: LaborEntry[];
}

export interface ValidationFlag {
  level: "error" | "warning" | "info";
  message: string;
  woIndex?: number;
  entryIndex?: number;
}

export interface ParseResult {
  work_orders: ParsedWorkOrder[];
  flags: ValidationFlag[];
  needsReview: boolean;
  summary: {
    totalFlags: number;
    errors: number;
    warnings: number;
  };
}
