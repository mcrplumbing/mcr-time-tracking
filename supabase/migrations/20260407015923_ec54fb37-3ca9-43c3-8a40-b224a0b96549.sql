CREATE TABLE public.customer_mappings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  keyword TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(keyword)
);

ALTER TABLE public.customer_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to customer_mappings"
  ON public.customer_mappings
  FOR ALL
  TO public
  USING (true)
  WITH CHECK (true);
