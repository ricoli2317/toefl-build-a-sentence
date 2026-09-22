/**
 * Minimal in-memory Supabase PostgREST-style builder used by permission tests.
 * Supports the query surface exercised by lib/accountAccess.ts:
 * select/eq/in/is/not/order/range/maybeSingle.
 *
 * Pass options.rpc to stub Supabase RPC calls:
 *   createMockSupabase(tables, { rpc: (fn, args, tables) => ({ data, error }) })
 */
export function createMockSupabase(tables, options = {}) {
  return {
    async rpc(fn, args) {
      if (typeof options.rpc !== "function") {
        return { data: null, error: { message: `rpc ${fn} is not stubbed` } };
      }
      return options.rpc(fn, args, tables);
    },
    from(tableName) {
      const plan = [];
      const builder = {
        select() {
          return builder;
        },
        eq(column, value) {
          plan.push((rows) => rows.filter((row) => row[column] === value));
          return builder;
        },
        in(column, values) {
          plan.push((rows) => rows.filter((row) => values.includes(row[column])));
          return builder;
        },
        is(column, value) {
          plan.push((rows) => rows.filter((row) => row[column] === value));
          return builder;
        },
        not(column, operation, value) {
          plan.push((rows) =>
            rows.filter((row) =>
              value === null ? row[column] !== null : row[column] !== value
            )
          );
          return builder;
        },
        order(column, { ascending = true, nullsFirst = false } = {}) {
          plan.push((rows) =>
            rows.slice().sort((left, right) => {
              const a = left[column];
              const b = right[column];
              if (a === null || a === undefined) {
                if (b === null || b === undefined) return 0;
                return nullsFirst ? -1 : 1;
              }
              if (b === null || b === undefined) {
                return nullsFirst ? 1 : -1;
              }
              const compared = a < b ? -1 : a > b ? 1 : 0;
              return ascending === false ? -compared : compared;
            })
          );
          return builder;
        },
        async maybeSingle() {
          const result = plan.reduce((rows, apply) => apply(rows), snapshot(tables[tableName]));
          return { data: result[0] ?? null, error: null };
        },
        async range(from, to) {
          const result = plan.reduce((rows, apply) => apply(rows), snapshot(tables[tableName]));
          return { data: result.slice(from, to + 1), error: null };
        }
      };
      return builder;
    }
  };
}

function snapshot(rows) {
  return (rows ?? []).map((row) => ({ ...row }));
}