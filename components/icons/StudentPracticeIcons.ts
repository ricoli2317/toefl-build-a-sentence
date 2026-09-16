import {
  BookOpen,
  FileText,
  Library,
  Mail,
  MessageCircleMore,
  Puzzle
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { CompleteTheWordsIcon } from "./CompleteTheWordsIcon";

export type StudentPracticeIcon = ComponentType<
  SVGProps<SVGSVGElement> & {
    size?: number | string;
    strokeWidth?: number | string;
  }
>;

/** One icon-shape source for the student sidebar, catalogs, history, and wrongbook. */
export const STUDENT_PRACTICE_ICONS = {
  build_sentence: Puzzle,
  email: Mail,
  academic_discussion: MessageCircleMore,
  ctw: CompleteTheWordsIcon,
  rdl: FileText,
  rap: BookOpen,
  full_set: Library
} satisfies Record<string, StudentPracticeIcon>;
