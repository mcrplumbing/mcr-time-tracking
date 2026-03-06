import { useState } from "react";
import { ParsedWorkOrder, LaborEntry } from "@/types/labor";
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
import { CheckCircle, Download, Pencil, Trash2, Send, ExternalLink, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface LaborReviewTableProps {
  workOrders: ParsedWorkOrder[];
  onUpdate: (workOrders: ParsedWorkOrder[]) => void;
}

const LaborReviewTable = ({ workOrders, onUpdate }: LaborReviewTableProps) => {
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
    const headers = ["Job #", "Date", "Day", "Employee", "Hours", "Type"];
    const rows = flatEntries.map((e) => [
      e.job_number,
      e.date,
      e.day_of_week,
      e.employee_name,
      e.hours,
      e.type,
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

  return (
    <div className="space-y-4">
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
      </p>

      <div className="rounded-lg border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-primary/5">
              <TableHead className="font-semibold">Job #</TableHead>
              <TableHead className="font-semibold">Date</TableHead>
              <TableHead className="font-semibold">Day</TableHead>
              <TableHead className="font-semibold">Employee</TableHead>
              <TableHead className="font-semibold">Hours</TableHead>
              <TableHead className="font-semibold">Type</TableHead>
              <TableHead className="w-10"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {flatEntries.map((entry) => {
              const key = `${entry.woIndex}-${entry.entryIndex}`;
              return (
                <TableRow key={key} className="group hover:bg-accent/50">
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
                  <TableCell className="text-sm">{entry.day_of_week}</TableCell>
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
                      <span
                        className="cursor-pointer hover:text-primary flex items-center gap-1"
                        onClick={() => setEditingCell(cellKey(entry.woIndex, entry.entryIndex, "name"))}
                      >
                        {entry.employee_name}
                        <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-100" />
                      </span>
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
                        className="cursor-pointer hover:text-primary font-medium"
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
