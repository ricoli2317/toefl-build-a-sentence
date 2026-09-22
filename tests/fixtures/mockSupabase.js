/**
 * Minimal in-memory Supabase PostgREST-style builder used by permission tests.
 *
 * Supported surface:
 * - select/eq/in/is/ilike/not/order/limit/range/maybeSingle/single
 * - insert/delete with the same filters and a thenable builder
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
      const filters = [];
      const transforms = [];
      let operation = { type: "select" };
      let selectRequested = false;

      function selectRows() {
        let rows = snapshot(tables[tableName]);
        for (const filter of filters) rows = rows.filter(filter);
        for (const transform of transforms) rows = transform(rows);
        return rows;
      }

      function run() {
        if (operation.type === "insert") {
          const table = tables[tableName] ?? (tables[tableName] = []);
          const inserted = operation.rows.map((row) => {
            const next = { ...row };
            if (tableName === "teacher_student_bindings") {
              next.binding_id = next.binding_id ?? `mock-binding-${table.length + 1}`;
              next.created_at = next.created_at ?? new Date().toISOString();
            }
            return next;
          });
          table.push(...inserted);
          return { data: selectRequested ? inserted : null, error: null };
        }
        if (operation.type === "delete") {
          const table = tables[tableName] ?? [];
          const matches = (row) => filters.every((filter) => filter(row));
          const deleted = table.filter(matches);
          tables[tableName] = table.filter((row) => !matches(row));
          return { data: deleted, error: null };
        }
        return { data: selectRows(), error: null };
      }

      const builder = {
        select() {
          selectRequested = true;
          return builder;
        },
        insert(rows) {
          operation = { type: "insert", rows: Array.isArray(rows) ? rows : [rows] };
          return builder;
        },
        delete() {
          operation = { type: "delete" };
          return builder;
        },
        eq(column, value) {
          filters.push((row) => row[column] === value);
          return builder;
        },
        in(column, values) {
          filters.push((row) => values.includes(row[column]));
          return builder;
        },
        is(column, value) {
          filters.push((row) => row[column] === value);
          return builder;
        },
        ilike(column, pattern) {
          const regex = likePatternToRegex(pattern);
          filters.push((row) => regex.test(String(row[column] ?? "")));
          return builder;
        },
        not(column, operator, value) {
          filters.push((row) =>
            value === null ? row[column] !== null : row[column] !== value
          );
          return builder;
        },
        order(column, { ascending = true, nullsFirst = false } = {}) {
          transforms.push((rows) =>
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
        limit(count) {
          transforms.push((rows) => rows.slice(0, count));
          return builder;
        },
        range(from, to) {
          transforms.push((rows) => rows.slice(from, to + 1));
          return builder;
        },
        async maybeSingle() {
          const result = selectRows();
          return { data: result[0] ?? null, error: null };
        },
        async single() {
          const result = selectRows();
          return result[0]
            ? { data: result[0], error: null }
            : { data: null, error: { message: "No rows found" } };
        },
        then(onFulfilled, onRejected) {
          return Promise.resolve(run()).then(onFulfilled, onRejected);
        }
      };
      return builder;
    }
  };
}

function snapshot(rows) {
  return (rows ?? []).map((row) => ({ ...row }));
}

function likePatternToRegex(pattern) {
  const source = String(pattern)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");
  return new RegExp(`^${source}$`, "is");
}
