import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertCanonicalRdlTitle,
  countEnglishTitleWords,
  decideRdlProductionTitle,
  type RdlTitleAction
} from "../lib/reading/rdlTitles.ts";

type DecisionSource = {
  materialId: string;
  originalTitle: string | null;
  generatedTitle?: string;
};

type ManifestMaterial = {
  materialId: string;
  firstSeen: string;
  title: string;
  selectionMapRuntimePath: string;
};

const decisions: DecisionSource[] = [
  keep("RDL-001", "University Robotics Club Workshop"),
  keep("RDL-002", "Dorm Printer Setup Instructions"),
  generate("RDL-003", null, "Mini Fridge Repair Chat"),
  generate("RDL-004", "IN TUNE WITH WELL-BEING: A Full-Spectrum Wellness Journey", "Full-Spectrum Wellness Journey"),
  generate("RDL-005", null, "Life at Larkhaven"),
  keep("RDL-006", "UNIVERSITY HEALTH AND WELLNESS CONFERENCE"),
  keep("RDL-007", "Fall Midterm Schedule"),
  keep("RDL-008", "Greetings from an Eliot fan"),
  keep("RDL-009", "Mystery is a Must-See"),
  generate("RDL-010", null, "Student Film Showcase"),
  keep("RDL-011", "Dormitory Quiet Hours"),
  generate("RDL-012", "Stay Healthy During Cold And Flu Season", "Cold and Flu Prevention"),
  keep("RDL-013", "Tasty Bites"),
  generate("RDL-014", "Revitalizing Campus Life at Ridgeview University", "Revitalizing Ridgeview Campus Life"),
  keep("RDL-015", "GoodBooks shipment"),
  keep("RDL-016", "Literature 201: Introduction to World Literature"),
  generate("RDL-017", null, "Concert Planning Chat"),
  keep("RDL-018", "Internship fair follow-up"),
  keep("RDL-019", "ENGL 102: Introduction to Literature II"),
  generate("RDL-020", "Instructions for Resetting Your Dorm Room Router", "Dorm Router Reset Instructions"),
  generate("RDL-021", null, "Radiant Beauty Salon Opening"),
  generate("RDL-022", "CAMPUS RESEARCHERS “CRACK” THE CONCRETE CODE", "Self-Healing Concrete Breakthrough"),
  keep("RDL-023", "Organic Chemistry I"),
  keep("RDL-024", "Request to join Debate Club"),
  generate("RDL-025", "Welcome to the Williamsville College Gardening Club!", "Williamsville Gardening Club"),
  generate("RDL-026", "Award Winner Returns to Alma Mater", "Actor Returns to Campus"),
  keep("RDL-027", "Student Center Closure"),
  keep("RDL-028", "DORM STARTUP GOES VIRAL"),
  keep("RDL-029", "Booking inquiry"),
  keep("RDL-030", "Review of The Kansas Kerfuffle"),
  keep("RDL-031", "My thesis proposal"),
  generate("RDL-032", null, "Student Hiking Plans"),
  keep("RDL-033", "Membership Application Form"),
  keep("RDL-034", "The University Photography Club"),
  keep("RDL-035", "BIOL 101 Introduction to Biology"),
  keep("RDL-036", "Welcome to Movie Mania"),
  generate("RDL-037", null, "Flex and Flow Opening"),
  keep("RDL-038", "English 202: The Sonnet"),
  keep("RDL-039", "Solar panels for university library"),
  keep("RDL-040", "SIGN LANGUAGE INTERPRETER NEEDED"),
  generate("RDL-041", "Frankson Library Renovation and Temporary Relocation", "Frankson Library Relocation"),
  keep("RDL-042", "Ella Bottled Water (1 Case)"),
  generate("RDL-043", null, "Introductory Physics Course"),
  keep("RDL-044", "Downtown School of Data Skills"),
  keep("RDL-045", "Study Abroad Expo - Session Schedule"),
  generate("RDL-046", "MISHTI Exciting Indian Cuisine Near Campus", "Mishti Indian Cuisine"),
  keep("RDL-047", "Dental appointment"),
  keep("RDL-048", "Attention Residents!"),
  keep("RDL-049", "Serve & Shine: Volunteer Opportunities Expo"),
  keep("RDL-050", "Welcome, Study-Abroad Students!"),
  generate("RDL-051", null, "College Craft-A-Thon"),
  generate("RDL-052", "Time Capsule Unearthed During Dorm Renovation", "Dorm Renovation Time Capsule"),
  generate("RDL-053", null, "Dorm Room Maintenance"),
  generate("RDL-054", "Student Housing Dilemma: A Shortage of Affordable Options", "Affordable Student Housing Shortage"),
  keep("RDL-055", "University Library Update"),
  keep("RDL-056", "Study Smarter: Academic Success Workshop"),
  keep("RDL-057", "Mental Well-Being Workshops"),
  keep("RDL-058", "CampusConnect"),
  keep("RDL-059", "POLS 201 Comparative Political Thought"),
  generate("RDL-060", "Momentum Meet-up: Networking Mixer for Students", "Student Networking Mixer"),
  generate("RDL-061", null, "Library Hours and Guidelines"),
  keep("RDL-062", "YOUR GLOBAL CLASSROOM AWAITS!"),
  keep("RDL-063", "Sidewalk Repair Project"),
  generate("RDL-064", null, "Remote Learning Assignment Chat"),
  generate("RDL-065", null, "Global Cultures Documentary"),
  generate("RDL-066", null, "Arts Week Flash Mob"),
  generate("RDL-067", "Extended Library Hours for Final Exams", "Finals Week Library Hours"),
  keep("RDL-068", "Supporting information needed"),
  generate("RDL-069", "Join the University STEM Peer Support Group!", "STEM Peer Support Group"),
  keep("RDL-070", "Gym membership"),
  keep("RDL-071", "ENGL 101: Introduction to Literature"),
  generate("RDL-072", "Urgent: Campus Transport and Traffic Advisory", "Campus Traffic Advisory"),
  keep("RDL-073", "Housing renewal application"),
  generate("RDL-074", null, "Bella Italia Dining Notice"),
  keep("RDL-075", "MATH 101 Calculus I"),
  keep("RDL-076", "Discover Estonia's Timeless Charm"),
  generate("RDL-077", null, "Poetry Magazine Submissions"),
  keep("RDL-078", "BRIDGEFORD UNIVERSITY MUSIC & CULTURE NIGHT"),
  generate("RDL-079", null, "University Research Reactor"),
  keep("RDL-080", "CAMPUS VOLUNTEER DAY"),
  generate("RDL-081", "Blackout Brings Creativity to Finals Week", "Finals Week Blackout"),
  keep("RDL-082", "LIT304 Shakespeare's Kings"),
  generate("RDL-083", null, "Student Council Meeting Chat"),
  keep("RDL-084", "CULN 310 Advanced Techniques: Sous Vide"),
  generate("RDL-085", null, "Kintsugi and Wabi-Sabi"),
  generate("RDL-086", "The Rise of Sustainable Living in University Housing", "Sustainable Campus Housing")
];

