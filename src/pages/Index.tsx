import { useState } from "react";
import WorkOrderInput from "@/components/WorkOrderInput";
import LaborReviewTable from "@/components/LaborReviewTable";
import { ParsedWorkOrder, ValidationFlag } from "@/types/labor";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Wrench, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const Index = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [parsedOrders, setParsedOrders] = useState<ParsedWorkOrder[]>([]);
  const [parseFlags, setParseFlags] = useState<ValidationFlag[]>([]);
  const [recalcTab, setRecalcTab] = useState("");

  const handleParse = async (text: string) => {
    setIsLoading(true);
    setParseFlags([]);
    try {
      const { data: corrections } = await supabase
        .from("labor_corrections")
        .select("*");

      let workOrderText = text;
      if (corrections && corrections.length > 0) {
        const correctionNotes = corrections
          .filter((c) => c.original_name !== c.corrected_name)
          .map((c) => `"${c.original_name}" should be "${c.corrected_name}"`)
          .join("; ");
        if (correctionNotes) {
          workOrderText += `\n\n[CORRECTION NOTES: ${correctionNotes}]`;
        }
      }

      const { data, error } = await supabase.functions.invoke("parse-labor", {
        body: { workOrders: workOrderText },
      });

      if (error) throw error;

      const orders = data?.work_orders || [];
      const flags: ValidationFlag[] = data?.flags || [];
      setParsedOrders(orders);
      setParseFlags(flags);

      if (orders.length === 0) {
        toast.warning("No labor data found in the work orders");
      } else {
        const totalEntries = orders.reduce(
          (sum: number, wo: ParsedWorkOrder) => sum + wo.entries.length,
          0
        );
        if (data?.needsReview) {
          toast.warning(
            `Parsed ${totalEntries} entries — ${data.summary.errors} error(s), ${data.summary.warnings} warning(s). Review before sending.`
          );
        } else if (flags.length > 0) {
          toast.info(
            `Parsed ${totalEntries} entries with ${flags.length} note(s). Check flagged items.`
          );
        } else {
          toast.success(
            `Parsed ${totalEntries} labor entries from ${orders.length} work order(s)`
          );
        }
      }
    } catch (err) {
      console.error("Parse error:", err);
      toast.error("Failed to parse work orders. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleRecalcRecap = async () => {
    if (!recalcTab.trim()) {
      toast.error("Enter a tab name, e.g. WE 3/8/26");
      return;
    }
    setIsRecalculating(true);
    try {
      const { data, error } = await supabase.functions.invoke("recalc-recap", {
        body: { tab_name: recalcTab.trim() },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      toast.success(`Recap updated for ${data.employees_updated} employees on ${data.tab}`);
    } catch (err: any) {
      console.error("Recalc error:", err);
      toast.error(err.message || "Failed to recalculate recap");
    } finally {
      setIsRecalculating(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="container max-w-5xl mx-auto px-4 py-4 flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-primary flex items-center justify-center">
            <Wrench className="h-5 w-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">
              MCR Payroll Parser
            </h1>
            <p className="text-sm text-muted-foreground">
              Work order → Timesheet automation
            </p>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container max-w-5xl mx-auto px-4 py-8 space-y-8">
        <WorkOrderInput onParse={handleParse} isLoading={isLoading} />
        <LaborReviewTable
          workOrders={parsedOrders}
          onUpdate={setParsedOrders}
          flags={parseFlags}
        />

        {/* Recalculate Recap */}
        <div className="border border-border rounded-lg p-4 bg-card space-y-3">
          <h2 className="text-sm font-semibold text-foreground">Recalculate Recap</h2>
          <p className="text-xs text-muted-foreground">
            Re-read the sheet and update recap totals (Regular / Off-Hours) from column A markers. Useful after manual edits.
          </p>
          <div className="flex gap-2 items-center">
            <Input
              placeholder="Tab name, e.g. WE 3/8/26"
              value={recalcTab}
              onChange={(e) => setRecalcTab(e.target.value)}
              className="max-w-xs"
            />
            <Button
              onClick={handleRecalcRecap}
              disabled={isRecalculating}
              variant="outline"
              size="sm"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${isRecalculating ? "animate-spin" : ""}`} />
              {isRecalculating ? "Recalculating..." : "Recalculate"}
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
};

export default Index;
