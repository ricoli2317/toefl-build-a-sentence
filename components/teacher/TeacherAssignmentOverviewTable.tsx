"use client";

import { ASSIGNMENT_CARD_CLASS } from "@/components/assignments/AssignmentPresentation";
import type {
  AssignmentOverview,
  AssignmentOverviewCell,
  AssignmentOverviewColumn,
  AssignmentOverviewRow
} from "@/lib/assignmentOverview";
import { formatLatestPracticeAt } from "@/lib/teacherStudentOverview";

/**
 * 作业总览: one row per recipient above the existing per-student cards.
 *
 * Columns are exactly the item types of the current Assignment Group, in
 * group order. The first line of every item cell is the completion count; the
 * second line is the secondary grade line (accuracy for BAS / Reading,
 * published teacher score for WE / AD). The summary row only exists for a
 * class Assignment; a one-to-one Assignment renders the same table with the
 * single student and no extra row.
 */
export function TeacherAssignmentOverviewTable({
  overview
}: {
  overview: AssignmentOverview;
}) {
  if (overview.columns.length === 0 || overview.rows.length === 0) return null;
  return (
    <section
      className={`${ASSIGNMENT_CARD_CLASS} min-w-0 p-4 sm:p-5`}
      data-assignment-overview
    >
      <h3 className="font-bold text-student-text">作业总览</h3>
      <div className="mt-3 max-w-full min-w-0 overflow-x-auto rounded-xl border border-student-border">
        <table
          className="w-full border-collapse text-left text-sm"
          style={{ minWidth: `${34 + overview.columns.length * 8.75}rem` }}
        >
          <caption className="sr-only">作业总览</caption>
          <thead className="bg-student-bg text-student-muted">
            <tr>
              <th className="whitespace-nowrap px-4 py-3 font-semibold" scope="col">学生</th>
              <th className="whitespace-nowrap px-4 py-3 font-semibold" scope="col">最近练习</th>
              <th className="whitespace-nowrap px-4 py-3 font-semibold" scope="col">作业进度</th>
              {overview.columns.map((column) => (
                <th
                  className="min-w-[8.5rem] whitespace-nowrap px-4 py-3 font-semibold"
                  key={column.taskType}
                  scope="col"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-student-border">
            {overview.rows.map((row) => (
              <tr key={row.studentId}>
                <td className="whitespace-nowrap px-4 py-3 font-semibold text-student-text">
                  {row.studentName}
                </td>
                <AssignmentOverviewMetricCells
                  columns={overview.columns}
                  row={row}
                />
              </tr>
            ))}
            {overview.summary ? (
              <tr className="bg-student-bg/60">
                <td className="whitespace-nowrap px-4 py-3 font-bold text-student-text">
                  {overview.summary.studentName}
                </td>
                <AssignmentOverviewMetricCells
                  columns={overview.columns}
                  row={overview.summary}
                />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Shared metric cells for both overviews: 最近练习, 作业进度 and every type
 * column. The caller owns the leading 学生 cell and any trailing actions cell.
 */
export function AssignmentOverviewMetricCells({
  columns,
  row,
  progressEmptyText
}: {
  columns: ReadonlyArray<AssignmentOverviewColumn>;
  row: AssignmentOverviewRow;
  /** Shown instead of `0/0（0%）` when no item is assigned to this row. */
  progressEmptyText?: string;
}) {
  return (
    <>
      <td className="whitespace-nowrap px-4 py-3 text-student-muted">
        {formatLatestPracticeAt(row.latestPracticeAt)}
      </td>
      <td className="whitespace-nowrap px-4 py-3 font-semibold text-student-text">
        {row.assignedCount === 0 && progressEmptyText
          ? progressEmptyText
          : `${row.completedCount}/${row.assignedCount}（${row.completionPercent}%）`}
      </td>
      {row.cells.map((cell, index) => (
        <td className="whitespace-nowrap px-4 py-3" key={cell.taskType}>
          <span className="block font-semibold text-student-text">
            {cell.completedCount}/{cell.assignedCount}
          </span>
          <span className="mt-0.5 block text-xs text-student-muted">
            {overviewGradeLabel(cell, columns[index])}
          </span>
        </td>
      ))}
    </>
  );
}

function overviewGradeLabel(
  cell: AssignmentOverviewCell,
  column: AssignmentOverviewColumn | undefined
) {
  if (!column || column.gradeKind === "accuracy") {
    return cell.accuracyPercent === null ? "—" : `正确率 ${cell.accuracyPercent}%`;
  }
  return cell.averageScore === null ? "—" : `平均分 ${cell.averageScore.toFixed(1)}/5`;
}
