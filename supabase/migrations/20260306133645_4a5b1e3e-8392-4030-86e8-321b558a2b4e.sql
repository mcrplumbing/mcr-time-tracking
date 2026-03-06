
CREATE TABLE public.weekly_sheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start date NOT NULL UNIQUE,
  spreadsheet_id text NOT NULL,
  spreadsheet_url text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.weekly_sheets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to weekly_sheets" ON public.weekly_sheets
  FOR ALL USING (true) WITH CHECK (true);
