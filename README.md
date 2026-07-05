# TOEFL Build a Sentence

Next.js + TypeScript + Supabase + Tailwind CSS practice system for TOEFL sentence-building exercises.

## Features

- Student login and teacher login with Supabase Auth
- Students choose a question set
- Each set contains 10 sentence-building questions
- Students click word chunks to fill blanks and click selected chunks to undo
- Server-side scoring against `correct_order`
- The browser fetches public question fields through an API route; `correct_order` is not exposed to students
- Stores each question's `submitted_order`
- Teacher dashboard shows student accuracy, set accuracy, and question accuracy

## Setup

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the Supabase SQL editor.
3. Create users in Supabase Auth. Set `raw_user_meta_data.role` to `student` or `teacher`, or update `public.profiles.role` after user creation.
4. Add environment variables from `.env.example`.
5. Install dependencies and run the app:

```bash
pnpm install
pnpm dev
```

## Vercel

Add these environment variables in Vercel:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

The service role key is used only in API routes for protected scoring and teacher aggregation.
