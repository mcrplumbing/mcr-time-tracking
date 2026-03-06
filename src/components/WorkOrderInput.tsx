import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FileText, Loader2 } from "lucide-react";

interface WorkOrderInputProps {
  onParse: (text: string) => void;
  isLoading: boolean;
}

const WorkOrderInput = ({ onParse, isLoading }: WorkOrderInputProps) => {
  const [text, setText] = useState("");

  const handleParse = () => {
    if (text.trim()) onParse(text.trim());
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <FileText className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold text-foreground">
          Paste Work Orders
        </h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Paste one or more work orders below. Separate multiple work orders with a blank line.
      </p>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Paste work order text here...\n\nExample:\nJob#25757 - Thursday - 3/5/26\n\nLabor:\nBryan. 8hr Regular\nCasey. 8 hrs Regular`}
        className="min-h-[250px] font-mono text-sm bg-card border-border"
      />
      <Button
        onClick={handleParse}
        disabled={!text.trim() || isLoading}
        className="w-full"
        size="lg"
      >
        {isLoading ? (
          <>
            <Loader2 className="animate-spin" />
            Parsing Work Orders...
          </>
        ) : (
          <>
            <FileText />
            Parse Labor Data
          </>
        )}
      </Button>
    </div>
  );
};

export default WorkOrderInput;
