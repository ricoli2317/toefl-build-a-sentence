import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { bearerToken } from "@/lib/auth";
import {
  dedupeGrammarQuestions,
  getGrammarTagSummaries,
  questionHasGrammarTag,
  shuffleQuestions,
  type GrammarQuestionRow
} from "@/lib/grammarPractice";
import { readAllSupabaseRows } from "@/lib/supabasePagination";

export const dynamic = "force-dynamic";

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

function jsonError(message: string, status = 500) {
  return json({ error: message }, { status });
}

export async function GET(request: Request) {
  try {
    const token = bearerToken(request);
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return jsonError("Missing Supabase environment variables.");
    }
    if (!token) return jsonError("Missing access token", 401);

    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } }
    });
    const {
      data: { user },
      error: userError
    } = await authClient.auth.getUser(token);
    if (userError || !user) {
      return jsonError(userError?.message ?? "Invalid session", 401);
    }

    const { data: profile, error: profileError } = await authClient
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (profileError || profile?.role !== "student") {
      return jsonError(profileError?.message ?? "Unauthorized", 401);
    }

    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const db = createClient(supabaseUrl, serviceRoleKey || supabaseAnonKey, {
      auth: { persistSession: false },
      global: {
        fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
        headers: serviceRoleKey ? {} : { Authorization: `Bearer ${token}` }
      }
    });
    const questionResult = await readAllSupabaseRows<GrammarQuestionRow>((from, to) =>
      db
        .from("questions")
        .select(
          "question_id,set_id,set_title,question_order,prompt,sentence_template,blank_count,options_text,distractors_text,final_sentence,grammar_tags_text"
        )
        .order("set_id", { ascending: true })
        .order("question_order", { ascending: true })
        .order("question_id", { ascending: true })
        .range(from, to)
    );
    if (questionResult.error) {
      return jsonError(`Failed to load grammar questions: ${questionResult.error.message}`);
    }

    const questions = (questionResult.data ?? []).map(normalizeQuestion);
    const url = new URL(request.url);
    const selectedTag = url.searchParams.get("tag")?.trim() ?? "";
    if (!selectedTag) {
      return json({ tags: getGrammarTagSummaries(questions) });
    }

    const mode = url.searchParams.get("mode") === "random" ? "random" : "all";
    const dedupedQuestions = dedupeGrammarQuestions(
      questions.filter((question) => questionHasGrammarTag(question, selectedTag))
    );
    const selectedQuestions =
      mode === "random" ? shuffleQuestions(dedupedQuestions).slice(0, 10) : dedupedQuestions;

    return json({
      count: selectedQuestions.length,
      questions: selectedQuestions.map(toPublicQuestion),
      tag: selectedTag
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load grammar practice.");
  }
}

function normalizeQuestion(question: GrammarQuestionRow): GrammarQuestionRow {
  return {
    blank_count: question.blank_count ?? 0,
    distractors_text: question.distractors_text ?? "",
    final_sentence: question.final_sentence ?? "",
    grammar_tags_text: question.grammar_tags_text ?? "",
    options_text: question.options_text ?? "",
    prompt: question.prompt ?? "",
    question_id: String(question.question_id),
    question_order: question.question_order ?? 0,
    sentence_template: question.sentence_template ?? "",
    set_id: String(question.set_id),
    set_title: question.set_title ?? String(question.set_id)
  };
}

function toPublicQuestion({ final_sentence: _finalSentence, ...question }: GrammarQuestionRow) {
  return question;
}
