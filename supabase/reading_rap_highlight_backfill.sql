-- Generated from data/reading/reports/rap-highlight-mapping-audit.json.
-- Source mappings: 186 HIGH ranges; logical targets: 152 questions / 156 ranges / 96 items.
-- This script changes only reading_questions.passage_highlight_ranges for the stable RAP targets below.

begin;

create temporary table rap_highlight_backfill_targets (
  question_id text primary key,
  logical_item_id text not null,
  ranges jsonb not null,
  expected_texts jsonb not null
) on commit drop;

insert into rap_highlight_backfill_targets (question_id, logical_item_id, ranges, expected_texts)
values
  ('reading-rap-00d1af757b20b7f4f6440076-q02', 'reading-rap-00d1af757b20b7f4f6440076', '[{"paragraphId":"reading-rap-00d1af757b20b7f4f6440076-passage-01-p01","startOffset":278,"endOffset":292}]'::jsonb, '["transformative"]'::jsonb),
  ('reading-rap-00d1af757b20b7f4f6440076-q04', 'reading-rap-00d1af757b20b7f4f6440076', '[{"paragraphId":"reading-rap-00d1af757b20b7f4f6440076-passage-01-p03","startOffset":448,"endOffset":488}]'::jsonb, '["the global spread of wireless technology"]'::jsonb),
  ('reading-rap-059ab1c8259c00f0242e7951-q01', 'reading-rap-059ab1c8259c00f0242e7951', '[{"paragraphId":"reading-rap-059ab1c8259c00f0242e7951-passage-01-p01","startOffset":5,"endOffset":11}]'::jsonb, '["static"]'::jsonb),
  ('reading-rap-059ab1c8259c00f0242e7951-q04', 'reading-rap-059ab1c8259c00f0242e7951', '[{"paragraphId":"reading-rap-059ab1c8259c00f0242e7951-passage-01-p03","startOffset":484,"endOffset":493},{"paragraphId":"reading-rap-059ab1c8259c00f0242e7951-passage-01-p03","startOffset":568,"endOffset":581}]'::jsonb, '["hospitals","office spaces"]'::jsonb),
  ('reading-rap-08b62a981873c3e2eef76ff4-q01', 'reading-rap-08b62a981873c3e2eef76ff4', '[{"paragraphId":"reading-rap-08b62a981873c3e2eef76ff4-passage-01-p01","startOffset":492,"endOffset":548}]'::jsonb, '["neural pathways associated with attention and processing"]'::jsonb),
  ('reading-rap-08b62a981873c3e2eef76ff4-q05', 'reading-rap-08b62a981873c3e2eef76ff4', '[{"paragraphId":"reading-rap-08b62a981873c3e2eef76ff4-passage-01-p03","startOffset":260,"endOffset":268}]'::jsonb, '["holistic"]'::jsonb),
  ('reading-rap-08f66e6c2b3e25bd34fa0651-q03', 'reading-rap-08f66e6c2b3e25bd34fa0651', '[{"paragraphId":"reading-rap-08f66e6c2b3e25bd34fa0651-passage-01-p03","startOffset":94,"endOffset":105}]'::jsonb, '["stewardship"]'::jsonb),
  ('reading-rap-0dd51c79faabdb5cfd63f07e-q02', 'reading-rap-0dd51c79faabdb5cfd63f07e', '[{"paragraphId":"reading-rap-0dd51c79faabdb5cfd63f07e-passage-01-p02","startOffset":236,"endOffset":244}]'::jsonb, '["vigilant"]'::jsonb),
  ('reading-rap-12e71c91e8c595abfee101fb-q03', 'reading-rap-12e71c91e8c595abfee101fb', '[{"paragraphId":"reading-rap-12e71c91e8c595abfee101fb-passage-01-p02","startOffset":29,"endOffset":38}]'::jsonb, '["cultivate"]'::jsonb),
  ('reading-rap-150613dd5287e3f4b779eb5a-q03', 'reading-rap-150613dd5287e3f4b779eb5a', '[{"paragraphId":"reading-rap-150613dd5287e3f4b779eb5a-passage-01-p03","startOffset":94,"endOffset":105}]'::jsonb, '["stewardship"]'::jsonb),
  ('reading-rap-18254e6c2471afbb626c22b4-q01', 'reading-rap-18254e6c2471afbb626c22b4', '[{"paragraphId":"reading-rap-18254e6c2471afbb626c22b4-passage-01-p01","startOffset":5,"endOffset":11}]'::jsonb, '["static"]'::jsonb),
  ('reading-rap-18254e6c2471afbb626c22b4-q04', 'reading-rap-18254e6c2471afbb626c22b4', '[{"paragraphId":"reading-rap-18254e6c2471afbb626c22b4-passage-01-p03","startOffset":484,"endOffset":493},{"paragraphId":"reading-rap-18254e6c2471afbb626c22b4-passage-01-p03","startOffset":568,"endOffset":581}]'::jsonb, '["hospitals","office spaces"]'::jsonb),
  ('reading-rap-199501db577904fb79815267-q01', 'reading-rap-199501db577904fb79815267', '[{"paragraphId":"reading-rap-199501db577904fb79815267-passage-01-p01","startOffset":290,"endOffset":299}]'::jsonb, '["anomalies"]'::jsonb),
  ('reading-rap-1f2a25af84cd749261037df0-q01', 'reading-rap-1f2a25af84cd749261037df0', '[{"paragraphId":"reading-rap-1f2a25af84cd749261037df0-passage-01-p01","startOffset":77,"endOffset":83}]'::jsonb, '["subtle"]'::jsonb),
  ('reading-rap-1f2a25af84cd749261037df0-q03', 'reading-rap-1f2a25af84cd749261037df0', '[{"paragraphId":"reading-rap-1f2a25af84cd749261037df0-passage-01-p02","startOffset":238,"endOffset":304}]'::jsonb, '["variations in rock density and the presence of faults or fractures"]'::jsonb),
  ('reading-rap-1f2a25af84cd749261037df0-q05', 'reading-rap-1f2a25af84cd749261037df0', '[{"paragraphId":"reading-rap-1f2a25af84cd749261037df0-passage-01-p03","startOffset":242,"endOffset":313}]'::jsonb, '["filtering methods and cross-referencing data from multiple seismometers"]'::jsonb),
  ('reading-rap-1f5a2a094976c7046412177a-q02', 'reading-rap-1f5a2a094976c7046412177a', '[{"paragraphId":"reading-rap-1f5a2a094976c7046412177a-passage-01-p02","startOffset":147,"endOffset":173}]'::jsonb, '["fitting oranges into boxes"]'::jsonb),
  ('reading-rap-1f5a2a094976c7046412177a-q04', 'reading-rap-1f5a2a094976c7046412177a', '[{"paragraphId":"reading-rap-1f5a2a094976c7046412177a-passage-01-p04","startOffset":73,"endOffset":78}]'::jsonb, '["belie"]'::jsonb),
  ('reading-rap-25e10401a0a3eeb038f2636e-q01', 'reading-rap-25e10401a0a3eeb038f2636e', '[{"paragraphId":"reading-rap-25e10401a0a3eeb038f2636e-passage-01-p01","startOffset":77,"endOffset":83}]'::jsonb, '["subtle"]'::jsonb),
  ('reading-rap-25e10401a0a3eeb038f2636e-q03', 'reading-rap-25e10401a0a3eeb038f2636e', '[{"paragraphId":"reading-rap-25e10401a0a3eeb038f2636e-passage-01-p02","startOffset":238,"endOffset":304}]'::jsonb, '["variations in rock density and the presence of faults or fractures"]'::jsonb),
  ('reading-rap-25e10401a0a3eeb038f2636e-q05', 'reading-rap-25e10401a0a3eeb038f2636e', '[{"paragraphId":"reading-rap-25e10401a0a3eeb038f2636e-passage-01-p03","startOffset":242,"endOffset":313}]'::jsonb, '["filtering methods and cross-referencing data from multiple seismometers"]'::jsonb),
  ('reading-rap-2662811490d7e1cb8ef50753-q02', 'reading-rap-2662811490d7e1cb8ef50753', '[{"paragraphId":"reading-rap-2662811490d7e1cb8ef50753-passage-01-p02","startOffset":206,"endOffset":237}]'::jsonb, '["This consequentialist framework"]'::jsonb),
  ('reading-rap-2662811490d7e1cb8ef50753-q03', 'reading-rap-2662811490d7e1cb8ef50753', '[{"paragraphId":"reading-rap-2662811490d7e1cb8ef50753-passage-01-p02","startOffset":482,"endOffset":492}]'::jsonb, '["allocating"]'::jsonb),
  ('reading-rap-26d0ed793e40bbe883e60a6a-q02', 'reading-rap-26d0ed793e40bbe883e60a6a', '[{"paragraphId":"reading-rap-26d0ed793e40bbe883e60a6a-passage-01-p01","startOffset":450,"endOffset":482}]'::jsonb, '["sunlight becomes chemical energy"]'::jsonb),
  ('reading-rap-26d0ed793e40bbe883e60a6a-q04', 'reading-rap-26d0ed793e40bbe883e60a6a', '[{"paragraphId":"reading-rap-26d0ed793e40bbe883e60a6a-passage-01-p02","startOffset":302,"endOffset":311}]'::jsonb, '["disparity"]'::jsonb),
  ('reading-rap-28b2cecf31bfee0a244d1a09-q03', 'reading-rap-28b2cecf31bfee0a244d1a09', '[{"paragraphId":"reading-rap-28b2cecf31bfee0a244d1a09-passage-01-p03","startOffset":259,"endOffset":272}]'::jsonb, '["fundamentally"]'::jsonb),
  ('reading-rap-28ff52f3a4ffdbd69e8d95cd-q02', 'reading-rap-28ff52f3a4ffdbd69e8d95cd', '[{"paragraphId":"reading-rap-28ff52f3a4ffdbd69e8d95cd-passage-01-p01","startOffset":507,"endOffset":514}]'::jsonb, '["a prism"]'::jsonb),
  ('reading-rap-28ff52f3a4ffdbd69e8d95cd-q05', 'reading-rap-28ff52f3a4ffdbd69e8d95cd', '[{"paragraphId":"reading-rap-28ff52f3a4ffdbd69e8d95cd-passage-01-p03","startOffset":178,"endOffset":186}]'::jsonb, '["prophecy"]'::jsonb),
  ('reading-rap-2a8207a6f456303be8bfd836-q01', 'reading-rap-2a8207a6f456303be8bfd836', '[{"paragraphId":"reading-rap-2a8207a6f456303be8bfd836-passage-01-p01","startOffset":208,"endOffset":213}]'::jsonb, '["norms"]'::jsonb),
  ('reading-rap-2a8207a6f456303be8bfd836-q04', 'reading-rap-2a8207a6f456303be8bfd836', '[{"paragraphId":"reading-rap-2a8207a6f456303be8bfd836-passage-01-p01","startOffset":1089,"endOffset":1103}]'::jsonb, '["these dynamics"]'::jsonb),
  ('reading-rap-2b14b33aacc064d75314fa53-q01', 'reading-rap-2b14b33aacc064d75314fa53', '[{"paragraphId":"reading-rap-2b14b33aacc064d75314fa53-passage-01-p01","startOffset":33,"endOffset":42}]'::jsonb, '["grappling"]'::jsonb),
  ('reading-rap-34f6bce8fefcc9ea8c94efb8-q01', 'reading-rap-34f6bce8fefcc9ea8c94efb8', '[{"paragraphId":"reading-rap-34f6bce8fefcc9ea8c94efb8-passage-01-p01","startOffset":341,"endOffset":381}]'::jsonb, '["higher prevalence of metabolic disorders"]'::jsonb),
  ('reading-rap-34f6bce8fefcc9ea8c94efb8-q05', 'reading-rap-34f6bce8fefcc9ea8c94efb8', '[{"paragraphId":"reading-rap-34f6bce8fefcc9ea8c94efb8-passage-01-p03","startOffset":310,"endOffset":317}]'::jsonb, '["rectify"]'::jsonb),
  ('reading-rap-356930309b8c015008667f85-q01', 'reading-rap-356930309b8c015008667f85', '[{"paragraphId":"reading-rap-356930309b8c015008667f85-passage-01-p01","startOffset":30,"endOffset":43}]'::jsonb, '["revolutionize"]'::jsonb),
  ('reading-rap-3c7da315889dceed32412dcf-q03', 'reading-rap-3c7da315889dceed32412dcf', '[{"paragraphId":"reading-rap-3c7da315889dceed32412dcf-passage-01-p02","startOffset":233,"endOffset":241}]'::jsonb, '["involved"]'::jsonb),
  ('reading-rap-3c7da315889dceed32412dcf-q04', 'reading-rap-3c7da315889dceed32412dcf', '[{"paragraphId":"reading-rap-3c7da315889dceed32412dcf-passage-01-p02","startOffset":288,"endOffset":313}]'::jsonb, '["a vegan cheese substitute"]'::jsonb),
  ('reading-rap-4042fb1dc21bdf042d6ea366-q04', 'reading-rap-4042fb1dc21bdf042d6ea366', '[{"paragraphId":"reading-rap-4042fb1dc21bdf042d6ea366-passage-01-p03","startOffset":216,"endOffset":221}]'::jsonb, '["evoke"]'::jsonb),
  ('reading-rap-43fe10b35ebdf733d430c751-q05', 'reading-rap-43fe10b35ebdf733d430c751', '[{"paragraphId":"reading-rap-43fe10b35ebdf733d430c751-passage-01-p03","startOffset":413,"endOffset":427}]'::jsonb, '["culminating in"]'::jsonb),
  ('reading-rap-44052a9cdd0f99d094526a4b-q03', 'reading-rap-44052a9cdd0f99d094526a4b', '[{"paragraphId":"reading-rap-44052a9cdd0f99d094526a4b-passage-01-p02","startOffset":69,"endOffset":82}]'::jsonb, '["sophisticated"]'::jsonb),
  ('reading-rap-4986420f2a3c5df66f0fe8d2-q01', 'reading-rap-4986420f2a3c5df66f0fe8d2', '[{"paragraphId":"reading-rap-4986420f2a3c5df66f0fe8d2-passage-01-p01","startOffset":587,"endOffset":594}]'::jsonb, '["harness"]'::jsonb),
  ('reading-rap-4986420f2a3c5df66f0fe8d2-q03', 'reading-rap-4986420f2a3c5df66f0fe8d2', '[{"paragraphId":"reading-rap-4986420f2a3c5df66f0fe8d2-passage-01-p02","startOffset":71,"endOffset":90}]'::jsonb, '["buoyancy principles"]'::jsonb),
  ('reading-rap-4986420f2a3c5df66f0fe8d2-q04', 'reading-rap-4986420f2a3c5df66f0fe8d2', '[{"paragraphId":"reading-rap-4986420f2a3c5df66f0fe8d2-passage-01-p02","startOffset":405,"endOffset":418}]'::jsonb, '["wear and tear"]'::jsonb),
  ('reading-rap-4f8833c13727320a3fbd20a9-q02', 'reading-rap-4f8833c13727320a3fbd20a9', '[{"paragraphId":"reading-rap-4f8833c13727320a3fbd20a9-passage-01-p01","startOffset":507,"endOffset":514}]'::jsonb, '["a prism"]'::jsonb),
  ('reading-rap-4f8833c13727320a3fbd20a9-q05', 'reading-rap-4f8833c13727320a3fbd20a9', '[{"paragraphId":"reading-rap-4f8833c13727320a3fbd20a9-passage-01-p03","startOffset":178,"endOffset":186}]'::jsonb, '["prophecy"]'::jsonb),
  ('reading-rap-50cfc4c5fd006c1ec78a60b8-q01', 'reading-rap-50cfc4c5fd006c1ec78a60b8', '[{"paragraphId":"reading-rap-50cfc4c5fd006c1ec78a60b8-passage-01-p01","startOffset":455,"endOffset":471}]'::jsonb, '["chemical changes"]'::jsonb),
  ('reading-rap-50cfc4c5fd006c1ec78a60b8-q02', 'reading-rap-50cfc4c5fd006c1ec78a60b8', '[{"paragraphId":"reading-rap-50cfc4c5fd006c1ec78a60b8-passage-01-p01","startOffset":658,"endOffset":698}]'::jsonb, '["a transitional moment in Greek sculpture"]'::jsonb),
  ('reading-rap-51f18b2b4046d93a70bdd300-q03', 'reading-rap-51f18b2b4046d93a70bdd300', '[{"paragraphId":"reading-rap-51f18b2b4046d93a70bdd300-passage-01-p02","startOffset":460,"endOffset":472}]'::jsonb, '["deliberately"]'::jsonb),
  ('reading-rap-51f18b2b4046d93a70bdd300-q04', 'reading-rap-51f18b2b4046d93a70bdd300', '[{"paragraphId":"reading-rap-51f18b2b4046d93a70bdd300-passage-01-p03","startOffset":280,"endOffset":321}]'::jsonb, '["autonomy and transparency in patient care"]'::jsonb),
  ('reading-rap-520073d086537b70cc6ba0fa-q03', 'reading-rap-520073d086537b70cc6ba0fa', '[{"paragraphId":"reading-rap-520073d086537b70cc6ba0fa-passage-01-p02","startOffset":69,"endOffset":82}]'::jsonb, '["sophisticated"]'::jsonb),
  ('reading-rap-5773e5b9a84f86d3ac356a45-q04', 'reading-rap-5773e5b9a84f86d3ac356a45', '[{"paragraphId":"reading-rap-5773e5b9a84f86d3ac356a45-passage-01-p03","startOffset":216,"endOffset":221}]'::jsonb, '["evoke"]'::jsonb),
  ('reading-rap-5817366a9ff4cc9c334fb39a-q03', 'reading-rap-5817366a9ff4cc9c334fb39a', '[{"paragraphId":"reading-rap-5817366a9ff4cc9c334fb39a-passage-01-p02","startOffset":596,"endOffset":609}]'::jsonb, '["echo chambers"]'::jsonb),
  ('reading-rap-5817366a9ff4cc9c334fb39a-q04', 'reading-rap-5817366a9ff4cc9c334fb39a', '[{"paragraphId":"reading-rap-5817366a9ff4cc9c334fb39a-passage-01-p02","startOffset":860,"endOffset":867}]'::jsonb, '["nuanced"]'::jsonb),
  ('reading-rap-5a2d23cea681010acb956443-q04', 'reading-rap-5a2d23cea681010acb956443', '[{"paragraphId":"reading-rap-5a2d23cea681010acb956443-passage-01-p03","startOffset":81,"endOffset":87}]'::jsonb, '["tailor"]'::jsonb),
  ('reading-rap-5a5d313c494dc11f7d69121b-q01', 'reading-rap-5a5d313c494dc11f7d69121b', '[{"paragraphId":"reading-rap-5a5d313c494dc11f7d69121b-passage-01-p01","startOffset":26,"endOffset":36}]'::jsonb, '["integrates"]'::jsonb),
  ('reading-rap-5a5d313c494dc11f7d69121b-q02', 'reading-rap-5a5d313c494dc11f7d69121b', '[{"paragraphId":"reading-rap-5a5d313c494dc11f7d69121b-passage-01-p02","startOffset":5,"endOffset":15}]'::jsonb, '["efficiency"]'::jsonb),
  ('reading-rap-5a5d313c494dc11f7d69121b-q05', 'reading-rap-5a5d313c494dc11f7d69121b', '[{"paragraphId":"reading-rap-5a5d313c494dc11f7d69121b-passage-01-p03","startOffset":120,"endOffset":146}]'::jsonb, '["fits neatly into templates"]'::jsonb),
  ('reading-rap-5a8c27c074aa0513d04f572b-q03', 'reading-rap-5a8c27c074aa0513d04f572b', '[{"paragraphId":"reading-rap-5a8c27c074aa0513d04f572b-passage-01-p03","startOffset":259,"endOffset":272}]'::jsonb, '["fundamentally"]'::jsonb),
  ('reading-rap-5bf7db5133284be39a3b362d-q03', 'reading-rap-5bf7db5133284be39a3b362d', '[{"paragraphId":"reading-rap-5bf7db5133284be39a3b362d-passage-01-p02","startOffset":297,"endOffset":312}]'::jsonb, '["straightforward"]'::jsonb),
  ('reading-rap-5e0859fbc2e185e743d11c4b-q02', 'reading-rap-5e0859fbc2e185e743d11c4b', '[{"paragraphId":"reading-rap-5e0859fbc2e185e743d11c4b-passage-01-p01","startOffset":278,"endOffset":292}]'::jsonb, '["transformative"]'::jsonb),
  ('reading-rap-5e0859fbc2e185e743d11c4b-q04', 'reading-rap-5e0859fbc2e185e743d11c4b', '[{"paragraphId":"reading-rap-5e0859fbc2e185e743d11c4b-passage-01-p03","startOffset":448,"endOffset":488}]'::jsonb, '["the global spread of wireless technology"]'::jsonb),
  ('reading-rap-634cdcba16cac603d9436627-q02', 'reading-rap-634cdcba16cac603d9436627', '[{"paragraphId":"reading-rap-634cdcba16cac603d9436627-passage-01-p01","startOffset":507,"endOffset":514}]'::jsonb, '["a prism"]'::jsonb),
  ('reading-rap-634cdcba16cac603d9436627-q05', 'reading-rap-634cdcba16cac603d9436627', '[{"paragraphId":"reading-rap-634cdcba16cac603d9436627-passage-01-p03","startOffset":178,"endOffset":186}]'::jsonb, '["prophecy"]'::jsonb),
  ('reading-rap-6522c75a66bfa0f293e67432-q01', 'reading-rap-6522c75a66bfa0f293e67432', '[{"paragraphId":"reading-rap-6522c75a66bfa0f293e67432-passage-01-p01","startOffset":322,"endOffset":331}]'::jsonb, '["interplay"]'::jsonb),
  ('reading-rap-6522c75a66bfa0f293e67432-q04', 'reading-rap-6522c75a66bfa0f293e67432', '[{"paragraphId":"reading-rap-6522c75a66bfa0f293e67432-passage-01-p02","startOffset":495,"endOffset":518}]'::jsonb, '["patients before surgery"]'::jsonb),
  ('reading-rap-65673b292aab5d2297ddb13f-q01', 'reading-rap-65673b292aab5d2297ddb13f', '[{"paragraphId":"reading-rap-65673b292aab5d2297ddb13f-passage-01-p01","startOffset":290,"endOffset":299}]'::jsonb, '["anomalies"]'::jsonb),
  ('reading-rap-668702bfa1634d0e0a73a4d1-q03', 'reading-rap-668702bfa1634d0e0a73a4d1', '[{"paragraphId":"reading-rap-668702bfa1634d0e0a73a4d1-passage-01-p03","startOffset":36,"endOffset":46}]'::jsonb, '["incredibly"]'::jsonb),
  ('reading-rap-6832cb7ccf74f003a2ef7628-q01', 'reading-rap-6832cb7ccf74f003a2ef7628', '[{"paragraphId":"reading-rap-6832cb7ccf74f003a2ef7628-passage-01-p01","startOffset":5,"endOffset":11}]'::jsonb, '["static"]'::jsonb),
  ('reading-rap-6832cb7ccf74f003a2ef7628-q04', 'reading-rap-6832cb7ccf74f003a2ef7628', '[{"paragraphId":"reading-rap-6832cb7ccf74f003a2ef7628-passage-01-p03","startOffset":484,"endOffset":493},{"paragraphId":"reading-rap-6832cb7ccf74f003a2ef7628-passage-01-p03","startOffset":568,"endOffset":581}]'::jsonb, '["hospitals","office spaces"]'::jsonb),
  ('reading-rap-69611be5fee90ca9b207c69e-q03', 'reading-rap-69611be5fee90ca9b207c69e', '[{"paragraphId":"reading-rap-69611be5fee90ca9b207c69e-passage-01-p02","startOffset":353,"endOffset":365}]'::jsonb, '["Collectively"]'::jsonb),
  ('reading-rap-6c60773bbb66e0a8dc6adcc0-q05', 'reading-rap-6c60773bbb66e0a8dc6adcc0', '[{"paragraphId":"reading-rap-6c60773bbb66e0a8dc6adcc0-passage-01-p03","startOffset":260,"endOffset":268}]'::jsonb, '["holistic"]'::jsonb),
  ('reading-rap-7066f8dd9b44a5d1e065719d-q02', 'reading-rap-7066f8dd9b44a5d1e065719d', '[{"paragraphId":"reading-rap-7066f8dd9b44a5d1e065719d-passage-01-p02","startOffset":206,"endOffset":237}]'::jsonb, '["This consequentialist framework"]'::jsonb),
  ('reading-rap-7066f8dd9b44a5d1e065719d-q03', 'reading-rap-7066f8dd9b44a5d1e065719d', '[{"paragraphId":"reading-rap-7066f8dd9b44a5d1e065719d-passage-01-p02","startOffset":482,"endOffset":492}]'::jsonb, '["allocating"]'::jsonb),
  ('reading-rap-7447d5926c9979015af28e99-q03', 'reading-rap-7447d5926c9979015af28e99', '[{"paragraphId":"reading-rap-7447d5926c9979015af28e99-passage-01-p03","startOffset":36,"endOffset":46}]'::jsonb, '["incredibly"]'::jsonb),
  ('reading-rap-7945215d82567f1f6f2af63a-q01', 'reading-rap-7945215d82567f1f6f2af63a', '[{"paragraphId":"reading-rap-7945215d82567f1f6f2af63a-passage-01-p01","startOffset":33,"endOffset":42}]'::jsonb, '["grappling"]'::jsonb),
  ('reading-rap-7d5d0462cf877efd8ae523af-q01', 'reading-rap-7d5d0462cf877efd8ae523af', '[{"paragraphId":"reading-rap-7d5d0462cf877efd8ae523af-passage-01-p01","startOffset":68,"endOffset":78}]'::jsonb, '["consistent"]'::jsonb),
  ('reading-rap-80e0d016a21881694ab06335-q02', 'reading-rap-80e0d016a21881694ab06335', '[{"paragraphId":"reading-rap-80e0d016a21881694ab06335-passage-01-p02","startOffset":206,"endOffset":237}]'::jsonb, '["This consequentialist framework"]'::jsonb),
  ('reading-rap-80e0d016a21881694ab06335-q03', 'reading-rap-80e0d016a21881694ab06335', '[{"paragraphId":"reading-rap-80e0d016a21881694ab06335-passage-01-p02","startOffset":482,"endOffset":492}]'::jsonb, '["allocating"]'::jsonb),
  ('reading-rap-8371c3948e75cac783023b5c-q01', 'reading-rap-8371c3948e75cac783023b5c', '[{"paragraphId":"reading-rap-8371c3948e75cac783023b5c-passage-01-p01","startOffset":292,"endOffset":430}]'::jsonb, '["If someone regularly chats with a group of friends who share strong opinions about climate change, they may gradually adopt similar views."]'::jsonb),
  ('reading-rap-8371c3948e75cac783023b5c-q03', 'reading-rap-8371c3948e75cac783023b5c', '[{"paragraphId":"reading-rap-8371c3948e75cac783023b5c-passage-01-p03","startOffset":36,"endOffset":46}]'::jsonb, '["incredibly"]'::jsonb),
  ('reading-rap-872c6a298ccb4eea664f4812-q04', 'reading-rap-872c6a298ccb4eea664f4812', '[{"paragraphId":"reading-rap-872c6a298ccb4eea664f4812-passage-01-p02","startOffset":632,"endOffset":639}]'::jsonb, '["unravel"]'::jsonb),
  ('reading-rap-88bc32dacb3916e75ed13c09-q02', 'reading-rap-88bc32dacb3916e75ed13c09', '[{"paragraphId":"reading-rap-88bc32dacb3916e75ed13c09-passage-01-p01","startOffset":467,"endOffset":477}]'::jsonb, '["escalating"]'::jsonb),
  ('reading-rap-88bc32dacb3916e75ed13c09-q04', 'reading-rap-88bc32dacb3916e75ed13c09', '[{"paragraphId":"reading-rap-88bc32dacb3916e75ed13c09-passage-01-p02","startOffset":198,"endOffset":208}]'::jsonb, '["tree rings"]'::jsonb),
  ('reading-rap-8ef2e4aefe74c7b7cdc2b9e1-q03', 'reading-rap-8ef2e4aefe74c7b7cdc2b9e1', '[{"paragraphId":"reading-rap-8ef2e4aefe74c7b7cdc2b9e1-passage-01-p03","startOffset":36,"endOffset":46}]'::jsonb, '["incredibly"]'::jsonb),
  ('reading-rap-94b83368bbbce780f1162836-q03', 'reading-rap-94b83368bbbce780f1162836', '[{"paragraphId":"reading-rap-94b83368bbbce780f1162836-passage-01-p02","startOffset":283,"endOffset":294}]'::jsonb, '["tethered to"]'::jsonb),
  ('reading-rap-94b83368bbbce780f1162836-q04', 'reading-rap-94b83368bbbce780f1162836', '[{"paragraphId":"reading-rap-94b83368bbbce780f1162836-passage-01-p03","startOffset":275,"endOffset":327}]'::jsonb, '["all primates, including humans, are social creatures"]'::jsonb),
  ('reading-rap-9597f97b9636121c0ef7ec58-q03', 'reading-rap-9597f97b9636121c0ef7ec58', '[{"paragraphId":"reading-rap-9597f97b9636121c0ef7ec58-passage-01-p02","startOffset":338,"endOffset":345}]'::jsonb, '["context"]'::jsonb),
  ('reading-rap-9597f97b9636121c0ef7ec58-q04', 'reading-rap-9597f97b9636121c0ef7ec58', '[{"paragraphId":"reading-rap-9597f97b9636121c0ef7ec58-passage-01-p03","startOffset":27,"endOffset":40}]'::jsonb, '["legal experts"]'::jsonb),
  ('reading-rap-9597f97b9636121c0ef7ec58-q05', 'reading-rap-9597f97b9636121c0ef7ec58', '[{"paragraphId":"reading-rap-9597f97b9636121c0ef7ec58-passage-01-p03","startOffset":492,"endOffset":502}]'::jsonb, '["cautiously"]'::jsonb),
  ('reading-rap-964b2c0d86db237d8e65b24e-q01', 'reading-rap-964b2c0d86db237d8e65b24e', '[{"paragraphId":"reading-rap-964b2c0d86db237d8e65b24e-passage-01-p01","startOffset":147,"endOffset":155}]'::jsonb, '["profound"]'::jsonb),
  ('reading-rap-96e6fb86c216f62eead5bb01-q01', 'reading-rap-96e6fb86c216f62eead5bb01', '[{"paragraphId":"reading-rap-96e6fb86c216f62eead5bb01-passage-01-p01","startOffset":234,"endOffset":244}]'::jsonb, '["invaluable"]'::jsonb),
  ('reading-rap-98e3b20d6b6e1d9ce46eac7c-q02', 'reading-rap-98e3b20d6b6e1d9ce46eac7c', '[{"paragraphId":"reading-rap-98e3b20d6b6e1d9ce46eac7c-passage-01-p02","startOffset":0,"endOffset":182}]'::jsonb, '["Bacteria develop resistance through a multitude of mechanisms, including genetic mutations and the sharing of genes, which allow them to survive antibiotic treatment and proliferate."]'::jsonb),
  ('reading-rap-98e3b20d6b6e1d9ce46eac7c-q04', 'reading-rap-98e3b20d6b6e1d9ce46eac7c', '[{"paragraphId":"reading-rap-98e3b20d6b6e1d9ce46eac7c-passage-01-p03","startOffset":26,"endOffset":39}]'::jsonb, '["comprehensive"]'::jsonb),
  ('reading-rap-9e68f83255448c35a0994ea1-q02', 'reading-rap-9e68f83255448c35a0994ea1', '[{"paragraphId":"reading-rap-9e68f83255448c35a0994ea1-passage-01-p01","startOffset":559,"endOffset":580}]'::jsonb, '["gravitational lensing"]'::jsonb),
  ('reading-rap-9e68f83255448c35a0994ea1-q03', 'reading-rap-9e68f83255448c35a0994ea1', '[{"paragraphId":"reading-rap-9e68f83255448c35a0994ea1-passage-01-p02","startOffset":392,"endOffset":401}]'::jsonb, '["minimized"]'::jsonb),
  ('reading-rap-a079611e1a822b5658af4b64-q03', 'reading-rap-a079611e1a822b5658af4b64', '[{"paragraphId":"reading-rap-a079611e1a822b5658af4b64-passage-01-p02","startOffset":230,"endOffset":241}]'::jsonb, '["aspirations"]'::jsonb),
  ('reading-rap-a5a1662900f8b43ba35add0e-q03', 'reading-rap-a5a1662900f8b43ba35add0e', '[{"paragraphId":"reading-rap-a5a1662900f8b43ba35add0e-passage-01-p02","startOffset":598,"endOffset":609}]'::jsonb, '["impediments"]'::jsonb),
  ('reading-rap-a67642faa0d4a3f2aca802b5-q01', 'reading-rap-a67642faa0d4a3f2aca802b5', '[{"paragraphId":"reading-rap-a67642faa0d4a3f2aca802b5-passage-01-p01","startOffset":243,"endOffset":253}]'::jsonb, '["seamlessly"]'::jsonb),
  ('reading-rap-a6a1d2431d2335daacfac1f5-q02', 'reading-rap-a6a1d2431d2335daacfac1f5', '[{"paragraphId":"reading-rap-a6a1d2431d2335daacfac1f5-passage-01-p02","startOffset":236,"endOffset":249}]'::jsonb, '["advocated for"]'::jsonb),
  ('reading-rap-a6a1d2431d2335daacfac1f5-q03', 'reading-rap-a6a1d2431d2335daacfac1f5', '[{"paragraphId":"reading-rap-a6a1d2431d2335daacfac1f5-passage-01-p02","startOffset":284,"endOffset":303}]'::jsonb, '["grid-based approach"]'::jsonb),
  ('reading-rap-a892b1f2362ab7405dd93573-q01', 'reading-rap-a892b1f2362ab7405dd93573', '[{"paragraphId":"reading-rap-a892b1f2362ab7405dd93573-passage-01-p01","startOffset":114,"endOffset":124}]'::jsonb, '["prevailing"]'::jsonb),
  ('reading-rap-a892b1f2362ab7405dd93573-q03', 'reading-rap-a892b1f2362ab7405dd93573', '[{"paragraphId":"reading-rap-a892b1f2362ab7405dd93573-passage-01-p02","startOffset":178,"endOffset":219}]'::jsonb, '["paraphrasing, summarizing, and clarifying"]'::jsonb),
  ('reading-rap-abf7cca7bbd44e6e78417d21-q01', 'reading-rap-abf7cca7bbd44e6e78417d21', '[{"paragraphId":"reading-rap-abf7cca7bbd44e6e78417d21-passage-01-p01","startOffset":399,"endOffset":408}]'::jsonb, '["anomalies"]'::jsonb),
  ('reading-rap-ac764d47560f731d32d42a93-q01', 'reading-rap-ac764d47560f731d32d42a93', '[{"paragraphId":"reading-rap-ac764d47560f731d32d42a93-passage-01-p01","startOffset":77,"endOffset":83}]'::jsonb, '["subtle"]'::jsonb),
  ('reading-rap-ac764d47560f731d32d42a93-q03', 'reading-rap-ac764d47560f731d32d42a93', '[{"paragraphId":"reading-rap-ac764d47560f731d32d42a93-passage-01-p02","startOffset":238,"endOffset":304}]'::jsonb, '["variations in rock density and the presence of faults or fractures"]'::jsonb),
  ('reading-rap-ac764d47560f731d32d42a93-q05', 'reading-rap-ac764d47560f731d32d42a93', '[{"paragraphId":"reading-rap-ac764d47560f731d32d42a93-passage-01-p03","startOffset":242,"endOffset":313}]'::jsonb, '["filtering methods and cross-referencing data from multiple seismometers"]'::jsonb),
  ('reading-rap-af29507332d217f7c7b827a7-q02', 'reading-rap-af29507332d217f7c7b827a7', '[{"paragraphId":"reading-rap-af29507332d217f7c7b827a7-passage-01-p02","startOffset":236,"endOffset":244}]'::jsonb, '["vigilant"]'::jsonb),
  ('reading-rap-af2f63bf59d1743d597f47f4-q02', 'reading-rap-af2f63bf59d1743d597f47f4', '[{"paragraphId":"reading-rap-af2f63bf59d1743d597f47f4-passage-01-p02","startOffset":206,"endOffset":237}]'::jsonb, '["This consequentialist framework"]'::jsonb),
  ('reading-rap-af2f63bf59d1743d597f47f4-q03', 'reading-rap-af2f63bf59d1743d597f47f4', '[{"paragraphId":"reading-rap-af2f63bf59d1743d597f47f4-passage-01-p02","startOffset":482,"endOffset":492}]'::jsonb, '["allocating"]'::jsonb),
  ('reading-rap-b5efb7a2f7351888b25fd0ae-q01', 'reading-rap-b5efb7a2f7351888b25fd0ae', '[{"paragraphId":"reading-rap-b5efb7a2f7351888b25fd0ae-passage-01-p01","startOffset":36,"endOffset":46}]'::jsonb, '["remarkable"]'::jsonb),
  ('reading-rap-bad55ea4a5cad4980668095d-q01', 'reading-rap-bad55ea4a5cad4980668095d', '[{"paragraphId":"reading-rap-bad55ea4a5cad4980668095d-passage-01-p01","startOffset":30,"endOffset":43}]'::jsonb, '["revolutionize"]'::jsonb),
  ('reading-rap-bad55ea4a5cad4980668095d-q04', 'reading-rap-bad55ea4a5cad4980668095d', '[{"paragraphId":"reading-rap-bad55ea4a5cad4980668095d-passage-01-p03","startOffset":90,"endOffset":111}]'::jsonb, '["external disturbances"]'::jsonb),
  ('reading-rap-bbe98bba9b4c8463d35912f4-q03', 'reading-rap-bbe98bba9b4c8463d35912f4', '[{"paragraphId":"reading-rap-bbe98bba9b4c8463d35912f4-passage-01-p01","startOffset":624,"endOffset":631}]'::jsonb, '["milieus"]'::jsonb),
  ('reading-rap-bbe98bba9b4c8463d35912f4-q04', 'reading-rap-bbe98bba9b4c8463d35912f4', '[{"paragraphId":"reading-rap-bbe98bba9b4c8463d35912f4-passage-01-p02","startOffset":0,"endOffset":194}]'::jsonb, '["Some insist that despite linguistic and cultural variation, certain philosophical concerns—like suffering, justice, or mortality—are shared across societies, suggesting a basis for universality."]'::jsonb),
  ('reading-rap-bd88c39e1718f0046a3df188-q02', 'reading-rap-bd88c39e1718f0046a3df188', '[{"paragraphId":"reading-rap-bd88c39e1718f0046a3df188-passage-01-p02","startOffset":235,"endOffset":242}]'::jsonb, '["fosters"]'::jsonb),
  ('reading-rap-c0a09dd368b968fd01c859ed-q01', 'reading-rap-c0a09dd368b968fd01c859ed', '[{"paragraphId":"reading-rap-c0a09dd368b968fd01c859ed-passage-01-p01","startOffset":290,"endOffset":299}]'::jsonb, '["anomalies"]'::jsonb),
  ('reading-rap-c0a09dd368b968fd01c859ed-q03', 'reading-rap-c0a09dd368b968fd01c859ed', '[{"paragraphId":"reading-rap-c0a09dd368b968fd01c859ed-passage-01-p02","startOffset":338,"endOffset":480}]'::jsonb, '["However, the effectiveness of these dashboards often hinges on the user''s ability to interpret complex visual cues, which can be overwhelming."]'::jsonb),
  ('reading-rap-c2f68bcc6afcbbe710f5c87d-q02', 'reading-rap-c2f68bcc6afcbbe710f5c87d', '[{"paragraphId":"reading-rap-c2f68bcc6afcbbe710f5c87d-passage-01-p02","startOffset":147,"endOffset":173}]'::jsonb, '["fitting oranges into boxes"]'::jsonb),
  ('reading-rap-c2f68bcc6afcbbe710f5c87d-q04', 'reading-rap-c2f68bcc6afcbbe710f5c87d', '[{"paragraphId":"reading-rap-c2f68bcc6afcbbe710f5c87d-passage-01-p04","startOffset":73,"endOffset":78}]'::jsonb, '["belie"]'::jsonb),
  ('reading-rap-c3233ad427c0e207ebb6a110-q05', 'reading-rap-c3233ad427c0e207ebb6a110', '[{"paragraphId":"reading-rap-c3233ad427c0e207ebb6a110-passage-01-p03","startOffset":413,"endOffset":427}]'::jsonb, '["culminating in"]'::jsonb),
  ('reading-rap-c60864a200a09f24ffb1835d-q02', 'reading-rap-c60864a200a09f24ffb1835d', '[{"paragraphId":"reading-rap-c60864a200a09f24ffb1835d-passage-01-p02","startOffset":309,"endOffset":318}]'::jsonb, '["premature"]'::jsonb),
  ('reading-rap-c63fb3651607230289cc9a21-q01', 'reading-rap-c63fb3651607230289cc9a21', '[{"paragraphId":"reading-rap-c63fb3651607230289cc9a21-passage-01-p01","startOffset":466,"endOffset":475},{"paragraphId":"reading-rap-c63fb3651607230289cc9a21-passage-01-p03","startOffset":68,"endOffset":77}]'::jsonb, '["retention","retention"]'::jsonb),
  ('reading-rap-c63fb3651607230289cc9a21-q04', 'reading-rap-c63fb3651607230289cc9a21', '[{"paragraphId":"reading-rap-c63fb3651607230289cc9a21-passage-01-p03","startOffset":0,"endOffset":16}]'::jsonb, '["Not surprisingly"]'::jsonb),
  ('reading-rap-cb3cd375aebae1a5539edb81-q03', 'reading-rap-cb3cd375aebae1a5539edb81', '[{"paragraphId":"reading-rap-cb3cd375aebae1a5539edb81-passage-01-p03","startOffset":267,"endOffset":278}]'::jsonb, '["impediments"]'::jsonb),
  ('reading-rap-cb5360908903e7adcdf0760d-q01', 'reading-rap-cb5360908903e7adcdf0760d', '[{"paragraphId":"reading-rap-cb5360908903e7adcdf0760d-passage-01-p01","startOffset":199,"endOffset":209}]'::jsonb, '["exacerbate"]'::jsonb),
  ('reading-rap-cb5360908903e7adcdf0760d-q03', 'reading-rap-cb5360908903e7adcdf0760d', '[{"paragraphId":"reading-rap-cb5360908903e7adcdf0760d-passage-01-p02","startOffset":34,"endOffset":51}]'::jsonb, '["beach nourishment"]'::jsonb),
  ('reading-rap-cb5360908903e7adcdf0760d-q04', 'reading-rap-cb5360908903e7adcdf0760d', '[{"paragraphId":"reading-rap-cb5360908903e7adcdf0760d-passage-01-p03","startOffset":33,"endOffset":51}]'::jsonb, '["natural approaches"]'::jsonb),
  ('reading-rap-cc8108658460dd4758f81cea-q03', 'reading-rap-cc8108658460dd4758f81cea', '[{"paragraphId":"reading-rap-cc8108658460dd4758f81cea-passage-01-p02","startOffset":128,"endOffset":134}]'::jsonb, '["lavish"]'::jsonb),
  ('reading-rap-cc8108658460dd4758f81cea-q04', 'reading-rap-cc8108658460dd4758f81cea', '[{"paragraphId":"reading-rap-cc8108658460dd4758f81cea-passage-01-p02","startOffset":160,"endOffset":176}]'::jsonb, '["heraldic emblems"]'::jsonb),
  ('reading-rap-ce5209524d2340201b2e81d2-q01', 'reading-rap-ce5209524d2340201b2e81d2', '[{"paragraphId":"reading-rap-ce5209524d2340201b2e81d2-passage-01-p02","startOffset":66,"endOffset":75}]'::jsonb, '["amplifies"]'::jsonb),
  ('reading-rap-d27de865cadb77d675378075-q02', 'reading-rap-d27de865cadb77d675378075', '[{"paragraphId":"reading-rap-d27de865cadb77d675378075-passage-01-p02","startOffset":236,"endOffset":249}]'::jsonb, '["advocated for"]'::jsonb),
  ('reading-rap-d27de865cadb77d675378075-q03', 'reading-rap-d27de865cadb77d675378075', '[{"paragraphId":"reading-rap-d27de865cadb77d675378075-passage-01-p02","startOffset":284,"endOffset":303}]'::jsonb, '["grid-based approach"]'::jsonb),
  ('reading-rap-dbb5edec85e50734f930693e-q01', 'reading-rap-dbb5edec85e50734f930693e', '[{"paragraphId":"reading-rap-dbb5edec85e50734f930693e-passage-01-p01","startOffset":30,"endOffset":43}]'::jsonb, '["revolutionize"]'::jsonb),
  ('reading-rap-e01f83375de9f2c96a209bc6-q04', 'reading-rap-e01f83375de9f2c96a209bc6', '[{"paragraphId":"reading-rap-e01f83375de9f2c96a209bc6-passage-01-p03","startOffset":42,"endOffset":51}]'::jsonb, '["pressures"]'::jsonb),
  ('reading-rap-e7ce2874e8c366c253f0bed0-q02', 'reading-rap-e7ce2874e8c366c253f0bed0', '[{"paragraphId":"reading-rap-e7ce2874e8c366c253f0bed0-passage-01-p02","startOffset":235,"endOffset":242}]'::jsonb, '["fosters"]'::jsonb),
  ('reading-rap-e87bf5f62e80a618270d51db-q03', 'reading-rap-e87bf5f62e80a618270d51db', '[{"paragraphId":"reading-rap-e87bf5f62e80a618270d51db-passage-01-p03","startOffset":49,"endOffset":58}]'::jsonb, '["evocative"]'::jsonb),
  ('reading-rap-e9f22c72c388b25c9ccc03d8-q01', 'reading-rap-e9f22c72c388b25c9ccc03d8', '[{"paragraphId":"reading-rap-e9f22c72c388b25c9ccc03d8-passage-01-p01","startOffset":322,"endOffset":331}]'::jsonb, '["interplay"]'::jsonb),
  ('reading-rap-ed56100135e379e25de1a6d4-q05', 'reading-rap-ed56100135e379e25de1a6d4', '[{"paragraphId":"reading-rap-ed56100135e379e25de1a6d4-passage-01-p04","startOffset":63,"endOffset":83}]'::jsonb, '["still in its infancy"]'::jsonb),
  ('reading-rap-f04bee90f6b464220dc4d249-q01', 'reading-rap-f04bee90f6b464220dc4d249', '[{"paragraphId":"reading-rap-f04bee90f6b464220dc4d249-passage-01-p01","startOffset":447,"endOffset":455}]'::jsonb, '["fostered"]'::jsonb),
  ('reading-rap-f1ccfc79e358e55f2ee63181-q02', 'reading-rap-f1ccfc79e358e55f2ee63181', '[{"paragraphId":"reading-rap-f1ccfc79e358e55f2ee63181-passage-01-p01","startOffset":278,"endOffset":292}]'::jsonb, '["transformative"]'::jsonb),
  ('reading-rap-f1ccfc79e358e55f2ee63181-q04', 'reading-rap-f1ccfc79e358e55f2ee63181', '[{"paragraphId":"reading-rap-f1ccfc79e358e55f2ee63181-passage-01-p03","startOffset":448,"endOffset":488}]'::jsonb, '["the global spread of wireless technology"]'::jsonb),
  ('reading-rap-f3d29f9504924cfb48ba1434-q05', 'reading-rap-f3d29f9504924cfb48ba1434', '[{"paragraphId":"reading-rap-f3d29f9504924cfb48ba1434-passage-01-p02","startOffset":700,"endOffset":712}]'::jsonb, '["precipitated"]'::jsonb),
  ('reading-rap-f50dd6e4cd831e6155bb31ac-q01', 'reading-rap-f50dd6e4cd831e6155bb31ac', '[{"paragraphId":"reading-rap-f50dd6e4cd831e6155bb31ac-passage-01-p01","startOffset":129,"endOffset":349}]'::jsonb, '["Unlike continuous geometry—which deals with shapes and structures that are smooth and unbroken, like curves and surfaces—discrete geometry focuses on objects that are finite or countable like points, lines, and polygons."]'::jsonb),
  ('reading-rap-f50dd6e4cd831e6155bb31ac-q04', 'reading-rap-f50dd6e4cd831e6155bb31ac', '[{"paragraphId":"reading-rap-f50dd6e4cd831e6155bb31ac-passage-01-p04","startOffset":73,"endOffset":78}]'::jsonb, '["belie"]'::jsonb),
  ('reading-rap-f9e62e69f26b24ec00d4aa76-q03', 'reading-rap-f9e62e69f26b24ec00d4aa76', '[{"paragraphId":"reading-rap-f9e62e69f26b24ec00d4aa76-passage-01-p02","startOffset":233,"endOffset":241}]'::jsonb, '["involved"]'::jsonb),
  ('reading-rap-f9e62e69f26b24ec00d4aa76-q04', 'reading-rap-f9e62e69f26b24ec00d4aa76', '[{"paragraphId":"reading-rap-f9e62e69f26b24ec00d4aa76-passage-01-p02","startOffset":288,"endOffset":313}]'::jsonb, '["a vegan cheese substitute"]'::jsonb),
  ('reading-rap-fcb877e86ce9cff28b0635f8-q05', 'reading-rap-fcb877e86ce9cff28b0635f8', '[{"paragraphId":"reading-rap-fcb877e86ce9cff28b0635f8-passage-01-p03","startOffset":413,"endOffset":427}]'::jsonb, '["culminating in"]'::jsonb),
  ('reading-rap-fdeb6000ce9ff3558cc559b5-q02', 'reading-rap-fdeb6000ce9ff3558cc559b5', '[{"paragraphId":"reading-rap-fdeb6000ce9ff3558cc559b5-passage-01-p01","startOffset":399,"endOffset":419}]'::jsonb, '["our sense of control"]'::jsonb),
  ('reading-rap-fdeb6000ce9ff3558cc559b5-q04', 'reading-rap-fdeb6000ce9ff3558cc559b5', '[{"paragraphId":"reading-rap-fdeb6000ce9ff3558cc559b5-passage-01-p02","startOffset":632,"endOffset":639}]'::jsonb, '["unravel"]'::jsonb),
  ('reading-rap-fe8411639546b0b11ec79d0b-q01', 'reading-rap-fe8411639546b0b11ec79d0b', '[{"paragraphId":"reading-rap-fe8411639546b0b11ec79d0b-passage-01-p02","startOffset":93,"endOffset":102}]'::jsonb, '["persevere"]'::jsonb),
  ('reading-rap-fe9caa2af2e2e6e581d4400b-q02', 'reading-rap-fe9caa2af2e2e6e581d4400b', '[{"paragraphId":"reading-rap-fe9caa2af2e2e6e581d4400b-passage-01-p01","startOffset":162,"endOffset":172}]'::jsonb, '["persistent"]'::jsonb),
  ('reading-rap-fe9caa2af2e2e6e581d4400b-q04', 'reading-rap-fe9caa2af2e2e6e581d4400b', '[{"paragraphId":"reading-rap-fe9caa2af2e2e6e581d4400b-passage-01-p03","startOffset":377,"endOffset":394}]'::jsonb, '["Patented GM seeds"]'::jsonb),
  ('reading-rap-fe9caa2af2e2e6e581d4400b-q05', 'reading-rap-fe9caa2af2e2e6e581d4400b', '[{"paragraphId":"reading-rap-fe9caa2af2e2e6e581d4400b-passage-01-p03","startOffset":594,"endOffset":632}]'::jsonb, '["the rapid pace of technological change"]'::jsonb);

