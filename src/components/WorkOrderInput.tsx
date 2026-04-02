import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FileText, Loader2, Upload, X } from "lucide-react";
import { toast } from "sonner";

interface WorkOrderInputProps {
  onParse: (text: string) => void;
  isLoading: boolean;
}

// Load pdf.js lazily on first use
let pdfjsPromise: Promise<any> | null = null;
function loadPdfJs(): Promise<any> {
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs";
      script.type = "module";
      // pdf.js as a classic script for broader compat
      const classic = document.createElement("script");
      classic.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.js";
      classic.onload = () => {
        const lib = (window as any).pdfjsLib;
        if (lib) {
          lib.GlobalWorkerOptions.workerSrc =
            "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.js";
          resolve(lib);
        } else {
          reject(new Error("pdf.js did not load"));
        }
      };
      classic.onerror = () => reject(new Error("Failed to load pdf.js"));
      document.head.appendChild(classic);
    });
  }
  return pdfjsPromise;
}

async function extractTextFromPDF(file: File): Promise<string> {
  const pdfjsLib = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map((item: any) => item.str);
    pages.push(strings.join(" "));
  }

  return pages.join("\n\n");
}

const WorkOrderInput = ({ onParse, isLoading }: WorkOrderInputProps) => {
  const [text, setText] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    if (file.type !== "application/pdf") {
      toast.error("Only PDF files are supported");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error("File too large (max 10MB)");
      return;
    }

    setPdfFile(file);
    setIsExtracting(true);
    try {
      const extracted = await extractTextFromPDF(file);
      if (!extracted.trim()) {
        toast.warning("No text found in PDF — it may be a scanned image. Try pasting the text instead.");
        setPdfFile(null);
      } else {
        setText(extracted);
        toast.success(`Extracted text from ${file.name}`);
      }
    } catch (err) {
      console.error("PDF extraction error:", err);
      toast.error("Failed to read PDF. Try pasting the work order text instead.");
      setPdfFile(null);
    } finally {
      setIsExtracting(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = "";
  };

  const clearPdf = () => {
    setPdfFile(null);
    setText("");
  };

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
        Paste work order text below, or drop a PDF file. Separate multiple work orders with a blank line.
      </p>

      {/* PDF drop zone wrapping the textarea */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`relative rounded-lg border-2 border-dashed transition-colors ${
          isDragging
            ? "border-primary bg-primary/5"
            : "border-border hover:border-muted-foreground/50"
        }`}
      >
        {pdfFile && (
          <div className="absolute top-2 right-2 z-10 flex items-center gap-2 bg-card border rounded-md px-3 py-1 text-xs text-muted-foreground shadow-sm">
            <FileText className="h-3 w-3" />
            {pdfFile.name}
            <button onClick={clearPdf} className="hover:text-destructive">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {isExtracting ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">Extracting text from PDF...</p>
          </div>
        ) : (
          <>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={`Paste work order text here...\n\nOr drag & drop a PDF file.\n\nExample:\nJob#25757 - Thursday - 3/5/26\n\nLabor:\nBryan. 8hr Regular\nCasey. 8 hrs Regular`}
              className="min-h-[250px] font-mono text-sm bg-card border-0 focus-visible:ring-0 resize-y"
            />
            {isDragging && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-primary/5 rounded-lg">
                <Upload className="h-10 w-10 text-primary mb-2" />
                <p className="text-sm font-medium text-primary">Drop PDF here</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex gap-2">
        <Button
          onClick={handleParse}
          disabled={!text.trim() || isLoading || isExtracting}
          className="flex-1"
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
        <Button
          variant="outline"
          size="lg"
          onClick={() => fileInputRef.current?.click()}
          disabled={isLoading || isExtracting}
        >
          <Upload className="h-4 w-4" />
          Upload PDF
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf"
          className="hidden"
          onChange={handleFileSelect}
        />
      </div>
    </div>
  );
};

export default WorkOrderInput;
