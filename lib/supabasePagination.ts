const PAGE_SIZE = 500;

type PageError = {
  message: string;
};

type PageResult<T> = {
  data: T[] | null;
  error: PageError | null;
};

export async function readAllSupabaseRows<T>(
  readPage: (from: number, to: number) => PromiseLike<PageResult<T>>
) {
  const rows: T[] = [];
  let from = 0;

  for (;;) {
    const result = await readPage(from, from + PAGE_SIZE - 1);
    if (result.error) {
      return { data: null, error: result.error };
    }

    const page = result.data ?? [];
    if (page.length === 0) {
      return { data: rows, error: null };
    }

    rows.push(...page);
    from += page.length;
  }
}
