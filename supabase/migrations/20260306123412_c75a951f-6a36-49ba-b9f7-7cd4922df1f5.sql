
-- Table to store labor parsing correction patterns (learning function)
CREATE TABLE public.labor_corrections (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  original_name TEXT NOT NULL,
  corrected_name TEXT NOT NULL,
  original_type TEXT,
  corrected_type TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- No RLS needed - this is an internal office tool, no user auth
ALTER TABLE public.labor_corrections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to labor_corrections"
  ON public.labor_corrections
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Table to store known employees for validation
CREATE TABLE public.employees (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  first_name TEXT NOT NULL UNIQUE,
  full_name TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access to employees"
  ON public.employees
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Seed known employees from the spreadsheet
INSERT INTO public.employees (first_name, full_name) VALUES
  ('Octavio', 'OCTAVIO RODRIGUEZ'),
  ('Christian', 'CHRISTIAN AGUILAR'),
  ('Gabriel', 'GABRIEL GUERRERO'),
  ('Peter', 'PETER QUINONES'),
  ('Martin', 'MARTIN VERDUZCO'),
  ('Mynor', 'MYNOR RANGEL'),
  ('Edwin', 'EDWIN VILLALOBOS'),
  ('John', 'JOHN FERNANDEZ'),
  ('Bryan', 'BRYAN GARCIA'),
  ('Daniel', NULL),
  ('Casey', NULL);
