import { useState } from "react";
import { ParsedWorkOrder, LaborEntry, ValidationFlag } from "@/types/labor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CheckCircle, Download, Pencil, Trash2, Send, ExternalLink, Loader2, AlertTriangle, AlertCircle, Info } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface LaborReviewTableProps {
  workOrders: ParsedWorkOrder[];
  onUpdate: (workOrders: ParsedWorkOrder[]) => void;
  flags?: ValidationFlag[];
}

const confidenceColors: Record<string, string> = {
  high: "",
  medium: "bg-yellow-50 dark:bg-yellow-950/20",
  low: "bg-red-50 dark:bg-red-950/20",
};

const confidenceBadge: Record<string, { label: string; className: string }> = {
  high: { label: "High", className: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300" },
  medium: { label: "Med", className: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300" },
  low: { label: "Low", className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300" },
};

const LaborReviewTable = ({ workOrders, onUpdate, flags = [] }: LaborReviewTableProps) => {
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);
  const flatEntries = workOrders.flatMap((wo) =>
    wo.entries.map((entry, i) => ({
      woIndex: workOrders.indexOf(wo),
      entryIndex: i,
      job_number: wo.job_number,
      date: wo.date,
      day_of_week: wo.day_of_week,
      customer: wo.customer || "",
      ...entry,
    }))
  );

  const updateEntry = async (
    woIdx: number,
    entryIdx: number,
    field: keyof LaborEntry,
    value: string | number
  ) => {
    const updated = [...workOrders];
    const entry = updated[woIdx].entries[entryIdx];
    const oldValue = entry[field];

    if (field === "hours") {
      entry.hours = Number(value) || 0;
    } else if (field === "type") {
      entry.type = value as "Regular" | "Off Hours";
    } else {
      entry.employee_name = value as string;
    }

    onUpdate(updated);
    setEditingCell(null);

    // Save correction for learning
    if (field === "employee_name" && oldValue !== value) {
      await supabase.from("labor_corrections").insert({
        original_name: String(oldValue),
        corrected_name: String(value),
      });
    }
    if (field === "type" && oldValue !== value) {
      await supabase.from("labor_corrections").insert({
        original_name: entry.employee_name,
        corrected_name: entry.employee_name,
        original_type: String(oldValue),
        corrected_type: String(value),
      });
    }
  };

  const deleteEntry = (woIdx: number, entryIdx: number) => {
    const updated = [...workOrders];
    updated[woIdx].entries.splice(entryIdx, 1);
    if (updated[woIdx].entries.length === 0) {
      updated.splice(woIdx, 1);
    }
    onUpdate(updated);
  };

  const exportCSV = () => {
    const headers = ["Job #", "Customer", "Date", "Day", "Employee", "Hours", "Type", "Confidence"];
    const rows = flatEntries.map((e) => [
      e.job_number,
      e.customer,
      e.date,
      e.day_of_week,
      e.employee_name,
      e.hours,
      e.type,
      e.confidence || "high",
    ]);

    const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `labor_data_${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("CSV exported successfully");
  };

  const sendToSheets = async () => {
    setIsSending(true);
    try {
      const entries = flatEntries.map((e) => ({
        job_number: e.job_number,
        customer: e.customer,
        date: e.date,
        day_of_week: e.day_of_week,
        employee_name: e.employee_name,
        hours: e.hours,
        type: e.type,
      }));

      const { data, error } = await supabase.functions.invoke("push-to-sheets", {
        body: { entries },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      setSheetUrl(data.spreadsheet_url);
      toast.success(
        `${data.entries_added} entries sent to Google Sheets${data.is_new_sheet ? " (new sheet created)" : ""}`
      );
    } catch (err) {
      console.error("Push to sheets error:", err);
      toast.error("Failed to send to Google Sheets. Please try again.");
    } finally {
      setIsSending(false);
    }
  };

  const cellKey = (woIdx: number, entryIdx: number, field: string) =>
    `${woIdx}-${entryIdx}-${field}`;

  if (flatEntries.length === 0) return null;

  // Group flags by level for the banner
  const errors = flags.filter((f) => f.level === "error");
  const warnings = flags.filter((f) => f.level === "warning");
  const infos = flags.filter((f) => f.level === "info");

  return (
    <div className="space-y-4">
      {/* Validation flags banner */}
      {flags.length > 0 && (
        <div className="space-y-2">
          {errors.length > 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-900/50 p-3">
              <div className="flex items-center gap-2 mb-1">
                <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
                <span className="text-sm font-semibold text-red-800 dark:text-red-300">
                  {errors.length} error{errors.length !== 1 ? "s" : ""} — review before sending
                </span>
              </div>
              <ul className="text-sm text-red-700 dark:text-red-400 space-y-0.5 ml-6">
                {errors.map((f, i) => (
                  <li key={i}>{f.message}</li>
                ))}
              </ul>
            </div>
          )}
          {warnings.length > 0 && (
            <div className="rounded-lg border border-yellow-200 bg-yellow-50 dark:bg-yellow-950/20 dark:border-yellow-900/50 p-3">
              <div className="flex items-center gap-2 mb-1">
                <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
                <span className="text-sm font-semibold text-yellow-800 dark:text-yellow-300">
                  {warnings.length} warning{warnings.length !== 1 ? "s" : ""}
                </span>
              </div>
              <ul className="text-sm text-yellow-700 dark:text-yellow-400 space-y-0.5 ml-6">
                {warnings.map((f, i) => (
                  <li key={i}>{f.message}</li>
                ))}
              </ul>
            </div>
          )}
          {infos.length > 0 && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-900/50 p-3">
              <div className="flex items-center gap-2 mb-1">
                <Info className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                <span className="text-sm font-semibold text-blue-800 dark:text-blue-300">
                  {infos.length} note{infos.length !== 1 ? "s" : ""}
                </span>
              </div>
              <ul className="text-sm text-blue-700 dark:text-blue-400 space-y-0.5 ml-6">
                {infos.map((f, i) => (
                  <li key={i}>{f.message}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CheckCircle className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold text-foreground">
            Parsed Labor Data
          </h2>
          <span className="text-sm text-muted-foreground">
            ({flatEntries.length} entries)
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={exportCSV}>
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
          <Button size="sm" onClick={sendToSheets} disabled={isSending}>
            {isSending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {isSending ? "Sending..." : "Send to Sheets"}
          </Button>
          {sheetUrl && (
            <a
              href={sheetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              Open Sheet <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Click any cell to edit. Corrections are remembered for future parsing.
        {flags.length > 0 && " Rows are color-coded by confidence."}
      </p>

      <div className="rounded-lg border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-primary/5">
              <TableHead className="font-semibold">Job #</TableHead>
              <TableHead className="font-semibold">Customer</TableHead>
              <TableHead className="font-semibold">Date</TableHead>
              <TableHead className="font-semibold">Day</TableHead>
              <TableHead className="font-semibold">Employee</TableHead>
              <TableHead className="font-semibold">Hours</TableHead>
              <TableHead className="font-semibold">Type</TableHead>
              <TableHead className="font-semibold w-16">Conf.</TableHead>
              <TableHead className="w-10"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {flatEntries.map((entry) => {
              const key = `${entry.woIndex}-${entry.entryIndex}`;
              const conf = entry.confidence || "high";
              const rowBg = confidenceColors[conf] || "";
              const badge = confidenceBadge[conf];
              return (
                <TableRow key={key} className={`group hover:bg-accent/50 ${rowBg}`}>
                  <TableCell className="font-mono text-sm">
                    {editingCell === cellKey(entry.woIndex, entry.entryIndex, "job") ? (
                      <Input
                        defaultValue={entry.job_number}
                        autoFocus
                        className="h-8 w-24"
                        onBlur={(e) => {
                          const updated = [...workOrders];
                          updated[entry.woIndex].job_number = e.target.value;
                          onUpdate(updated);
                          setEditingCell(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            const updated = [...workOrders];
                            updated[entry.woIndex].job_number = (e.target as HTMLInputElement).value;
                            onUpdate(updated);
                            setEditingCell(null);
                          }
                        }}
                      />
                    ) : (
                      <span
                        className="cursor-pointer hover:text-primary"
                        onClick={() => setEditingCell(cellKey(entry.woIndex, entry.entryIndex, "job"))}
                      >
                        {entry.job_number}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {editingCell === cellKey(entry.woIndex, entry.entryIndex, "date") ? (
                      <Input
                        defaultValue={entry.date}
                        autoFocus
                        className="h-8 w-28"
                        onBlur={(e) => {
                          const updated = [...workOrders];
                          updated[entry.woIndex].date = e.target.value;
                          onUpdate(updated);
                          setEditingCell(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            const updated = [...workOrders];
                            updated[entry.woIndex].date = (e.target as HTMLInputElement).value;
                            onUpdate(updated);
                            setEditingCell(null);
                          }
                        }}
                      />
                    ) : (
                      <span
                        className="cursor-pointer hover:text-primary"
                        onClick={() => setEditingCell(cellKey(entry.woIndex, entry.entryIndex, "date"))}
                      >
                        {entry.date}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {editingCell === cellKey(entry.woIndex, entry.entryIndex, "day") ? (
                      <Input
                        defaultValue={entry.day_of_week}
                        autoFocus
                        className="h-8 w-28"
                        onBlur={(e) => {
                          const updated = [...workOrders];
                          updated[entry.woIndex].day_of_week = e.target.value;
                          onUpdate(updated);
                          setEditingCell(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            const updated = [...workOrders];
                            updated[entry.woIndex].day_of_week = (e.target as HTMLInputElement).value;
                            onUpdate(updated);
                            setEditingCell(null);
                          }
                        }}
                      />
                    ) : (
                      <span
                        className="cursor-pointer hover:text-primary"
                        onClick={() => setEditingCell(cellKey(entry.woIndex, entry.entryIndex, "day"))}
                      >
                        {entry.day_of_week}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {editingCell === cellKey(entry.woIndex, entry.entryIndex, "name") ? (
                      <Input
                        defaultValue={entry.employee_name}
                        autoFocus
                        className="h-8"
                        onBlur={(e) =>
                          updateEntry(entry.woIndex, entry.entryIndex, "employee_name", e.target.value)
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            updateEntry(entry.woIndex, entry.entryIndex, "employee_name", (e.target as HTMLInputElement).value);
                          }
                        }}
                      />
                    ) : (
                      <div className="flex items-center gap-1">
                        <span
                          className="cursor-pointer hover:text-primary flex items-center gap-1"
                          onClick={() => setEditingCell(cellKey(entry.woIndex, entry.entryIndex, "name"))}
                        >
                          {entry.employee_name}
                          <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-100" />
                        </span>
                        {entry.original_name && entry.original_name !== entry.employee_name && (
                          <span className="text-xs text-muted-foreground" title={`Originally: "${entry.original_name}"`}>
                            (was "{entry.original_name}")
                          </span>
                        )}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {editingCell === cellKey(entry.woIndex, entry.entryIndex, "hours") ? (
                      <Input
                        type="number"
                        step="0.5"
                        defaultValue={entry.hours}
                        autoFocus
                        className="h-8 w-20"
                        onBlur={(e) =>
                          updateEntry(entry.woIndex, entry.entryIndex, "hours", Number(e.target.value))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            updateEntry(entry.woIndex, entry.entryIndex, "hours", Number((e.target as HTMLInputElement).value));
                          }
                        }}
                      />
                    ) : (
                      <span
                        className={`cursor-pointer hover:text-primary font-medium ${entry.hours > 16 ? "text-yellow-600 dark:text-yellow-400" : ""}`}
                        onClick={() => setEditingCell(cellKey(entry.woIndex, entry.entryIndex, "hours"))}
                      >
                        {entry.hours}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={entry.type}
                      onValueChange={(v) =>
                        updateEntry(entry.woIndex, entry.entryIndex, "type", v)
                      }
                    >
                      <SelectTrigger className="h-8 w-[130px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Regular">Regular</SelectItem>
                        <SelectItem value="Off Hours">Off Hours</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    {badge && (
                      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${badge.className}`}>
                        {badge.label}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => deleteEntry(entry.woIndex, entry.entryIndex)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
};

export default LaborReviewTable;
