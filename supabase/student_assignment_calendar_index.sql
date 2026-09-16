-- Supports student month/day calendar range scans without reading all history.
create index if not exists writing_assignment_students_student_assigned_idx
  on public.writing_assignment_students(student_id, assigned_at, assignment_id);
