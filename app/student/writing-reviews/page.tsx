import { StudentWritingReviewList } from "@/components/student/StudentWritingReview";
import { StudentPage } from "@/components/student/StudentUI";

export default function StudentWritingReviewsPage() {
  return (
    <StudentPage subtitle="查看教师已经发布的写作批改结果。" title="已发布批改">
      <StudentWritingReviewList />
    </StudentPage>
  );
}
