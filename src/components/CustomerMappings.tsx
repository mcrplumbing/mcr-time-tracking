import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
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
import { Plus, Trash2, BookOpen, Pencil, Check, X } from "lucide-react";
import { toast } from "sonner";

interface Mapping {
  id: string;
  keyword: string;
  customer_name: string;
}

const CustomerMappings = () => {
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [newKeyword, setNewKeyword] = useState("");
  const [newCustomer, setNewCustomer] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editKeyword, setEditKeyword] = useState("");
  const [editCustomer, setEditCustomer] = useState("");

  const fetchMappings = async () => {
    const { data } = await supabase
      .from("customer_mappings")
      .select("id, keyword, customer_name")
      .order("customer_name");
    setMappings(data || []);
  };

  useEffect(() => {
    if (isOpen) fetchMappings();
  }, [isOpen]);

  const addMapping = async () => {
    if (!newKeyword.trim() || !newCustomer.trim()) {
      toast.error("Both fields are required");
      return;
    }
    const { error } = await supabase.from("customer_mappings").upsert(
      { keyword: newKeyword.trim().toUpperCase(), customer_name: newCustomer.trim() },
      { onConflict: "keyword" }
    );
    if (error) {
      toast.error("Failed to add mapping");
      return;
    }
    toast.success(`"${newKeyword.trim()}" → "${newCustomer.trim()}" saved`);
    setNewKeyword("");
    setNewCustomer("");
    fetchMappings();
  };

  const deleteMapping = async (id: string, keyword: string) => {
    await supabase.from("customer_mappings").delete().eq("id", id);
    toast.success(`Removed "${keyword}"`);
    fetchMappings();
  };

  const startEdit = (m: Mapping) => {
    setEditingId(m.id);
    setEditKeyword(m.keyword);
    setEditCustomer(m.customer_name);
  };

  const saveEdit = async () => {
    if (!editKeyword.trim() || !editCustomer.trim()) return;
    await supabase
      .from("customer_mappings")
      .update({ keyword: editKeyword.trim().toUpperCase(), customer_name: editCustomer.trim() })
      .eq("id", editingId);
    setEditingId(null);
    toast.success("Mapping updated");
    fetchMappings();
  };

  // Group by customer_name for display
  const grouped = mappings.reduce<Record<string, Mapping[]>>((acc, m) => {
    (acc[m.customer_name] = acc[m.customer_name] || []).push(m);
    return acc;
  }, {});

  return (
    <div className="border border-border rounded-lg bg-card">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-accent/50 transition-colors rounded-lg"
      >
        <div className="flex items-center gap-2">
          <BookOpen className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">Customer Mappings</span>
          <span className="text-xs text-muted-foreground">({mappings.length} rules)</span>
        </div>
        <span className="text-xs text-muted-foreground">{isOpen ? "▲" : "▼"}</span>
      </button>

      {isOpen && (
        <div className="px-4 pb-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            Teach the parser to recognize customer abbreviations. When a keyword appears in work order text, it maps to the customer name.
          </p>

          {/* Add new */}
          <div className="flex gap-2 items-center">
            <Input
              placeholder="Keyword (e.g. HC4)"
              value={newKeyword}
              onChange={(e) => setNewKeyword(e.target.value)}
              className="h-8 max-w-[160px] text-sm"
              onKeyDown={(e) => e.key === "Enter" && addMapping()}
            />
            <span className="text-muted-foreground text-sm">→</span>
            <Input
              placeholder="Customer (e.g. USC-H)"
              value={newCustomer}
              onChange={(e) => setNewCustomer(e.target.value)}
              className="h-8 max-w-[160px] text-sm"
              onKeyDown={(e) => e.key === "Enter" && addMapping()}
            />
            <Button size="sm" variant="outline" onClick={addMapping} className="h-8">
              <Plus className="h-3 w-3 mr-1" /> Add
            </Button>
          </div>

          {/* Existing mappings */}
          {Object.keys(grouped).length > 0 && (
            <div className="rounded border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead className="text-xs py-2">Keyword</TableHead>
                    <TableHead className="text-xs py-2">Customer</TableHead>
                    <TableHead className="text-xs py-2 w-20"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mappings.map((m) => (
                    <TableRow key={m.id} className="group">
                      {editingId === m.id ? (
                        <>
                          <TableCell className="py-1">
                            <Input
                              value={editKeyword}
                              onChange={(e) => setEditKeyword(e.target.value)}
                              className="h-7 text-sm"
                            />
                          </TableCell>
                          <TableCell className="py-1">
                            <Input
                              value={editCustomer}
                              onChange={(e) => setEditCustomer(e.target.value)}
                              className="h-7 text-sm"
                            />
                          </TableCell>
                          <TableCell className="py-1">
                            <div className="flex gap-1">
                              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={saveEdit}>
                                <Check className="h-3 w-3 text-green-600" />
                              </Button>
                              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditingId(null)}>
                                <X className="h-3 w-3" />
                              </Button>
                            </div>
                          </TableCell>
                        </>
                      ) : (
                        <>
                          <TableCell className="py-1.5 text-sm font-mono">{m.keyword}</TableCell>
                          <TableCell className="py-1.5 text-sm">{m.customer_name}</TableCell>
                          <TableCell className="py-1.5">
                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7"
                                onClick={() => startEdit(m)}
                              >
                                <Pencil className="h-3 w-3" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7 text-destructive"
                                onClick={() => deleteMapping(m.id, m.keyword)}
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          </TableCell>
                        </>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default CustomerMappings;
