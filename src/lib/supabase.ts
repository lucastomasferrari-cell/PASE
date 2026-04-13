import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://pduxydviqiaxfqnshhdc.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBkdXh5ZHZpcWlheGZxbnNoaGRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NDExNDAsImV4cCI6MjA5MTMxNzE0MH0.oh0ObrthoSjmHeAEC3_kfvDnZeOY22ShGAsxv6_2o08";

export const db = createClient(SUPABASE_URL, SUPABASE_KEY);
