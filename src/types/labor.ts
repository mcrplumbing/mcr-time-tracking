export interface LaborEntry {
  employee_name: string;
  hours: number;
  type: "Regular" | "Off Hours";
}

export interface ParsedWorkOrder {
  job_number: string;
  date: string;
  day_of_week: string;
  entries: LaborEntry[];
}