async function main() {
  const projectRoot = process.cwd();
  const manifestPath = resolve(projectRoot, "data/reading/manifests/rdl-materials.json");
  const reportPath = resolve(projectRoot, "data/reading/reports/rdl-title-audit.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { materials: ManifestMaterial[] };
  const previousReport = JSON.parse(await readFile(reportPath, "utf8")) as {
    materials?: Array<{ material_id: string; new_title: string }>;
  };
  const previousTitleById = new Map(
    (previousReport.materials ?? []).map((row) => [row.material_id, row.new_title])
  );
  const byId = new Map(manifest.materials.map((material) => [material.materialId, material]));
  if (byId.size !== decisions.length || decisions.length !== 86) {
    throw new Error(`RDL title audit must cover all 86 canonical materials; received ${decisions.length}/${byId.size}`);
  }

  const rows = await Promise.all(decisions.map(async (source) => {
    const material = byId.get(source.materialId);
    if (!material) throw new Error(`unknown material ${source.materialId}`);
    const selection = JSON.parse(
      await readFile(resolve(projectRoot, "public", material.selectionMapRuntimePath.slice(1)), "utf8")
    ) as { lines?: Array<{ text?: string }> };
    const sourceOpeningText = selection.lines?.map((line) => line.text ?? "").join(" ") ?? "";
    const result = decideRdlProductionTitle({
      explicitOriginalTitle: source.originalTitle !== null,
      originalTitle: source.originalTitle,
      generatedTitle: source.generatedTitle ?? null,
      sourceOpeningText
    });
    return {
      material_id: source.materialId,
      source: `material-index.json#${source.materialId}`,
      source_label: material.firstSeen,
      current_title: material.title,
      previous_title: previousTitleById.get(source.materialId) ?? material.title,
      explicit_original_title: source.originalTitle !== null,
      original_title: source.originalTitle,
      original_title_word_count: result.originalTitleWordCount,
      action: result.action,
      new_title: result.title,
      new_title_word_count: countEnglishTitleWords(result.title)
    };
  }));

  const ids = new Set(rows.map((row) => row.material_id));
  if (ids.size !== 86 || rows.some((row) => assertCanonicalRdlTitle(row.new_title) !== row.new_title)) {
    throw new Error("RDL title audit is incomplete or contains an invalid final title");
  }
  const counts = countActions(rows.map((row) => row.action));
  const report = {
    schema_version: 2,
    material_count: rows.length,
    keep_original_count: counts.KEEP_ORIGINAL,
    generate_short_title_count: counts.GENERATE_SHORT_TITLE,
    all_final_titles_at_most_five_words: true,
    all_final_titles_capitalization_compliant: true,
    explicit_title_basis: "Independent source heading/title, explicit email Subject, or reviewed canonical title field only",
    materials: rows
  };
  const sqlPath = resolve(projectRoot, "supabase/reading_rdl_title_backfill.sql");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(sqlPath, backfillSql(rows), "utf8");
  console.log(JSON.stringify({ reportPath, sqlPath, ...counts, materialCount: rows.length }, null, 2));
}

function keep(materialId: string, originalTitle: string): DecisionSource {
  return { materialId, originalTitle };
}

function generate(materialId: string, originalTitle: string | null, generatedTitle: string): DecisionSource {
  return { materialId, originalTitle, generatedTitle };
}

function countActions(actions: RdlTitleAction[]) {
  return {
    KEEP_ORIGINAL: actions.filter((action) => action === "KEEP_ORIGINAL").length,
    GENERATE_SHORT_TITLE: actions.filter((action) => action === "GENERATE_SHORT_TITLE").length
  };
}

function sqlLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function backfillSql(rows: Array<{
  material_id: string;
  current_title: string;
  previous_title: string;
  new_title: string;
  action: RdlTitleAction;
  new_title_word_count: number;
}>) {
  const values = rows.map((row) => `  (${[
    sqlLiteral(row.material_id),
    sqlLiteral(row.current_title),
    sqlLiteral(row.previous_title),
    sqlLiteral(row.new_title),
    sqlLiteral(row.action),
    String(row.new_title_word_count)
  ].join(", ")})`).join(",\n");
  return `-- Generated by scripts/backfill-rdl-titles.ts. Review, then run once in Supabase SQL Editor.\n` +
`begin;\n\n` +
`create temporary table rdl_title_backfill (\n` +
`  material_id text primary key,\n` +
`  old_title text not null,\n` +
`  previous_title text not null,\n` +
`  new_title text not null,\n` +
`  action text not null check (action in ('KEEP_ORIGINAL', 'GENERATE_SHORT_TITLE')),\n` +
`  english_word_count integer not null check (english_word_count between 1 and 5)\n` +
`) on commit drop;\n\n` +
`insert into rdl_title_backfill values\n${values};\n\n` +
`do $$\n` +
`begin\n` +
`  if (select count(*) from rdl_title_backfill) <> 86 then\n` +
`    raise exception 'RDL title backfill must contain exactly 86 materials';\n` +
`  end if;\n` +
`  if exists (\n` +
`    select 1 from rdl_title_backfill b\n` +
`    left join reading_materials m on m.material_id = b.material_id\n` +
`    where m.material_id is null or m.title not in (b.old_title, b.previous_title, b.new_title)\n` +
`  ) then\n` +
`    raise exception 'RDL title preflight failed: missing material or unexpected current title';\n` +
`  end if;\n` +
`end $$;\n\n` +
`update reading_materials m\n` +
`set title = b.new_title\n` +
`from rdl_title_backfill b\n` +
`where m.material_id = b.material_id\n` +
`  and m.title is distinct from b.new_title;\n\n` +
`update reading_logical_items i\n` +
`set title = mapped.new_title\n` +
`from (\n` +
`  select distinct q.logical_item_id, b.new_title\n` +
`  from reading_questions q\n` +
`  join rdl_title_backfill b on b.material_id = q.material_id\n` +
`) mapped\n` +
`where i.logical_item_id = mapped.logical_item_id\n` +
`  and i.module = 'rdl'\n` +
`  and i.title is distinct from mapped.new_title;\n\n` +
`do $$\n` +
`begin\n` +
`  if exists (\n` +
`    select 1 from rdl_title_backfill b\n` +
`    join reading_materials m on m.material_id = b.material_id\n` +
`    where m.title <> b.new_title\n` +
`  ) then\n` +
`    raise exception 'RDL material title verification failed';\n` +
`  end if;\n` +
`  if exists (\n` +
`    select 1 from reading_logical_items i\n` +
`    join reading_questions q on q.logical_item_id = i.logical_item_id\n` +
`    join reading_materials m on m.material_id = q.material_id\n` +
`    where i.module = 'rdl' and i.title <> m.title\n` +
`  ) then\n` +
`    raise exception 'RDL logical item/material title verification failed';\n` +
`  end if;\n` +
`end $$;\n\n` +
`commit;\n`;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
