"""Offline initial CEFR membership handoff. Never connects to a database.

Uses reviewed Phase 2 CEFR/content, existing Phase 1 topic provenance, and the
same functional-word/seeded topic balancing rule as the mixed-List generator.
Does not rerun that generator or change mixed Lists. Runtime consumes DB only.
"""
import argparse
import collections
import hashlib
import json
import math
from pathlib import Path
import random

ROOT = Path(__file__).resolve().parents[1]
GROUPS = ('A1', 'A2', 'B1', 'B2', 'C1-C2')
FUNCTION_POS = {'preposition', 'conjunction', 'determiner', 'pronoun', 'particle'}
AUXILIARY = {'be', 'have', 'do', 'can', 'may', 'might', 'will'}
COMMON_ADVERBS = {'also', 'ago', 'along', 'away', 'back', 'far', 'how', 'however', 'just', 'long', 'not', 'now', 'often', 'only', 'so', 'together', 'why'}


def build(rows, mapping):
    provenance = collections.defaultdict(list)
    for item in mapping:
        provenance[item['word'].lower()].append(item)
    assert len(rows) == 1032 and len({r['word'].lower() for r in rows}) == 1032
    assert all(r['word'].lower() in provenance for r in rows), 'Missing original theme provenance'
    assignments, summaries = [], []
    for group in GROUPS:
        entries = {r['word'].lower(): r for r in rows if ('C1-C2' if r['cefr'] in ('C1', 'C2') else r['cefr']) == group}
        words = sorted(entries)
        number = math.ceil(len(words) / 50)
        capacities = [50] * (number - 1) + [len(words) - 50 * (number - 1)]
        buckets = [[] for _ in capacities]
        topic_counts = [collections.Counter() for _ in capacities]
        fn_counts = [0] * number
        def functional(word):
            return any(s['pos'] in FUNCTION_POS for s in entries[word]['senses']) or word in AUXILIARY | COMMON_ADVERBS
        functions = [w for w in words if functional(w)]
        content = [w for w in words if not functional(w)]
        rng = random.Random(20261014)
        rng.shuffle(functions)
        for word in functions:
            eligible = [j for j in range(number) if len(buckets[j]) < capacities[j]]
            j = min(eligible, key=lambda j: (fn_counts[j], j))
            buckets[j].append(word)
            fn_counts[j] += 1
        rng.shuffle(content)
        for word in content:
            topics = collections.Counter(r['topic'] for r in provenance[word])
            topic = sorted(topics, key=lambda t: (-topics[t], t))[0]
            eligible = [j for j in range(number) if len(buckets[j]) < capacities[j]]
            j = min(eligible, key=lambda j: (topic_counts[j][topic], len(buckets[j]) / capacities[j], j))
            buckets[j].append(word)
            topic_counts[j][topic] += 1
        for j, bucket in enumerate(buckets):
            rng.shuffle(bucket)
            assert len(bucket) == capacities[j]
            for position, word in enumerate(bucket, 1):
                assignments.append(dict(word=word, cefr_group=group, list_number=j + 1, list_position=position))
            coverage = sorted({t for w in bucket for r in provenance[w] for t in r['all_topics'].split('、')})
            summaries.append(dict(group=group, list_number=j + 1, count=len(bucket), function_count=fn_counts[j],
                                  topic_coverage=coverage, primary_topic_counts=dict(topic_counts[j])))
    assert len(assignments) == 1032 and len(summaries) == 23
    assert len({a['word'] for a in assignments}) == 1032
    return assignments, summaries


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--reviewed', type=Path, default=ROOT / 'data/ctw-vocabulary/ctw-vocabulary-cefr-reviewed.json')
    parser.add_argument('--provenance', type=Path, default=ROOT / 'data/ctw-vocabulary/source-topics.json')
    parser.add_argument('--output', type=Path, default=ROOT / 'outputs/ctw-vocabulary-phase3')
    args = parser.parse_args()
    raw = args.reviewed.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == '09480ce1a52a79906082df9cd0503396c4b334850587f8c95e8629ce63eb38c6', 'Reviewed source SHA mismatch'
    assignments, summaries = build(json.loads(raw), json.loads(args.provenance.read_text()))
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = json.dumps(assignments, ensure_ascii=False, separators=(',', ':'))
    sql = (ROOT / 'supabase/ctw_vocabulary_phase3_lists.sql.template').read_text().replace('__CTW_CEFR_MAPPING__', manifest.replace("'", "''"))
    for name, text in [('cefr-membership.json', json.dumps(assignments, ensure_ascii=False, indent=2)),
                       ('cefr-balancing-audit.json', json.dumps(summaries, ensure_ascii=False, indent=2)),
                       ('ctw-vocabulary-phase3-install.sql', sql)]:
        target = args.output / name
        if target.exists() and target.read_text() != text:
            raise FileExistsError(f'Refusing to replace a changed handoff: {target}')
        target.write_text(text)
    for group in GROUPS:
        print(group, [(s['count'], s['function_count'], len(s['topic_coverage'])) for s in summaries if s['group'] == group])


if __name__ == '__main__':
    main()