do $$
declare
  v_question_count integer;
  v_range_count integer;
  v_item_count integer;
  v_invalid_count integer;
begin
  select count(*), coalesce(sum(jsonb_array_length(ranges)), 0), count(distinct logical_item_id)
  into v_question_count, v_range_count, v_item_count
  from rap_highlight_backfill_targets;

  if v_question_count <> 152
    or v_range_count <> 156
    or v_item_count <> 96 then
    raise exception 'Unexpected RAP highlight target totals: questions=%, ranges=%, items=%',
      v_question_count, v_range_count, v_item_count;
  end if;

  if exists (
    select 1
    from rap_highlight_backfill_targets target
    left join public.reading_questions question
      on question.question_id = target.question_id
      and question.logical_item_id = target.logical_item_id
    where question.question_id is null
      or question.question_type not in (
        'rap_multiple_choice',
        'rap_sentence_insertion',
        'rap_sentence_selection'
      )
      or question.module <> 'rap'
  ) then
    raise exception 'RAP highlight backfill target identity/type validation failed';
  end if;

  if exists (
    select 1
    from rap_highlight_backfill_targets target
    join public.reading_questions question
      on question.question_id = target.question_id
      and question.logical_item_id = target.logical_item_id
    where question.passage_highlight_ranges <> '[]'::jsonb
      and question.passage_highlight_ranges is distinct from target.ranges
  ) then
    raise exception 'RAP highlight backfill would overwrite a conflicting non-empty payload';
  end if;

  with expanded as (
    select
      target.question_id,
      target.logical_item_id,
      range_item.ordinality,
      range_item.value as range_value,
      expected_item.value #>> '{}' as highlighted_text
    from rap_highlight_backfill_targets target
    cross join lateral jsonb_array_elements(target.ranges) with ordinality as range_item(value, ordinality)
    join lateral jsonb_array_elements(target.expected_texts) with ordinality as expected_item(value, ordinality)
      on expected_item.ordinality = range_item.ordinality
  ), checked as (
    select
      expanded.*,
      question.question_type,
      paragraph.paragraph_text,
      (range_value->>'startOffset')::integer as start_offset,
      (range_value->>'endOffset')::integer as end_offset
    from expanded
    join public.reading_questions question
      on question.question_id = expanded.question_id
      and question.logical_item_id = expanded.logical_item_id
    left join public.reading_passage_paragraphs paragraph
      on paragraph.passage_id = question.passage_id
      and paragraph.paragraph_id = range_value->>'paragraphId'
  )
  select count(*) into v_invalid_count
  from checked
  where jsonb_typeof(range_value->'paragraphId') <> 'string'
    or jsonb_typeof(range_value->'startOffset') <> 'number'
    or jsonb_typeof(range_value->'endOffset') <> 'number'
    or paragraph_text is null
    or start_offset < 0
    or end_offset <= start_offset
    or end_offset > char_length(paragraph_text)
    or substring(paragraph_text from start_offset + 1 for end_offset - start_offset) <> highlighted_text;

  if v_invalid_count <> 0 then
    raise exception 'RAP highlight backfill has % invalid paragraph/range/text mappings', v_invalid_count;
  end if;
end;
$$;

update public.reading_questions question
set passage_highlight_ranges = target.ranges
from rap_highlight_backfill_targets target
where question.question_id = target.question_id
  and question.logical_item_id = target.logical_item_id
  and question.module = 'rap'
  and question.question_type in (
    'rap_multiple_choice',
    'rap_sentence_insertion',
    'rap_sentence_selection'
  )
  and question.passage_highlight_ranges is distinct from target.ranges;

do $$
begin
  if exists (
    select 1
    from rap_highlight_backfill_targets target
    join public.reading_questions question
      on question.question_id = target.question_id
      and question.logical_item_id = target.logical_item_id
    where question.passage_highlight_ranges is distinct from target.ranges
  ) then
    raise exception 'RAP highlight backfill post-update payload verification failed';
  end if;
end;
$$;

commit;
