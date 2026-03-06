import { useState } from "react";
import WorkOrderInput from "@/components/WorkOrderInput";
import LaborReviewTable from "@/components/LaborReviewTable";
import { ParsedWorkOrder } from "@/types/labor";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Wrench } from "lucide-react";

const Index = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [parsedOrders, setParsedOrders] = useState<ParsedWorkOrder[]>([]);

  const handleParse = async (text: string) => {
    setIsLoading(true);
    try {
      // Fetch corrections for learning
      const { data: corrections } = await supabase
        .from("labor_corrections")
        .select("*");

      let workOrderText = text;
      if (corrections && corrections.length > 0) {
        // Append correction context
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
      setParsedOrders(orders);

      if (orders.length === 0) {
        toast.warning("No labor data found in the work orders");
      } else {
        const totalEntries = orders.reduce(
          (sum: number, wo: ParsedWorkOrder) => sum + wo.entries.length,
          0
        );
        toast.success(
          `Parsed ${totalEntries} labor entries from ${orders.length} work order(s)`
        );
      }
    } catch (err) {
      console.error("Parse error:", err);
      toast.error("Failed to parse work orders. Please try again.");
    } finally {
      setIsLoading(false);
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
        />
      </main>
    </div>
  );
};

export default Index;
